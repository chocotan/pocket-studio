#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import readline from 'node:readline';
import { promptFixture } from './conversation-e2e-lib.mjs';

const sessionId = process.env.POCKET_E2E_MOCK_SESSION || `mock-acp-${process.pid}`;
const logPath = process.env.POCKET_E2E_MOCK_LOG || '';
const delayMs = Number(process.env.POCKET_E2E_MOCK_DELAY_MS || 1400);
let activePrompt = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = async (value) => {
  if (!logPath) return;
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value })}\n`, { mode: 0o600 });
};

function update(sessionUpdate, body) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate, ...body } } });
}

async function runPrompt(msg, prompt) {
  const fixture = promptFixture(prompt);
  const toolCallId = `tool-${sessionId}-${msg.id}`;
  const token = { cancelled: false };
  activePrompt = token;
  await log({ type: 'prompt', runtime: process.env.POCKET_E2E_RUNTIME || 'acp', prompt, session_id: sessionId });
  update('tool_call', {
    toolCallId,
    title: fixture.toolTitle,
    kind: fixture.toolKind,
    status: 'pending',
    rawInput: fixture.toolInput,
  });
  update('tool_call_update', {
    toolCallId,
    title: fixture.toolTitle,
    kind: fixture.toolKind,
    status: 'in_progress',
    rawInput: fixture.toolInput,
  });
  update('agent_message_chunk', { content: { type: 'text', text: fixture.firstChunk } });
  await log({ type: 'barrier', prompt, state: 'active_reply' });
  await sleep(delayMs);
  if (token.cancelled) return;
  update('tool_call_update', {
    toolCallId,
    title: fixture.toolTitle,
    kind: fixture.toolKind,
    status: 'completed',
    rawInput: fixture.toolInput,
    rawOutput: fixture.toolOutput,
    content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(fixture.toolOutput) } }],
  });
  update('agent_message_chunk', { content: { type: 'text', text: fixture.finalChunk.slice(fixture.firstChunk.length) } });
  send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  await log({ type: 'completed', prompt, session_id: sessionId });
  if (activePrompt === token) activePrompt = null;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: 1,
        agentInfo: { name: 'Pocket E2E Mock ACP', version: '1.0.0' },
        capabilities: { loadSession: true, sessionCapabilities: {} },
        models: { currentModelId: 'mock-model', availableModels: [{ id: 'mock-model', name: 'Mock Model' }] },
      },
    });
    void log({ type: 'initialize' });
    return;
  }
  if (['session/new', 'session/load', 'session/resume'].includes(msg.method)) {
    send({
      jsonrpc: '2.0', id: msg.id, result: {
        sessionId,
        models: { currentModelId: 'mock-model', availableModels: [{ id: 'mock-model', name: 'Mock Model' }] },
      },
    });
    void log({ type: msg.method, session_id: sessionId });
    return;
  }
  if (msg.method === 'session/prompt') {
    const prompt = String(msg.params?.prompt?.[0]?.text || '');
    void runPrompt(msg, prompt).catch(async (error) => {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: error.message } });
      await log({ type: 'error', error: error.message });
    });
    return;
  }
  if (msg.method === 'session/cancel') {
    if (activePrompt) activePrompt.cancelled = true;
    void log({ type: 'cancel', session_id: sessionId });
    return;
  }
  if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    void log({ type: 'close', session_id: sessionId });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await log({ type: 'signal', signal });
    process.exit(0);
  });
}
