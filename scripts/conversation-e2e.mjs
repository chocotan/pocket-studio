#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import {
  access,
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXACT_PROMPTS,
  RUNTIMES,
  SCENARIOS,
  SCHEMA_VERSION,
  assistantHistoryContains,
  assertPortsAvailable,
  captureServerStateTasksPayload,
  captureTaskEventPayload,
  captureWaitTaskEventsPayload,
  classifyWebSocketPayload,
  completedTurnEvidence,
  evaluateManagedProcessHealth,
  evaluateNoBuildFreshness,
  evaluateCell,
  findSecrets,
  fixedCasePorts,
  flattenTaskEvents,
  frameTaskWorkspaceViolations,
  followUpPrompt,
  makeCaseOwnedCleanupResult,
  makeTmuxCleanupResult,
  makeQualificationPlan,
  managedProcessAlreadyExited,
  makePairMatrix,
  normalizeComparableText,
  parseJSONLines,
  processIDsFromProcEntries,
  promptFixture,
  redactArtifactValue,
  redactSecrets,
  realTurnProgressSignature,
  reloadTurnOutcome,
  runtimeAgentPairs,
  qualifiedACPAgentConfig,
  realAdapterWrapperScript,
  wrappedACPAgentConfig,
  sha256,
  summarizeMatrixPlan,
  summarizeManagedProcessLogs,
  summarizeResultProgress,
  summarizeTaskEvents,
  toolHistoryContains,
  validateFixedPortPlan,
  waitForProgressCompletion,
  sha256File,
} from './conversation-e2e-lib.mjs';
import { processAlive, processGroupAlive, runCommandInProcessGroup, terminateProcessTree } from './conversation-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultArtifactDir = join(root, 'qualification-artifacts', 'conversation-e2e');
const defaultCapabilityReport = join(root, 'qualification-artifacts', 'agent-health', 'report.json');
const mockACPPath = join(root, 'scripts', 'conversation-e2e-mock-acp.mjs');
const activeStacks = new Set();
const activeTempRoots = new Set();
const activeCommandGroups = new Set();
let signalCleanupStarted = false;
let receivedSignal = '';

function assertNotInterrupted(stage) {
  if (!signalCleanupStarted) return;
  throw new Error(`harness interrupted by ${receivedSignal || 'signal'} during ${stage}`);
}

async function cleanupAfterSignal(signal) {
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  if (signalCleanupStarted) {
    process.exit(exitCode);
  }
  signalCleanupStarted = true;
  receivedSignal = signal;
  await closeActiveCommandGroups();
  await closeActiveStacks();
  process.exitCode = exitCode;
}

async function closeActiveCommandGroups() {
  const children = [...activeCommandGroups];
  await Promise.all(children.map(async (child) => {
    try { await terminateProcessTree(child); } catch {}
    finally { activeCommandGroups.delete(child); }
  }));
}

async function closeActiveStacks() {
  const stacks = [...activeStacks].reverse();
  for (const stack of stacks) {
    try { await stack.close(); } catch {}
    finally { activeStacks.delete(stack); }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void cleanupAfterSignal(signal); });
}

function usage() {
  return `Pocket Studio destructive conversation E2E

Usage:
  node scripts/conversation-e2e.mjs [options]

Options:
  --mode mock|real          deterministic mock matrix or installed agent (default: mock)
  --runtime LIST            all or direct_acp
  --scenario LIST           all or comma-separated scenario ids
  --prompt all|disk|news    exact prompt selection
  --agent all|NAME          all qualified pairs or one agent (default: all)
  --capability-report PATH  G001 qualification report (default: qualification-artifacts/agent-health/report.json)
  --artifact-dir PATH       artifact root (default: qualification-artifacts/conversation-e2e)
  --real-config PATH        source daemon config for real mode
  --timeout-ms N            per wait timeout (default: 30000)
  --hard-timeout-ms N       real turn hard ceiling (default: 600000)
  --mock-delay-ms N         active-reply barrier duration (default: 2500)
  --port-base N             fixed disjoint 3-port range per matrix cell
  --preflight-only          validate/build without running matrix
  --no-build                reuse dist binaries and existing frontend dist
  --headed                  show Chromium
  --keep-temp               preserve isolated temporary runtime directory
  --help                    print this help

Scenarios:
  ${Object.keys(SCENARIOS).join(', ')}
`;
}

function parseArgs(argv) {
  const options = {
    mode: 'mock',
    runtimes: [...RUNTIMES],
    scenarios: Object.keys(SCENARIOS),
    prompts: [...EXACT_PROMPTS],
    agent: 'all',
    capabilityReport: defaultCapabilityReport,
    artifactDir: defaultArtifactDir,
    realConfig: process.env.POCKET_STUDIO_REAL_CONFIG || join(homedir(), '.config', 'pocket-studio', 'agentbridge.daemon.json'),
    timeoutMs: 30_000,
    hardTimeoutMs: 600_000,
    mockDelayMs: 2_500,
    portBase: null,
    preflightOnly: false,
    build: true,
    headed: false,
    keepTemp: false,
  };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { ...options, help: true };
    if (arg === '--mode') options.mode = value(index++, arg);
    else if (arg === '--runtime') options.runtimes = parseList(value(index++, arg), RUNTIMES, arg);
    else if (arg === '--scenario') options.scenarios = parseList(value(index++, arg), Object.keys(SCENARIOS), arg);
    else if (arg === '--prompt') {
      const selected = value(index++, arg);
      if (selected === 'all') options.prompts = [...EXACT_PROMPTS];
      else if (selected === 'disk' || selected === EXACT_PROMPTS[0]) options.prompts = [EXACT_PROMPTS[0]];
      else if (selected === 'news' || selected === EXACT_PROMPTS[1]) options.prompts = [EXACT_PROMPTS[1]];
      else throw new Error(`unsupported --prompt ${selected}`);
    } else if (arg === '--agent') options.agent = value(index++, arg).trim().toLowerCase();
    else if (arg === '--capability-report') options.capabilityReport = resolve(value(index++, arg));
    else if (arg === '--artifact-dir') options.artifactDir = resolve(value(index++, arg));
    else if (arg === '--real-config') options.realConfig = resolve(value(index++, arg));
    else if (arg === '--timeout-ms') options.timeoutMs = positiveInt(value(index++, arg), arg);
    else if (arg === '--hard-timeout-ms') options.hardTimeoutMs = positiveInt(value(index++, arg), arg);
    else if (arg === '--mock-delay-ms') options.mockDelayMs = positiveInt(value(index++, arg), arg);
    else if (arg === '--port-base') options.portBase = portBaseInt(value(index++, arg), arg);
    else if (arg === '--preflight-only') options.preflightOnly = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--keep-temp') options.keepTemp = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!['mock', 'real'].includes(options.mode)) throw new Error(`unsupported --mode ${options.mode}`);
  if (!options.agent) throw new Error('--agent must not be empty');
  if (options.hardTimeoutMs < options.timeoutMs) throw new Error('--hard-timeout-ms must be >= --timeout-ms');
  return options;
}

function parseList(raw, allowed, flag) {
  if (raw === 'all') return [...allowed];
  const values = [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
  const unknown = values.filter((item) => !allowed.includes(item));
  if (unknown.length) throw new Error(`${flag} contains unsupported values: ${unknown.join(', ')}`);
  if (!values.length) throw new Error(`${flag} resolved to an empty list`);
  return values;
}

function positiveInt(raw, flag) {
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer`);
  return number;
}

function portBaseInt(raw, flag) {
  const number = positiveInt(raw, flag);
  if (number > 65535) throw new Error(`${flag} must be between 1 and 65535`);
  return number;
}

function commandInfo(command, args = ['--version']) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  return {
    command,
    available: result.status === 0,
    version: redactSecrets(`${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/)[0] || ''),
  };
}

async function executable(path) {
  try { await access(path, fsConstants.X_OK); return true; } catch { return false; }
}

function findChromium() {
  const candidates = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean);
  for (const candidate of candidates) {
    if (spawnSync('test', ['-x', candidate]).status === 0) return candidate;
  }
  return '';
}

async function runCommand(command, args, { cwd = root, env = process.env, timeoutMs = 180_000 } = {}) {
  try {
    return await runCommandInProcessGroup(command, args, {
      cwd,
      env,
      timeoutMs,
      onSpawn: (child) => activeCommandGroups.add(child),
      onSettled: (child) => activeCommandGroups.delete(child),
    });
  } catch (error) {
    throw new Error(redactSecrets(error.message));
  }
}

async function preflight(options, tempRoot) {
  assertNotInterrupted('preflight checks');
  const checks = {
    node: commandInfo(process.execPath),
    npm: commandInfo('npm'),
    go: commandInfo('go', ['version']),
    chromium: { command: findChromium(), available: Boolean(findChromium()), version: '' },
    mock_acp: { path: mockACPPath, available: await executable(process.execPath) },
  };
  if (checks.chromium.available) checks.chromium.version = commandInfo(checks.chromium.command).version;
  if (options.mode === 'real') {
    checks.real_config = { path: options.realConfig, available: false };
    try { await access(options.realConfig); checks.real_config.available = true; } catch {}
  }
  const unavailable = Object.entries(checks).filter(([, check]) => check.available === false).map(([name]) => name);
  if (unavailable.length) throw new Error(`preflight unavailable: ${unavailable.join(', ')}`);

  const binDir = join(tempRoot, 'bin');
  await mkdir(binDir, { recursive: true });
  const serverBin = options.build ? join(binDir, 'pocket-studio-server') : join(root, 'dist', 'pocket-studio-server-bin');
  const daemonBin = options.build ? join(binDir, 'pocket-studio-daemon') : join(root, 'dist', 'pocket-studio-daemon-bin');
  const build = [];
  if (options.build) {
    assertNotInterrupted('frontend build');
    const frontendStarted = Date.now();
    await runCommand('npm', ['run', 'build'], { cwd: join(root, 'studio-frontend') });
    assertNotInterrupted('server build');
    build.push({ target: 'studio-frontend', status: 'PASS', duration_ms: Date.now() - frontendStarted });
    const serverStarted = Date.now();
    const serverBuild = await buildServerWithTemporaryEmbed(serverBin, tempRoot);
    assertNotInterrupted('daemon build');
    build.push({ target: './cmd/server', status: 'PASS', duration_ms: Date.now() - serverStarted, ...serverBuild });
    const daemonStarted = Date.now();
    await runCommand('go', ['build', '-o', daemonBin, './cmd/daemon']);
    assertNotInterrupted('post-build validation');
    build.push({ target: './cmd/daemon', status: 'PASS', duration_ms: Date.now() - daemonStarted });
  }
  for (const binary of [serverBin, daemonBin]) {
    if (!(await executable(binary))) throw new Error(`required binary is not executable: ${binary}`);
  }
  if (!options.build) {
    const serverInfo = await stat(serverBin);
    const frontendModifiedMs = await newestFileModifiedMs(join(root, 'studio-frontend', 'dist'));
    checks.no_build_freshness = evaluateNoBuildFreshness({
      serverModifiedMs: serverInfo.mtimeMs,
      frontendModifiedMs,
    });
    if (!checks.no_build_freshness.fresh) {
      throw new Error(`--no-build rejected stale embedded server: ${checks.no_build_freshness.reason}; run without --no-build`);
    }
  }
  return { status: 'PASS', checks, build, binaries: { server: serverBin, daemon: daemonBin }, chromium: checks.chromium.command };
}

async function newestFileModifiedMs(path) {
  let newest = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestFileModifiedMs(child));
    else if (entry.isFile()) newest = Math.max(newest, (await stat(child)).mtimeMs);
  }
  return newest;
}

async function syncEmbeddedStudio(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === 'README.md') continue;
    await rm(join(target, entry.name), { recursive: true, force: true });
  }
  await cp(source, target, { recursive: true });
}

async function buildServerWithTemporaryEmbed(serverBin, tempRoot) {
  const sourceEmbed = join(root, 'cmd', 'server', 'embedded', 'studio');
  const sourceDigest = await directoryDigest(sourceEmbed);
  const buildRoot = join(tempRoot, 'server-build');
  await mkdir(join(buildRoot, 'cmd'), { recursive: true });
  await Promise.all([
    cp(join(root, 'go.mod'), join(buildRoot, 'go.mod')),
    cp(join(root, 'go.sum'), join(buildRoot, 'go.sum')),
    cp(join(root, 'cmd', 'server'), join(buildRoot, 'cmd', 'server'), { recursive: true }),
    cp(join(root, 'internal'), join(buildRoot, 'internal'), { recursive: true }),
  ]);
  await syncEmbeddedStudio(
    join(root, 'studio-frontend', 'dist'),
    join(buildRoot, 'cmd', 'server', 'embedded', 'studio'),
  );
  await runCommand('go', ['build', '-o', serverBin, './cmd/server'], { cwd: buildRoot });
  const sourceDigestAfter = await directoryDigest(sourceEmbed);
  if (sourceDigestAfter !== sourceDigest) throw new Error('isolated server build modified repository embedded studio');
  return { isolated_source_build: true, repository_embed_unchanged: true, repository_embed_sha256: sourceDigest };
}

async function directoryDigest(path) {
  const rows = [];
  const walk = async (current, relative = '') => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = join(current, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) rows.push(`${childRelative}\0${sha256(await readFile(child))}`);
    }
  };
  await walk(path);
  return sha256(rows.join('\n'));
}

async function freePorts(count) {
  const servers = [];
  const ports = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer();
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolvePromise);
      });
      servers.push(server);
      ports.push(server.address().port);
    }
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolvePromise) => server.close(resolvePromise))));
  }
  return ports;
}

async function portIsFree(port) {
  const server = createServer();
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolvePromise);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

function processIdentityKey(processInfo) {
  return `${processInfo.pid}:${processInfo.start_ticks}`;
}

async function readLinuxProcess(pid, markers) {
  try {
    const [statText, commandRaw, environmentRaw] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`),
      readFile(`/proc/${pid}/environ`),
    ]);
    const closeParen = statText.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = statText.slice(closeParen + 1).trim().split(/\s+/);
    if (fields[0] === 'Z') return null;
    const startTicks = fields[19] || '';
    const commandArgs = commandRaw.toString('utf8').split('\0').filter(Boolean);
    const environmentEntries = new Set(environmentRaw.toString('utf8').split('\0').filter(Boolean));
    const matched = markers.filter((marker) => commandArgs.includes(marker) || environmentEntries.has(marker));
    if (!startTicks || matched.length === 0) return null;
    return {
      pid: Number(pid),
      start_ticks: startTicks,
      command: basename(commandArgs[0] || 'unknown'),
      marker_count: matched.length,
    };
  } catch {
    return null;
  }
}

async function snapshotCaseOwnedProcesses(markers) {
  if (process.platform !== 'linux') return [];
  // String-only readdir avoids Node's Dirent fallback lstat racing a PID that exits mid-scan.
  const pids = processIDsFromProcEntries(await readdir('/proc'), process.pid);
  const rows = await Promise.all(pids.map((pid) => readLinuxProcess(pid, markers)));
  return rows.filter(Boolean);
}

async function signalOwnedProcess(processInfo, signal, markers) {
  const current = await readLinuxProcess(processInfo.pid, markers);
  if (!current || processIdentityKey(current) !== processIdentityKey(processInfo)) return false;
  try { process.kill(processInfo.pid, signal); return true; } catch { return false; }
}

async function cleanupCaseOwnedProcesses(markers, baseline, excludedPIDs = [], { scope = 'case' } = {}) {
  if (process.platform !== 'linux') return { status: 'PASS', skipped: true, reason: 'requires /proc' };
  const naturalExitGraceMs = 500;
  const baselineKeys = new Set((baseline || []).map(processIdentityKey));
  const excluded = new Set(excludedPIDs.filter((pid) => Number(pid) > 0));
  await delay(naturalExitGraceMs);
  const discovered = new Map();
  const remember = (items) => {
    for (const item of items) discovered.set(processIdentityKey(item), item);
    return items;
  };
  const owned = remember((await snapshotCaseOwnedProcesses(markers))
    .filter((item) => !baselineKeys.has(processIdentityKey(item)) && !excluded.has(item.pid)));
  const termAttempts = await Promise.all(owned.map(async (item) => ({
    identity: processIdentityKey(item),
    pid: item.pid,
    signal: 'SIGTERM',
    sent: await signalOwnedProcess(item, 'SIGTERM', markers),
  })));
  await delay(500);
  let survivors = remember((await snapshotCaseOwnedProcesses(markers))
    .filter((item) => !baselineKeys.has(processIdentityKey(item)) && !excluded.has(item.pid)));
  const killAttempts = await Promise.all(survivors.map(async (item) => ({
    identity: processIdentityKey(item),
    pid: item.pid,
    signal: 'SIGKILL',
    sent: await signalOwnedProcess(item, 'SIGKILL', markers),
  })));
  await delay(100);
  survivors = remember((await snapshotCaseOwnedProcesses(markers))
    .filter((item) => !baselineKeys.has(processIdentityKey(item)) && !excluded.has(item.pid)));
  return makeCaseOwnedCleanupResult({
    baselineCount: baselineKeys.size,
    naturalExitGraceMs,
    scope,
    discovered: [...discovered.values()],
    termAttempts,
    killAttempts,
    survivors,
  });
}

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function secureMkdir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function redactCommandArgs(args) {
  const sensitiveFlag = /^--?(?:token|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|password|authorization)$/i;
  let redactNext = false;
  return args.map((arg) => {
    const value = String(arg);
    if (redactNext) {
      redactNext = false;
      return '[REDACTED]';
    }
    const [flag] = value.split('=', 1);
    if (sensitiveFlag.test(flag)) {
      if (!value.includes('=')) redactNext = true;
      return value.includes('=') ? `${flag}=[REDACTED]` : value;
    }
    return redactSecrets(value);
  });
}

async function waitFor(fn, label, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    assertNotInterrupted(label);
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

class ManagedProcess {
  constructor(name, command, args, options) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.options = options;
    this.child = null;
    this.exit = null;
    this.childClose = null;
    this.logWrite = Promise.resolve();
    this.logWriteError = null;
    this.stopRequested = false;
    this.unexpectedExitBeforeStop = false;
  }

  appendLog(text) {
    this.logWrite = this.logWrite
      .then(() => appendFile(this.options.logPath, text))
      .catch((error) => { this.logWriteError ||= error; });
  }

  async logHealth() {
    if (this.childClose) await Promise.race([this.childClose, delay(1_000)]);
    await this.logWrite;
    if (this.logWriteError) {
      return {
        process: this.name,
        status: 'FAIL',
        findings: [{ process: this.name, line_number: 0, kind: 'log_write_error', line: redactSecrets(this.logWriteError.message) }],
      };
    }
    try {
      const observedExit = this.exit || (this.unexpectedExitBeforeStop ? {
        code: this.child?.exitCode ?? null,
        signal: this.child?.signalCode ?? null,
        expected: false,
        at: '',
      } : null);
      return evaluateManagedProcessHealth(this.name, await readFile(this.options.logPath, 'utf8'), observedExit);
    } catch (error) {
      return {
        process: this.name,
        status: 'FAIL',
        findings: [{ process: this.name, line_number: 0, kind: 'log_read_error', line: redactSecrets(error.message) }],
      };
    }
  }

  async start() {
    if (this.child && this.exit === null) throw new Error(`${this.name} is already running`);
    if (this.options.canStart && !this.options.canStart()) throw new Error(`${this.name} start cancelled`);
    await secureMkdir(dirname(this.options.logPath));
    await writeFile(this.options.logPath, '', { flag: 'a', mode: 0o600 });
    await writeFile(this.options.lifecyclePath, '', { flag: 'a', mode: 0o600 });
    await chmod(this.options.logPath, 0o600);
    await chmod(this.options.lifecyclePath, 0o600);
    if (this.options.canStart && !this.options.canStart()) throw new Error(`${this.name} start cancelled`);
    this.exit = null;
    this.stopRequested = false;
    this.unexpectedExitBeforeStop = false;
    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.childClose = new Promise((resolvePromise) => child.once('close', resolvePromise));
    if (this.options.canStart && !this.options.canStart()) {
      await terminateProcessTree(child);
      throw new Error(`${this.name} start cancelled after spawn`);
    }
    await appendFile(this.options.lifecyclePath, `${JSON.stringify({ at: new Date().toISOString(), type: 'start', name: this.name, pid: child.pid, command: basename(this.command), args: redactCommandArgs(this.args) })}\n`);
    for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', (line) => {
        this.appendLog(`[${new Date().toISOString()}] [${streamName}] ${String(redactArtifactValue(line))}\n`);
      });
    }
    child.on('error', (error) => {
      this.appendLog(`[${new Date().toISOString()}] [process-error] ${redactSecrets(error.stack || error.message)}\n`);
    });
    child.on('exit', (code, signal) => {
      this.exit = { code, signal, expected: this.stopRequested && !this.unexpectedExitBeforeStop, at: new Date().toISOString() };
      void appendFile(this.options.lifecyclePath, `${JSON.stringify({ type: 'exit', name: this.name, pid: child.pid, ...this.exit })}\n`);
    });
    await delay(30);
    if (this.exit !== null) throw new Error(`${this.name} exited during startup: ${JSON.stringify(this.exit)}`);
    return child;
  }

  async stop(graceMs = 2_500) {
    const child = this.child;
    if (!child) return;
    const alreadyExited = managedProcessAlreadyExited({
      recordedExit: this.exit,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      alive: processAlive(child.pid),
    });
    if (alreadyExited) this.unexpectedExitBeforeStop = true;
    else this.stopRequested = true;
    const pid = child.pid;
    await appendFile(this.options.lifecyclePath, `${JSON.stringify({ at: new Date().toISOString(), type: 'stop', name: this.name, pid })}\n`);
    await terminateProcessTree(child, { graceMs });
    await waitFor(() => this.exit !== null, `${this.name} stopped`, 3_000, 50).catch(() => {});
    if (this.childClose) await Promise.race([this.childClose, delay(1_000)]);
    await this.logWrite;
    await appendFile(this.options.lifecyclePath, `${JSON.stringify({ at: new Date().toISOString(), type: 'group_stopped', name: this.name, pid })}\n`);
  }
}

class CDP {
  constructor(url, requestTimeoutMs = 30_000) {
    this.ws = new WebSocket(url);
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextID = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener('message', async (event) => {
      const text = typeof event.data === 'string' ? event.data : event.data instanceof Blob ? await event.data.text() : Buffer.from(event.data).toString('utf8');
      const message = JSON.parse(text);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      } else if (message.method) this.events.push(message);
    });
    this.ws.addEventListener('close', () => this.rejectPending(new Error('CDP connection closed')));
    this.ws.addEventListener('error', () => this.rejectPending(new Error('CDP websocket error')));
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  ready() {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), 5_000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error')); }, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.nextID;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() {
    this.rejectPending(new Error('CDP connection closed'));
    try { this.ws.close(); } catch {}
  }
}

async function evalPage(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(`browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result.value;
}

async function connectCDP(port, timeoutMs) {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 'Chromium CDP', timeoutMs);
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await response.json();
  const requestTimeoutMs = Math.min(Math.max(timeoutMs, 5_000), 30_000);
  const cdp = new CDP(target.webSocketDebuggerUrl, requestTimeoutMs);
  await cdp.ready();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: browserInstrumentation() });
  return cdp;
}

function browserInstrumentation() {
  return `(() => {
    window.__POCKET_E2E__ = {
      frames: [], task_event_frames: {}, task_event_versions: {}, wait_task_events: {},
      server_state_frames: {}, server_state_tasks: {}, sockets: [], errors: [], protocol_revision: 0, dropped_noise_frames: 0
    };
    const state = window.__POCKET_E2E__;
    const OriginalWebSocket = window.WebSocket;
    const classifyPayload = ${classifyWebSocketPayload.toString()};
    const captureTaskEvent = ${captureTaskEventPayload.toString()};
    const captureWaitTaskEvents = ${captureWaitTaskEventsPayload.toString()};
    const captureServerStateTasks = ${captureServerStateTasksPayload.toString()};
    const record = (entry) => {
      state.frames.push({ at: Date.now(), ...entry });
      state.protocol_revision++;
    };
    const taskEventKey = (taskEvent) => String(taskEvent.task_id || '') + '\\u0000' + taskEvent.event_id;
    const storeTaskEvent = (taskEvent, entry) => {
        const key = taskEventKey(taskEvent);
        const previous = state.task_event_versions[key];
        const replace = !previous
          || taskEvent.rank > previous.rank
          || (taskEvent.rank === previous.rank && taskEvent.updated_at > previous.updated_at)
          || (taskEvent.rank === previous.rank && taskEvent.updated_at === previous.updated_at && taskEvent.data_size > previous.data_size);
        if (replace) {
          state.task_event_versions[key] = {
            rank: taskEvent.rank, updated_at: taskEvent.updated_at, data_size: taskEvent.data_size
          };
          if (entry) state.task_event_frames[key] = { at: Date.now(), ...entry };
          if (taskEvent.wait_event) state.wait_task_events[key] = taskEvent.event;
          state.protocol_revision++;
        }
    };
    const recordPayload = (entry) => {
      const taskEvent = captureTaskEvent(entry.data);
      if (taskEvent) {
        storeTaskEvent(taskEvent, entry);
        return;
      }
      const classification = classifyPayload(entry.data);
      if (classification === 'noise') {
        state.dropped_noise_frames++;
        return;
      }
      const frame = { at: Date.now(), ...entry };
      if (classification === 'state') {
        const key = entry.socket_id + ':' + entry.direction;
        state.server_state_frames[key] = frame;
        state.server_state_tasks[key] = captureServerStateTasks(entry.data);
        for (const nestedEvent of captureWaitTaskEvents(entry.data)) storeTaskEvent(nestedEvent, null);
        return;
      }
      state.frames.push(frame);
      state.protocol_revision++;
    };
    let nextSocketId = 0;
    window.addEventListener('error', (event) => state.errors.push({ at: Date.now(), message: String(event.message || event.error || 'window error') }));
    window.addEventListener('unhandledrejection', (event) => state.errors.push({ at: Date.now(), message: String(event.reason || 'unhandled rejection') }));
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        const url = String(args[0]);
        const socket = new target(...args);
        const socketInfo = { id: ++nextSocketId, url, at: Date.now(), ready_state: socket.readyState };
        state.sockets.push(socketInfo);
        record({ direction: 'lifecycle', type: 'construct', socket_id: socketInfo.id, url });
        const originalSend = socket.send.bind(socket);
        socket.send = (data) => {
          recordPayload({ direction: 'send', socket_id: socketInfo.id, url, data: typeof data === 'string' ? data : '[binary]' });
          return originalSend(data);
        };
        socket.addEventListener('open', () => { socketInfo.ready_state = socket.readyState; record({ direction: 'lifecycle', type: 'open', socket_id: socketInfo.id, url }); });
        socket.addEventListener('close', (event) => { socketInfo.ready_state = socket.readyState; record({ direction: 'lifecycle', type: 'close', socket_id: socketInfo.id, url, code: event.code, reason: event.reason }); });
        socket.addEventListener('error', () => { socketInfo.ready_state = socket.readyState; record({ direction: 'lifecycle', type: 'error', socket_id: socketInfo.id, url }); });
        socket.addEventListener('message', async (event) => {
          let data = '[binary]';
          if (typeof event.data === 'string') data = event.data;
          else if (event.data instanceof Blob) data = await event.data.text();
          recordPayload({ direction: 'receive', socket_id: socketInfo.id, url, data });
        });
        return socket;
      }
    });
  })();`;
}

async function screenshot(cdp, path) {
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path, Buffer.from(capture.data, 'base64'), { mode: 0o600 });
}

async function pageClick(cdp, selector, timeoutMs) {
  await waitFor(() => evalPage(cdp, `Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.offsetParent !== null))`), `visible ${selector}`, timeoutMs);
  const clicked = await evalPage(cdp, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.offsetParent !== null); if (!el) return false; el.click(); return true; })()`);
  if (!clicked) throw new Error(`failed to click ${selector}`);
}

async function pageClickByText(cdp, text, timeoutMs) {
  const expression = `(() => [...document.querySelectorAll('button')].find((el) => el.offsetParent !== null && el.innerText.trim() === ${JSON.stringify(text)}))()`;
  await waitFor(() => evalPage(cdp, `Boolean(${expression})`), `visible button text ${text}`, timeoutMs);
  const clicked = await evalPage(cdp, `(() => { const el = ${expression}; if (!el) return false; el.click(); return true; })()`);
  if (!clicked) throw new Error(`failed to click button text ${text}`);
}

async function pageClickSelectorOrText(cdp, selector, text, timeoutMs) {
  const selectorVisible = await evalPage(cdp, `Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.offsetParent !== null))`);
  if (selectorVisible) await pageClick(cdp, selector, timeoutMs);
  else await pageClickByText(cdp, text, timeoutMs);
}

async function openChat(cdp, cell, timeoutMs) {
  await pageClick(cdp, '[data-testid="panel-add-tab"]', timeoutMs);
  const runtimeLabel = 'ACP会话';
  await pageClickSelectorOrText(cdp, `[data-testid="menu-runtime-${cell.runtime}"]`, runtimeLabel, timeoutMs);
  const agentLabel = cell.agent === 'claude' ? 'claude code' : cell.agent === 'qwen' ? 'qwen code' : cell.agent === 'kilo' ? 'kilo code' : cell.agent;
  await pageClickSelectorOrText(cdp, `[data-testid="menu-agent-${cell.runtime}-${cell.agent}"]`, agentLabel, timeoutMs);
  const selector = `[data-testid="agent-chat"][data-agent-runtime="${cell.runtime}"][data-agent-kind="${cell.agent}"]`;
  await waitFor(() => evalPage(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`), 'agent chat root', timeoutMs);
  await waitFor(() => evalPage(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)})?.dataset.sessionId)`), 'agent session id', timeoutMs);
  await delay(500);
  return selector;
}

async function sendPrompt(cdp, rootSelector, prompt, timeoutMs) {
  const sent = await evalPage(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const input = root?.querySelector('[data-testid="agent-input"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!sent) throw new Error('agent input not available');
  await waitFor(() => evalPage(cdp, `Boolean(document.querySelector(${JSON.stringify(rootSelector)})?.querySelector('[data-testid="agent-send"]:not(:disabled)'))`), 'agent send enabled', timeoutMs);
  await pageClick(cdp, `${rootSelector} [data-testid="agent-send"]`, timeoutMs);
}

async function waitForAssistant(cdp, rootSelector, text, timeoutMs) {
  const expected = normalizeComparableText(text);
  return waitFor(() => evalPage(cdp, `(() => [...document.querySelectorAll(${JSON.stringify(`${rootSelector} [data-message-kind="assistant_message"]`)})].map((node) => node.innerText).join('').replace(/\\s+/g, '').includes(${JSON.stringify(expected)}))()`), `assistant text ${text}`, timeoutMs);
}

async function waitForWorking(cdp, rootSelector, expected, timeoutMs) {
  return waitFor(() => evalPage(cdp, `document.querySelector(${JSON.stringify(rootSelector)})?.dataset.working === ${JSON.stringify(expected ? 'true' : 'false')}`), `working=${expected}`, timeoutMs);
}

async function collectDOM(cdp, rootSelector) {
  await expandToolGroups(cdp, rootSelector);
  return evalPage(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root) return { missing: true, working: true, error: 'agent chat root missing', assistant_messages: [], user_prompts: [], tools: [] };
    const text = (selector) => [...root.querySelectorAll(selector)].map((node) => node.innerText.trim());
    return {
      missing: false,
      runtime: root.dataset.agentRuntime || '',
      agent: root.dataset.agentKind || '',
      run_status: root.dataset.runStatus || '',
      session_id: root.dataset.sessionId || '',
      working: root.dataset.working === 'true',
      error: root.querySelector('[data-testid="agent-error"]')?.innerText.trim() || '',
      assistant_messages: text('[data-message-kind="assistant_message"]'),
      assistant_cards: [...root.querySelectorAll('[data-message-kind="assistant_message"]')].map((node) => ({
        id: node.dataset.messageId || '', text: node.innerText.trim(),
      })),
      user_prompts: text('[data-message-kind="user_prompt"]'),
      tools: [...root.querySelectorAll('[data-testid="agent-tool-call"]')].map((node) => ({ ...node.dataset, text: node.innerText.trim() })),
      timeline: root.querySelector('[data-testid="agent-timeline"]')?.innerText || '',
    };
  })()`);
}

async function expandToolGroups(cdp, rootSelector) {
  const expandedGroups = await evalPage(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root) return 0;
    const toggles = [...root.querySelectorAll('[data-testid="agent-tool-group-toggle"][aria-expanded="false"]')];
    for (const toggle of toggles) toggle.click();
    return toggles.length;
  })()`);
  if (expandedGroups > 0) await delay(50);
  const expandedCards = await evalPage(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root) return 0;
    const toggles = [...root.querySelectorAll('[data-testid="agent-tool-call-toggle"][aria-expanded="false"]')];
    for (const toggle of toggles) toggle.click();
    return toggles.length;
  })()`);
  if (expandedCards > 0) await delay(50);
}

async function browserFrameMetadata(cdp) {
  return evalPage(cdp, `(() => {
    const state = window.__POCKET_E2E__ || {};
    return {
      frame_counts: {
        frames: (state.frames || []).length,
        task_events: Object.keys(state.task_event_frames || {}).length,
        server_states: Object.keys(state.server_state_frames || {}).length,
      },
      sockets: state.sockets || [], errors: state.errors || [], href: location.href,
      protocol_revision: state.protocol_revision || 0,
      dropped_noise_frames: state.dropped_noise_frames || 0,
    };
  })()`);
}

async function browserFrames(cdp) {
  const metadata = await browserFrameMetadata(cdp);
  const frames = [];
  const sources = [
    ['state.frames || []', metadata.frame_counts.frames],
    ['Object.values(state.task_event_frames || {})', metadata.frame_counts.task_events],
    ['Object.values(state.server_state_frames || {})', metadata.frame_counts.server_states],
  ];
  const pageSize = 50;
  for (const [source, count] of sources) {
    for (let offset = 0; offset < count; offset += pageSize) {
      const page = await evalPage(cdp, `(() => {
        const state = window.__POCKET_E2E__ || {};
        return (${source}).slice(${offset}, ${offset + pageSize});
      })()`);
      frames.push(...page);
    }
  }
  frames.sort((left, right) => Number(left.at || 0) - Number(right.at || 0));
  return { ...metadata, frames };
}

async function browserTaskEvents(cdp) {
  return evalPage(cdp, `Object.values(window.__POCKET_E2E__?.wait_task_events || {})`);
}

async function browserServerStateTasks(cdp) {
  return evalPage(cdp, `(() => {
    const snapshots = Object.values(window.__POCKET_E2E__?.server_state_tasks || {});
    const latest = new Map();
    for (const task of snapshots.flat()) {
      if (!task?.task_id) continue;
      const previous = latest.get(task.task_id);
      if (!previous || Number(task.updated_at || 0) >= Number(previous.updated_at || 0)) latest.set(task.task_id, task);
    }
    return [...latest.values()];
  })()`);
}

function taskEventsFromFrames(frames) {
  const result = [];
  for (const frame of frames) {
    if (frame.direction !== 'receive' || typeof frame.data !== 'string') continue;
    try {
      const found = [];
      flattenTaskEvents(JSON.parse(frame.data), found);
      result.push(...found.map((event) => ({ ...event, __received_at: frame.at })));
    } catch {}
  }
  return result;
}

async function writeRuntimeJSON(path, value) {
  await secureMkdir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeArtifactJSON(path, value) {
  await secureMkdir(dirname(path));
  await writeFile(path, `${JSON.stringify(redactArtifactValue(value), null, 2)}\n`, { mode: 0o600 });
}

async function writeArtifactJSONL(path, rows) {
  await secureMkdir(dirname(path));
  await writeFile(path, rows.map((row) => JSON.stringify(redactArtifactValue(row))).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
}

async function mockRowsSince(path, startOffset = 0) {
  try {
    const text = await readFile(path, 'utf8');
    return parseJSONLines(text.slice(startOffset));
  } catch { return []; }
}

async function readConfig(options) {
  if (options.mode === 'mock') return {};
  return JSON.parse(await readFile(options.realConfig, 'utf8'));
}

async function loadRuntimeAgentPlans(options) {
  const report = JSON.parse(await readFile(options.capabilityReport, 'utf8'));
  return {
    report,
    selectedPairs: runtimeAgentPairs(report, { runtimes: options.runtimes, agent: options.agent }),
    qualificationPlan: makeQualificationPlan(report),
  };
}

async function makeCaseConfig({ options, cell, caseTemp, ports, mockLog, qualificationReport }) {
  const [serverPort, directPort] = ports;
  const workspace = join(caseTemp, 'workspace');
  const configDir = join(caseTemp, 'config');
  const mockState = join(caseTemp, 'mock-state');
  const shimDir = join(caseTemp, 'shim-bin');
  const tmuxSocket = `pocket-e2e-${process.pid}-${sha256(caseTemp).slice(0, 16)}`;
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(configDir, { recursive: true }), mkdir(mockState, { recursive: true }), mkdir(shimDir, { recursive: true })]);

  const source = await readConfig(options);
  const common = {
    ...source,
    device: { id: `pocket-e2e-${cell.runtime}`, name: 'Pocket E2E Device', alias: 'Pocket E2E Device' },
    server: { url: `ws://127.0.0.1:${serverPort}/ws/daemon`, token: '' },
    workspaces: [{ id: 'conversation-e2e', name: 'Conversation E2E', path: workspace }],
    direct_web: { enabled: true, listen_addr: `127.0.0.1:${directPort}`, public_host: '127.0.0.1', token: 'e2e-local-token' },
  };
  if (options.mode === 'mock') {
    const capabilityShim = join(shimDir, cell.agent);
    await writeFile(capabilityShim, '#!/bin/sh\nexit 0\n');
    await chmod(capabilityShim, 0o755);
    common.direct_acp = {
      enabled: true,
      agents: {
        [cell.agent]: {
          command: process.execPath,
          args: [mockACPPath],
          env: {
            POCKET_E2E_MOCK_LOG: mockLog,
            POCKET_E2E_MOCK_STATE: mockState,
            POCKET_E2E_MOCK_DELAY_MS: String(options.mockDelayMs),
            POCKET_E2E_RUNTIME: cell.runtime,
          },
        },
      },
    };
  } else {
    const configuredCommands = JSON.stringify(source.direct_acp);
    if (configuredCommands.includes('conversation-e2e-mock') || configuredCommands.includes(mockACPPath) || configuredCommands.includes(shimDir)) {
      throw new Error('real mode configuration resolves to a conversation E2E mock or shim');
    }
    const realHome = homedir();
    const realXDGConfigHome = process.env.XDG_CONFIG_HOME || join(realHome, '.config');
	const qualified = qualifiedACPAgentConfig(qualificationReport, cell.agent);
    const adapterWrapper = join(shimDir, `pocket-e2e-real-${qualified.registryAgent}-adapter`);
    await writeFile(adapterWrapper, realAdapterWrapperScript({
      command: qualified.config.command,
      home: realHome,
      xdgConfigHome: realXDGConfigHome,
    }), { mode: 0o700 });
    await chmod(adapterWrapper, 0o700);
	const wrapped = wrappedACPAgentConfig(qualified.config, adapterWrapper);
	common.direct_acp = {
	  ...(source.direct_acp || {}),
	  enabled: true,
	  agents: {
	    ...(source.direct_acp?.agents || {}),
	    [cell.agent]: wrapped,
	  },
    };
  }
  await writeRuntimeJSON(join(configDir, 'agentbridge.daemon.json'), common);
  return {
    configDir,
    workspace,
    mockState,
    shimDir,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'FORCE_COLOR')),
      NO_COLOR: '1',
      ...(options.mode === 'mock' ? { PATH: `${shimDir}:${process.env.PATH || ''}` } : {}),
      POCKET_STUDIO_CONFIG_DIR: configDir,
      POCKET_STUDIO_DAEMON_CONFIG_DIR: configDir,
      POCKET_STUDIO_AUTH_DIR: join(caseTemp, 'auth'),
      POCKET_STUDIO_TMUX_SOCKET: tmuxSocket,
      POCKET_E2E_CASE_MARKER: caseTemp,
      ...(options.mode === 'mock' ? {
        POCKET_E2E_MOCK_LOG: mockLog,
        POCKET_E2E_MOCK_STATE: mockState,
        POCKET_E2E_MOCK_DELAY_MS: String(options.mockDelayMs),
        POCKET_E2E_RUNTIME: cell.runtime,
      } : {}),
    },
    tmuxSocket,
  };
}

function inspectTmuxSocket(socketName) {
  const result = spawnSync('tmux', [
    '-L', socketName, 'list-panes', '-a', '-F',
    '#{session_name}\t#{pane_current_path}\t#{pane_pid}',
  ], { encoding: 'utf8', timeout: 5000 });
  if (result.error) {
    return { status: 'FAIL', server_running: false, panes: [], error: redactSecrets(result.error.message) };
  }
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0) {
    if (/no server running|failed to connect|no such file or directory/i.test(stderr)) {
      return { status: 'PASS', server_running: false, panes: [], error: '' };
    }
    return { status: 'FAIL', server_running: false, panes: [], error: redactSecrets(stderr || `tmux exited ${result.status}`) };
  }
  const panes = String(result.stdout || '').split('\n').filter(Boolean).map((line) => {
    const [session = '', cwd = '', pid = '0'] = line.split('\t');
    return { session, cwd, pid: Number(pid) || 0 };
  });
  return { status: 'PASS', server_running: true, panes, error: '' };
}

async function cleanupTmuxSocket(socketName, baseline) {
  const before = inspectTmuxSocket(socketName);
  const baselineSessions = new Set((baseline?.panes || []).map((pane) => pane.session));
  const discovered = before.panes.filter((pane) => !baselineSessions.has(pane.session));
  let kill = { attempted: false, status: null, error: '' };
  if (before.status === 'PASS' && before.server_running && baselineSessions.size === 0) {
    const result = spawnSync('tmux', ['-L', socketName, 'kill-server'], { encoding: 'utf8', timeout: 5000 });
    kill = {
      attempted: true,
      status: result.status,
      error: result.error ? redactSecrets(result.error.message) : redactSecrets(String(result.stderr || '').trim()),
    };
  }
  let after = inspectTmuxSocket(socketName);
  for (let attempt = 0; attempt < 20 && after.server_running; attempt++) {
    await delay(50);
    after = inspectTmuxSocket(socketName);
  }
  const survivors = after.panes.filter((pane) => !baselineSessions.has(pane.session));
  const socketCleanup = await removeOwnedTmuxSocketFile(socketName, after.status === 'PASS' && !after.server_running);
  return makeTmuxCleanupResult({
    socket: socketName,
    baseline: baseline || null,
    before,
    discovered,
    kill,
    after,
    survivors,
    ...socketCleanup,
  });
}

function tmuxSocketFilesystemPath(socketName) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID);
  if (!Number.isInteger(uid) || uid < 0) return '';
  return join(process.env.TMUX_TMPDIR || tmpdir(), `tmux-${uid}`, socketName);
}

async function tmuxSocketPathExists(path) {
  if (!path) return false;
  try {
    await lstat(path);
    return true;
  }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwnedTmuxSocketFile(socketName, serverInactive) {
  const socketPath = tmuxSocketFilesystemPath(socketName);
  let socketExistsBefore = false;
  let socketRemoved = false;
  let socketExistsAfter = true;
  let socketCleanupError = '';
  try {
    const ownedPattern = new RegExp(`^pocket-e2e-${process.pid}-[a-f0-9]{16}$`);
    if (!ownedPattern.test(socketName)) throw new Error('refusing to remove a tmux socket not owned by this harness');
    if (!socketPath) throw new Error('unable to resolve the tmux socket path');
    socketExistsBefore = await tmuxSocketPathExists(socketPath);
    if (socketExistsBefore) {
      if (!serverInactive) throw new Error('refusing to remove a tmux socket while its server may be active');
      await rm(socketPath, { force: true });
      socketRemoved = true;
    }
    socketExistsAfter = await tmuxSocketPathExists(socketPath);
  } catch (error) {
    socketCleanupError = redactSecrets(error.message);
    try { socketExistsAfter = await tmuxSocketPathExists(socketPath); }
    catch (inspectError) {
      socketExistsAfter = true;
      socketCleanupError = `${socketCleanupError}; ${redactSecrets(inspectError.message)}`;
    }
  }
  return {
    socketPath,
    socketExistsBefore,
    socketRemoved,
    socketExistsAfter,
    socketCleanupError,
  };
}

class CaseStack {
  constructor({ options, cell, caseTemp, caseDir, ports, binaries, chromium, config }) {
    this.options = options;
    this.cell = cell;
    this.caseTemp = caseTemp;
    this.caseDir = caseDir;
    this.ports = ports;
    this.binaries = binaries;
    this.chromium = chromium;
    this.config = config;
    this.processes = [];
    this.daemonGeneration = 0;
    this.cdp = null;
    this.lifecyclePath = join(caseDir, 'processes.jsonl');
    this.startupEvidence = [];
    this.frameArchive = [];
    this.browserErrors = [];
    this.browserEpoch = 0;
    this.ownedProcessBaseline = [];
    this.tmuxBaseline = null;
    this.closing = false;
  }

  assertCanContinue(stage) {
    if (this.closing) throw new Error(`case stack is closing during ${stage}`);
    assertNotInterrupted(stage);
  }

  ownershipMarkers() {
    return [`POCKET_E2E_CASE_MARKER=${this.caseTemp}`];
  }

  processOwnerValue(name) {
    return `${this.caseTemp}:${name}`;
  }

  processOwnerMarker(name) {
    return `POCKET_E2E_PROCESS_OWNER=${this.processOwnerValue(name)}`;
  }

  activeManagedPIDs() {
    return this.processes.filter((managed) => managed.child && managed.exit === null).map((managed) => managed.child.pid);
  }

  process(name, command, args, env = this.config.env) {
    this.assertCanContinue(`${name} process creation`);
    const managed = new ManagedProcess(name, command, args, {
      cwd: root,
      env: { ...env, POCKET_E2E_PROCESS_OWNER: this.processOwnerValue(name) },
      logPath: join(this.caseDir, `${name}.log`),
      lifecyclePath: this.lifecyclePath,
      canStart: () => !this.closing && !signalCleanupStarted,
    });
    this.processes.push(managed);
    return managed;
  }

  async start() {
    this.assertCanContinue('case startup');
    this.ownedProcessBaseline = await snapshotCaseOwnedProcesses(this.ownershipMarkers());
    this.tmuxBaseline = inspectTmuxSocket(this.config.tmuxSocket);
    if (this.tmuxBaseline.status !== 'PASS' || this.tmuxBaseline.server_running) {
      throw new Error(`case tmux socket is not isolated at startup: ${JSON.stringify(this.tmuxBaseline)}`);
    }
    this.assertCanContinue('server startup');
    const [serverPort, directPort, cdpPort] = this.ports;
    this.server = this.process('server', this.binaries.server, ['-server.addr', `127.0.0.1:${serverPort}`]);
    await this.server.start();
    this.assertCanContinue('server readiness');
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${serverPort}/api/project/list`);
      return response.ok;
    }, 'server API', this.options.timeoutMs);
    this.assertCanContinue('daemon startup');
    await this.startDaemon();
    this.assertCanContinue('chromium startup');
    const chromeProfile = join(this.caseTemp, 'chrome-profile');
    await mkdir(chromeProfile, { recursive: true });
    const args = [
      ...(this.options.headed ? [] : ['--headless=new']),
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeProfile}`, '--window-size=1440,1000', 'about:blank',
    ];
    this.chrome = this.process('chromium', this.chromium, args);
    await this.chrome.start();
    this.assertCanContinue('chromium CDP connection');
    this.cdp = await connectCDP(cdpPort, this.options.timeoutMs);
    this.assertCanContinue('studio navigation');
    await this.cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/studio/projects/${encodeURIComponent(this.project.id)}` });
    this.assertCanContinue('studio readiness');
    const firstAttemptTimeout = Math.min(this.options.timeoutMs, 8000);
    try {
      await this.waitForStudioReady(firstAttemptTimeout);
      this.startupEvidence.push({ attempt: 1, status: 'ready' });
    } catch (error) {
      this.startupEvidence.push({ attempt: 1, status: 'reload', error: redactSecrets(error.message) });
      await this.cdp.send('Page.reload', { ignoreCache: false });
      await this.waitForStudioReady(this.options.timeoutMs);
      this.startupEvidence.push({ attempt: 2, status: 'ready' });
    }
    const hasPanel = await evalPage(this.cdp, `Boolean(document.querySelector('[data-testid="panel-add-tab"]'))`);
    if (!hasPanel) {
      await pageClick(this.cdp, '[data-testid="empty-create-bash"]', this.options.timeoutMs);
      await waitFor(() => evalPage(this.cdp, `Boolean(document.querySelector('[data-testid="panel-add-tab"]'))`), 'initial Bash panel', this.options.timeoutMs);
    }
  }

  async waitForStudioReady(timeoutMs) {
    await waitFor(() => evalPage(this.cdp, `document.readyState === 'complete'`), 'Studio page load', timeoutMs);
    await waitFor(() => evalPage(this.cdp, `(() => {
      const workspace = document.querySelector('[data-testid="studio-workspace"]');
      if (!workspace || workspace.dataset.stateLoaded !== 'true') return false;
      return Boolean(document.querySelector('[data-testid="panel-add-tab"], [data-testid="empty-create-bash"]'));
    })()`), 'Studio workspace ready', timeoutMs);
  }

  async startDaemon() {
    this.assertCanContinue('daemon process creation');
    const [serverPort, directPort] = this.ports;
    this.daemonGeneration++;
    this.daemon = this.process(`daemon-${this.daemonGeneration}`, this.binaries.daemon, [
      '-daemon.server.url', `ws://127.0.0.1:${serverPort}/ws/daemon`,
      '-daemon.direct-web.listen', `127.0.0.1:${directPort}`,
      '-daemon.direct-web.public-host', '127.0.0.1',
      '-daemon.workspace', `conversation-e2e:Conversation E2E:${this.config.workspace}`,
    ]);
    const startedAt = Date.now();
    await this.daemon.start();
    this.assertCanContinue(`daemon generation ${this.daemonGeneration} readiness`);
    const deviceID = `pocket-e2e-${this.cell.runtime}`;
    const device = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${serverPort}/api/state`);
      if (!response.ok) return null;
      const state = await response.json();
      return state.devices?.find((candidate) => candidate.id === deviceID && candidate.status === 'online'
        && Number(candidate.last_seen_at || 0) >= Math.floor(startedAt / 1000)) || null;
    }, `daemon generation ${this.daemonGeneration} online`, this.options.timeoutMs);
    this.daemonOnline = {
      generation: this.daemonGeneration,
      pid: this.daemon.child.pid,
      started_at_ms: startedAt,
      observed_at_ms: Date.now(),
      last_seen_at: device.last_seen_at,
    };
    this.project = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${serverPort}/api/project/list`);
      if (!response.ok) return null;
      const projects = await response.json();
      return Array.isArray(projects) ? projects.find((project) => project.workspace_path === this.config.workspace) : null;
    }, 'daemon project registration', this.options.timeoutMs);
  }

  async restartDaemon() {
    const [serverPort] = this.ports;
    const oldPID = this.daemon?.child?.pid || 0;
    const oldDaemonOwnerMarker = this.processOwnerMarker(this.daemon?.name || `daemon-${this.daemonGeneration}`);
    await this.daemon.stop();
    const offlineAt = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${serverPort}/api/state`);
      if (!response.ok) return null;
      const state = await response.json();
      return state.devices?.some((device) => device.id === `pocket-e2e-${this.cell.runtime}`) ? null : Date.now();
    }, 'old daemon offline', this.options.timeoutMs);
    const detachedCleanup = await cleanupCaseOwnedProcesses(
      [oldDaemonOwnerMarker],
      [],
      [],
      { scope: 'daemon_owner' },
    );
    if (detachedCleanup.status !== 'PASS') throw new Error(`case-owned process cleanup failed during daemon restart: ${JSON.stringify(detachedCleanup)}`);
    await this.startDaemon();
    return { old_pid: oldPID, offline_at_ms: offlineAt, detached_cleanup: detachedCleanup, ...this.daemonOnline };
  }

  async archiveBrowserEpoch(label) {
    const state = await browserFrames(this.cdp);
    this.frameArchive.push(...state.frames.map((frame) => ({ ...frame, epoch: this.browserEpoch, epoch_label: label })));
    this.browserErrors.push(...state.errors.map((error) => ({ ...error, epoch: this.browserEpoch, epoch_label: label })));
    const evidence = { frame_epoch: this.browserEpoch, frame_count: state.frames.length, socket_count: state.sockets.length };
    this.browserEpoch++;
    return evidence;
  }

  async currentBrowserEvidence(sessionID = '') {
    const state = await browserFrameMetadata(this.cdp);
    const agentSockets = state.sockets.filter((socket) => {
      try {
        const url = new URL(socket.url);
        return url.pathname.endsWith('/ws/agent') && url.searchParams.get('task_id') === sessionID;
      } catch { return false; }
    });
    return {
      frame_epoch: this.browserEpoch,
      frame_count: Object.values(state.frame_counts).reduce((sum, count) => sum + count, 0),
      socket_count: state.sockets.length,
      agent_socket_count: agentSockets.length,
      agent_socket_open_count: agentSockets.filter((socket) => socket.ready_state === 1).length,
    };
  }

  async collectBrowserState() {
    const state = await browserFrames(this.cdp);
    return {
      frames: [...this.frameArchive, ...state.frames.map((frame) => ({ ...frame, epoch: this.browserEpoch, epoch_label: 'terminal' }))],
      sockets: state.sockets,
      errors: [...this.browserErrors, ...state.errors.map((error) => ({ ...error, epoch: this.browserEpoch, epoch_label: 'terminal' }))],
      href: state.href,
    };
  }

  async close() {
    this.closing = true;
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeImpl();
    return this.closePromise;
  }

  async closeImpl() {
    this.cdp?.close();
    const processes = [];
    const processLogReports = [];
    for (const managed of [...this.processes].reverse()) {
      const pid = managed.child?.pid || 0;
      let error = '';
      try { await managed.stop(); } catch (stopError) { error = redactSecrets(stopError.message); }
      const groupAlive = processGroupAlive(pid);
      const logHealth = await managed.logHealth();
      processLogReports.push(logHealth);
      processes.push({ name: managed.name, pid, status: !error && !groupAlive && logHealth.status === 'PASS' ? 'PASS' : 'FAIL', group_alive: groupAlive, error, log_health: logHealth.status });
    }
    const ports = {};
    for (const [name, port] of Object.entries({ server: this.ports[0], direct_daemon: this.ports[1], cdp: this.ports[2] })) {
      ports[name] = { port, free: await portIsFree(port) };
    }
    const tmux = await cleanupTmuxSocket(this.config.tmuxSocket, this.tmuxBaseline);
    const caseOwnedProcesses = await cleanupCaseOwnedProcesses(this.ownershipMarkers(), this.ownedProcessBaseline);
    const logHealth = summarizeManagedProcessLogs(processLogReports);
    return {
      status: processes.every((process) => process.status === 'PASS')
        && Object.values(ports).every((port) => port.free)
        && caseOwnedProcesses.status === 'PASS'
        && tmux.status === 'PASS'
        && logHealth.status === 'PASS' ? 'PASS' : 'FAIL',
      processes,
      ports,
      case_owned_processes: caseOwnedProcesses,
      tmux,
      log_health: logHealth,
    };
  }
}

function compactChatState(dom, browser, daemonGeneration) {
  return {
    working: dom.working,
    run_status: dom.run_status || '',
    session_id: dom.session_id || '',
    user_prompts: dom.user_prompts || [],
    assistant_messages: dom.assistant_messages || [],
    assistant_cards: dom.assistant_cards || [],
    assistant_count: (dom.assistant_messages || []).length,
    tools: (dom.tools || []).map((tool) => ({
      tool_id: tool.toolId || '', title: tool.toolTitle || '', kind: tool.toolKind || '', status: tool.toolStatus || '',
      text: tool.text || '', text_sha256: sha256(normalizeComparableText(tool.text || '')),
    })),
    daemon_generation: daemonGeneration,
    ...browser,
  };
}

async function collectActionState(stack, rootSelector) {
  const dom = await collectDOM(stack.cdp, rootSelector);
  return {
    ...compactChatState(
      dom,
      await stack.currentBrowserEvidence(dom.session_id || ''),
      stack.daemonGeneration,
    ),
    daemon_pid: stack.daemon?.child?.pid || 0,
    daemon_online_at_ms: stack.daemonOnline?.observed_at_ms || 0,
  };
}

async function waitForPromptHistory(cdp, rootSelector, prompts, timeoutMs) {
  const expected = prompts.map(normalizeComparableText);
  await waitFor(() => evalPage(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const prompts = [...(root?.querySelectorAll('[data-message-kind="user_prompt"]') || [])].map((node) => node.innerText.replace(/\\s+/g, ''));
    return ${JSON.stringify(expected)}.every((prompt) => prompts.includes(prompt));
  })()`), 'prompt history restored', timeoutMs);
}

async function waitForVisibleConversationHistory(cdp, rootSelector, before, timeoutMs) {
  const tools = before.tools || [];
  await waitFor(async () => {
    await expandToolGroups(cdp, rootSelector);
    const current = await collectDOM(cdp, rootSelector);
    const visibleTools = (current.tools || []).map((tool) => ({
      tool_id: tool.toolId || '',
      title: tool.toolTitle || '',
      kind: tool.toolKind || '',
      status: tool.toolStatus || '',
    }));
    return assistantHistoryContains(before.assistant_messages, current.assistant_messages)
      && toolHistoryContains(tools, visibleTools);
  }, 'assistant/tool history restored', timeoutMs);
}

async function startActiveTurn({ stack, rootSelector, prompt, turnOrdinal, mockLog }) {
  const { cdp, options } = stack;
  const baseline = await collectDOM(cdp, rootSelector);
  const baselineAssistantCount = (baseline.assistant_messages || []).length;
  const baselineToolCount = (baseline.tools || []).length;
  const mockRowOffset = options.mode === 'mock' ? (await mockRowsSince(mockLog)).length : 0;
  await sendPrompt(cdp, rootSelector, prompt, options.timeoutMs);
  const preconditions = {
    working: true,
    first_activity: false,
    mock_barrier: false,
    activity_observed_at_ms: 0,
    assistant_count_before: baselineAssistantCount,
    assistant_count_after: baselineAssistantCount,
    tool_count_before: baselineToolCount,
    tool_count_after: baselineToolCount,
  };
  let promptEvent;
  if (options.mode === 'mock') {
    const handoff = await waitFor(async () => {
      const [rows, activity, taskEvents] = await Promise.all([
        mockRowsSince(mockLog),
        evalPage(cdp, `(() => {
          const root = document.querySelector(${JSON.stringify(rootSelector)});
          return {
            working: root?.dataset.working === 'true',
            assistant_count: root?.querySelectorAll('[data-message-kind="assistant_message"]').length || 0,
            tool_count: root?.querySelectorAll('[data-testid="agent-tool-call"]').length || 0,
            observed_at_ms: Date.now(),
          };
        })()`),
        browserTaskEvents(cdp),
      ]);
      const barrier = rows.slice(mockRowOffset).some((row) => row.type === 'barrier' && row.prompt === prompt);
      const summary = summarizeTaskEvents(taskEvents);
      const observedPrompt = summary.prompt_events.findLast((candidate) => candidate.prompt === prompt);
      const progressed = activity.assistant_count > baselineAssistantCount || activity.tool_count > baselineToolCount;
      return barrier && activity.working && progressed && observedPrompt ? { promptEvent: observedPrompt, activity } : null;
    }, `mock prompt/barrier/working handoff turn ${turnOrdinal}`, options.timeoutMs, 25);
    promptEvent = handoff.promptEvent;
    preconditions.first_activity = true;
    preconditions.mock_barrier = true;
    preconditions.activity_observed_at_ms = handoff.activity.observed_at_ms;
    preconditions.assistant_count_after = handoff.activity.assistant_count;
    preconditions.tool_count_after = handoff.activity.tool_count;
  } else {
    await waitForWorking(cdp, rootSelector, true, options.timeoutMs);
    const activity = await waitForRealActivity(cdp, rootSelector, {
      assistantCount: baselineAssistantCount,
      toolCount: baselineToolCount,
    }, options.timeoutMs);
    preconditions.first_activity = true;
    preconditions.activity_observed_at_ms = activity.observed_at_ms;
    preconditions.assistant_count_after = activity.assistant_count;
    preconditions.tool_count_after = activity.tool_count;
    promptEvent = await waitFor(async () => {
      const summary = summarizeTaskEvents(await browserTaskEvents(cdp));
      return summary.prompt_events.findLast((candidate) => candidate.prompt === prompt) || null;
    }, `prompt event turn ${turnOrdinal}`, options.timeoutMs);
  }
  return {
    prompt,
    ordinal: turnOrdinal,
    task_id: promptEvent?.task_id || '',
    turn_id: promptEvent?.turn_id || '',
    baseline_assistant_count: baselineAssistantCount,
    preconditions,
  };
}

async function waitTurnCompletion(stack, rootSelector, turn) {
  if (stack.options.mode === 'mock') {
    await waitForAssistant(stack.cdp, rootSelector, promptFixture(turn.prompt).finalChunk, stack.options.timeoutMs);
    await waitForWorking(stack.cdp, rootSelector, false, stack.options.timeoutMs);
  } else {
    await waitForRealCompletion(
      stack.cdp,
      rootSelector,
      turn.baseline_assistant_count,
      stack.options.timeoutMs,
      stack.options.hardTimeoutMs,
    );
  }
  await waitForTurnTerminal(stack, turn, 'completed');
}

async function waitForTurnTerminal(stack, turn, expected) {
  return waitFor(async () => {
    const summary = summarizeTaskEvents(await browserTaskEvents(stack.cdp));
    const observed = summary.turns.find((candidate) => turn.turn_id ? candidate.turn_id === turn.turn_id : candidate.ordinal === turn.ordinal && candidate.prompt === turn.prompt);
    if (!observed) return null;
    const terminal = observed.terminal_events.find((event) => {
      if (expected === 'completed') return /^(?:task|turn)\.completed$/.test(event.event_type);
      if (/^(?:task|turn)\.(?:killed|stopped)$/.test(event.event_type)) return true;
      if (!/^(?:task|turn)\.failed$/.test(event.event_type)) return false;
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data || {};
      return /interrupt|restart|killed|stopped|user_requested/i.test(String(data.reason || data.error || ''));
    });
    return terminal || null;
  }, `${expected} terminal for turn ${turn.ordinal}`, stack.options.timeoutMs);
}

async function waitForNoError(cdp, rootSelector, timeoutMs) {
  await waitFor(() => evalPage(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    return Boolean(root && !(root.querySelector('[data-testid="agent-error"]')?.innerText.trim()));
  })()`), 'agent error cleared', timeoutMs);
}

async function waitForReloadOutcome(stack, rootSelector, turn, mode, timeoutMs) {
  return waitFor(async () => {
    const [taskEvents, taskRecords, dom] = await Promise.all([
      browserTaskEvents(stack.cdp),
      browserServerStateTasks(stack.cdp),
      collectDOM(stack.cdp, rootSelector),
    ]);
    return reloadTurnOutcome({ taskEvents, taskRecords, dom, turn, mode });
  }, 'reload restored target turn as running or fully completed', timeoutMs);
}

async function performActions({ stack, cell, rootSelector, actionEvidence, currentTurn, mockLog, executedPrompts }) {
  const { cdp, options } = stack;
  let active = true;
  let turn = currentTurn;
  for (let actionIndex = 0; actionIndex < cell.actions.length; actionIndex++) {
    const action = cell.actions[actionIndex];
    const started = Date.now();
    const actionMockOffset = options.mode === 'mock' ? (await mockRowsSince(mockLog)).length : 0;
    const evidence = {
      action,
      status: 'started',
      target_prompt: turn.prompt,
      target_turn_ordinal: turn.ordinal,
      target_turn_id: turn.turn_id,
      expected_pre_working: true,
      action_started_at_ms: started,
      before: null,
      preconditions: turn.preconditions,
    };
    actionEvidence.push(evidence);
    let before;
    try {
      before = await collectActionState(stack, rootSelector);
      evidence.before = before;
    } catch (error) {
      evidence.status = 'precondition_failed';
      evidence.error = redactSecrets(error.message);
      evidence.duration_ms = Date.now() - started;
      throw error;
    }
    if (before.working !== true) {
      evidence.status = 'precondition_failed';
      evidence.error = `action ${action} target turn ${turn.ordinal} was no longer working after active barrier`;
      evidence.duration_ms = Date.now() - started;
      throw new Error(evidence.error);
    }
    if (action === 'stop') {
      evidence.action_sent_at_ms = Date.now();
      await pageClick(cdp, `${rootSelector} [data-testid="agent-stop"]`, options.timeoutMs);
      await waitForWorking(cdp, rootSelector, false, options.timeoutMs);
      if (options.mode === 'mock' && cell.runtime !== 'direct_acp') {
        await waitFor(async () => (await mockRowsSince(mockLog)).slice(actionMockOffset).some((row) => row.type === 'cancel'), `mock cancel turn ${turn.ordinal}`, options.timeoutMs);
      }
      const terminal = await waitForTurnTerminal(stack, turn, 'interrupted');
      evidence.terminal_observed_after_action = true;
      evidence.terminal_event_id = terminal.event_id || '';
      active = false;
    } else if (action === 'reload') {
      evidence.action_sent_at_ms = Date.now();
      await stack.archiveBrowserEpoch(`before-${cell.scenario}-${action}`);
      await cdp.send('Page.reload', { ignoreCache: false });
      await waitFor(() => evalPage(cdp, `document.readyState === 'complete'`), 'page reload', options.timeoutMs);
      await waitFor(() => evalPage(cdp, `Boolean(document.querySelector(${JSON.stringify(rootSelector)}))`), 'chat restored after reload', options.timeoutMs);
      await waitForPromptHistory(cdp, rootSelector, before.user_prompts, options.timeoutMs);
      await waitForVisibleConversationHistory(cdp, rootSelector, before, options.timeoutMs);
      const reloadOutcome = await waitForReloadOutcome(stack, rootSelector, turn, options.mode, options.timeoutMs);
      if (reloadOutcome === 'failed') throw new Error(`reload target turn failed: ${turn.prompt}`);
      evidence.reload_outcome = reloadOutcome;
      active = reloadOutcome === 'running';
    } else if (action === 'restart') {
      evidence.action_sent_at_ms = Date.now();
      evidence.restart_readiness = await stack.restartDaemon();
      active = false;
      await waitForPromptHistory(cdp, rootSelector, before.user_prompts, options.timeoutMs);
      await waitForWorking(cdp, rootSelector, false, options.timeoutMs);
      await waitForTurnTerminal(stack, turn, 'interrupted');
    }
    evidence.after = await collectActionState(stack, rootSelector);
    evidence.status = 'observed';
    evidence.duration_ms = Date.now() - started;
    if (actionIndex < cell.actions.length - 1) {
      if (active) {
        await waitTurnCompletion(stack, rootSelector, turn);
        active = false;
      }
      const nextTurnOrdinal = actionIndex + 1;
      const nextPrompt = cell.prompt_sequence[nextTurnOrdinal];
      executedPrompts.push(nextPrompt);
      turn = await startActiveTurn({
        stack,
        rootSelector,
        prompt: nextPrompt,
        turnOrdinal: nextTurnOrdinal,
        mockLog,
      });
      active = true;
    }
  }
  return { working: active, turn };
}

async function waitForRealActivity(cdp, rootSelector, baseline, timeoutMs) {
  return waitFor(() => evalPage(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root || root.dataset.working !== 'true') return false;
    const assistants = root.querySelectorAll('[data-message-kind="assistant_message"]').length;
    const tools = root.querySelectorAll('[data-testid="agent-tool-call"]').length;
    if (assistants <= ${baseline.assistantCount} && tools <= ${baseline.toolCount}) return false;
    return { assistant_count: assistants, tool_count: tools, observed_at_ms: Date.now() };
  })()`), 'real assistant/tool activity', timeoutMs);
}

async function waitForRealCompletion(cdp, rootSelector, baselineAssistantCount, idleTimeoutMs, hardTimeoutMs) {
  await waitForProgressCompletion({
    idleTimeoutMs,
    hardTimeoutMs,
    sample: () => evalPage(cdp, `(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)});
      if (!root) return { missing: true, working: true, error: '', assistants: [], tools: [], protocol_revision: 0 };
      return {
        missing: false,
        working: root.dataset.working === 'true',
        error: root.querySelector('[data-testid="agent-error"]')?.innerText.trim() || '',
        assistants: [...root.querySelectorAll('[data-message-kind="assistant_message"]')].map((node) => ({
          id: node.dataset.messageId || '', text: node.innerText,
        })),
        tools: [...root.querySelectorAll('[data-testid="agent-tool-call"]')].map((node) => ({
          id: node.dataset.toolId || '', status: node.dataset.toolStatus || '', text: node.innerText,
        })),
        protocol_revision: window.__POCKET_E2E__?.protocol_revision || 0,
      };
    })()`),
    isComplete: (observed) => observed.working === false && observed.assistants.length > baselineAssistantCount,
    signature: realTurnProgressSignature,
  });
}

async function cleanupAgentSession(stack, rootSelector, sessionID, mockLog) {
  if (!rootSelector || !sessionID) return { status: 'PASS', skipped: true, reason: 'session was not created' };
  const mockOffset = stack.options.mode === 'mock' ? (await mockRowsSince(mockLog)).length : 0;
  const startedAt = Date.now();
  let mockClose = { required: false, observed: false, type: '' };
  try {
    await pageClick(stack.cdp, '[data-testid="active-tab-close"]', stack.options.timeoutMs);
    await waitFor(() => evalPage(stack.cdp, `!document.querySelector(${JSON.stringify(rootSelector)})`), 'agent tab closed', stack.options.timeoutMs);
    if (stack.options.mode === 'mock') {
      const expectedType = stack.cell.runtime === 'acpx' ? 'sessions.close' : 'close';
      mockClose = { required: true, observed: false, type: expectedType };
      await waitFor(async () => (await mockRowsSince(mockLog)).slice(mockOffset).some((row) => row.type === expectedType), `mock ${expectedType}`, stack.options.timeoutMs);
      mockClose.observed = true;
    }
    const [serverPort] = stack.ports;
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${serverPort}/api/state`);
      if (!response.ok) return false;
      const state = await response.json();
      return !state.tasks?.some((task) => task.task_id === sessionID);
    }, 'deleted task absent from server state', stack.options.timeoutMs);
    return { status: 'PASS', skipped: false, session_id: sessionID, duration_ms: Date.now() - startedAt, ui_close: true, backend_absent: true, mock_close: mockClose };
  } catch (error) {
    return { status: 'FAIL', skipped: false, session_id: sessionID, duration_ms: Date.now() - startedAt, error: redactSecrets(error.message) };
  }
}

async function runCell({ options, cell, runTemp, runDir, preflightResult, qualificationReport, index, total }) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const caseDir = join(runDir, 'cases', cell.id);
  const caseTemp = join(runTemp, 'cases', cell.id);
  const mockLog = join(caseDir, 'mock.jsonl');
  await Promise.all([secureMkdir(caseDir), secureMkdir(caseTemp)]);
  const ports = options.portBase === null ? await freePorts(3) : fixedCasePorts(options.portBase, index);
  if (options.portBase !== null) await assertPortsAvailable(ports, portIsFree, `fixed ports for ${cell.id}`);
  const config = await makeCaseConfig({ options, cell, caseTemp, ports, mockLog, qualificationReport });
  const stack = new CaseStack({ options, cell, caseTemp, caseDir, ports, binaries: preflightResult.binaries, chromium: preflightResult.chromium, config });
  const actionEvidence = [];
  const executedPrompts = [];
  let executedRecoveryTurnOrdinal = cell.actions.length ? null : 0;
  const screenshots = [];
  let rootSelector = '';
  let failure = null;
  let executionStage = 'startup';
  let dom = { working: true, error: 'case did not reach DOM collection', assistant_messages: [] };
  let frameState = { frames: [], sockets: [], errors: [] };
  let cleanupEvidence = { status: 'FAIL', processes: [], ports: {} };
  let sessionCleanup = { status: 'PASS', skipped: true };
  let workspaceViolations = [];
  console.log(`[${index + 1}/${total}] ${cell.id}`);
  activeStacks.add(stack);
  try {
    await stack.start();
    executionStage = 'open_chat';
    rootSelector = await openChat(stack.cdp, cell, options.timeoutMs);
    await screenshot(stack.cdp, join(caseDir, '00-ready.png'));
    screenshots.push('00-ready.png');
    executionStage = 'primary_prompt';
    executedPrompts.push(cell.prompt);
    const primaryTurn = await startActiveTurn({ stack, rootSelector, prompt: cell.prompt, turnOrdinal: 0, mockLog });
    await screenshot(stack.cdp, join(caseDir, '01-active-reply.png'));
    screenshots.push('01-active-reply.png');

    if (cell.actions.length === 0) {
      executionStage = 'primary_completion';
      await waitTurnCompletion(stack, rootSelector, primaryTurn);
    } else {
      executionStage = 'destructive_actions';
      const actionState = await performActions({ stack, cell, rootSelector, actionEvidence, currentTurn: primaryTurn, mockLog, executedPrompts });
      if (actionState.working) {
        executionStage = 'action_turn_completion';
        await waitTurnCompletion(stack, rootSelector, actionState.turn);
      }
      executionStage = 'recovery_turn';
      const recoveryOrdinal = actionState.turn.ordinal + 1;
      const recoveryPrompt = followUpPrompt(actionState.turn.prompt);
      executedPrompts.push(recoveryPrompt);
      executedRecoveryTurnOrdinal = recoveryOrdinal;
      const recoveryTurn = await startActiveTurn({
        stack,
        rootSelector,
        prompt: recoveryPrompt,
        turnOrdinal: recoveryOrdinal,
        mockLog,
      });
      await waitTurnCompletion(stack, rootSelector, recoveryTurn);
    }
    await waitForNoError(stack.cdp, rootSelector, options.timeoutMs);
    executionStage = 'terminal_capture';
    await screenshot(stack.cdp, join(caseDir, '02-terminal.png'));
    screenshots.push('02-terminal.png');
  } catch (error) {
    failure = redactSecrets(error.stack || error.message);
    if (stack.cdp) {
      try {
        await screenshot(stack.cdp, join(caseDir, '99-failure.png'));
        screenshots.push('99-failure.png');
      } catch {}
    }
  } finally {
    const recordFinalizationError = (stage, error) => {
      const message = `${stage}: ${redactSecrets(error?.stack || error?.message || String(error))}`;
      failure = failure ? `${failure}\n${message}` : message;
      if (executionStage === 'terminal_capture' || !executionStage) executionStage = stage;
    };
    try {
      if (stack.cdp && rootSelector) {
        try { dom = await collectDOM(stack.cdp, rootSelector); }
        catch (error) {
          dom = { working: true, error: redactSecrets(error.message), assistant_messages: [] };
          recordFinalizationError('dom_capture', error);
        }
        try { sessionCleanup = await cleanupAgentSession(stack, rootSelector, dom.session_id || '', mockLog); }
        catch (error) {
          sessionCleanup = { status: 'FAIL', skipped: false, error: redactSecrets(error.message) };
          recordFinalizationError('session_cleanup', error);
        }
      }
      if (stack.cdp) {
        try { frameState = await stack.collectBrowserState(); }
        catch (error) { recordFinalizationError('browser_capture', error); }
      }
      workspaceViolations = frameTaskWorkspaceViolations(frameState.frames, config.workspace);
      try {
        await writeArtifactJSONL(join(caseDir, 'websocket.jsonl'), frameState.frames);
      } catch (error) { recordFinalizationError('websocket_artifact', error); }
      try {
        await writeArtifactJSON(join(caseDir, 'browser.json'), { href: frameState.href || '', errors: frameState.errors || [], cdp_events: stack.cdp?.events.slice(-200) || [] });
      } catch (error) { recordFinalizationError('browser_artifact', error); }
    } finally {
      try { cleanupEvidence = await stack.close(); }
      catch (error) {
        cleanupEvidence = { status: 'FAIL', processes: [], ports: {}, error: redactSecrets(error.message) };
        recordFinalizationError('process_cleanup', error);
      } finally {
        activeStacks.delete(stack);
      }
      cleanupEvidence.session = sessionCleanup;
      if (sessionCleanup.status !== 'PASS') cleanupEvidence.status = 'FAIL';
    }
  }

  const mockRows = await mockRowsSince(mockLog);
  const taskEvents = taskEventsFromFrames(frameState.frames);
  const actualTurnPlan = {
    prompts: executedPrompts,
    action_turn_ordinals: actionEvidence.map((evidence) => evidence.target_turn_ordinal),
    recovery_turn_ordinal: executedRecoveryTurnOrdinal,
  };
  const executedCell = {
    ...cell,
    actual_turn_plan: actualTurnPlan,
  };
  let oracle;
  try {
    oracle = evaluateCell({ cell: executedCell, mode: options.mode, dom, taskEvents, mockRows, actionEvidence });
  } catch (error) {
    const oracleMessage = redactSecrets(error.stack || error.message);
    failure = failure ? `${failure}\noracle_evaluation: ${oracleMessage}` : `oracle_evaluation: ${oracleMessage}`;
    executionStage = 'oracle_evaluation';
    oracle = {
      status: 'FAIL',
      checks: [{ name: 'oracle_evaluation', pass: false, actual: oracleMessage, expected: 'evaluator returns checks without throwing' }],
      observed: {
        prompt_counts: {}, dom_prompt_counts: {}, mock_prompt_counts: {}, assistant_text: '',
        tool_events: [], terminal_event_types: [], turns: [], dom,
      },
    };
  }
  oracle.checks.push({
    name: 'task_workspace_isolation',
    pass: workspaceViolations.length === 0,
    actual: workspaceViolations,
    expected: 'every task record observed in browser frames belongs to the current isolated case workspace',
  });
  if (workspaceViolations.length > 0) oracle.status = 'FAIL';
  const failureClassification = failure && ['startup', 'open_chat'].includes(executionStage) ? 'startup' : failure ? 'execution' : null;
  if (failure) {
    oracle.status = 'FAIL';
    const failureCheck = { name: failureClassification, pass: false, actual: failure, expected: `no ${failureClassification} exception` };
    if (failureClassification === 'startup') oracle.checks = [failureCheck];
    else oracle.checks.unshift(failureCheck);
  }
  oracle.checks.push({ name: 'managed_process_log_health', pass: cleanupEvidence.log_health?.status === 'PASS', actual: cleanupEvidence.log_health, expected: 'no panic, fatal, uncaught, or process errors in managed process logs' });
  oracle.checks.push({ name: 'isolated_process_cleanup', pass: cleanupEvidence.status === 'PASS', actual: cleanupEvidence, expected: 'all process groups stopped, logs healthy, ports free, and the case tmux socket removed' });
  if (cleanupEvidence.status !== 'PASS') oracle.status = 'FAIL';
  const result = {
    schema_version: SCHEMA_VERSION,
    id: cell.id,
    mode: options.mode,
    runtime: cell.runtime,
    agent: cell.agent,
    scenario: cell.scenario,
    prompt: cell.prompt,
    follow_up_prompt: cell.follow_up_prompt,
    actions: cell.actions,
    turn_plan: actualTurnPlan,
    action_evidence: actionEvidence,
    startup_evidence: stack.startupEvidence,
    failure: failure ? { classification: failureClassification, stage: executionStage, message: failure } : null,
    status: oracle.status,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    ports: { server: ports[0], direct_daemon: ports[1], cdp: ports[2] },
    isolation: {
      config: true,
      workspace: workspaceViolations.length === 0,
      workspace_violations: workspaceViolations,
      browser_profile: true,
      process_groups: cleanupEvidence.status === 'PASS',
    },
    cleanup: cleanupEvidence,
    oracle,
    artifacts: {
      websocket: 'websocket.jsonl', browser: 'browser.json', lifecycle: 'processes.jsonl', mock: 'mock.jsonl',
      screenshots,
    },
  };
  await writeArtifactJSON(join(caseDir, 'result.json'), result);
  console.log(`  ${result.status} ${result.duration_ms}ms${failure ? `: ${failure.split('\n')[0]}` : ''}`);
  return result;
}

async function listFiles(path, base = path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(full, base));
    else result.push({ full, relative: full.slice(base.length + 1) });
  }
  return result;
}

async function artifactSecretScan(runDir) {
  const findings = [];
  const textExtensions = new Set(['.json', '.jsonl', '.log', '.md', '.txt']);
  for (const file of await listFiles(runDir)) {
    const extension = file.relative.includes('.') ? `.${file.relative.split('.').at(-1)}` : '';
    if (!textExtensions.has(extension)) continue;
    const text = await readFile(file.full, 'utf8');
    const matches = findSecrets(text);
    if (matches.length) {
      let sanitized = redactSecrets(text);
      if (findSecrets(sanitized).length) sanitized = '[REDACTED_ARTIFACT_DUE_TO_SECRET_SCAN]\n';
      await writeFile(file.full, sanitized, { mode: 0o600 });
      findings.push({ file: file.relative, patterns: matches, sanitized: true });
    }
  }
  return { status: findings.length ? 'FAIL' : 'PASS', findings };
}

async function artifactPermissionAudit(runDir) {
  const findings = [];
  async function walk(path, relative = '') {
    const info = await stat(path);
    const mode = info.mode & 0o777;
    if (info.isDirectory()) {
      if ((mode & 0o077) !== 0) findings.push({ path: relative || '.', type: 'directory', mode: mode.toString(8), expected: '700' });
      for (const entry of await readdir(path, { withFileTypes: true })) await walk(join(path, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
    } else if ((mode & 0o077) !== 0) {
      findings.push({ path: relative, type: 'file', mode: mode.toString(8), expected: '600' });
    }
  }
  await walk(runDir);
  return { status: findings.length ? 'FAIL' : 'PASS', findings };
}

async function writeManifest(runDir) {
  const files = await listFiles(runDir);
  const entries = [];
  for (const file of files) {
    if (file.relative === 'manifest.json') continue;
    const info = await stat(file.full);
    entries.push({ path: file.relative, size: info.size, sha256: await sha256File(file.full) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = { schema_version: SCHEMA_VERSION, generated_at: new Date().toISOString(), files: entries };
  await writeArtifactJSON(join(runDir, 'manifest.json'), manifest);
  return manifest;
}

async function writeReadme(path) {
  await writeFile(path, `# Conversation E2E artifacts

Generated by \`node scripts/conversation-e2e.mjs\`.

- \`report.json\`: matrix-level status and cell summaries.
- \`manifest.json\`: SHA-256 and size for every artifact.
- \`secret-scan.json\`: artifact credential scan result.
- \`cases/*/result.json\`: per-cell oracle and observations.
- \`cases/*/websocket.jsonl\`: browser-observed WebSocket traffic, redacted.
- \`cases/*/processes.jsonl\`: supervised process lifecycle.
- \`cases/*/mock.jsonl\`: deterministic protocol barrier/prompt evidence in mock mode.
- \`cases/*/*.png\`: UI state screenshots.
`, { mode: 0o600 });
}

function promptCoverage(results, matrix) {
  const byKey = {};
  for (const cell of matrix) {
    const key = `${cell.runtime}/${cell.agent}/${cell.scenario}`;
    byKey[key] ||= { expected: 0, event_observed: 0, mock_observed: 0 };
    byKey[key].expected += cell.prompt_sequence.length;
  }
  for (const result of results) {
    const key = `${result.runtime}/${result.agent}/${result.scenario}`;
    byKey[key] ||= { expected: 0, event_observed: 0, mock_observed: 0 };
    byKey[key].event_observed += Object.values(result.oracle.observed.prompt_counts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
    byKey[key].mock_observed += Object.values(result.oracle.observed.mock_prompt_counts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
  }
  return {
    prompt_dispatches_expected: Object.values(byKey).reduce((sum, item) => sum + item.expected, 0),
    prompt_dispatches_event_observed: Object.values(byKey).reduce((sum, item) => sum + item.event_observed, 0),
    prompt_dispatches_mock_observed: Object.values(byKey).reduce((sum, item) => sum + item.mock_observed, 0),
    by_runtime_agent_scenario: byKey,
  };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n\n${usage()}`); process.exitCode = 2; return; }
  if (options.help) { console.log(usage()); return; }

  const runID = `${options.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const tempRoot = await mkdtemp(join(tmpdir(), `pocket-conversation-e2e-${runID}-`));
  activeTempRoots.add(tempRoot);
  const runDir = join(options.artifactDir, 'runs', runID);
  await secureMkdir(runDir);
  let overallStatus = 'FAIL';
  let report = null;
  let pairs = [];
  let qualificationPlan = null;
  let qualificationReport = null;
  let plannedMatrix = [];
  let selectedPlan = { pairs: 0, cells: 0, expected_prompt_dispatches: 0 };
  let preflightResult = null;
  let fixedPortPlan = null;
  const completedResults = [];
  try {
    console.log(`preflight: mode=${options.mode} build=${options.build} temp=${tempRoot}`);
    const plans = await loadRuntimeAgentPlans(options);
    qualificationReport = plans.report;
    pairs = plans.selectedPairs;
    qualificationPlan = plans.qualificationPlan;
    plannedMatrix = makePairMatrix({ pairs, scenarios: options.scenarios, prompts: options.prompts });
    if (new Set(plannedMatrix.map((cell) => cell.id)).size !== plannedMatrix.length) throw new Error('planned matrix contains duplicate cell ids');
    selectedPlan = summarizeMatrixPlan(plannedMatrix);
    if (options.portBase !== null) {
      fixedPortPlan = validateFixedPortPlan(options.portBase, plannedMatrix.length);
      const plannedPorts = Array.from({ length: fixedPortPlan.total_ports }, (_, offset) => options.portBase + offset);
      await assertPortsAvailable(plannedPorts, portIsFree, 'fixed matrix port plan');
    }
    preflightResult = await preflight(options, tempRoot);
    preflightResult.runtime_agent_pairs = pairs;
    preflightResult.capability_report = options.capabilityReport;
    preflightResult.qualification_plan = qualificationPlan;
    preflightResult.selected_plan = selectedPlan;
    preflightResult.fixed_port_plan = fixedPortPlan;
    preflightResult.planned = { pairs: selectedPlan.pairs, cells: selectedPlan.cells, prompt_dispatches: selectedPlan.expected_prompt_dispatches };
    await writeArtifactJSON(join(runDir, 'preflight.json'), preflightResult);
    if (options.preflightOnly) {
      report = { schema_version: SCHEMA_VERSION, run_id: runID, mode: options.mode, status: 'PASS', preflight: preflightResult, qualification_plan: qualificationPlan, selected_plan: selectedPlan, fixed_port_plan: fixedPortPlan, runtime_agent_pairs: pairs, summary: { total: 0, passed: 0, failed: 0, planned_pairs: selectedPlan.pairs, planned_cells: selectedPlan.cells, prompt_dispatches_expected: selectedPlan.expected_prompt_dispatches }, cells: [], failures: [] };
      overallStatus = 'PASS';
    } else {
      const matrix = plannedMatrix;
      await writeArtifactJSON(join(runDir, 'matrix.json'), {
        schema_version: SCHEMA_VERSION,
        mode: options.mode,
        exact_prompts: EXACT_PROMPTS,
        scenario_definitions: SCENARIOS,
        qualification_plan: qualificationPlan,
        selected_plan: selectedPlan,
        fixed_port_plan: fixedPortPlan,
        runtime_agent_pairs: pairs,
        cells: matrix,
      });
      const results = completedResults;
      for (let index = 0; index < matrix.length; index++) {
        assertNotInterrupted(`before cell ${index + 1}`);
        results.push(await runCell({ options, cell: matrix[index], runTemp: tempRoot, runDir, preflightResult, qualificationReport, index, total: matrix.length }));
        assertNotInterrupted(`after cell ${index + 1}`);
      }
      const failures = results.filter((result) => result.status !== 'PASS');
      overallStatus = failures.length ? 'FAIL' : 'PASS';
      const prompts = promptCoverage(results, matrix);
      const progress = summarizeResultProgress(results);
      report = {
        schema_version: SCHEMA_VERSION,
        run_id: runID,
        generated_at: new Date().toISOString(),
        mode: options.mode,
        status: overallStatus,
        exact_prompts: EXACT_PROMPTS,
        runtimes: options.runtimes,
        scenarios: options.scenarios,
        agent: options.agent,
        qualification_plan: qualificationPlan,
        selected_plan: selectedPlan,
        fixed_port_plan: fixedPortPlan,
        runtime_agent_pairs: pairs,
        summary: { ...progress, planned_pairs: selectedPlan.pairs, planned_cells: selectedPlan.cells, ...prompts },
        preflight: { status: preflightResult.status, build: preflightResult.build, checks: preflightResult.checks },
        cells: results.map((result) => ({ id: result.id, runtime: result.runtime, agent: result.agent, scenario: result.scenario, prompt: result.prompt, status: result.status, duration_ms: result.duration_ms, failure_classification: result.failure?.classification || null, result: `cases/${result.id}/result.json` })),
        failures: failures.map((result) => ({ id: result.id, classification: result.failure?.classification || 'oracle', stage: result.failure?.stage || null, failed_checks: result.oracle.checks.filter((check) => !check.pass).map((check) => check.name) })),
      };
    }
    await writeReadme(join(runDir, 'README.md'));
    await writeArtifactJSON(join(runDir, 'report.json'), report);
    const secretScan = await artifactSecretScan(runDir);
    if (secretScan.status !== 'PASS') overallStatus = 'FAIL';
    report.status = overallStatus;
    report.secret_scan = secretScan;
    report.summary.artifact_security_failed = secretScan.status !== 'PASS';
    if (secretScan.status !== 'PASS') {
      report.failures.push({ id: 'artifact-secret-scan', classification: 'security', stage: 'artifact_scan', failed_checks: secretScan.findings.map((finding) => `${finding.file}:${finding.patterns.join(',')}`) });
    }
    await writeArtifactJSON(join(runDir, 'secret-scan.json'), secretScan);
    await writeArtifactJSON(join(runDir, 'report.json'), report);
    const permissionAudit = await artifactPermissionAudit(runDir);
    if (permissionAudit.status !== 'PASS') overallStatus = 'FAIL';
    report.status = overallStatus;
    report.permission_audit = permissionAudit;
    report.summary.artifact_permissions_failed = permissionAudit.status !== 'PASS';
    if (permissionAudit.status !== 'PASS') {
      report.failures.push({ id: 'artifact-permission-audit', classification: 'security', stage: 'artifact_permissions', failed_checks: permissionAudit.findings.map((finding) => `${finding.path}:${finding.mode}`) });
    }
    await writeArtifactJSON(join(runDir, 'permission-audit.json'), permissionAudit);
    await writeArtifactJSON(join(runDir, 'report.json'), report);
    const manifest = await writeManifest(runDir);
    await cp(join(runDir, 'report.json'), join(options.artifactDir, 'report.json'));
    await cp(join(runDir, 'manifest.json'), join(options.artifactDir, 'manifest.json'));
    await cp(join(runDir, 'secret-scan.json'), join(options.artifactDir, 'secret-scan.json'));
    await writeArtifactJSON(join(options.artifactDir, 'latest.json'), { schema_version: SCHEMA_VERSION, run_id: runID, run_dir: `runs/${runID}`, status: overallStatus, manifest_files: manifest.files.length });
    console.log(`conversation E2E ${overallStatus}: ${runDir}`);
  } catch (error) {
    overallStatus = 'FAIL';
    const fatalMessage = redactSecrets(error.stack || error.message);
    console.error(fatalMessage);
    const fatal = { status: 'FAIL', classification: 'fatal', error: fatalMessage, at: new Date().toISOString() };
    await writeArtifactJSON(join(runDir, 'fatal.json'), fatal).catch(() => {});
    const completedFailures = completedResults.filter((result) => result.status !== 'PASS');
    const hadReport = Boolean(report);
    report ||= {
      schema_version: SCHEMA_VERSION,
      run_id: runID,
      generated_at: new Date().toISOString(),
      mode: options.mode,
      exact_prompts: EXACT_PROMPTS,
      runtimes: options.runtimes,
      scenarios: options.scenarios,
      agent: options.agent,
      qualification_plan: qualificationPlan,
      selected_plan: selectedPlan,
      fixed_port_plan: fixedPortPlan,
      runtime_agent_pairs: pairs,
      summary: {
        ...summarizeResultProgress(completedResults, { includeHarnessFatal: true }),
        planned_pairs: selectedPlan.pairs,
        planned_cells: selectedPlan.cells,
        ...promptCoverage(completedResults, plannedMatrix),
      },
      preflight: preflightResult ? { status: preflightResult.status, build: preflightResult.build, checks: preflightResult.checks } : null,
      cells: completedResults.map((result) => ({ id: result.id, runtime: result.runtime, agent: result.agent, scenario: result.scenario, prompt: result.prompt, status: result.status, duration_ms: result.duration_ms, failure_classification: result.failure?.classification || null, result: `cases/${result.id}/result.json` })),
      failures: completedFailures.map((result) => ({ id: result.id, classification: result.failure?.classification || 'oracle', stage: result.failure?.stage || null, failed_checks: result.oracle.checks.filter((check) => !check.pass).map((check) => check.name) })),
    };
    report.status = 'FAIL';
    report.summary ||= summarizeResultProgress(completedResults, { includeHarnessFatal: true });
    if (hadReport) {
      report.summary.total = Number(report.summary.total || 0) + 1;
      report.summary.failed = Number(report.summary.failed || 0) + 1;
      report.summary.completed_cells = completedResults.length;
      report.summary.harness_fatal_failures = Number(report.summary.harness_fatal_failures || 0) + 1;
    }
    report.failures ||= [];
    report.failures.push({ id: 'harness-fatal', classification: 'fatal', stage: 'harness', failed_checks: [fatalMessage] });
    const secretScan = await artifactSecretScan(runDir).catch((scanError) => ({ status: 'FAIL', findings: [{ file: '.', patterns: ['scan_error'], error: redactSecrets(scanError.message) }] }));
    report.secret_scan = secretScan;
    await writeArtifactJSON(join(runDir, 'secret-scan.json'), secretScan).catch(() => {});
    await writeArtifactJSON(join(runDir, 'report.json'), report).catch(() => {});
    const manifest = await writeManifest(runDir).catch(() => ({ files: [] }));
    await secureMkdir(options.artifactDir).catch(() => {});
    await cp(join(runDir, 'report.json'), join(options.artifactDir, 'report.json')).catch(() => {});
    await cp(join(runDir, 'manifest.json'), join(options.artifactDir, 'manifest.json')).catch(() => {});
    await cp(join(runDir, 'secret-scan.json'), join(options.artifactDir, 'secret-scan.json')).catch(() => {});
    await writeArtifactJSON(join(options.artifactDir, 'latest.json'), { schema_version: SCHEMA_VERSION, run_id: runID, run_dir: `runs/${runID}`, status: 'FAIL', fatal: true, manifest_files: manifest.files.length }).catch(() => {});
  } finally {
    await closeActiveCommandGroups();
    await closeActiveStacks();
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true });
    else console.log(`kept temp runtime: ${tempRoot}`);
    activeTempRoots.delete(tempRoot);
  }
  if (overallStatus !== 'PASS' && !signalCleanupStarted) process.exitCode = 1;
}

await main();
