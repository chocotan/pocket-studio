import { spawn, spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await sleep(25);
  }
  return !processGroupAlive(pid);
}

export async function terminateProcessTree(child, { graceMs = 2_500, killWaitMs = 3_000 } = {}) {
  const pid = Number(child?.pid || 0);
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    if (!(await waitForGroupExit(pid, killWaitMs))) throw new Error(`process tree ${pid} survived taskkill`);
    return;
  }

  if (processGroupAlive(pid)) {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
  }
  if (await waitForGroupExit(pid, graceMs)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  if (!(await waitForGroupExit(pid, killWaitMs))) throw new Error(`process group ${pid} survived SIGKILL`);
}

export function runCommandInProcessGroup(command, args, {
  cwd,
  env = process.env,
  timeoutMs = 180_000,
  onSpawn,
  onSettled,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { onSettled?.(child); } catch {}
      callback(value);
    };
    try { onSpawn?.(child); } catch (error) {
      void terminateProcessTree(child).finally(() => finish(reject, error));
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).then(
        () => finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`)),
        (error) => finish(reject, new Error(`${command} timed out after ${timeoutMs}ms; cleanup failed: ${error.message}`)),
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { finish(reject, error); });
    child.on('exit', (code, signal) => {
      if (timedOut) return;
      if (code === 0) finish(resolvePromise, { stdout, stderr });
      else finish(reject, new Error(`${command} ${args.join(' ')} exited code=${code} signal=${signal}\n${stderr || stdout}`));
    });
  });
}
