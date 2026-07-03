#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const serverPort = Number(process.env.POCKET_STUDIO_E2E_SERVER_PORT || 20180 + Math.floor(Math.random() * 500));
const directPort = Number(process.env.POCKET_STUDIO_E2E_DIRECT_PORT || serverPort + 1000);
const cdpPort = Number(process.env.POCKET_STUDIO_E2E_CDP_PORT || serverPort + 2000);
const chromiumBin = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
const workspace = await mkdtemp(join(tmpdir(), 'remote-agent-browser-direct-ws-'));
const configDir = await mkdtemp(join(tmpdir(), 'remote-agent-browser-direct-config-'));
const chromeProfile = await mkdtemp(join(tmpdir(), 'remote-agent-browser-direct-chrome-'));
const logs = [];

function start(name, cmd, args, extraEnv = {}) {
  const proc = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(`[${name} stdout] ${d}`));
  proc.stderr.on('data', (d) => logs.push(`[${name} stderr] ${d}`));
  proc.on('exit', (code, signal) => logs.push(`[${name} exit] code=${code} signal=${signal}`));
  return proc;
}

async function waitFor(fn, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} timed out${lastErr ? `: ${lastErr.message}` : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJSON(path) {
  const res = await fetch(`http://127.0.0.1:${serverPort}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function postJSON(path, body) {
  const res = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener('message', async (event) => {
      const text = typeof event.data === 'string'
        ? event.data
        : event.data instanceof Blob
          ? await event.data.text()
          : Buffer.from(event.data).toString('utf8');
      const msg = JSON.parse(text);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp websocket timeout')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp websocket error')); }, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function newPageCDP() {
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    return res.ok;
  }, 'chromium cdp');
  const newRes = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
  const target = await newRes.json();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable').catch(() => {});
  return cdp;
}

async function evalExpr(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

function pageScript(projectId, serverPortValue, directPortValue) {
  return `
(async () => {
  window.__wsUrls = [];
  window.__wsEvents = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, label, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(label + ' timed out');
  };
  const directButton = await waitFor(() => [...document.querySelectorAll('button')].find((button) => (button.title || '').includes('终端 WebSocket') || (button.title || '').includes('直连终端') || /中转|直连|保存中/.test(button.innerText)), 'direct mode button');
  directButton.click();
  await waitFor(async () => {
    const res = await fetch('/api/project/list');
    const projects = await res.json();
    const project = Array.isArray(projects) ? projects.find((item) => item.id === ${JSON.stringify(projectId)}) : null;
    return project && project.direct_mode && project.direct_endpoint && project.direct_endpoint.terminal_ws_url;
  }, 'direct mode enabled');
  await sleep(300);
  window.__wsUrls = [];
  window.__wsEvents = [];
  const terminalButton = await waitFor(() => [...document.querySelectorAll('button')].find((button) => button.innerText.includes('普通终端') || button.innerText.includes('打开 Bash 终端')), 'terminal create button');
  terminalButton.click();
  await waitFor(() => window.__wsUrls.some((url) => url.includes('/ws/terminal') && url.includes(String(${directPortValue}))), 'direct terminal websocket');
  await sleep(800);
  document.querySelector('.xterm-helper-textarea')?.focus();
  const terminalUrls = window.__wsUrls.filter((url) => url.includes('/ws/terminal'));
  const activeTerminalUrls = [...(window.__activeWsUrls || [])].filter((url) => url.includes('/ws/terminal'));
  const wsEvents = window.__wsEvents || [];
  const terminalEvents = wsEvents.filter((event) => event.url && event.url.includes('/ws/terminal'));
  return {
    ok: true,
    projectId: ${JSON.stringify(projectId)},
    serverPort: ${serverPortValue},
    directPort: ${directPortValue},
    terminalUrls,
    activeTerminalUrls,
    hasDirectTerminalURL: terminalUrls.some((url) => url.includes(':' + ${JSON.stringify(String(directPortValue))} + '/ws/terminal')),
    hasServerTerminalURL: terminalUrls.some((url) => url.includes(':' + ${JSON.stringify(String(serverPortValue))} + '/ws/terminal')),
    activeDirectTerminalCount: activeTerminalUrls.filter((url) => url.includes(':' + ${JSON.stringify(String(directPortValue))} + '/ws/terminal')).length,
    activeServerTerminalCount: activeTerminalUrls.filter((url) => url.includes(':' + ${JSON.stringify(String(serverPortValue))} + '/ws/terminal')).length,
    hasServerTerminalEvent: terminalEvents.some((event) => event.url.includes(':' + ${JSON.stringify(String(serverPortValue))} + '/ws/terminal')),
    serverTerminalEvents: terminalEvents.filter((event) => event.url.includes(':' + ${JSON.stringify(String(serverPortValue))} + '/ws/terminal')),
    terminalEvents,
    wsEvents: wsEvents.slice(-40),
    bodyText: document.body.innerText.slice(0, 1000),
  };
})()`;
}

let server;
let daemon;
let chrome;
let cdp;
try {
  const env = { POCKET_STUDIO_CONFIG_DIR: configDir };
  server = start('server', './dist/pocket-studio-server-bin', ['-server.addr', `127.0.0.1:${serverPort}`], env);
  daemon = start('daemon', './dist/pocket-studio-daemon-bin', [
    '-daemon.server.url', `ws://127.0.0.1:${serverPort}/ws/daemon`,
    '-daemon.direct-web.listen', `127.0.0.1:${directPort}`,
    '-daemon.direct-web.public-host', '127.0.0.1',
    '-daemon.workspace', `browser-direct-e2e:Browser Direct E2E:${workspace}`,
  ], env);

  const project = await waitFor(async () => {
    const list = await getJSON('/api/project/list');
    return Array.isArray(list) && list.find((item) => item.workspace_path === workspace);
  }, 'project appears');
  const projectId = project.id;
  await postJSON('/api/project/direct-mode', { project_id: projectId, direct_mode: false });

  chrome = start('chromium', chromiumBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    'about:blank',
  ]);
  cdp = await newPageCDP();
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__wsUrls=[]; window.__wsEvents=[]; window.__activeWsUrls=new Set(); const __OriginalWebSocket=window.WebSocket; window.WebSocket=new Proxy(__OriginalWebSocket,{construct(target,args){const url=String(args[0]); window.__wsUrls.push(url); window.__wsEvents.push({type:'construct',url,at:Date.now()}); const ws=new target(...args); const originalSend=ws.send.bind(ws); ws.send=(data)=>{window.__wsEvents.push({type:'send',url,at:Date.now(),dataType:typeof data,data:typeof data==='string'?data.slice(0,120):undefined}); return originalSend(data);}; ws.addEventListener('open',()=>{window.__activeWsUrls.add(url); window.__wsEvents.push({type:'open',url,at:Date.now()});}); const markClosed=()=>{window.__activeWsUrls.delete(url); window.__wsEvents.push({type:'close',url,at:Date.now()});}; ws.addEventListener('close',markClosed); ws.addEventListener('error',()=>window.__wsEvents.push({type:'error',url,at:Date.now()})); return ws;}});`,
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/studio/projects/${encodeURIComponent(projectId)}` });
  const result = await evalExpr(cdp, pageScript(projectId, serverPort, directPort));
  if (!result.hasDirectTerminalURL) throw new Error(`browser did not open daemon direct terminal WS: ${JSON.stringify(result)}`);
  if (result.hasServerTerminalURL || result.hasServerTerminalEvent) throw new Error(`browser also constructed/opened server terminal relay WS in direct mode: ${JSON.stringify(result)}`);
  if (result.activeDirectTerminalCount !== 1) throw new Error(`browser should keep exactly one active daemon direct terminal WS: ${JSON.stringify(result)}`);
  if (result.activeServerTerminalCount !== 0) throw new Error(`browser kept active server terminal relay WS in direct mode: ${JSON.stringify(result)}`);
  await evalExpr(cdp, `window.__wsEvents = []; document.querySelector('.xterm-helper-textarea')?.focus(); true`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'q', unmodifiedText: 'q' });
  const inputResult = await evalExpr(cdp, `new Promise((resolve) => setTimeout(() => { const events = window.__wsEvents || []; resolve({ qSends: events.filter((event) => event.type === 'send' && event.data === 'q'), terminalEvents: events.filter((event) => event.url && event.url.includes('/ws/terminal')) }); }, 300))`);
  if (inputResult.qSends.length !== 1) throw new Error(`one keypress should be sent exactly once over direct WS: ${JSON.stringify({ result, inputResult })}`);
  await evalExpr(cdp, `window.__wsEvents = []; document.querySelector('.xterm-helper-textarea')?.focus(); true`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\u0003', unmodifiedText: '\u0003' });
  await sleep(200);
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'a', unmodifiedText: 'a' });
  await sleep(80);
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'b', unmodifiedText: 'b' });
  await sleep(80);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 });
  await sleep(80);
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'X', unmodifiedText: 'X' });
  await sleep(80);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
  await sleep(80);
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'Y', unmodifiedText: 'Y' });
  await sleep(80);
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r' });
  const homeEndResult = await evalExpr(cdp, `new Promise((resolve) => setTimeout(() => {
    const events = (window.__wsEvents || []).filter((event) => event.type === 'send' && event.url && event.url.includes('/ws/terminal'));
    resolve({ sends: events.map((event) => event.data), terminalEvents: events, bodyText: document.body.innerText.slice(-500) });
  }, 700))`);
  if (!homeEndResult.sends.includes('\u001bOH') || !homeEndResult.sends.includes('\u001bOF') || !homeEndResult.bodyText.includes('command not found: XabY')) {
    throw new Error(`Home/End should edit the current terminal line correctly: ${JSON.stringify({ result, homeEndResult })}`);
  }
  console.log(JSON.stringify({ ...result, inputResult, homeEndResult }, null, 2));
} catch (err) {
  if (cdp) {
    try {
      const diag = await evalExpr(cdp, `({ href: location.href, body: document.body ? document.body.innerText.slice(0, 4000) : '', wsUrls: window.__wsUrls || [] })`);
      console.error(JSON.stringify({ browserDiag: diag, cdpEvents: cdp.events.slice(-20) }, null, 2));
    } catch {}
  }
  throw err;
} finally {
  cdp?.close();
  for (const proc of [chrome, daemon, server]) {
    try { proc?.kill('SIGTERM'); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(workspace, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(chromeProfile, { recursive: true, force: true });
  if (process.env.SHOW_LOGS) console.error(logs.join(''));
}
