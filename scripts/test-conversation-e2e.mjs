#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXACT_PROMPTS,
  RUNTIMES,
  SCENARIOS,
  assertPortsAvailable,
  assistantHistoryContains,
  evaluateCell,
  evaluateManagedProcessHealth,
  evaluateManagedProcessLog,
  evaluateNoBuildFreshness,
  findSecrets,
  flattenTaskEvents,
  fixedCasePorts,
  makeCaseOwnedCleanupResult,
  makeTmuxCleanupResult,
  makeMatrix,
  makePairMatrix,
  makeQualificationPlan,
  managedProcessAlreadyExited,
  normalizeRenderedMarkdownText,
  processIDsFromProcEntries,
  frameTaskWorkspaceViolations,
  qualifiedACPAgentConfig,
  realAdapterWrapperScript,
  wrappedACPAgentConfig,
  captureServerStateTasksPayload,
  classifyWebSocketPayload,
	completedTurnEvidence,
  captureTaskEventPayload,
  captureWaitTaskEventsPayload,
  realTurnProgressSignature,
  reloadTurnOutcome,
  waitForProgressCompletion,
  promptFixture,
  redactArtifactValue,
  redactSecrets,
  runtimeAgentPairs,
  summarizeMatrixPlan,
  summarizeManagedProcessLogs,
  summarizeResultProgress,
  summarizeTaskEvents,
  toolHistoryContains,
  validateFixedPortPlan,
} from './conversation-e2e-lib.mjs';
import { processAlive, processGroupAlive, runCommandInProcessGroup, terminateProcessTree } from './conversation-process.mjs';

const matrix = makeMatrix({ runtimes: RUNTIMES, scenarios: Object.keys(SCENARIOS), prompts: EXACT_PROMPTS, agent: 'opencode' });
assert.equal(matrix.length, 16);
assert.equal(new Set(matrix.map((cell) => cell.id)).size, 16);
assert.equal(
  normalizeRenderedMarkdownText('**1. SpaceX update**\n- detail'),
  normalizeRenderedMarkdownText('1. SpaceX update\ndetail'),
  'Markdown-wrapped list numbers must normalize the same as rendered DOM list text',
);

const qualificationFixture = {
  static_check: { status: 'PASS', errors: [] },
  dynamic_check: { status: 'PASS', failures: [] },
  static: {
    ui_selectable: {
      direct_acp: Array.from({ length: 6 }, (_, index) => `direct-agent-${index}`),
      total: 6,
    },
  },
};
const pairs = runtimeAgentPairs(qualificationFixture, { runtimes: RUNTIMES, agent: 'all' });
assert.equal(pairs.length, qualificationFixture.static.ui_selectable.total);
const fullMatrix = makePairMatrix({ pairs, scenarios: Object.keys(SCENARIOS), prompts: EXACT_PROMPTS });
assert.equal(fullMatrix.length, 96);
assert.equal(new Set(fullMatrix.map((cell) => cell.id)).size, 96);
assert.deepEqual(runtimeAgentPairs(qualificationFixture, { runtimes: ['direct_acp'], agent: 'direct-agent-2' }), [{ runtime: 'direct_acp', agent: 'direct-agent-2' }]);
const qualificationPlan = makeQualificationPlan(qualificationFixture);
const turnsPerPairAndPrompt = Object.values(SCENARIOS).reduce((sum, scenario) => sum + scenario.actions.length + 1, 0);
assert.equal(turnsPerPairAndPrompt, 20);
assert.equal(qualificationPlan.pairs, 6);
assert.equal(qualificationPlan.cells, 96);
assert.equal(qualificationPlan.expected_prompt_dispatches, 6 * EXACT_PROMPTS.length * turnsPerPairAndPrompt);
assert.equal(qualificationPlan.expected_prompt_dispatches, 240);

const selectedPlan = summarizeMatrixPlan(makePairMatrix({
  pairs: [{ runtime: 'direct_acp', agent: 'direct-agent-2' }], scenarios: ['normal'], prompts: [EXACT_PROMPTS[0]],
}));
assert.deepEqual(selectedPlan, { pairs: 1, cells: 1, expected_prompt_dispatches: 1 });
assert.deepEqual(summarizeResultProgress([{ status: 'PASS' }, { status: 'PASS' }], { includeHarnessFatal: true }), {
  total: 3,
  passed: 2,
  failed: 1,
  completed_cells: 2,
  harness_fatal_failures: 1,
});

assert.deepEqual(fixedCasePorts(21000, 0), [21000, 21001, 21002]);
assert.deepEqual(fixedCasePorts(21000, 15), [21045, 21046, 21047]);
assert.throws(() => fixedCasePorts(21000, -1), /cell index/i);
assert.deepEqual(validateFixedPortPlan(21000, 16), {
  port_base: 21000,
  cells: 16,
  ports_per_cell: 3,
  first_port: 21000,
  last_port: 21047,
  total_ports: 48,
});
for (const [base, cells] of [[0, 1], [21000.5, 1], [65534, 1], [65530, 3], [21000, 0]]) {
  assert.throws(() => validateFixedPortPlan(base, cells), /port|cell/i);
}
await assert.doesNotReject(() => assertPortsAvailable([21000, 21001, 21002], async () => true, 'test shard'));
await assert.rejects(
  () => assertPortsAvailable([21000, 21001, 21002], async (port) => port !== 21001, 'test shard'),
  /test shard.*21001/i,
);
const helpResult = spawnSync(process.execPath, ['scripts/conversation-e2e.mjs', '--help'], { cwd: process.cwd(), encoding: 'utf8' });
assert.equal(helpResult.status, 0, helpResult.stderr);
assert.match(helpResult.stdout, /--port-base N/);
const invalidPortBase = spawnSync(process.execPath, ['scripts/conversation-e2e.mjs', '--port-base', '65536', '--preflight-only'], { cwd: process.cwd(), encoding: 'utf8' });
assert.equal(invalidPortBase.status, 2);
assert.match(invalidPortBase.stderr, /--port-base.*65535/i);

const qualifiedConfig = qualifiedACPAgentConfig({
  inventory: {
    kilo: {
      executable: '/opt/kilo',
      effective_command: ['kilo', 'acp', '--pure'],
    },
    cursor: {
      executable: '/opt/cursor-agent',
      effective_command: [],
    },
  },
}, 'kilo');
assert.deepEqual(qualifiedConfig, {
  registryAgent: 'kilocode',
  config: {
    command: '/opt/kilo',
    args: ['acp', '--pure'],
  },
});
assert.deepEqual(
  qualifiedACPAgentConfig({ inventory: { cursor: { executable: '/opt/cursor-agent', effective_command: [] } } }, 'cursor').config,
  {
    command: '/opt/cursor-agent', args: ['acp'],
  },
);
assert.deepEqual(
  wrappedACPAgentConfig({
    command: '/opt/kilo',
    args: ['acp', '--pure'],
    env: { QUALIFICATION_SECRET: 'must-not-reach-runtime-config' },
  }, '/tmp/kilo-wrapper'),
  { command: '/tmp/kilo-wrapper', args: ['acp', '--pure'] },
);

const wrapperRoot = await mkdtemp(join(tmpdir(), 'conversation-adapter-wrapper-'));
try {
  const adapterPath = join(wrapperRoot, "adapter's command");
  const wrapperPath = join(wrapperRoot, 'wrapper');
  await writeFile(adapterPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$HOME" "$XDG_CONFIG_HOME" "\${FORCE_COLOR-unset}" "$NO_COLOR" "$1" "$2"`,
    '',
  ].join('\n'));
  await chmod(adapterPath, 0o755);
  const wrapperScript = realAdapterWrapperScript({
    command: adapterPath,
    home: "/home/tester's real home",
    xdgConfigHome: "/home/tester's real config",
  });
  await writeFile(wrapperPath, wrapperScript, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  assert.equal((await stat(wrapperPath)).mode & 0o777, 0o700);
  assert.equal(await readFile(wrapperPath, 'utf8'), wrapperScript);
  assert.doesNotMatch(wrapperScript, /must-not-reach-runtime-config/);
  const wrapperResult = await new Promise((resolve, reject) => {
    const child = spawn(wrapperPath, ['alpha', 'two words'], {
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        HOME: '/isolated-home',
        XDG_CONFIG_HOME: '/isolated-config',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
  assert.equal(wrapperResult.code, 0, wrapperResult.stderr);
  assert.deepEqual(wrapperResult.stdout.trimEnd().split('\n'), [
    "/home/tester's real home",
    "/home/tester's real config",
    'unset',
    '1',
    'alpha',
    'two words',
  ]);
} finally {
  await rm(wrapperRoot, { recursive: true, force: true });
}

const expectedWorkspace = '/tmp/conversation-case/workspace';
const workspaceFrames = [{
  direction: 'receive',
  data: JSON.stringify({
    type: 'server.state',
    payload: {
      tasks: [
        { task_id: 'owned', workspace_path: expectedWorkspace },
        { task_id: 'foreign', workspace_path: '/home/tester/other-project' },
      ],
    },
  }),
}];
assert.deepEqual(
  frameTaskWorkspaceViolations(workspaceFrames, expectedWorkspace).map((item) => item.task_id),
  ['foreign'],
  'any task record from outside the isolated case workspace must fail the frame gate',
);

let fakeNow = 0;
let sampleIndex = 0;
const progressSamples = [
  { working: true, text: 'a' },
  { working: true, text: 'ab' },
  { working: true, text: 'abc' },
  { working: false, text: 'complete' },
];
const progressResult = await waitForProgressCompletion({
  sample: async () => progressSamples[Math.min(sampleIndex++, progressSamples.length - 1)],
  isComplete: (sample) => sample.working === false,
  signature: (sample) => sample.text,
  idleTimeoutMs: 100,
  hardTimeoutMs: 1_000,
  intervalMs: 60,
  now: () => fakeNow,
  sleep: async (ms) => { fakeNow += ms; },
});
assert.equal(progressResult.text, 'complete', 'continuous progress must reset the idle deadline beyond the original total timeout');
await assert.rejects(
  waitForProgressCompletion({
    sample: () => new Promise(() => {}),
    isComplete: () => false,
    idleTimeoutMs: 35,
    hardTimeoutMs: 35,
  }),
  /real turn hard timeout after 35ms/,
  'a stalled sampler must not bypass the real-turn hard ceiling',
);
assert.equal(classifyWebSocketPayload('{"type":"ping"}'), 'noise');
assert.equal(classifyWebSocketPayload('{"type":"pong"}\n'), 'noise');
assert.equal(classifyWebSocketPayload('{"type":"server.state","payload":{"tasks":[]}}'), 'state');
assert.equal(classifyWebSocketPayload('{"type":"task.event","payload":{"event_type":"assistant.message"}}'), 'evidence');
assert.equal(classifyWebSocketPayload('not-json'), 'evidence');
const capturedPrompt = captureTaskEventPayload(JSON.stringify({
  type: 'task.event',
  payload: {
    task_id: 'task-1', event_id: 'prompt-1', event_type: 'user.prompt', sequence: 3, timestamp: 10,
    data: { _seq: 2, _ts: 10001, prompt: EXACT_PROMPTS[0], turn_id: 'turn-1' },
  },
}));
assert.equal(capturedPrompt?.event_id, 'prompt-1');
assert.equal(capturedPrompt?.task_id, 'task-1');
assert.equal(capturedPrompt?.wait_event, true);
assert.equal(captureTaskEventPayload(JSON.stringify({
  type: 'task.event',
  payload: { task_id: 'task-1', event_id: 'tool-1', event_type: 'tool.output', data: { output: 'large' } },
}))?.wait_event, false);
assert.equal(captureTaskEventPayload('{"type":"pong"}'), null);
assert.deepEqual(processIDsFromProcEntries(['self', '0', '17', '42', '42x', '999'], 42), [17, 999]);
const completionDuringReloadState = JSON.stringify({
  type: 'server.state',
  payload: {
    tasks: [{
      task_id: 'task-reload', session_id: 'task-reload', prompt: EXACT_PROMPTS[0], status: 'completed', updated_at: 101,
      history: [
        { task_id: 'task-reload', event_id: 'prompt-reload', event_type: 'user.prompt', sequence: 1, timestamp: 98, data: { prompt: EXACT_PROMPTS[0], turn_id: 'turn-reload', _seq: 1 } },
        { task_id: 'task-reload', event_id: 'start-reload', event_type: 'task.started', sequence: 2, timestamp: 99, data: { turn_id: 'turn-reload', _seq: 2 } },
        { task_id: 'task-reload', event_id: 'done-reload', event_type: 'task.completed', sequence: 3, timestamp: 100, data: { turn_id: 'turn-reload', _seq: 3 } },
      ],
    }],
  },
});
const reloadStateEvents = captureWaitTaskEventsPayload(completionDuringReloadState).map((item) => item.event);
const reloadStateSummary = summarizeTaskEvents(reloadStateEvents);
assert.equal(reloadStateSummary.turns.length, 1);
assert.equal(reloadStateSummary.turns[0].turn_id, 'turn-reload');
assert.equal(reloadStateSummary.turns[0].prompt, EXACT_PROMPTS[0]);
assert.deepEqual(reloadStateSummary.turns[0].terminal_events.map((event) => event.event_type), ['task.completed']);
assert.deepEqual(captureServerStateTasksPayload(completionDuringReloadState), [{
  task_id: 'task-reload', session_id: 'task-reload', prompt: EXACT_PROMPTS[0], status: 'completed', started_at: 0, updated_at: 101,
}]);
const failureDuringReloadState = JSON.stringify({
  type: 'server.state',
  payload: {
    tasks: [{
      task_id: 'task-reload', events: [
        { task_id: 'task-reload', event_id: 'prompt-failed', event_type: 'user.prompt', sequence: 1, data: { prompt: EXACT_PROMPTS[1], turn_id: 'turn-failed' } },
        { task_id: 'task-reload', event_id: 'failed-reload', event_type: 'turn.failed', sequence: 2, data: { turn_id: 'turn-failed', reason: 'daemon_restart' } },
      ],
    }],
  },
});
const failedReloadTurn = summarizeTaskEvents(captureWaitTaskEventsPayload(failureDuringReloadState).map((item) => item.event)).turns[0];
assert.equal(failedReloadTurn.terminal_events[0].event_type, 'turn.failed');
assert.equal(failedReloadTurn.terminal_events[0].data.reason, 'daemon_restart');
const reloadDOM = {
  session_id: 'task-reload', working: false, error: '', run_status: 'idle',
  user_prompts: [EXACT_PROMPTS[0]],
  assistant_messages: [promptFixture(EXACT_PROMPTS[0]).finalChunk],
  tools: [{ toolStatus: 'completed' }],
};
const reloadTurn = { task_id: 'task-reload', turn_id: 'turn-reload', ordinal: 0, prompt: EXACT_PROMPTS[0], baseline_assistant_count: 0 };
assert.equal(reloadTurnOutcome({ taskEvents: reloadStateEvents, dom: reloadDOM, turn: reloadTurn, mode: 'mock' }), 'completed');
const reloadDOMWithoutTools = { ...reloadDOM, tools: [] };
const reloadEvidenceWithoutTools = completedTurnEvidence(reloadStateSummary.turns[0], EXACT_PROMPTS[0], 'mock', reloadDOMWithoutTools);
assert.equal(reloadEvidenceWithoutTools.protocol_tool_ok, false, 'the final oracle must still reject a completed turn without tools');
assert.equal(
  reloadTurnOutcome({ taskEvents: reloadStateEvents, dom: reloadDOMWithoutTools, turn: reloadTurn, mode: 'mock' }),
  'completed',
  'reload lifecycle recovery must not time out solely because the agent completed without invoking a tool',
);
assert.equal(reloadTurnOutcome({
  taskRecords: captureServerStateTasksPayload(completionDuringReloadState), dom: reloadDOM, turn: reloadTurn, mode: 'mock',
}), 'completed', 'a task that completes while the page is disconnected must recover from the fresh server-state status');
assert.equal(reloadTurnOutcome({
  taskRecords: [{ task_id: 'task-reload', status: 'running' }], dom: { ...reloadDOM, working: true }, turn: reloadTurn, mode: 'mock',
}), 'running');
assert.equal(reloadTurnOutcome({
  taskRecords: [{ task_id: 'task-reload', status: 'failed' }], dom: reloadDOM, turn: reloadTurn, mode: 'mock',
}), 'failed');
assert.equal(assistantHistoryContains(['checking disk'], ['checking disk now', 'done']), true);
assert.equal(assistantHistoryContains(['missing'], ['checking disk now']), false);
const pendingToolHistory = [{ tool_id: 'tool-1', title: 'Terminal', kind: 'bash', status: 'pending' }];
assert.equal(toolHistoryContains(pendingToolHistory, [
  { tool_id: 'tool-1', title: 'df -h', kind: 'execute', status: 'completed' },
]), true, 'active tool metadata may be enriched across reload when the stable ID and status progression are preserved');
assert.equal(toolHistoryContains(pendingToolHistory, [
  { tool_id: 'tool-1', title: 'df -h', kind: 'execute', status: 'completed' },
  { tool_id: 'tool-1', title: 'duplicate', kind: 'execute', status: 'completed' },
]), false, 'reload history must reject duplicate tool IDs');
assert.equal(toolHistoryContains([
  { tool_id: 'tool-1', title: 'df -h', kind: 'execute', status: 'completed' },
], [
  { tool_id: 'tool-1', title: 'other command', kind: 'execute', status: 'completed' },
]), false, 'terminal tool metadata must remain stable across reload');
assert.equal(toolHistoryContains([
  { tool_id: 'tool-1', title: 'df -h', kind: 'execute', status: 'completed' },
], [
  { tool_id: 'tool-1', title: 'df -h', kind: 'execute', status: 'pending' },
]), false, 'terminal tool status must not regress across reload');
const timedToolProgress = {
  working: true,
  assistants: [],
  tools: [{ id: 'tool-1', status: 'in_progress', text: '执行命令\n1秒\n$ df -h' }],
  protocol_revision: 9,
};
assert.equal(
  realTurnProgressSignature(timedToolProgress),
  realTurnProgressSignature({
    ...timedToolProgress,
    tools: [{ ...timedToolProgress.tools[0], text: '执行命令\n29秒\n$ df -h' }],
  }),
  'elapsed UI text must not count as assistant/tool protocol progress',
);
assert.notEqual(
  realTurnProgressSignature(timedToolProgress),
  realTurnProgressSignature({ ...timedToolProgress, protocol_revision: 10 }),
  'a new protocol evidence frame must reset the real-turn idle deadline',
);
let idleNow = 0;
let elapsedTick = 0;
await assert.rejects(
  waitForProgressCompletion({
    sample: async () => ({
      ...timedToolProgress,
      tools: [{ ...timedToolProgress.tools[0], text: `执行命令\n${elapsedTick++}秒\n$ df -h` }],
    }),
    isComplete: () => false,
    signature: realTurnProgressSignature,
    idleTimeoutMs: 100,
    hardTimeoutMs: 1_000,
    intervalMs: 60,
    now: () => idleNow,
    sleep: async (ms) => { idleNow += ms; },
  }),
  /real turn produced no assistant\/tool progress for 100ms/,
  'a changing elapsed label must still reach the idle timeout',
);
assert.equal(evaluateNoBuildFreshness({ serverModifiedMs: 200, frontendModifiedMs: 100 }).fresh, true);
assert.deepEqual(
  evaluateNoBuildFreshness({ serverModifiedMs: 100, frontendModifiedMs: 200 }),
  {
    status: 'FAIL', fresh: false, server_modified_ms: 100, frontend_modified_ms: 200,
    reason: 'embedded server binary is older than the newest frontend dist asset',
  },
);
const totalMismatchFixture = structuredClone(qualificationFixture);
totalMismatchFixture.static.ui_selectable.total = 18;
assert.throws(() => runtimeAgentPairs(totalMismatchFixture), /pair total mismatch/);

const cleanedOwnedProcess = { pid: 101, start_ticks: '1001', command: 'adapter' };
const cleanedLeakResult = makeCaseOwnedCleanupResult({
  baselineCount: 2,
  naturalExitGraceMs: 500,
  discovered: [cleanedOwnedProcess],
  termAttempts: [{ identity: '101:1001', pid: 101, signal: 'SIGTERM', sent: true }],
  survivors: [],
});
assert.deepEqual(cleanedLeakResult, {
  status: 'FAIL',
  skipped: false,
  policy: 'strict',
  scope: 'case',
  baseline_count: 2,
  natural_exit_grace_ms: 500,
  discovered: [cleanedOwnedProcess],
  termination_attempts: [{ identity: '101:1001', pid: 101, signal: 'SIGTERM', sent: true }],
  terminated: [cleanedOwnedProcess],
  confirmed_terminated: [cleanedOwnedProcess],
  survivors: [],
});
assert.equal(makeCaseOwnedCleanupResult({ naturalExitGraceMs: 500 }).status, 'PASS');
assert.equal(makeCaseOwnedCleanupResult({
  discovered: [cleanedOwnedProcess],
  termAttempts: [{ identity: '101:1001', pid: 101, signal: 'SIGTERM', sent: false }],
}).status, 'FAIL');
const survivingOwnedProcess = { pid: 202, start_ticks: '2002', command: 'adapter' };
const failedOwnedCleanup = makeCaseOwnedCleanupResult({
  discovered: [survivingOwnedProcess],
  killAttempts: [{ identity: '202:2002', pid: 202, signal: 'SIGKILL', sent: false }],
  survivors: [survivingOwnedProcess],
});
assert.equal(failedOwnedCleanup.status, 'FAIL');
assert.deepEqual(failedOwnedCleanup.terminated, []);
assert.deepEqual(failedOwnedCleanup.survivors, [survivingOwnedProcess]);
assert.equal(makeCaseOwnedCleanupResult({ scope: 'daemon_owner' }).scope, 'daemon_owner');

const stoppedTmux = {
  status: 'PASS', server_running: false, panes: [], error: '',
};
const cleanTmuxResult = makeTmuxCleanupResult({
  socket: 'pocket-e2e-123-aabbccddeeff0011',
  baseline: stoppedTmux,
  before: stoppedTmux,
  after: stoppedTmux,
  socketRemoved: true,
  socketExistsAfter: false,
});
assert.equal(cleanTmuxResult.status, 'PASS');
assert.equal(cleanTmuxResult.socket_exists_after, false);
const staleSocketResult = makeTmuxCleanupResult({
  socket: 'pocket-e2e-123-aabbccddeeff0011',
  baseline: stoppedTmux,
  before: stoppedTmux,
  after: stoppedTmux,
  socketRemoved: false,
  socketExistsAfter: true,
});
assert.equal(staleSocketResult.status, 'FAIL', 'a stale tmux socket must fail cleanup even when no server or pane survives');
assert.equal(makeTmuxCleanupResult({
  socket: 'pocket-e2e-123-aabbccddeeff0011',
  baseline: stoppedTmux,
  before: stoppedTmux,
  after: stoppedTmux,
  socketExistsAfter: false,
  socketCleanupError: 'refusing unexpected path type',
}).status, 'FAIL', 'tmux path inspection or removal errors must fail cleanup');

const healthyProcessLog = evaluateManagedProcessLog('daemon', [
  'daemon connection closed: websocket: close 1006 (abnormal closure): unexpected EOF',
  'INFO connection closed cause="peer connection closed"',
  'server stopped by SIGTERM',
].join('\n'));
assert.equal(healthyProcessLog.status, 'PASS');
assert.deepEqual(healthyProcessLog.findings, []);
for (const [line, kind] of [
  ['panic: send on closed channel', 'go_panic'],
  ['http: panic serving 127.0.0.1:1234: send on closed channel', 'go_panic'],
  ['panic({0x123?, 0x456?})', 'go_panic'],
  ['fatal error: concurrent map writes', 'go_fatal'],
  ['Uncaught Exception: socket failure', 'node_uncaught'],
  ['UnhandledPromiseRejection: failed', 'node_uncaught'],
  ['[FATAL:zygote_host_impl_linux.cc] check failed', 'fatal_marker'],
  ['[process-error] spawn ENOENT', 'process_error'],
]) {
  const report = evaluateManagedProcessLog('server', line);
  assert.equal(report.status, 'FAIL', line);
  assert.equal(report.findings[0].kind, kind, line);
}
assert.equal(summarizeManagedProcessLogs([healthyProcessLog]).status, 'PASS');
assert.equal(summarizeManagedProcessLogs([healthyProcessLog, evaluateManagedProcessLog('server', 'panic: boom')]).status, 'FAIL');
for (const code of [0, 1]) {
  const unexpected = evaluateManagedProcessHealth('server', '', { code, signal: null, expected: false, at: 'now' });
  assert.equal(unexpected.status, 'FAIL');
  assert.equal(unexpected.findings[0].kind, 'unexpected_exit');
}
assert.equal(evaluateManagedProcessHealth('daemon-1', '', { code: 0, signal: null, expected: true, at: 'now' }).status, 'PASS');
const exitedBeforeStop = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
await new Promise((resolvePromise) => exitedBeforeStop.once('close', resolvePromise));
assert.equal(managedProcessAlreadyExited({
  recordedExit: null,
  exitCode: exitedBeforeStop.exitCode,
  signalCode: exitedBeforeStop.signalCode,
  alive: processAlive(exitedBeforeStop.pid),
}), true, 'real child exit before stop must be classified as already exited');
const aliveBeforeStop = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: process.platform !== 'win32',
  stdio: 'ignore',
});
try {
  assert.equal(managedProcessAlreadyExited({
    recordedExit: null,
    exitCode: aliveBeforeStop.exitCode,
    signalCode: aliveBeforeStop.signalCode,
    alive: processAlive(aliveBeforeStop.pid),
  }), false, 'live child must remain eligible for expected stop');
} finally {
  await terminateProcessTree(aliveBeforeStop, { graceMs: 100 });
  const deadline = Date.now() + 2_000;
  while (processAlive(aliveBeforeStop.pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.equal(processAlive(aliveBeforeStop.pid), false, 'managed-process classifier fixture child must be cleaned up');
}

for (const prompt of EXACT_PROMPTS) {
  const fixture = promptFixture(prompt);
  assert.ok(fixture.finalChunk.startsWith(fixture.firstChunk));
  assert.ok(fixture.toolTitle);
}

const secretSample = 'Authorization: Bearer abc.def.ghi token=super-secret sk-proj-12345678901234567890 https://user:pass@example.test';
assert.ok(findSecrets(secretSample).length >= 3);
assert.equal(findSecrets(redactSecrets(secretSample)).length, 0);
const awsSecretSample = [
  'Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260714/cn-north-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'https://bucket.example.test/object?X-Amz-Credential=ASIAIOSFODNN7EXAMPLE%2F20260714%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
].join('\n');
assert.ok(findSecrets(awsSecretSample).includes('aws_credential'));
assert.ok(findSecrets(awsSecretSample).includes('aws_signature'));
assert.ok(findSecrets(awsSecretSample).includes('aws_query_credential'));
assert.ok(findSecrets(awsSecretSample).includes('aws_query_signature'));
assert.equal(findSecrets(redactSecrets(awsSecretSample)).length, 0);
const authorizationSchemes = [
  'Authorization: Basic dXNlcjpwYXNzd29yZA==',
  'Authorization: Digest username="admin", realm="private", nonce="abc123", response="0123456789abcdef0123456789abcdef"',
  'Authorization: ApiKey ultra-private-api-key',
  '{"Authorization":"Basic dXNlcjpwYXNzd29yZA==","safe":"kept"}',
].join('\n');
assert.ok(findSecrets(authorizationSchemes).some((name) => name.startsWith('authorization')));
const redactedAuthorizationSchemes = redactSecrets(authorizationSchemes);
assert.equal(findSecrets(redactedAuthorizationSchemes).length, 0);
assert.ok(!/dXNlcjpwYXNzd29yZA|admin|abc123|ultra-private-api-key/.test(redactedAuthorizationSchemes));
assert.deepEqual(redactArtifactValue({ nested: { authorization: 'Basic secret', token: 'token-value', safe: 'kept' } }), {
  nested: { authorization: '[REDACTED]', token: '[REDACTED]', safe: 'kept' },
});
const formSecretSample = 'client_secret=form-client-secret&access_token=form-access-token&safe=kept';
assert.ok(findSecrets(formSecretSample).includes('form_secret'));
assert.equal(findSecrets(redactSecrets(formSecretSample)).length, 0);
assert.ok(!/form-client-secret|form-access-token/.test(redactSecrets(formSecretSample)));
assert.deepEqual(redactArtifactValue({ payload: JSON.stringify({ nested: { password: 'nested-secret', safe: 'kept' } }) }), {
  payload: JSON.stringify({ nested: { password: '[REDACTED]', safe: 'kept' } }),
});
const websocketFrame = {
  at: '2026-07-15T00:00:00.000Z',
  direction: 'received',
  data: JSON.stringify({
    jsonrpc: '2.0',
    params: {
      input: {
        command: 'curl -H "Authorization: Bearer websocket-secret" --data \'{"query":"Elon Musk latest news"}\'',
      },
      output: 'HTTP/1.1 200 OK\nAuthorization: Bearer websocket-secret\n{"results":[{"title":"kept"}]}',
    },
  }),
};
const redactedWebsocketFrame = redactArtifactValue(websocketFrame);
const parsedRedactedWebsocketData = JSON.parse(redactedWebsocketFrame.data);
assert.equal(parsedRedactedWebsocketData.params.output.includes('websocket-secret'), false);
assert.match(parsedRedactedWebsocketData.params.output, /Authorization: \[REDACTED\]/);
assert.match(parsedRedactedWebsocketData.params.output, /"results":\[\{"title":"kept"\}\]/);
assert.match(parsedRedactedWebsocketData.params.input.command, /Authorization: \[REDACTED\]/);
assert.match(parsedRedactedWebsocketData.params.input.command, /--data .*Elon Musk latest news/);
assert.equal(findSecrets(JSON.stringify(redactedWebsocketFrame)).length, 0);
const digestCommand = String.raw`curl -H "Authorization: Digest username=\"admin\", realm=\"private\", nonce=\"abc123\", response=\"0123456789abcdef\"" --data '{"query":"Elon Musk latest news"}'`;
const redactedDigestCommand = redactArtifactValue(digestCommand);
assert.match(redactedDigestCommand, /Authorization: \[REDACTED\]/);
assert.match(redactedDigestCommand, /--data .*Elon Musk latest news/);
assert.equal(/admin|private|abc123|0123456789abcdef/.test(redactedDigestCommand), false);
assert.equal(findSecrets(redactedDigestCommand).length, 0);

const nested = { payload: { events: [{ event_id: '1', event_type: 'user.prompt', data: '{}' }] } };
assert.equal(flattenTaskEvents(nested).length, 1);

function event(id, eventType, sequence, data, taskID = 'task-1') {
  return { task_id: taskID, event_id: id, event_type: eventType, sequence, data };
}

function activeReplyPreconditions(observedAt, { mockBarrier = true, assistantBefore = 0, assistantAfter = 1, toolBefore = 0, toolAfter = 1 } = {}) {
  return {
    working: true,
    first_activity: true,
    mock_barrier: mockBarrier,
    activity_observed_at_ms: observedAt,
    assistant_count_before: assistantBefore,
    assistant_count_after: assistantAfter,
    tool_count_before: toolBefore,
    tool_count_after: toolAfter,
  };
}

function completedTurn(prompt, ordinal, startSequence) {
  const fixture = promptFixture(prompt);
  const turnID = `turn-${ordinal}`;
  const toolID = `tool-${ordinal}`;
  return [
    event(`prompt-${ordinal}`, 'user.prompt', startSequence, { prompt, turn_id: turnID, acpx_turn_index: ordinal }),
    event(`start-${ordinal}`, 'task.started', startSequence + 1, { turn_id: turnID, acpx_turn_index: ordinal }),
    event(`call-${ordinal}`, 'tool.call', startSequence + 2, {
      tool_use_id: toolID, title: fixture.toolTitle, name: fixture.toolTitle, kind: fixture.toolKind,
      input: fixture.toolInput, status: 'pending', acpx_turn_index: ordinal,
    }),
    event(`assistant-${ordinal}`, 'assistant.message', startSequence + 3, { text: fixture.finalChunk, acpx_turn_index: ordinal }),
    event(`output-${ordinal}`, 'tool.output', startSequence + 4, {
      tool_use_id: toolID, title: fixture.toolTitle, name: fixture.toolTitle, kind: fixture.toolKind,
      input: fixture.toolInput, output: fixture.toolOutput, status: 'completed', acpx_turn_index: ordinal,
    }),
    event(`done-${ordinal}`, 'task.completed', startSequence + 5, { turn_id: turnID, acpx_turn_index: ordinal }),
  ];
}

function domForPrompts(prompts) {
  const finalFixture = promptFixture(prompts.at(-1));
  return {
    working: false,
    error: '',
    user_prompts: prompts,
    assistant_messages: prompts.map((prompt) => promptFixture(prompt).finalChunk),
    assistant_cards: prompts.map((prompt, index) => ({ id: `assistant-${index}`, text: promptFixture(prompt).finalChunk })),
    tools: [{
      toolId: `tool-${prompts.length - 1}`,
      toolKind: finalFixture.toolKind === 'execute' ? 'bash' : 'websearch',
      toolStatus: 'completed',
      toolTitle: finalFixture.toolTitle,
      text: `${finalFixture.toolTitle}\n${JSON.stringify(finalFixture.toolInput)}\n${JSON.stringify(finalFixture.toolOutput)}`,
    }],
  };
}

function mockRowsFor(prompts) {
  return prompts.flatMap((prompt) => [{ type: 'prompt', prompt }, { type: 'barrier', prompt }, { type: 'completed', prompt }]);
}

function failedChecks(result) {
  return result.checks.filter((check) => !check.pass).map((check) => check.name);
}

function assertFailsCheck(input, checkName) {
  const result = evaluateCell(input);
  assert.equal(result.status, 'FAIL', `expected FAIL for ${checkName}`);
  assert.ok(failedChecks(result).includes(checkName), `${checkName} not failed: ${JSON.stringify(failedChecks(result))}`);
}

const normalCell = matrix.find((item) => item.runtime === 'direct_acp' && item.scenario === 'normal' && item.prompt === EXACT_PROMPTS[0]);
const normalEvents = completedTurn(normalCell.prompt, 0, 1);
normalEvents.push(event('prompt-history-duplicate', 'user.prompt', 99, {
  prompt: normalCell.prompt, turn_id: 'turn-0', acpx_turn_index: 0, acpx_event_key: 'turn:0:user.prompt:0',
}));
const normalInput = {
  cell: normalCell,
  mode: 'mock',
  dom: domForPrompts([normalCell.prompt]),
  taskEvents: normalEvents,
  mockRows: mockRowsFor([normalCell.prompt]),
  actionEvidence: [],
};
const normalResult = evaluateCell(normalInput);
assert.equal(normalResult.status, 'PASS', JSON.stringify(normalResult, null, 2));
assert.equal(summarizeTaskEvents(normalEvents).user_prompts.length, 1, 'same task+turn prompt must be logical exact-once');
const replayedNormal = structuredClone(normalInput);
for (const eventID of ['assistant-0', 'call-0', 'output-0']) {
  const replay = structuredClone(replayedNormal.taskEvents.find((item) => item.event_id === eventID));
  replay.__received_at = 999;
  replayedNormal.taskEvents.push(replay);
}
assert.equal(evaluateCell(replayedNormal).status, 'PASS', 'same-ID message/tool replay must not duplicate semantic evidence');

const duplicateDOM = structuredClone(normalInput);
duplicateDOM.dom.user_prompts.push(normalCell.prompt);
assertFailsCheck(duplicateDOM, `dom_prompt_exact_once:${normalCell.prompt}`);

const unrelatedCompleted = structuredClone(normalInput);
unrelatedCompleted.taskEvents = unrelatedCompleted.taskEvents.filter((item) => item.event_id !== 'output-0');
unrelatedCompleted.taskEvents.push(event('unrelated-call', 'tool.call', 20, {
  tool_use_id: 'unrelated', title: 'unrelated', name: 'unrelated', kind: 'execute', input: { command: 'true' }, status: 'pending', acpx_turn_index: 0,
}));
unrelatedCompleted.taskEvents.push(event('unrelated-output', 'tool.output', 21, {
  tool_use_id: 'unrelated', title: 'unrelated', name: 'unrelated', kind: 'execute', input: { command: 'true' }, output: { output: 'ok' }, status: 'completed', acpx_turn_index: 0,
}));
assertFailsCheck(unrelatedCompleted, 'tool_output_exact');

for (const [name, mutate] of [
  ['tool_call_exact', (input) => { input.taskEvents.find((item) => item.event_id === 'call-0').data.kind = 'fetch'; }],
  ['tool_call_exact', (input) => { input.taskEvents.find((item) => item.event_id === 'call-0').data.input = { command: 'df -h' }; }],
  ['tool_output_exact', (input) => { input.taskEvents.find((item) => item.event_id === 'output-0').data.tool_use_id = 'wrong-id'; }],
  ['tool_output_exact', (input) => { input.taskEvents.find((item) => item.event_id === 'output-0').data.output = { output: 'partial' }; }],
  ['tool_terminal_status', (input) => { input.taskEvents.find((item) => item.event_id === 'output-0').data.status = 'pending'; }],
  ['tool_dom_exact', (input) => { input.dom.tools[0].toolKind = 'websearch'; }],
  ['tool_dom_exact', (input) => { input.dom.tools[0].toolTitle = 'wrong title'; }],
  ['tool_dom_exact', (input) => { input.dom.tools[0].toolStatus = 'pending'; }],
]) {
  const input = structuredClone(normalInput);
  mutate(input);
  assertFailsCheck(input, name);
}

const stopCell = matrix.find((item) => item.runtime === 'direct_acp' && item.scenario === 'stop_followup' && item.prompt === EXACT_PROMPTS[0]);
const primaryFixture = promptFixture(stopCell.prompt);
const stopEvents = [
  event('prompt-primary', 'user.prompt', 1, { prompt: stopCell.prompt, turn_id: 'turn-primary', acpx_turn_index: 0 }),
  event('start-primary', 'task.started', 2, { turn_id: 'turn-primary', acpx_turn_index: 0 }),
  event('call-primary', 'tool.call', 3, {
    tool_use_id: 'tool-primary', title: primaryFixture.toolTitle, name: primaryFixture.toolTitle, kind: primaryFixture.toolKind,
    input: primaryFixture.toolInput, status: 'pending', acpx_turn_index: 0,
  }),
  event('assistant-primary', 'assistant.message', 4, { text: primaryFixture.firstChunk, acpx_turn_index: 0 }),
  event('killed-primary', 'task.killed', 5, { reason: 'user_requested', acpx_turn_index: 0 }),
  ...completedTurn(stopCell.follow_up_prompt, 1, 10),
];
const stopInput = {
  cell: { ...stopCell, actual_turn_plan: { prompts: stopCell.prompt_sequence, action_turn_ordinals: stopCell.action_turn_ordinals, recovery_turn_ordinal: stopCell.recovery_turn_ordinal } },
  mode: 'mock',
  dom: domForPrompts([stopCell.prompt, stopCell.follow_up_prompt]),
  taskEvents: stopEvents,
  mockRows: [
    { type: 'prompt', prompt: stopCell.prompt },
    { type: 'barrier', prompt: stopCell.prompt },
    { type: 'cancel' },
    ...mockRowsFor([stopCell.follow_up_prompt]),
  ],
  actionEvidence: [{
    action: 'stop', status: 'observed',
    target_prompt: stopCell.prompt, target_turn_ordinal: 0, target_turn_id: 'turn-primary', action_sent_at_ms: 100,
    preconditions: activeReplyPreconditions(90),
    before: { working: true, session_id: 'task-1', user_prompts: [stopCell.prompt], frame_epoch: 0, socket_count: 1, daemon_generation: 1 },
    after: { working: false, session_id: 'task-1', user_prompts: [stopCell.prompt], frame_epoch: 0, socket_count: 1, daemon_generation: 1 },
  }],
};
stopInput.dom.assistant_messages = [primaryFixture.firstChunk, promptFixture(stopCell.follow_up_prompt).finalChunk];
stopInput.dom.assistant_cards = [
  { id: 'assistant-primary', text: primaryFixture.firstChunk },
  { id: 'assistant-1', text: promptFixture(stopCell.follow_up_prompt).finalChunk },
];
const stopResult = evaluateCell(stopInput);
assert.equal(stopResult.status, 'PASS', JSON.stringify(stopResult, null, 2));
const directStopWithoutChildCancel = structuredClone(stopInput);
directStopWithoutChildCancel.cell.runtime = 'direct_acp';
directStopWithoutChildCancel.mockRows = directStopWithoutChildCancel.mockRows.filter((row) => row.type !== 'cancel');
directStopWithoutChildCancel.actionEvidence[0].terminal_observed_after_action = true;
directStopWithoutChildCancel.actionEvidence[0].terminal_event_id = 'killed-primary';
assert.equal(evaluateCell(directStopWithoutChildCancel).status, 'PASS', JSON.stringify(evaluateCell(directStopWithoutChildCancel), null, 2));
const mismatchedTurnPlan = structuredClone(stopInput);
mismatchedTurnPlan.cell.actual_turn_plan.prompts = [stopCell.prompt];
assertFailsCheck(mismatchedTurnPlan, 'actual_turn_plan_matches_declared');

const stopNegativeCases = [
  ['action_first_activity:stop', (input) => { input.actionEvidence[0].preconditions.first_activity = false; }],
  ['action_activity_advanced:stop', (input) => { input.actionEvidence[0].preconditions.assistant_count_after = 0; input.actionEvidence[0].preconditions.tool_count_after = 0; }],
  ['action_after_first_activity:stop', (input) => { input.actionEvidence[0].preconditions.activity_observed_at_ms = 101; }],
  ['stop_observed_working', (input) => { input.actionEvidence[0].preconditions.working = false; }],
  ['stop_observed_first_activity', (input) => { input.actionEvidence[0].preconditions.first_activity = false; }],
  ['stop_observed_mock_barrier', (input) => { input.actionEvidence[0].preconditions.mock_barrier = false; }],
  ['stop_protocol_cancel', (input) => { input.mockRows = input.mockRows.filter((row) => row.type !== 'cancel'); }],
  ['stop_primary_final_absent', (input) => { input.taskEvents.find((item) => item.event_id === 'assistant-primary').data.text = primaryFixture.finalChunk; }],
  ['stop_primary_tool_not_completed', (input) => { input.taskEvents.find((item) => item.event_id === 'call-primary').data.status = 'completed'; }],
  ['stop_primary_terminal', (input) => { input.taskEvents = input.taskEvents.filter((item) => item.event_id !== 'killed-primary'); }],
  ['stop_no_late_primary_completion', (input) => { input.taskEvents.push(event('late-done', 'task.completed', 6, { acpx_turn_index: 0 })); }],
  ['stop_mock_primary_not_completed', (input) => {
    const nextPrompt = input.mockRows.findIndex((row) => row.type === 'prompt' && row.prompt === stopCell.follow_up_prompt);
    input.mockRows.splice(nextPrompt, 0, { type: 'completed', prompt: stopCell.prompt });
  }],
  ['follow_up_completed', (input) => { input.dom.assistant_messages.pop(); input.dom.assistant_cards.pop(); }],
  ['final_turn_completed', (input) => { input.taskEvents = input.taskEvents.filter((item) => item.event_id !== 'done-1'); }],
];
for (const [checkName, mutate] of stopNegativeCases) {
  const input = structuredClone(stopInput);
  mutate(input);
  assertFailsCheck(input, checkName);
}

const restartCell = matrix.find((item) => item.runtime === 'direct_acp' && item.scenario === 'reload_restart_followup' && item.prompt === EXACT_PROMPTS[0]);
const restartPrompt = restartCell.follow_up_prompt;
const restartFixture = promptFixture(restartPrompt);
const restartEvents = [
  ...completedTurn(restartCell.prompt, 0, 1),
  event('prompt-restart', 'user.prompt', 10, { prompt: restartPrompt, turn_id: 'turn-restart', acpx_turn_index: 1 }),
  event('start-restart', 'task.started', 11, { turn_id: 'turn-restart', acpx_turn_index: 1 }),
  event('call-restart', 'tool.call', 12, {
    tool_use_id: 'tool-restart', title: restartFixture.toolTitle, name: restartFixture.toolTitle, kind: restartFixture.toolKind,
    input: restartFixture.toolInput, status: 'pending', acpx_turn_index: 1,
  }),
  event('assistant-restart', 'assistant.message', 13, { text: restartFixture.firstChunk, acpx_turn_index: 1 }),
  event('failed-restart', 'task.failed', 14, { reason: 'interrupted', error: 'task interrupted by daemon restart', acpx_turn_index: 1 }),
  ...completedTurn(restartCell.prompt, 2, 20),
];
const restartInput = {
  cell: { ...restartCell, actual_turn_plan: { prompts: restartCell.prompt_sequence, action_turn_ordinals: restartCell.action_turn_ordinals, recovery_turn_ordinal: restartCell.recovery_turn_ordinal } },
  mode: 'mock',
  dom: {
    working: false,
    error: '',
    user_prompts: [restartCell.prompt, restartPrompt, restartCell.prompt],
    assistant_messages: [promptFixture(restartCell.prompt).finalChunk, restartFixture.firstChunk, promptFixture(restartCell.prompt).finalChunk],
    assistant_cards: [
      { id: 'assistant-0', text: promptFixture(restartCell.prompt).finalChunk },
      { id: 'assistant-restart', text: restartFixture.firstChunk },
      { id: 'assistant-2', text: promptFixture(restartCell.prompt).finalChunk },
    ],
    tools: [
      {
        toolId: 'tool-0', toolKind: 'bash', toolStatus: 'completed', toolTitle: promptFixture(restartCell.prompt).toolTitle,
        text: `${promptFixture(restartCell.prompt).toolTitle}\n${JSON.stringify(promptFixture(restartCell.prompt).toolInput)}\n${JSON.stringify(promptFixture(restartCell.prompt).toolOutput)}`,
      },
      { toolId: 'tool-restart', toolKind: 'websearch', toolStatus: 'failed', toolTitle: restartFixture.toolTitle },
      {
        toolId: 'tool-2', toolKind: 'bash', toolStatus: 'completed', toolTitle: promptFixture(restartCell.prompt).toolTitle,
        text: `${promptFixture(restartCell.prompt).toolTitle}\n${JSON.stringify(promptFixture(restartCell.prompt).toolInput)}\n${JSON.stringify(promptFixture(restartCell.prompt).toolOutput)}`,
      },
    ],
  },
  taskEvents: restartEvents,
  mockRows: [
    ...mockRowsFor([restartCell.prompt]),
    { type: 'prompt', prompt: restartPrompt }, { type: 'barrier', prompt: restartPrompt },
    ...mockRowsFor([restartCell.prompt]),
  ],
  actionEvidence: [
    {
      action: 'reload', status: 'observed',
      target_prompt: restartCell.prompt, target_turn_ordinal: 0, target_turn_id: 'turn-0', action_sent_at_ms: 100,
      preconditions: activeReplyPreconditions(90),
      before: { working: true, session_id: 'task-1', user_prompts: [restartCell.prompt], assistant_messages: [primaryFixture.firstChunk], tools: [{ tool_id: 'tool-0', title: primaryFixture.toolTitle, kind: 'bash', status: 'pending' }], frame_epoch: 0, socket_count: 1, agent_socket_count: 1, agent_socket_open_count: 1, daemon_generation: 1, daemon_pid: 101 },
      after: { working: false, session_id: 'task-1', user_prompts: [restartCell.prompt], assistant_messages: [primaryFixture.finalChunk], tools: [{ tool_id: 'tool-0', title: primaryFixture.toolTitle, kind: 'bash', status: 'completed' }], frame_epoch: 1, socket_count: 2, agent_socket_count: 1, agent_socket_open_count: 1, daemon_generation: 1, daemon_pid: 101 },
    },
    {
      action: 'restart', status: 'observed',
      target_prompt: restartPrompt, target_turn_ordinal: 1, target_turn_id: 'turn-restart', action_sent_at_ms: 200,
      preconditions: activeReplyPreconditions(190, { assistantBefore: 1, assistantAfter: 2, toolBefore: 1, toolAfter: 2 }),
      before: { working: true, session_id: 'task-1', user_prompts: [restartCell.prompt, restartPrompt], assistant_messages: [primaryFixture.finalChunk, restartFixture.firstChunk], tools: [{ tool_id: 'tool-0', title: primaryFixture.toolTitle, kind: 'bash', status: 'completed' }, { tool_id: 'tool-restart', title: restartFixture.toolTitle, kind: 'websearch', status: 'pending' }], frame_epoch: 1, socket_count: 2, daemon_generation: 1, daemon_pid: 101 },
      after: { working: false, session_id: 'task-1', user_prompts: [restartCell.prompt, restartPrompt], assistant_messages: [primaryFixture.finalChunk, restartFixture.firstChunk], tools: [{ tool_id: 'tool-0', title: primaryFixture.toolTitle, kind: 'bash', status: 'completed' }, { tool_id: 'tool-restart', title: restartFixture.toolTitle, kind: 'websearch', status: 'failed' }], frame_epoch: 1, socket_count: 2, daemon_generation: 2, daemon_pid: 202, daemon_online_at_ms: 250 },
    },
  ],
};
assert.equal(evaluateCell(restartInput).status, 'PASS', JSON.stringify(evaluateCell(restartInput), null, 2));
const missingReloadEvidence = structuredClone(restartInput);
missingReloadEvidence.actionEvidence = missingReloadEvidence.actionEvidence.filter((entry) => entry.action !== 'reload');
const missingReloadResult = evaluateCell(missingReloadEvidence);
assert.equal(missingReloadResult.status, 'FAIL');
assert.ok(failedChecks(missingReloadResult).includes('action_observed:reload'));
assert.ok(failedChecks(missingReloadResult).includes('reload_target_tool_preserved'));
const missingReloadTurn = structuredClone(restartInput);
missingReloadTurn.actionEvidence[0].target_turn_ordinal = 999;
delete missingReloadTurn.actionEvidence[0].target_prompt;
const missingReloadTurnResult = evaluateCell(missingReloadTurn);
assert.equal(missingReloadTurnResult.status, 'FAIL');
assert.ok(failedChecks(missingReloadTurnResult).includes('action_target_turn:reload'));
assert.ok(failedChecks(missingReloadTurnResult).includes('reload_target_tool_preserved'));
const missingAllActionEvidence = structuredClone(restartInput);
missingAllActionEvidence.actionEvidence = undefined;
assert.equal(evaluateCell(missingAllActionEvidence).status, 'FAIL');
const invalidPromptEvidence = structuredClone(normalInput);
invalidPromptEvidence.cell.prompt = undefined;
invalidPromptEvidence.cell.prompt_sequence = [undefined];
const invalidPromptResult = evaluateCell(invalidPromptEvidence);
assert.equal(invalidPromptResult.status, 'FAIL');
assert.ok(failedChecks(invalidPromptResult).includes('mock_prompt_fixtures_available'));
assert.equal(evaluateCell().status, 'FAIL');
for (const [checkName, mutate] of [
  ['action_first_activity:reload', (input) => { input.actionEvidence[0].preconditions.first_activity = false; }],
  ['action_activity_advanced:reload', (input) => { input.actionEvidence[0].preconditions.assistant_count_after = 0; input.actionEvidence[0].preconditions.tool_count_after = 0; }],
  ['action_after_first_activity:reload', (input) => { input.actionEvidence[0].preconditions.activity_observed_at_ms = 101; }],
  ['action_first_activity:restart', (input) => { input.actionEvidence[1].preconditions.first_activity = false; }],
  ['action_activity_advanced:restart', (input) => { input.actionEvidence[1].preconditions.assistant_count_after = 1; input.actionEvidence[1].preconditions.tool_count_after = 1; }],
  ['action_after_first_activity:restart', (input) => { input.actionEvidence[1].preconditions.activity_observed_at_ms = 201; }],
  ['reload_epoch_advanced', (input) => { input.actionEvidence[0].after.frame_epoch = 0; }],
  ['reload_session_preserved', (input) => { input.actionEvidence[0].after.session_id = 'other-task'; }],
  ['reload_history_recovered', (input) => { input.actionEvidence[0].after.user_prompts = []; }],
  ['reload_socket_reconnected', (input) => { input.actionEvidence[0].after.agent_socket_open_count = 0; }],
  ['restart_generation_advanced', (input) => { input.actionEvidence[1].after.daemon_generation = 1; }],
  ['restart_old_turn_terminal', (input) => { input.taskEvents = input.taskEvents.filter((item) => item.event_id !== 'failed-restart'); }],
]) {
  const input = structuredClone(restartInput);
  mutate(input);
  assertFailsCheck(input, checkName);
}

const realInput = structuredClone(normalInput);
realInput.mode = 'real';
realInput.mockRows = [];
realInput.dom.assistant_messages = ['磁盘检查完成，当前文件系统可用 60 GB。'];
realInput.taskEvents.find((item) => item.event_id === 'assistant-0').data.text = realInput.dom.assistant_messages[0];
realInput.dom.assistant_cards = [{ id: 'assistant-0', text: realInput.dom.assistant_messages[0] }];
assert.equal(evaluateCell(realInput).status, 'PASS', JSON.stringify(evaluateCell(realInput), null, 2));
assert.ok(!evaluateCell(realInput).checks.some((check) => check.name.startsWith('mock_')));
const badReal = structuredClone(realInput);
badReal.dom.assistant_messages = ['检查完成。'];
badReal.dom.assistant_cards = [{ id: 'assistant-0', text: '检查完成。' }];
badReal.taskEvents.find((item) => item.event_id === 'assistant-0').data.text = '检查完成。';
assertFailsCheck(badReal, 'real_final_response_semantic');

const badRealDOM = structuredClone(realInput);
badRealDOM.dom.assistant_cards = [{ id: 'assistant-0', text: '检查完成。' }];
assertFailsCheck(badRealDOM, 'real_final_response_in_dom');

const rawProviderDiagnostics = structuredClone(realInput);
rawProviderDiagnostics.taskEvents.push(event('raw-reconnect', 'acpx.raw', 4.5, {
  stream: 'assistant', text: 'Reconnecting... 1/5', acpx_turn_index: 0,
}));
rawProviderDiagnostics.taskEvents.push(event('raw-metadata-warning', 'acpx.raw', 4.6, {
  stream: 'assistant',
  text: 'Warning: Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
  acpx_turn_index: 0,
}));
assert.equal(evaluateCell(rawProviderDiagnostics).status, 'PASS', 'raw provider diagnostics are retained as evidence without polluting assistant replies');

const reconnectProtocolPollution = structuredClone(realInput);
reconnectProtocolPollution.taskEvents.push(event('assistant-reconnect', 'assistant.message', 4.5, {
  text: 'Reconnecting... 1/5', acpx_turn_index: 0,
}));
assertFailsCheck(reconnectProtocolPollution, 'no_provider_diagnostics_in_protocol_assistant');

const metadataProtocolPollution = structuredClone(realInput);
metadataProtocolPollution.taskEvents.push(event('assistant-metadata-warning', 'assistant.message', 4.5, {
  text: 'Warning: Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
  acpx_turn_index: 0,
}));
assertFailsCheck(metadataProtocolPollution, 'no_provider_diagnostics_in_protocol_assistant');

const reconnectDOMPollution = structuredClone(realInput);
reconnectDOMPollution.dom.assistant_messages.push('Reconnecting... 1/5');
reconnectDOMPollution.dom.assistant_cards.push({ id: 'provider-reconnect', text: 'Reconnecting... 1/5' });
assertFailsCheck(reconnectDOMPollution, 'no_provider_diagnostics_in_dom');

const metadataDOMPollution = structuredClone(realInput);
metadataDOMPollution.dom.assistant_messages.push('Warning: Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.');
metadataDOMPollution.dom.assistant_cards.push({ id: 'provider-metadata-warning', text: metadataDOMPollution.dom.assistant_messages.at(-1) });
assertFailsCheck(metadataDOMPollution, 'no_provider_diagnostics_in_dom');

const reconnectNormalProse = structuredClone(realInput);
const reconnectProse = 'Reconnecting... 1/5 was a transient status; the completed disk answer remains available.';
reconnectNormalProse.taskEvents.push(event('assistant-reconnect-prose', 'assistant.message', 4.5, {
  text: reconnectProse, acpx_turn_index: 0,
}));
reconnectNormalProse.dom.assistant_messages.push(reconnectProse);
reconnectNormalProse.dom.assistant_cards.push({ id: 'assistant-reconnect-prose', text: reconnectProse });
assert.equal(evaluateCell(reconnectNormalProse).status, 'PASS', 'normal assistant prose mentioning reconnect is not a provider diagnostic');

const conciseDiskReal = structuredClone(realInput);
conciseDiskReal.dom.assistant_messages = ['73G'];
conciseDiskReal.dom.assistant_cards = [{ id: 'assistant-0', text: '73G' }];
conciseDiskReal.taskEvents.find((item) => item.event_id === 'assistant-0').data.text = '73G';
conciseDiskReal.taskEvents.find((item) => item.event_id === 'output-0').data.output = { output: '73G\n' };
conciseDiskReal.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[0]).toolInput)}\n输出结果\n73G`;
assert.equal(
  evaluateCell(conciseDiskReal).status,
  'PASS',
  'a truthful df tool result and concise single-capacity answer satisfy the disk-space prompt',
);
const piWrappedDisk = structuredClone(realInput);
const piDiskText = promptFixture(EXACT_PROMPTS[0]).toolOutput.output;
piWrappedDisk.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  content: [{ type: 'text', text: piDiskText }],
};
piWrappedDisk.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[0]).toolInput)}\n输出结果\n${piDiskText}`;
assert.equal(evaluateCell(piWrappedDisk).status, 'PASS', 'Pi ACP text envelopes preserve real terminal newlines');
const piEscapedDiskDOM = structuredClone(piWrappedDisk);
piEscapedDiskDOM.dom.tools[0].text = JSON.stringify(
  piEscapedDiskDOM.taskEvents.find((item) => item.event_id === 'output-0').data.output,
  null,
  2,
);
assertFailsCheck(piEscapedDiskDOM, 'real_tool_dom_exact');

const markdownReal = structuredClone(realInput);
markdownReal.taskEvents.find((item) => item.event_id === 'assistant-0').data.text = '**磁盘可用空间**检查命令为 `df -h`。';
markdownReal.taskEvents.push(event('assistant-table', 'assistant.message', 4.5, {
  text: '| Filesystem | Size | Avail |\n| --- | ---: | ---: |\n| /dev/sda | 475G | 247G |',
  acpx_turn_index: 0,
}));
markdownReal.dom.assistant_messages = [
  '磁盘可用空间检查命令为 df -h。',
  'Filesystem\nSize\nAvail\n/dev/sda\n475G\n247G',
];
markdownReal.dom.assistant_cards = [
  { id: 'assistant-0', text: markdownReal.dom.assistant_messages[0] },
  { id: 'assistant-table', text: markdownReal.dom.assistant_messages[1] },
];
assert.equal(evaluateCell(markdownReal).status, 'PASS', JSON.stringify(evaluateCell(markdownReal), null, 2));
const missingMarkdownValue = structuredClone(markdownReal);
missingMarkdownValue.dom.assistant_messages[1] = missingMarkdownValue.dom.assistant_messages[1].replace('247G', '');
missingMarkdownValue.dom.assistant_cards[1].text = missingMarkdownValue.dom.assistant_messages[1];
assertFailsCheck(missingMarkdownValue, 'real_final_response_in_dom');
const reorderedMarkdownCards = structuredClone(markdownReal);
reorderedMarkdownCards.dom.assistant_cards.reverse();
assertFailsCheck(reorderedMarkdownCards, 'real_final_response_in_dom');
const duplicateMarkdownCard = structuredClone(markdownReal);
duplicateMarkdownCard.dom.assistant_cards.push(structuredClone(duplicateMarkdownCard.dom.assistant_cards[1]));
assertFailsCheck(duplicateMarkdownCard, 'real_final_response_in_dom');
const literalMarkdownDOM = structuredClone(markdownReal);
literalMarkdownDOM.dom.assistant_cards[0].text = '**磁盘可用空间**检查命令为 `df -h`。';
assert.equal(evaluateCell(literalMarkdownDOM).status, 'PASS', 'literal markdown tokens left in DOM text remain semantically equivalent');
const horizontalRuleMarkdown = structuredClone(realInput);
horizontalRuleMarkdown.taskEvents.find((item) => item.event_id === 'assistant-0').data.text = '磁盘可用空间 60 GB。\n\n---\n\n检查完成。';
horizontalRuleMarkdown.dom.assistant_messages = ['磁盘可用空间 60 GB。\n\n检查完成。'];
horizontalRuleMarkdown.dom.assistant_cards = [{ id: 'assistant-0', text: horizontalRuleMarkdown.dom.assistant_messages[0] }];
assert.equal(evaluateCell(horizontalRuleMarkdown).status, 'PASS', 'rendered Markdown horizontal rules do not appear in DOM innerText');
const pipeLinkListMarkdown = structuredClone(realInput);
pipeLinkListMarkdown.taskEvents.find((item) => item.event_id === 'assistant-0').data.text = '磁盘可用空间 60 GB。\n\nSources:\n- [Disk status | Example](https://example.com/disk)';
pipeLinkListMarkdown.dom.assistant_messages = ['磁盘可用空间 60 GB。\n\nSources:\nDisk status | Example'];
pipeLinkListMarkdown.dom.assistant_cards = [{ id: 'assistant-0', text: pipeLinkListMarkdown.dom.assistant_messages[0] }];
assert.equal(evaluateCell(pipeLinkListMarkdown).status, 'PASS', 'a pipe inside a Markdown link list item must not be normalized as a table row');
const whitespaceAssistantEvent = structuredClone(realInput);
whitespaceAssistantEvent.taskEvents.push(event('assistant-whitespace', 'assistant.message', 4.5, {
  text: '\n\n', acpx_turn_index: 0,
}));
assert.equal(evaluateCell(whitespaceAssistantEvent).status, 'PASS', 'whitespace-only protocol chunks do not require empty DOM cards');

for (const [checkName, mutate] of [
  ['real_tool_dom_exact', (input) => { input.dom.tools[0].toolTitle = 'wrong'; }],
  ['real_tool_dom_exact', (input) => { input.dom.tools[0].toolKind = 'websearch'; }],
  ['real_tool_dom_exact', (input) => { input.dom.tools[0].toolStatus = 'pending'; }],
]) {
  const input = structuredClone(realInput);
  mutate(input);
  assertFailsCheck(input, checkName);
}

const hiddenToolOutput = structuredClone(realInput);
hiddenToolOutput.dom.tools[0].text = JSON.stringify(promptFixture(EXACT_PROMPTS[0]).toolInput);
assertFailsCheck(hiddenToolOutput, 'real_tool_dom_exact');
const wrongToolOutput = structuredClone(realInput);
wrongToolOutput.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[0]).toolInput)}\nwrong output`;
assertFailsCheck(wrongToolOutput, 'real_tool_dom_exact');
const metadataDescriptionOnly = structuredClone(realInput);
const diskOutputText = promptFixture(EXACT_PROMPTS[0]).toolOutput.output;
const metadataDescriptionOutput = metadataDescriptionOnly.taskEvents.find((item) => item.event_id === 'output-0').data;
metadataDescriptionOutput.output = {
  metadata: { description: 'Show disk space usage', output: diskOutputText },
  output: diskOutputText,
};
metadataDescriptionOnly.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[0]).toolInput)}\nShow disk space usage`;
assertFailsCheck(metadataDescriptionOnly, 'real_tool_dom_exact');

for (const invalidInput of [undefined, {}, [], '   ']) {
  const missingInput = structuredClone(realInput);
  const callData = missingInput.taskEvents.find((item) => item.event_id === 'call-0').data;
  const outputData = missingInput.taskEvents.find((item) => item.event_id === 'output-0').data;
  if (invalidInput === undefined) {
    delete callData.input;
    delete outputData.input;
  } else {
    callData.input = invalidInput;
    outputData.input = invalidInput;
  }
  assertFailsCheck(missingInput, 'real_tool_semantic');
}

const twoToolReal = structuredClone(realInput);
twoToolReal.taskEvents.push(
  event('extra-call', 'tool.call', 30, {
    tool_use_id: 'extra-tool', title: 'df -h /tmp', name: 'df -h /tmp', kind: 'execute', input: { command: 'df -h /tmp' }, status: 'pending', acpx_turn_index: 0,
  }),
  event('extra-output', 'tool.output', 31, {
    tool_use_id: 'extra-tool', title: 'df -h /tmp', name: 'df -h /tmp', kind: 'execute', input: { command: 'df -h /tmp' }, output: { output: 'tmpfs 20G 5G 15G 25% /tmp' }, status: 'completed', acpx_turn_index: 0,
  }),
);
twoToolReal.dom.tools.push({
  toolId: 'extra-tool', toolKind: 'bash', toolStatus: 'completed', toolTitle: 'df -h /tmp',
  text: '执行命令\ndf -h /tmp\n输入参数\n{"command":"df -h /tmp"}\n输出结果\ntmpfs 20G 5G 15G 25% /tmp',
});
assert.equal(evaluateCell(twoToolReal).status, 'PASS', JSON.stringify(evaluateCell(twoToolReal), null, 2));
const missingSecondSemanticCard = structuredClone(twoToolReal);
missingSecondSemanticCard.dom.tools = missingSecondSemanticCard.dom.tools.filter((tool) => tool.toolId !== 'extra-tool');
assertFailsCheck(missingSecondSemanticCard, 'real_tool_dom_exact');

const pendingOrphanTool = structuredClone(realInput);
pendingOrphanTool.taskEvents.push(event('orphan-call', 'tool.call', 30, {
  tool_use_id: 'orphan-tool', title: 'df -h /orphan', name: 'df -h /orphan', kind: 'execute',
  input: { command: 'df -h /orphan' }, status: 'pending', acpx_turn_index: 0,
}));
assertFailsCheck(pendingOrphanTool, 'real_observable_tool_integrity');

const orphanToolOutput = structuredClone(realInput);
orphanToolOutput.taskEvents.push(event('orphan-output', 'tool.output', 30, {
  tool_use_id: 'orphan-output-tool', title: 'df -h /orphan', name: 'df -h /orphan', kind: 'execute',
  input: { command: 'df -h /orphan' }, output: { error: 'path missing' }, status: 'failed', acpx_turn_index: 0,
}));
orphanToolOutput.dom.tools.push({
  toolId: 'orphan-output-tool', toolKind: 'bash', toolStatus: 'failed', toolTitle: 'df -h /orphan',
  text: 'df -h /orphan\npath missing',
});
assertFailsCheck(orphanToolOutput, 'real_observable_tool_integrity');

const pendingToolOutput = structuredClone(realInput);
pendingToolOutput.taskEvents.find((item) => item.event_id === 'output-0').data.status = 'pending';
pendingToolOutput.dom.tools[0].toolStatus = 'pending';
assertFailsCheck(pendingToolOutput, 'real_observable_tool_integrity');

const truthfulFailedRetry = structuredClone(realInput);
truthfulFailedRetry.taskEvents.push(
  event('failed-retry-call', 'tool.call', 30, {
    tool_use_id: 'failed-retry', title: 'df -h /missing', name: 'df -h /missing', kind: 'execute',
    input: { command: 'df -h /missing' }, status: 'pending', acpx_turn_index: 0,
  }),
  event('failed-retry-output', 'tool.output', 31, {
    tool_use_id: 'failed-retry', title: 'df -h /missing', name: 'df -h /missing', kind: 'execute',
    input: { command: 'df -h /missing' }, output: { error: 'df: /missing: no such file or directory' }, status: 'failed', acpx_turn_index: 0,
  }),
);
truthfulFailedRetry.dom.tools.push({
  toolId: 'failed-retry', toolKind: 'bash', toolStatus: 'failed', toolTitle: 'df -h /missing',
  text: 'df -h /missing\ndf: /missing: no such file or directory',
});
assert.equal(evaluateCell(truthfulFailedRetry).status, 'PASS', JSON.stringify(evaluateCell(truthfulFailedRetry), null, 2));
const piWrappedFailedRetry = structuredClone(truthfulFailedRetry);
const piFailedOutput = {
  content: [{ type: 'text', text: 'df: /missing: no such file\nCommand exited with code 1' }],
  details: {},
};
piWrappedFailedRetry.taskEvents.find((item) => item.event_id === 'failed-retry-output').data.output = piFailedOutput;
piWrappedFailedRetry.dom.tools.find((tool) => tool.toolId === 'failed-retry').text = `df -h /missing\n${JSON.stringify(piFailedOutput, null, 2)}`;
assert.equal(evaluateCell(piWrappedFailedRetry).status, 'PASS', 'Pi JSON-escaped failed output remains complete and truthful in DOM');
const hiddenFailedRetryOutput = structuredClone(truthfulFailedRetry);
hiddenFailedRetryOutput.dom.tools.find((tool) => tool.toolId === 'failed-retry').text = 'df -h /missing';
assertFailsCheck(hiddenFailedRetryOutput, 'real_observable_tool_integrity');

const terminalToolMetadata = structuredClone(realInput);
const terminalCall = terminalToolMetadata.taskEvents.find((item) => item.event_id === 'call-0').data;
const terminalOutput = terminalToolMetadata.taskEvents.find((item) => item.event_id === 'output-0').data;
terminalCall.title = 'bash';
terminalCall.name = 'bash';
terminalCall.input = { cwd: '/workspace' };
terminalOutput.title = 'df -h';
terminalOutput.name = 'df -h';
terminalOutput.input = promptFixture(EXACT_PROMPTS[0]).toolInput;
terminalToolMetadata.dom.tools[0].toolTitle = 'df -h';
assert.equal(
  evaluateCell(terminalToolMetadata).status,
  'PASS',
  'same-ID terminal tool metadata completes the placeholder title and input from the initial call',
);

const duplicateSemanticTool = structuredClone(realInput);
const diskFixture = promptFixture(EXACT_PROMPTS[0]);
duplicateSemanticTool.taskEvents.push(
  event('duplicate-call', 'tool.call', 30, {
    tool_use_id: 'duplicate-disk', title: diskFixture.toolTitle, name: diskFixture.toolTitle, kind: diskFixture.toolKind,
    input: diskFixture.toolInput, status: 'pending', acpx_turn_index: 0,
  }),
  event('duplicate-output', 'tool.output', 31, {
    tool_use_id: 'duplicate-disk', title: diskFixture.toolTitle, name: diskFixture.toolTitle, kind: diskFixture.toolKind,
    input: diskFixture.toolInput, output: diskFixture.toolOutput, status: 'completed', acpx_turn_index: 0,
  }),
);
duplicateSemanticTool.dom.tools.push({
  ...structuredClone(duplicateSemanticTool.dom.tools[0]),
  toolId: 'duplicate-disk',
});
assert.equal(
  evaluateCell(duplicateSemanticTool).status,
  'PASS',
  'two distinct agent-issued tool IDs remain two truthful executions even when their semantic payloads match',
);

const diskCommandNotFound = structuredClone(realInput);
diskCommandNotFound.taskEvents.find((item) => item.event_id === 'output-0').data.output = { output: 'df: command not found' };
assertFailsCheck(diskCommandNotFound, 'real_tool_semantic');

const newsCell = matrix.find((item) => item.runtime === 'direct_acp' && item.scenario === 'normal' && item.prompt === EXACT_PROMPTS[1]);
const newsReal = {
  cell: newsCell,
  mode: 'real',
  dom: domForPrompts([newsCell.prompt]),
  taskEvents: completedTurn(newsCell.prompt, 0, 1),
  mockRows: [],
  actionEvidence: [],
};
assert.equal(evaluateCell(newsReal).status, 'PASS', JSON.stringify(evaluateCell(newsReal), null, 2));
const completeMultiResultNews = structuredClone(newsReal);
completeMultiResultNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  results: [
    { title: '马斯克公布 SpaceX 新进展', source: 'Example A' },
    { title: 'Tesla 发布新计划', url: 'https://example.test/tesla' },
  ],
};
completeMultiResultNews.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[1]).toolInput)}\n马斯克公布 SpaceX 新进展\nExample A\nTesla 发布新计划\nhttps://example.test/tesla`;
assert.equal(evaluateCell(completeMultiResultNews).status, 'PASS', JSON.stringify(evaluateCell(completeMultiResultNews), null, 2));
const partialMultiResultNews = structuredClone(completeMultiResultNews);
partialMultiResultNews.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[1]).toolInput)}\n马斯克公布 SpaceX 新进展\nExample A`;
assertFailsCheck(partialMultiResultNews, 'real_observable_tool_integrity');
const codexCompletedSearch = structuredClone(newsReal);
const codexSearchInput = {
  type: 'webSearch', id: 'tool-0', query: 'Elon Musk latest news July 15 2026',
  action: {
    type: 'search', query: 'Elon Musk latest news July 15 2026',
    queries: ['Elon Musk latest news July 15 2026', 'Elon Musk latest Reuters July 2026'],
  },
};
const codexSearchOutput = {
  type: 'webSearch', status: 'completed', action: codexSearchInput.action,
  query: codexSearchInput.query, queries: codexSearchInput.action.queries,
};
const codexSearchCall = codexCompletedSearch.taskEvents.find((item) => item.event_id === 'call-0').data;
const codexSearchResult = codexCompletedSearch.taskEvents.find((item) => item.event_id === 'output-0').data;
for (const tool of [codexSearchCall, codexSearchResult]) {
  tool.title = 'Web search: Elon Musk latest news July 15 2026';
  tool.name = tool.title;
  tool.kind = 'search';
  tool.input = codexSearchInput;
  tool.status = 'completed';
}
codexSearchResult.output = codexSearchOutput;
codexCompletedSearch.dom.tools[0] = {
  toolId: 'tool-0', toolKind: 'websearch', toolStatus: 'completed', toolTitle: codexSearchCall.title,
  text: `${codexSearchCall.title}\n${JSON.stringify(codexSearchInput)}\n${JSON.stringify(codexSearchOutput)}`,
};
assert.equal(
  evaluateCell(codexCompletedSearch).status,
  'PASS',
  'Codex completed webSearch action metadata is truthful same-ID tool evidence without invented result rows',
);
const incompleteCodexSearch = structuredClone(codexCompletedSearch);
incompleteCodexSearch.taskEvents.find((item) => item.event_id === 'output-0').data.output.status = 'pending';
assertFailsCheck(incompleteCodexSearch, 'real_tool_semantic');
const wrappedNews = structuredClone(newsReal);
wrappedNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  metadata: { provider: 'search', truncated: false },
  output: JSON.stringify({
    search_id: 'search-real-shape',
    results: [{ title: '马斯克公布 SpaceX 新进展', url: 'https://example.test/musk' }],
  }),
};
wrappedNews.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[1]).toolInput)}\n${wrappedNews.taskEvents.find((item) => item.event_id === 'output-0').data.output.output}`;
assert.equal(
  evaluateCell(wrappedNews).status,
  'PASS',
  'ACPX adapters may wrap structured search results in the raw output string',
);
const doubleWrappedNews = structuredClone(newsReal);
doubleWrappedNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  metadata: { truncated: false },
  output: JSON.stringify(JSON.stringify([
    { title: '马斯克公布 SpaceX 新进展', link: 'https://example.test/musk', content: '新闻摘要' },
  ])),
};
doubleWrappedNews.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[1]).toolInput)}\n${doubleWrappedNews.taskEvents.find((item) => item.event_id === 'output-0').data.output.output}`;
assert.equal(
  evaluateCell(doubleWrappedNews).status,
  'PASS',
  'GoSDK adapters may expose a doubly JSON-encoded search result array',
);
const piWrappedNews = structuredClone(newsReal);
const piNewsResults = JSON.stringify({
  results: [{ title: '马斯克公布 SpaceX 新进展', url: 'https://example.test/musk' }],
});
piWrappedNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  content: [{ type: 'text', text: piNewsResults }],
};
piWrappedNews.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[1]).toolInput)}\n${piNewsResults}`;
assert.equal(evaluateCell(piWrappedNews).status, 'PASS', 'Pi ACP text envelopes may contain structured search JSON');
const piWrappedNewsWithDetails = structuredClone(piWrappedNews);
piWrappedNewsWithDetails.taskEvents.find((item) => item.event_id === 'output-0').data.output.details = {};
assert.equal(
  evaluateCell(piWrappedNewsWithDetails).status,
  'PASS',
  'Pi ACP text envelopes may include an empty details object alongside successful content',
);
const piWrappedNewsWithFailureDetails = structuredClone(piWrappedNews);
piWrappedNewsWithFailureDetails.taskEvents.find((item) => item.event_id === 'output-0').data.output.details = { error: 'provider failed' };
assertFailsCheck(piWrappedNewsWithFailureDetails, 'real_tool_semantic');
const redactedPiCommandNews = structuredClone(piWrappedNewsWithDetails);
const redactedPiCommand = redactArtifactValue(
  'curl -H "Authorization: Bearer websocket-secret" --data \'{"query":"Elon Musk latest news"}\'',
);
for (const item of redactedPiCommandNews.taskEvents.filter((eventItem) => ['call-0', 'output-0'].includes(eventItem.event_id))) {
  item.data.input = { command: redactedPiCommand };
  item.data.kind = 'execute';
  item.data.title = 'bash';
  item.data.name = 'bash';
}
redactedPiCommandNews.dom.tools[0] = {
  ...redactedPiCommandNews.dom.tools[0],
  toolKind: 'bash',
  toolTitle: 'bash',
  text: `${redactedPiCommand}\n${piNewsResults}`,
};
assert.equal(
  evaluateCell(redactedPiCommandNews).status,
  'PASS',
  'redacting a quoted Authorization header preserves later search arguments for artifact replay',
);
const nestedPiNews = structuredClone(piWrappedNews);
nestedPiNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  content: [{ type: 'content', content: { type: 'text', text: piNewsResults } }],
};
assert.equal(evaluateCell(nestedPiNews).status, 'PASS', 'nested ACP text envelopes preserve search results');
const mixedPiNews = structuredClone(piWrappedNews);
mixedPiNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  content: [
    { type: 'text', text: piNewsResults },
    { type: 'image', url: 'https://example.test/image.png' },
  ],
};
assertFailsCheck(mixedPiNews, 'real_tool_semantic');
const emptyPiNews = structuredClone(piWrappedNews);
emptyPiNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
};
assertFailsCheck(emptyPiNews, 'real_tool_semantic');
const errorPiNews = structuredClone(piWrappedNews);
errorPiNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  content: [{ type: 'text', text: JSON.stringify({ error: 'unauthorized' }) }],
};
assertFailsCheck(errorPiNews, 'real_tool_semantic');
const wrongQueryPiNews = structuredClone(piWrappedNews);
for (const item of wrongQueryPiNews.taskEvents.filter((eventItem) => ['call-0', 'output-0'].includes(eventItem.event_id))) {
  item.data.input = { query: 'weather today' };
  item.data.title = 'search: weather today';
  item.data.name = 'search: weather today';
}
assertFailsCheck(wrongQueryPiNews, 'real_tool_semantic');
const emptyNews = structuredClone(newsReal);
emptyNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = { results: [] };
assertFailsCheck(emptyNews, 'real_tool_semantic');
const networkNews = structuredClone(newsReal);
networkNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = 'network failed: connection refused';
assertFailsCheck(networkNews, 'real_tool_semantic');
const failedLaunchNews = structuredClone(newsReal);
failedLaunchNews.taskEvents.find((item) => item.event_id === 'output-0').data.output = {
  results: [{ title: 'SpaceX reviews failed launch before next flight', source: 'Example News' }],
};
failedLaunchNews.dom.tools[0].text = `${JSON.stringify(promptFixture(EXACT_PROMPTS[1]).toolInput)}\nSpaceX reviews failed launch before next flight\nExample News`;
assert.equal(evaluateCell(failedLaunchNews).status, 'PASS', JSON.stringify(evaluateCell(failedLaunchNews), null, 2));
const structuredNewsError = structuredClone(newsReal);
structuredNewsError.taskEvents.find((item) => item.event_id === 'output-0').data.output = { error: 'upstream unavailable' };
assertFailsCheck(structuredNewsError, 'real_tool_semantic');

const realStop = structuredClone(stopInput);
realStop.mode = 'real';
realStop.mockRows = [];
realStop.actionEvidence[0].action_sent_at_ms = 150;
realStop.actionEvidence[0].terminal_observed_after_action = true;
realStop.actionEvidence[0].terminal_event_id = 'killed-primary';
realStop.taskEvents.find((item) => item.event_id === 'assistant-primary').__received_at = 100;
realStop.taskEvents.find((item) => item.event_id === 'killed-primary').__received_at = 200;
assert.equal(evaluateCell(realStop).status, 'PASS', JSON.stringify(evaluateCell(realStop), null, 2));
const staleRealStopTerminal = structuredClone(realStop);
staleRealStopTerminal.taskEvents.find((item) => item.event_id === 'killed-primary').__received_at = 100;
assertFailsCheck(staleRealStopTerminal, 'stop_terminal_after_action');

const abaReal = structuredClone(restartInput);
abaReal.mode = 'real';
abaReal.mockRows = [];
assert.equal(evaluateCell(abaReal).status, 'PASS', JSON.stringify(evaluateCell(abaReal), null, 2));
const missingFinalABACard = structuredClone(abaReal);
missingFinalABACard.dom.assistant_cards = missingFinalABACard.dom.assistant_cards.filter((card) => card.id !== 'assistant-2');
assertFailsCheck(missingFinalABACard, 'real_final_response_in_dom');

const replayPrompt = { ...event('replay-prompt', 'user.prompt', 1, { prompt: EXACT_PROMPTS[0], turn_id: 'replay-turn', acpx_turn_index: 0 }), __received_at: 50 };
const replayAssistant = { ...event('replay-assistant', 'assistant.message', 2, { text: 'partial', acpx_turn_index: 0 }), __received_at: 100 };
const replayTerminal = { ...event('replay-killed', 'task.killed', 3, { reason: 'user_requested', acpx_turn_index: 0 }), __received_at: 200 };
const replayedAssistant = { ...replayAssistant, __received_at: 300 };
const replaySummary = summarizeTaskEvents([replayPrompt, replayAssistant, replayTerminal, replayedAssistant]);
const summarizedAssistant = replaySummary.turns[0].events.find((item) => item.event_id === 'replay-assistant');
assert.equal(summarizedAssistant.__first_received_at, 100);
assert.equal(summarizedAssistant.__last_received_at, 300);

const leaderCode = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(String(child.pid) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
`;
const leader = spawn(process.execPath, ['-e', leaderCode], {
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'ignore'],
});
let grandchildPID = 0;
try {
  grandchildPID = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('grandchild pid timeout')), 2_000);
    leader.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      resolvePromise(Number(String(chunk).trim()));
    });
  });
  assert.ok(grandchildPID > 0);
  await terminateProcessTree(leader, { graceMs: 100, killWaitMs: 2_000 });
  assert.equal(processGroupAlive(leader.pid), false, 'spawned process group must be empty after cleanup');
  const childDeadline = Date.now() + 2_000;
  while (processAlive(grandchildPID) && Date.now() < childDeadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(processAlive(grandchildPID), false, 'grandchild must be gone after process-tree cleanup');
} finally {
  if (processGroupAlive(leader.pid)) {
    try { process.kill(process.platform === 'win32' ? leader.pid : -leader.pid, 'SIGKILL'); } catch {}
  }
  if (processAlive(grandchildPID)) {
    try { process.kill(grandchildPID, 'SIGKILL'); } catch {}
  }
}

const timeoutDir = await mkdtemp(join(tmpdir(), 'conversation-timeout-tree-'));
const timeoutPIDPath = join(timeoutDir, 'grandchild.pid');
try {
  const timeoutCode = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(timeoutPIDPath)}, String(child.pid));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  await assert.rejects(runCommandInProcessGroup(process.execPath, ['-e', timeoutCode], { timeoutMs: 100 }), /timed out/);
  const timeoutGrandchildPID = Number(await readFile(timeoutPIDPath, 'utf8'));
  const timeoutDeadline = Date.now() + 2_000;
  while (processAlive(timeoutGrandchildPID) && Date.now() < timeoutDeadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(processAlive(timeoutGrandchildPID), false, 'runCommand timeout must kill descendant tree');
} finally {
  await rm(timeoutDir, { recursive: true, force: true });
}

console.log('conversation-e2e unit tests: PASS');
