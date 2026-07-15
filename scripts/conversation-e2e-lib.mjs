import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const SCHEMA_VERSION = 1;
export const EXACT_PROMPTS = ['磁盘剩余空间多少', '来点马斯克新闻'];
export const RUNTIMES = ['direct_acp'];

export function classifyWebSocketPayload(data) {
  if (typeof data !== 'string') return 'evidence';
  try {
    const value = JSON.parse(data.trim());
    const type = String(value?.type || '').toLowerCase();
    if (type === 'ping' || type === 'pong') return 'noise';
    if (type === 'server.state') return 'state';
  } catch {}
  return 'evidence';
}

export function captureTaskEventPayload(data) {
  if (typeof data !== 'string') return null;
  try {
    const message = JSON.parse(data.trim());
    if (message?.type !== 'task.event' || !message.payload || typeof message.payload !== 'object') return null;
    const event = message.payload;
    const eventID = String(event.event_id || '');
    const eventType = String(event.event_type || '');
    if (!eventID || !eventType) return null;
    const eventData = event.data && typeof event.data === 'object' ? event.data : {};
    return {
      task_id: String(event.task_id || ''),
      event_id: eventID,
      event_type: eventType,
      rank: Number(eventData._seq ?? event.sequence ?? 0),
      updated_at: Number(eventData._ts ?? event.timestamp ?? 0),
      data_size: JSON.stringify(event.data ?? null).length,
      wait_event: /^(?:user\.prompt|(?:task|turn)\.(?:started|completed|failed|killed|stopped))$/.test(eventType),
      event,
    };
  } catch {
    return null;
  }
}

export function captureWaitTaskEventsPayload(data) {
  if (typeof data !== 'string') return [];
  try {
    const message = JSON.parse(data.trim());
    const found = [];
    const visit = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const eventID = String(value.event_id || '');
      const eventType = String(value.event_type || '');
      if (eventID && /^(?:user\.prompt|(?:task|turn)\.(?:started|completed|failed|killed|stopped))$/.test(eventType)) {
        const eventData = value.data && typeof value.data === 'object' ? value.data : {};
        found.push({
          task_id: String(value.task_id || ''),
          event_id: eventID,
          event_type: eventType,
          rank: Number(eventData._seq ?? value.sequence ?? 0),
          updated_at: Number(eventData._ts ?? value.timestamp ?? 0),
          data_size: JSON.stringify(value.data ?? null).length,
          wait_event: true,
          event: value,
        });
      }
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(message);
    return found;
  } catch {
    return [];
  }
}

export function captureServerStateTasksPayload(data) {
  if (typeof data !== 'string') return [];
  try {
    const message = JSON.parse(data.trim());
    const envelopes = Array.isArray(message) ? message : [message];
    return envelopes.flatMap((envelope) => {
      if (envelope?.type !== 'server.state' || !Array.isArray(envelope?.payload?.tasks)) return [];
      return envelope.payload.tasks.filter((task) => task && typeof task === 'object').map((task) => ({
        task_id: String(task.task_id || ''),
        session_id: String(task.session_id || ''),
        prompt: String(task.prompt || ''),
        status: String(task.status || ''),
        started_at: Number(task.started_at || 0),
        updated_at: Number(task.updated_at || 0),
      }));
    });
  } catch {
    return [];
  }
}

export function processIDsFromProcEntries(entries, ownPID) {
  return (entries || []).filter((entry) => /^\d+$/.test(String(entry)))
    .map((entry) => Number(entry))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== ownPID);
}

export function realTurnProgressSignature(observed) {
  const value = observed && typeof observed === 'object' ? observed : {};
  return JSON.stringify({
    missing: Boolean(value.missing),
    working: Boolean(value.working),
    error: String(value.error || ''),
    assistants: Array.isArray(value.assistants)
      ? value.assistants.map((item) => ({ id: String(item?.id || ''), text: String(item?.text || '') }))
      : [],
    tools: Array.isArray(value.tools)
      ? value.tools.map((item) => ({ id: String(item?.id || ''), status: String(item?.status || '') }))
      : [],
    protocol_revision: Number(value.protocol_revision || 0),
  });
}

export const SCENARIOS = Object.freeze({
  normal: { actions: [], followUp: false },
  stop_followup: { actions: ['stop'], followUp: true },
  reload_followup: { actions: ['reload'], followUp: true },
  restart_followup: { actions: ['restart'], followUp: true },
  stop_reload_followup: { actions: ['stop', 'reload'], followUp: true },
  stop_restart_followup: { actions: ['stop', 'restart'], followUp: true },
  reload_restart_followup: { actions: ['reload', 'restart'], followUp: true },
  stop_reload_restart_followup: { actions: ['stop', 'reload', 'restart'], followUp: true },
});

export function promptFixture(prompt) {
  if (prompt === EXACT_PROMPTS[0]) {
    return {
      prompt,
      toolKind: 'execute',
      toolTitle: 'df -h .',
      toolInput: { command: 'df -h .', cwd: '/workspace' },
      toolOutput: { output: 'mockfs 100G 40G 60G 40% /workspace\n' },
      firstChunk: '磁盘检查进行中。',
      finalChunk: '磁盘检查进行中。当前工作区所在磁盘总计 100G，已用 40G，剩余 60G，使用率 40%。',
    };
  }
  if (prompt === EXACT_PROMPTS[1]) {
    return {
      prompt,
      toolKind: 'fetch',
      toolTitle: 'search: Elon Musk latest news',
      toolInput: { query: 'Elon Musk latest news', max_results: 3 },
      toolOutput: { results: [{ title: 'Mock Musk headline', source: 'Pocket E2E News' }] },
      firstChunk: '正在整理马斯克新闻。',
      finalChunk: '正在整理马斯克新闻。最新模拟新闻：Mock Musk headline（来源 Pocket E2E News）。',
    };
  }
  throw new Error(`unsupported exact prompt: ${prompt}`);
}

function evaluationPromptFixture(prompt) {
  return EXACT_PROMPTS.includes(prompt) ? promptFixture(prompt) : null;
}

export function followUpPrompt(prompt) {
  return prompt === EXACT_PROMPTS[0] ? EXACT_PROMPTS[1] : EXACT_PROMPTS[0];
}

export function conversationTurnPlan(prompt, actions) {
  if (!actions.length) return { prompts: [prompt], action_turn_ordinals: [], recovery_turn_ordinal: 0 };
  const prompts = [];
  const actionTurnOrdinals = actions.map((_, index) => index);
  let currentPrompt = prompt;
  for (let index = 0; index < actions.length; index++) {
    prompts.push(currentPrompt);
    currentPrompt = followUpPrompt(currentPrompt);
  }
  prompts.push(currentPrompt);
  return { prompts, action_turn_ordinals: actionTurnOrdinals, recovery_turn_ordinal: prompts.length - 1 };
}

export function normalizeComparableText(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

function decodeMarkdownEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function normalizeRenderedMarkdownText(value) {
  const blockNormalized = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return '';
      if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) return '';
      const listItem = /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
      const unescapedPipes = (trimmed.match(/(^|[^\\])\|/g) || []).length;
      if (!listItem && unescapedPipes >= 2) {
        return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()).join(' ');
      }
      return line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '');
    })
    .join('\n');
  const inlineNormalized = blockNormalized
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(`+)([\s\S]*?)\1/g, '$2')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(^|[^\\])([*_])([^\n]+?)\2/g, '$1$3')
    .replace(/\\([\\`*{}\[\]()#+\-.!_|>])/g, '$1');
  const listNormalized = inlineNormalized
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, ''))
    .join('\n');
  return normalizeComparableText(decodeMarkdownEntities(listNormalized));
}

export function qualifiedACPAgentConfig(report, agent) {
  const inventoryAgent = agent === 'kilocode' ? 'kilo' : agent;
  const item = report?.inventory?.[inventoryAgent];
  if (!item || typeof item !== 'object') throw new Error(`capability report missing inventory.${inventoryAgent}`);
  const effective = Array.isArray(item.effective_command)
    ? item.effective_command.map((part) => String(part)).filter(Boolean)
    : [];
  const executable = String(item.executable || effective[0] || '').trim();
  if (!executable) throw new Error(`qualified ACP adapter executable missing for ${agent}`);
  const args = effective.length > 0
    ? effective.slice(1)
    : inventoryAgent === 'cursor' ? ['acp'] : [];
  if (effective.length === 0 && inventoryAgent !== 'cursor') {
    throw new Error(`qualified ACP adapter command missing for ${agent}`);
  }
  return {
    registryAgent: inventoryAgent === 'kilo' ? 'kilocode' : inventoryAgent,
    config: {
      command: executable,
      args,
    },
  };
}

export function wrappedACPAgentConfig(config, wrapperCommand) {
  const command = String(wrapperCommand || '').trim();
  if (!command) throw new Error('real adapter wrapper command is required');
  return {
    command,
    args: Array.isArray(config?.args) ? config.args.map((part) => String(part)) : [],
  };
}

export function realAdapterWrapperScript({ command, home, xdgConfigHome }) {
  const executable = String(command || '').trim();
  const realHome = String(home || '').trim();
  const realXDGConfigHome = String(xdgConfigHome || '').trim();
  if (!executable) throw new Error('real adapter command is required');
  if (!realHome || !realXDGConfigHome) {
    throw new Error('real adapter HOME and XDG_CONFIG_HOME are required');
  }
  const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  return [
    '#!/bin/sh',
    'unset FORCE_COLOR',
    `export HOME=${quote(realHome)}`,
    `export XDG_CONFIG_HOME=${quote(realXDGConfigHome)}`,
    'export NO_COLOR=1',
    `exec ${quote(executable)} "$@"`,
    '',
  ].join('\n');
}

export function frameTaskWorkspaceViolations(frames, expectedWorkspace) {
  const expected = resolve(String(expectedWorkspace || ''));
  const violations = [];
  const seen = new Set();
  for (let frameIndex = 0; frameIndex < (frames || []).length; frameIndex++) {
    const frame = frames[frameIndex];
    if (frame?.direction !== 'receive' || typeof frame.data !== 'string') continue;
    let envelope;
    try { envelope = JSON.parse(frame.data); } catch { continue; }
    const payload = envelope?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const candidates = [
      ...(Array.isArray(payload.tasks) ? payload.tasks : []),
      ...(payload.record && typeof payload.record === 'object' ? [payload.record] : []),
      ...(payload.task && typeof payload.task === 'object' ? [payload.task] : []),
    ];
    for (const task of candidates) {
      const taskID = String(task?.task_id || task?.taskId || task?.TaskID || '').trim();
      const workspace = String(task?.workspace_path || task?.workspacePath || task?.WorkspacePath || '').trim();
      if (!taskID || !workspace || resolve(workspace) === expected) continue;
      const key = `${taskID}\0${resolve(workspace)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({
        task_id: taskID,
        workspace_path: workspace,
        frame_index: frameIndex,
        envelope_type: String(envelope.type || ''),
      });
    }
  }
  return violations;
}

export async function waitForProgressCompletion({
  sample,
  isComplete,
  signature = JSON.stringify,
  idleTimeoutMs,
  hardTimeoutMs,
  intervalMs = 100,
  now = Date.now,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
}) {
  if (typeof sample !== 'function' || typeof isComplete !== 'function' || typeof signature !== 'function') {
    throw new Error('progress wait requires sample, isComplete, and signature functions');
  }
  if (!(idleTimeoutMs > 0) || !(hardTimeoutMs >= idleTimeoutMs)) {
    throw new Error('progress wait requires hardTimeoutMs >= idleTimeoutMs > 0');
  }
  const startedAt = now();
  const hardDeadline = startedAt + hardTimeoutMs;
  let idleDeadline = startedAt + idleTimeoutMs;
  let lastSignature;
  for (;;) {
    const sampleDeadline = Math.min(idleDeadline, hardDeadline);
    const sampleTimeoutMessage = hardDeadline <= idleDeadline
      ? `real turn hard timeout after ${hardTimeoutMs}ms`
      : `real turn produced no assistant/tool progress for ${idleTimeoutMs}ms`;
    const sampleBudgetMs = sampleDeadline - now();
    if (sampleBudgetMs <= 0) {
      if (now() >= hardDeadline) throw new Error(`real turn hard timeout after ${hardTimeoutMs}ms`);
      throw new Error(`real turn produced no assistant/tool progress for ${idleTimeoutMs}ms`);
    }
    let sampleTimer;
    let observed;
    try {
      observed = await Promise.race([
        Promise.resolve().then(sample),
        new Promise((_, reject) => {
          sampleTimer = setTimeout(() => reject(new Error(sampleTimeoutMessage)), sampleBudgetMs);
        }),
      ]);
    } finally {
      clearTimeout(sampleTimer);
    }
    if (isComplete(observed)) return observed;
    const currentSignature = String(signature(observed));
    const observedAt = now();
    if (lastSignature === undefined || currentSignature !== lastSignature) {
      lastSignature = currentSignature;
      idleDeadline = observedAt + idleTimeoutMs;
    }
    if (observedAt >= hardDeadline) {
      throw new Error(`real turn hard timeout after ${hardTimeoutMs}ms`);
    }
    if (observedAt >= idleDeadline) {
      throw new Error(`real turn produced no assistant/tool progress for ${idleTimeoutMs}ms`);
    }
    await sleep(Math.min(intervalMs, idleDeadline - observedAt, hardDeadline - observedAt));
  }
}

export function makeMatrix({ runtimes, scenarios, prompts, agent }) {
  const cells = [];
  for (const runtime of runtimes) {
    for (const scenario of scenarios) {
      for (const prompt of prompts) {
        const plan = conversationTurnPlan(prompt, SCENARIOS[scenario].actions);
        cells.push({
          id: `${runtime}__${agent}__${scenario}__${prompt === EXACT_PROMPTS[0] ? 'disk' : 'news'}`,
          runtime,
          agent,
          scenario,
          prompt,
          follow_up_prompt: SCENARIOS[scenario].followUp ? followUpPrompt(prompt) : null,
          actions: [...SCENARIOS[scenario].actions],
          prompt_sequence: plan.prompts,
          action_turn_ordinals: plan.action_turn_ordinals,
          recovery_turn_ordinal: plan.recovery_turn_ordinal,
        });
      }
    }
  }
  return cells;
}

const PORTS_PER_CELL = 3;

export function validateFixedPortPlan(portBase, cellCount) {
  if (!Number.isSafeInteger(portBase) || portBase < 1 || portBase > 65535) {
    throw new Error('port base must be an integer between 1 and 65535');
  }
  if (!Number.isSafeInteger(cellCount) || cellCount < 1) throw new Error('cell count must be a positive integer');
  const totalPorts = cellCount * PORTS_PER_CELL;
  const lastPort = portBase + totalPorts - 1;
  if (lastPort > 65535) throw new Error(`fixed port plan exceeds 65535: ${portBase}-${lastPort}`);
  return {
    port_base: portBase,
    cells: cellCount,
    ports_per_cell: PORTS_PER_CELL,
    first_port: portBase,
    last_port: lastPort,
    total_ports: totalPorts,
  };
}

export function fixedCasePorts(portBase, cellIndex) {
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0) throw new Error('cell index must be a non-negative integer');
  validateFixedPortPlan(portBase, cellIndex + 1);
  const first = portBase + cellIndex * PORTS_PER_CELL;
  return Array.from({ length: PORTS_PER_CELL }, (_, offset) => first + offset);
}

export async function assertPortsAvailable(ports, probe, label = 'fixed port plan') {
  if (!Array.isArray(ports) || ports.length === 0 || new Set(ports).size !== ports.length
    || ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`${label} contains invalid or duplicate ports`);
  }
  if (typeof probe !== 'function') throw new Error(`${label} requires an availability probe`);
  const availability = [];
  for (const port of ports) availability.push({ port, free: await probe(port) });
  const occupied = availability.filter((item) => !item.free).map((item) => item.port);
  if (occupied.length > 0) throw new Error(`${label} unavailable ports: ${occupied.join(', ')}`);
  return { status: 'PASS', ports: [...ports] };
}

export function runtimeAgentPairs(report, { runtimes = RUNTIMES, agent = 'all' } = {}) {
  const selectable = report?.static?.ui_selectable;
  if (!selectable || typeof selectable !== 'object') throw new Error('capability report missing static.ui_selectable');
  if (report?.static_check?.status !== 'PASS' || report?.dynamic_check?.status !== 'PASS') {
    throw new Error(`capability report is not qualified: static=${report?.static_check?.status || 'missing'} dynamic=${report?.dynamic_check?.status || 'missing'}`);
  }
  const declaredTotal = Number(selectable.total);
  const constructedTotal = RUNTIMES.reduce((total, runtime) => total + (Array.isArray(selectable[runtime]) ? selectable[runtime].length : 0), 0);
  if (!Number.isInteger(declaredTotal) || declaredTotal <= 0 || constructedTotal !== declaredTotal) {
    throw new Error(`capability report pair total mismatch: declared=${selectable.total} constructed=${constructedTotal}`);
  }
  const pairs = [];
  for (const runtime of runtimes) {
    const agents = selectable[runtime];
    if (!Array.isArray(agents)) throw new Error(`capability report missing static.ui_selectable.${runtime}`);
    for (const candidate of agents) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      if (agent !== 'all' && candidate !== agent) continue;
      pairs.push({ runtime, agent: candidate });
    }
  }
  if (!pairs.length) throw new Error(`no selectable runtime-agent pairs for agent=${agent}`);
  const pairKeys = pairs.map((pair) => `${pair.runtime}:${pair.agent}`);
  if (new Set(pairKeys).size !== pairKeys.length) throw new Error('capability report contains duplicate runtime-agent pairs');
  return pairs;
}

export function makePairMatrix({ pairs, scenarios, prompts }) {
  return pairs.flatMap((pair) => makeMatrix({
    runtimes: [pair.runtime],
    scenarios,
    prompts,
    agent: pair.agent,
  }));
}

export function summarizeMatrixPlan(matrix) {
  const pairKeys = new Set(matrix.map((cell) => `${cell.runtime}:${cell.agent}`));
  return {
    pairs: pairKeys.size,
    cells: matrix.length,
    expected_prompt_dispatches: matrix.reduce((sum, cell) => sum + cell.prompt_sequence.length, 0),
  };
}

export function summarizeResultProgress(results, { includeHarnessFatal = false } = {}) {
  const completed = Array.isArray(results) ? results : [];
  const passed = completed.filter((result) => result?.status === 'PASS').length;
  const failed = completed.length - passed;
  return {
    total: completed.length + (includeHarnessFatal ? 1 : 0),
    passed,
    failed: failed + (includeHarnessFatal ? 1 : 0),
    completed_cells: completed.length,
    harness_fatal_failures: includeHarnessFatal ? 1 : 0,
  };
}

const managedProcessFailurePatterns = [
  { kind: 'go_panic', pattern: /\bpanic(?::\s|\s+serving\b|\()/i },
  { kind: 'go_fatal', pattern: /fatal error:\s/i },
  { kind: 'node_uncaught', pattern: /\b(?:uncaught(?:exception)?|unhandledpromiserejection|unhandled promise rejection)\b/i },
  { kind: 'fatal_marker', pattern: /(?:^|[\s[])FATAL(?:[:\]\s]|$)/ },
  { kind: 'process_error', pattern: /\[process-error\]/i },
];

export function evaluateManagedProcessLog(processName, text) {
  const findings = [];
  for (const [index, line] of String(text || '').split(/\r?\n/).entries()) {
    const match = managedProcessFailurePatterns.find(({ pattern }) => pattern.test(line));
    if (!match) continue;
    findings.push({
      process: String(processName || ''),
      line_number: index + 1,
      kind: match.kind,
      line: line.trim().slice(0, 1000),
    });
  }
  return {
    process: String(processName || ''),
    status: findings.length === 0 ? 'PASS' : 'FAIL',
    findings,
  };
}

export function evaluateManagedProcessHealth(processName, text, exit = null) {
  const report = evaluateManagedProcessLog(processName, text);
  if (exit && exit.expected === false) {
    report.findings.push({
      process: String(processName || ''),
      line_number: 0,
      kind: 'unexpected_exit',
      line: JSON.stringify({ code: exit.code ?? null, signal: exit.signal ?? null, at: exit.at || '' }),
    });
    report.status = 'FAIL';
  }
  return report;
}

export function managedProcessAlreadyExited({ recordedExit = null, exitCode = null, signalCode = null, alive = true } = {}) {
  return recordedExit !== null || exitCode !== null || signalCode !== null || alive === false;
}

export function summarizeManagedProcessLogs(processes = []) {
  const reports = Array.isArray(processes) ? processes : [];
  const findings = reports.flatMap((report) => Array.isArray(report?.findings) ? report.findings : []);
  return {
    status: reports.every((report) => report?.status === 'PASS') ? 'PASS' : 'FAIL',
    processes: reports,
    findings,
  };
}

export function evaluateNoBuildFreshness({ serverModifiedMs, frontendModifiedMs } = {}) {
  const server = Number(serverModifiedMs);
  const frontend = Number(frontendModifiedMs);
  const valid = Number.isFinite(server) && server > 0 && Number.isFinite(frontend) && frontend > 0;
  const fresh = valid && server >= frontend;
  return {
    status: fresh ? 'PASS' : 'FAIL',
    fresh,
    server_modified_ms: valid ? server : null,
    frontend_modified_ms: valid ? frontend : null,
    reason: fresh ? '' : valid
      ? 'embedded server binary is older than the newest frontend dist asset'
      : 'artifact modification times are unavailable',
  };
}

export function makeQualificationPlan(report) {
  const pairs = runtimeAgentPairs(report, { runtimes: RUNTIMES, agent: 'all' });
  const matrix = makePairMatrix({ pairs, scenarios: Object.keys(SCENARIOS), prompts: EXACT_PROMPTS });
  return {
    ...summarizeMatrixPlan(matrix),
    runtime_agent_pairs: pairs,
    runtimes: [...RUNTIMES],
    scenarios: Object.keys(SCENARIOS),
    exact_prompts: [...EXACT_PROMPTS],
  };
}

function cleanupProcessIdentity(processInfo) {
  return `${processInfo?.pid ?? ''}:${processInfo?.start_ticks ?? ''}`;
}

export function makeCaseOwnedCleanupResult({
  baselineCount = 0,
  naturalExitGraceMs = 0,
  scope = 'case',
  discovered = [],
  termAttempts = [],
  killAttempts = [],
  survivors = [],
} = {}) {
  const survivorKeys = new Set(survivors.map(cleanupProcessIdentity));
  const successfulAttemptKeys = new Set([...termAttempts, ...killAttempts]
    .filter((attempt) => attempt?.sent === true)
    .map((attempt) => String(attempt.identity || '')));
  const terminated = discovered.filter((item) => !survivorKeys.has(cleanupProcessIdentity(item)));
  const confirmedTerminated = terminated.filter((item) => successfulAttemptKeys.has(cleanupProcessIdentity(item)));
  return {
    status: discovered.length === 0 && survivors.length === 0 ? 'PASS' : 'FAIL',
    skipped: false,
    policy: 'strict',
    scope,
    baseline_count: baselineCount,
    natural_exit_grace_ms: naturalExitGraceMs,
    discovered,
    termination_attempts: [...termAttempts, ...killAttempts],
    terminated,
    confirmed_terminated: confirmedTerminated,
    survivors,
  };
}

export function makeTmuxCleanupResult({
  socket = '',
  baseline = null,
  before = null,
  discovered = [],
  kill = { attempted: false, status: null, error: '' },
  after = null,
  survivors = [],
  socketPath = '',
  socketExistsBefore = false,
  socketRemoved = false,
  socketExistsAfter = true,
  socketCleanupError = '',
} = {}) {
  const baselineSessions = Array.isArray(baseline?.panes) ? baseline.panes.length : -1;
  const clean = baseline?.status === 'PASS'
    && before?.status === 'PASS'
    && after?.status === 'PASS'
    && baselineSessions === 0
    && survivors.length === 0
    && after.server_running === false
    && (!kill.attempted || kill.status === 0)
    && socketExistsAfter === false
    && socketCleanupError === '';
  return {
    status: clean ? 'PASS' : 'FAIL',
    socket,
    socket_path: socketPath,
    baseline,
    discovered,
    kill,
    after,
    survivors,
    socket_exists_before_cleanup: socketExistsBefore,
    socket_removed: socketRemoved,
    socket_exists_after: socketExistsAfter,
    socket_cleanup_error: socketCleanupError,
  };
}

const SECRET_PATTERNS = [
  { name: 'aws_query_credential', re: /\b(X-Amz-Credential=)(?:AKIA|ASIA)[A-Z0-9]{16}(?:(?:%2F)|\/)[^&\s"']+/gi, replace: '$1[REDACTED_AWS_CREDENTIAL]' },
  { name: 'aws_query_signature', re: /\b(X-Amz-Signature=)[a-f0-9]{32,}/gi, replace: '$1[REDACTED_AWS_SIGNATURE]' },
  { name: 'aws_credential', re: /\b(Credential=)(?:AKIA|ASIA)[A-Z0-9]{16}\/[0-9]{8}\/[a-z0-9-]+\/[a-z0-9-]+\/aws4_request/gi, replace: '$1[REDACTED_AWS_CREDENTIAL]' },
  { name: 'aws_signature', re: /\b(Signature=)[a-f0-9]{32,}/gi, replace: '$1[REDACTED_AWS_SIGNATURE]' },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: '[REDACTED_AWS_ACCESS_KEY]' },
  { name: 'authorization_json', re: /((?:"|')authorization(?:"|')\s*:\s*")(?:\\.|[^"\\])*(")/gi, replace: '$1[REDACTED]$2' },
  { name: 'authorization_quoted', re: /(["'])(authorization\s*[:=])(?!(?:\s*)\[REDACTED\])(\s*)(?:\\.|(?!\1)[^\\\r\n])*\1/gi, replace: '$1$2$3[REDACTED]$1' },
  { name: 'authorization', re: /\b(authorization\s*[:=])(?!(?:\s*)\[REDACTED\])(\s*)[^\r\n]+/gi, replace: '$1$2[REDACTED]' },
  { name: 'json_secret', re: /("(?:x[-_]api[-_]key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|security[_-]?token|password|cookie|set-cookie)"\s*:\s*")(?:\\.|[^"\\])*(")/gi, replace: '$1[REDACTED]$2' },
  { name: 'cookie', re: /\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, replace: '$1[REDACTED]' },
  { name: 'form_secret', re: /\b((?:x[-_]api[-_]key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|security[_-]?token|password)\s*[:=]\s*)[^&\s,"']+/gi, replace: '$1[REDACTED]' },
  { name: 'bearer', re: /\bbearer\s+[a-z0-9._~+\/-]+=*/gi, replace: 'Bearer [REDACTED]' },
  { name: 'jwt', re: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, replace: '[REDACTED_JWT]' },
  { name: 'api_key', re: /\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)["']?[^\s,"'}]+/gi, replace: '$1[REDACTED]' },
  { name: 'provider_key', re: /\b(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_a-zA-Z0-9]{16,}\b/g, replace: '[REDACTED_KEY]' },
  { name: 'url_credentials', re: /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, replace: '$1[REDACTED]@' },
];

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern.re, pattern.replace);
  return text;
}

const SENSITIVE_ARTIFACT_KEY = /^(?:authorization|proxy[-_]authorization|x[-_]api[-_]key|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|security[_-]?token|token|secret|password|credential|signature|cookie|set-cookie)$/i;

export function redactArtifactValue(value, key = '') {
  if (SENSITIVE_ARTIFACT_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactArtifactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redactArtifactValue(nestedValue, nestedKey)]));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') return JSON.stringify(redactArtifactValue(parsed));
      } catch {}
    }
    return redactSecrets(value);
  }
  return value;
}

export function findSecrets(value) {
  const text = String(value ?? '');
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(text)) !== null) {
      if (!match[0].includes('[REDACTED')) {
        findings.push(pattern.name);
        break;
      }
      if (match[0].length === 0) pattern.re.lastIndex++;
    }
    pattern.re.lastIndex = 0;
  }
  return [...new Set(findings)].sort();
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

export function flattenTaskEvents(value, into = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenTaskEvents(item, into);
    return into;
  }
  if (!value || typeof value !== 'object') return into;
  if (typeof value.event_type === 'string') into.push(value);
  for (const nested of Object.values(value)) flattenTaskEvents(nested, into);
  return into;
}

export function parseJSONLines(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function parseEventData(event) {
  const raw = event?.data;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function logicalEventOrder(event) {
  const data = parseEventData(event);
  const turn = Number(data.acpx_turn_index);
  let order = Number(data._seq);
  if (!Number.isFinite(order)) {
    if (Number.isInteger(turn) && event.event_type === 'user.prompt' && event.source === 'web') order = 1;
    else if (Number.isInteger(turn) && /^(?:task|turn)\.(?:completed|failed|killed|stopped)$/.test(event.event_type)) order = Number.MAX_SAFE_INTEGER;
    else order = Number(event.__first_sequence || event.sequence || 0);
  }
  return {
    task_id: String(event.task_id || ''),
    turn: Number.isInteger(turn) ? turn : null,
    order,
    timestamp: Number(event.timestamp || 0),
    sequence: Number(event.__first_sequence || event.sequence || 0),
  };
}

function sortLogicalTaskEvents(events) {
  return events.map((event, index) => ({ event, index, key: logicalEventOrder(event) }))
    .sort((left, right) => {
      if (left.key.task_id === right.key.task_id) {
        if (left.key.turn !== null && right.key.turn !== null && left.key.turn !== right.key.turn) {
          return left.key.turn - right.key.turn;
        }
        if ((left.key.turn === null) === (right.key.turn === null) && left.key.order !== right.key.order) {
          return left.key.order - right.key.order;
        }
      }
      if (left.key.timestamp !== right.key.timestamp) return left.key.timestamp - right.key.timestamp;
      if (left.key.sequence !== right.key.sequence) return left.key.sequence - right.key.sequence;
      return left.index - right.index;
    })
    .map((item) => item.event);
}

export function summarizeTaskEvents(events) {
  const unique = new Map();
  for (const event of events) {
    const data = parseEventData(event);
    const taskID = String(event.task_id || '');
    const turnIdentity = String(data.turn_id ?? data.acpx_turn_index ?? '');
    let logicalKey = '';
    if (event.event_type === 'user.prompt' && taskID && data.turn_id) logicalKey = `user.prompt:${taskID}:${data.turn_id}`;
    else if (taskID && data.acpx_event_key) logicalKey = `acpx:${taskID}:${data.acpx_event_key}`;
    else if (taskID && (event.event_type === 'assistant.message' || event.event_type === 'assistant.thinking') && data.stream_id) {
      logicalKey = `stream:${taskID}:${turnIdentity}:${event.event_type}:${data.stream_id}`;
    } else if (taskID && (event.event_type === 'tool.call' || event.event_type === 'tool.output') && toolID(data)) {
      logicalKey = `tool:${taskID}:${turnIdentity}:${event.event_type}:${toolID(data)}`;
    }
    const key = logicalKey || event.event_id || `${taskID}:${event.sequence || ''}:${event.event_type}:${JSON.stringify(event.data || null)}`;
    const previous = unique.get(key);
    unique.set(key, {
      ...event,
      event_id: previous?.event_id || event.event_id,
      __first_sequence: previous?.__first_sequence ?? Number(event.sequence || 0),
      __first_received_at: previous?.__first_received_at ?? Number(event.__received_at || 0),
      __last_received_at: Number(event.__received_at || previous?.__last_received_at || 0),
    });
  }
  const list = sortLogicalTaskEvents([...unique.values()]);
  const promptEvents = list.filter((event) => event.event_type === 'user.prompt').map((event, ordinal) => {
    const data = parseEventData(event);
    return {
      ordinal,
      task_id: String(event.task_id || ''),
      turn_id: String(data.turn_id || ''),
      prompt: String(data.prompt || ''),
      acpx_turn_index: Number.isInteger(data.acpx_turn_index) ? data.acpx_turn_index : null,
      event,
    };
  });
  const turns = promptEvents.map((prompt) => ({ ...prompt, events: [], assistant_texts: [], tools: [], terminal_events: [] }));
  const turnByID = new Map(promptEvents.filter((prompt) => prompt.turn_id).map((prompt) => [`${prompt.task_id}:${prompt.turn_id}`, prompt.ordinal]));
  const turnByACPXIndex = new Map(promptEvents.filter((prompt) => prompt.acpx_turn_index !== null).map((prompt) => [`${prompt.task_id}:${prompt.acpx_turn_index}`, prompt.ordinal]));
  const starts = list.flatMap((event) => {
    if (event.event_type !== 'task.started') return [];
    const data = parseEventData(event);
    const ordinal = turnByID.get(`${event.task_id || ''}:${data.turn_id || ''}`);
    return ordinal === undefined ? [] : [{ task_id: String(event.task_id || ''), sequence: event.__first_sequence, ordinal }];
  });
  const resolveTurn = (event) => {
    const data = parseEventData(event);
    const taskID = String(event.task_id || '');
    if (data.turn_id) {
      const ordinal = turnByID.get(`${taskID}:${data.turn_id}`);
      if (ordinal !== undefined) return ordinal;
    }
    if (Number.isInteger(data.acpx_turn_index)) {
      const ordinal = turnByACPXIndex.get(`${taskID}:${data.acpx_turn_index}`);
      if (ordinal !== undefined) return ordinal;
    }
    const sequence = Number(event.__first_sequence || event.sequence || 0);
    const started = starts
      .filter((item) => item.task_id === taskID && item.sequence <= sequence)
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (started) return started.ordinal;
    return turns.length === 1 ? 0 : null;
  };
  for (const event of list) {
    const ordinal = resolveTurn(event);
    if (ordinal === null || !turns[ordinal]) continue;
    const turn = turns[ordinal];
    const data = parseEventData(event);
    turn.events.push(event);
    if (event.event_type === 'assistant.message') turn.assistant_texts.push(String(data.text || ''));
    if (event.event_type === 'tool.call' || event.event_type === 'tool.output') turn.tools.push({
      event_type: event.event_type,
      __first_received_at: event.__first_received_at,
      __last_received_at: event.__last_received_at,
      ...data,
    });
    if (/^(?:task|turn)\.(?:completed|failed|killed|stopped)$/.test(event.event_type)) turn.terminal_events.push(event);
  }
  return {
    events: list,
    event_types: list.map((event) => event.event_type),
    user_prompts: promptEvents.map((event) => event.prompt),
    prompt_events: promptEvents,
    assistant_texts: list.filter((event) => event.event_type === 'assistant.message').map((event) => String(parseEventData(event).text || '')),
    tools: list.filter((event) => event.event_type === 'tool.call' || event.event_type === 'tool.output').map((event) => ({
      event_type: event.event_type,
      ...parseEventData(event),
    })),
    terminal_events: list.filter((event) => /^(?:task|turn)\.(?:completed|failed|killed|stopped)$/.test(event.event_type)),
    turns,
  };
}

function terminalDescription(event) {
  const data = parseEventData(event);
  return `${event.event_type}:${String(data.reason || data.error || '')}`;
}

function turnCompleted(turn) {
  return Boolean(turn?.terminal_events.some((event) => /^(?:task|turn)\.completed$/.test(event.event_type)));
}

function turnInterrupted(turn) {
  return Boolean(turn?.terminal_events.some((event) => {
    if (/^(?:task|turn)\.(?:killed|stopped)$/.test(event.event_type)) return true;
    if (!/^(?:task|turn)\.failed$/.test(event.event_type)) return false;
    const data = parseEventData(event);
    return /interrupt|restart|killed|stopped|user_requested/i.test(String(data.reason || data.error || ''));
  }));
}

function interruptedTerminal(turn) {
  return turn?.terminal_events.find((event) => {
    if (/^(?:task|turn)\.(?:killed|stopped)$/.test(event.event_type)) return true;
    if (!/^(?:task|turn)\.failed$/.test(event.event_type)) return false;
    const data = parseEventData(event);
    return /interrupt|restart|killed|stopped|user_requested/i.test(String(data.reason || data.error || ''));
  });
}

function semanticResponse(prompt, text) {
  const value = String(text || '');
  if (prompt === EXACT_PROMPTS[0]) {
    return /\b\d+(?:\.\d+)?\s*(?:bytes?|[kmgtpe]i?b|[kmgtpe])\b/i.test(value);
  }
  return /(?:马斯克|elon\s+musk|musk)/i.test(value)
    && /(?:https?:\/\/|来源|source|新闻|news|headline|报道|202[5-9])/i.test(value);
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return value.map(canonicalJSON);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJSON(value[key])]));
}

function sameJSON(left, right) {
  return JSON.stringify(canonicalJSON(left)) === JSON.stringify(canonicalJSON(right));
}

function toolID(tool) {
  return String(tool.tool_use_id || tool.tool_call_id || tool.toolCallId || tool.toolCallID || '');
}

function expectedToolPair(turn, fixture) {
  const tools = turn?.tools || [];
  const calls = tools.filter((tool) => tool.event_type === 'tool.call');
  const outputs = tools.filter((tool) => tool.event_type === 'tool.output');
  const matchingCalls = calls.filter((tool) => {
    const title = String(tool.title || tool.name || '');
    return title === fixture.toolTitle
      && String(tool.kind || '') === fixture.toolKind
      && sameJSON(tool.input, fixture.toolInput)
      && toolID(tool);
  });
  const matchingOutputs = matchingCalls.flatMap((call) => outputs.filter((tool) => {
    const title = String(tool.title || tool.name || '');
    return toolID(tool) === toolID(call)
      && title === fixture.toolTitle
      && String(tool.kind || '') === fixture.toolKind
      && sameJSON(tool.input, fixture.toolInput)
      && sameJSON(tool.output, fixture.toolOutput);
  }));
  const call = matchingCalls.length === 1 ? matchingCalls[0] : null;
  const output = call && matchingOutputs.length === 1 ? matchingOutputs[0] : null;
  return { call, output, matchingCalls, matchingOutputs, calls, outputs };
}

function completedToolPairs(turn) {
  const tools = turn?.tools || [];
  const calls = tools.filter((tool) => tool.event_type === 'tool.call' && toolID(tool));
  const outputs = tools.filter((tool) => tool.event_type === 'tool.output' && ['completed', 'success'].includes(String(tool.status || '').toLowerCase()));
  return calls.flatMap((call) => {
    const output = outputs.find((candidate) => toolID(candidate) === toolID(call));
    if (!output) return [];
    const input = nonEmptyToolInput(output.input) ? output.input : call.input;
    const title = String(output.title || output.name || call.title || call.name || '');
    const name = String(output.name || output.title || call.name || call.title || '');
    const kind = String(output.kind || call.kind || '');
    return [{
      call: { ...call, title, name, kind, input },
      output: { ...output, title, name, kind, input },
    }];
  });
}

function nonEmptyToolInput(input) {
  if (typeof input === 'string') return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  return Boolean(input && typeof input === 'object' && Object.keys(input).length > 0);
}

function toolOutputIndicatesFailure(output) {
  if (typeof output === 'string') {
    const text = output.trim();
    try { return toolOutputIndicatesFailure(JSON.parse(text)); } catch {}
    return false;
  }
  if (Array.isArray(output)) return output.some(toolOutputIndicatesFailure);
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  for (const [key, value] of Object.entries(output)) {
    const normalizedKey = key.toLowerCase();
    if (['error', 'errors', 'failure'].includes(normalizedKey) && String(value || '').trim()) return true;
    if (normalizedKey === 'status' && /^(?:failed|error|failure|unauthorized|forbidden|timeout)$/i.test(String(value || '').trim())) return true;
    if (['ok', 'success'].includes(normalizedKey) && value === false) return true;
    if (value && typeof value === 'object' && toolOutputIndicatesFailure(value)) return true;
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value) && toolOutputIndicatesFailure(value)) return true;
  }
  return false;
}

function acpTextContent(output, depth = 0) {
  if (depth > 4) return null;
  if (Array.isArray(output)) {
    if (output.length === 0) return null;
    const chunks = output.map((item) => acpTextContent(item, depth + 1));
    if (chunks.some((chunk) => chunk === null)) return null;
    const text = chunks.join('');
    return text.trim() ? text : null;
  }
  if (!output || typeof output !== 'object') return null;
  const keys = Object.keys(output);
  if (output.type === 'text' && typeof output.text === 'string'
    && keys.every((key) => key === 'type' || key === 'text')) {
    return output.text.trim() ? output.text : null;
  }
  if (output.type === 'content' && keys.every((key) => key === 'type' || key === 'content')) {
    return acpTextContent(output.content, depth + 1);
  }
  const hasOnlyEmptyDetails = output.details === undefined || output.details === null
    || (typeof output.details === 'object' && !Array.isArray(output.details) && Object.keys(output.details).length === 0);
  if (output.type === undefined && Object.hasOwn(output, 'content') && hasOnlyEmptyDetails
    && keys.every((key) => key === 'content' || key === 'details')) {
    return acpTextContent(output.content, depth + 1);
  }
  return null;
}

function isACPContentBlockArray(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => item && typeof item === 'object' && typeof item.type === 'string');
}

function semanticToolOutput(output, depth = 0) {
  if (depth > 8) return output;
  if (typeof output === 'string') {
    const text = output.trim();
    try { return semanticToolOutput(JSON.parse(text), depth + 1); } catch {}
    return output;
  }
  const envelopeText = acpTextContent(output);
  if (envelopeText !== null) return semanticToolOutput(envelopeText, depth + 1);
  if (!output || Array.isArray(output) || typeof output !== 'object') return output;
  if (Array.isArray(output.results)) return output;
  for (const key of ['output', 'data', 'result', 'content']) {
    if (output[key] !== undefined && output[key] !== null) {
      if (key === 'content' && isACPContentBlockArray(output[key])) return output;
      const nested = semanticToolOutput(output[key], depth + 1);
      if (nested !== undefined && nested !== null && nested !== '') return nested;
    }
  }
  return output;
}

function completedWebSearchQueries(output) {
  if (!output || Array.isArray(output) || typeof output !== 'object') return [];
  const action = output.action && !Array.isArray(output.action) && typeof output.action === 'object'
    ? output.action : null;
  if (!action || !['search', 'websearch', 'web_search'].includes(String(action.type || '').toLowerCase())) return [];
  if (!['completed', 'success', 'succeeded', 'done'].includes(String(output.status || '').toLowerCase())) return [];
  const values = [output.query, action.query];
  if (Array.isArray(output.queries)) values.push(...output.queries);
  if (Array.isArray(action.queries)) values.push(...action.queries);
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function realToolPairSemantic(prompt, pair) {
  if (!pair) return false;
  if (!nonEmptyToolInput(pair.call?.input)) return false;
  const callText = JSON.stringify({ title: pair.call.title || pair.call.name, kind: pair.call.kind, input: pair.call.input });
  const rawOutput = pair.output.output ?? pair.output.text ?? pair.output.content ?? null;
  const output = semanticToolOutput(rawOutput);
  const outputText = JSON.stringify(output);
  if (!callText || !outputText || outputText === 'null') return false;
  if (toolOutputIndicatesFailure(output)) return false;
  if (/(?:command not found|not recognized|network failed|connection (?:refused|reset)|unauthorized|forbidden|timed? out|timeout exceeded)/i.test(outputText)) return false;
  if (prompt === EXACT_PROMPTS[0]) {
    return /(?:\bdf\b|lsblk|diskutil|get-psdrive|filesystem|磁盘)/i.test(callText)
      && /\b\d+(?:\.\d+)?\s*(?:bytes?|[kmgtpe]i?b|[kmgtpe])\b/i.test(outputText);
  }
  if (!/(?:马斯克|elon\s+musk|musk)/i.test(callText)) return false;
  const completionQueries = completedWebSearchQueries(output);
  if (completionQueries.some((query) => /(?:马斯克|elon\s+musk|musk)/i.test(query))) return true;
  if (Array.isArray(output?.results)) {
    return output.results.length > 0 && output.results.some((result) => result && typeof result === 'object'
      && ['title', 'source', 'url', 'content', 'snippet'].some((key) => String(result[key] || '').trim().length > 0));
  }
  if (Array.isArray(output)) {
    return output.length > 0 && output.some((result) => result && (typeof result === 'string'
      ? result.trim().length > 0
      : ['title', 'source', 'url', 'content', 'snippet'].some((key) => String(result[key] || '').trim().length > 0)));
  }
  return typeof output === 'string' && output.trim().length > 0
    && /(?:https?:\/\/|来源|source|title|headline|新闻|news)/i.test(output);
}

function realToolPairFingerprint(pair) {
  return JSON.stringify(canonicalJSON({
    title: String(pair.call.title || pair.call.name || ''),
    kind: String(pair.call.kind || ''),
    input: pair.call.input,
    output: pair.output.output ?? pair.output.text ?? pair.output.content ?? null,
  }));
}

function domToolKind(call) {
  const kind = String(call?.kind || '').trim().toLowerCase();
  const input = call?.input && typeof call.input === 'object' ? call.input : {};
  if (['execute', 'bash', 'shell', 'exec', 'exec_command'].includes(kind)
    || ['command', 'cmd', 'script', 'argv'].some((key) => input[key] !== undefined)) return 'bash';
  if (['web_search', 'websearch', 'search'].includes(kind)
    || ['query', 'search_query', 'searchQuery'].some((key) => input[key] !== undefined)) return 'websearch';
  if (['fetch', 'web_fetch', 'webfetch'].includes(kind)
    || ['url', 'uri', 'href'].some((key) => input[key] !== undefined)) return kind === 'fetch' && input.query !== undefined ? 'websearch' : 'webfetch';
  return kind;
}

const OBSERVABLE_TOOL_KINDS = new Set(['bash', 'websearch', 'webfetch']);
const SUCCESS_TOOL_STATUSES = new Set(['completed', 'success', 'succeeded', 'done']);
const FAILURE_TOOL_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'killed', 'stopped']);

function toolStatusGroup(status) {
  const value = String(status || '').trim().toLowerCase();
  if (SUCCESS_TOOL_STATUSES.has(value)) return 'success';
  if (FAILURE_TOOL_STATUSES.has(value)) return 'failure';
  return '';
}

function rawToolOutput(tool) {
  if (!tool || typeof tool !== 'object') return null;
  let fallback = null;
  for (const key of ['output', 'result', 'content', 'data', 'text', 'error', 'errors']) {
    if (tool[key] === undefined || tool[key] === null) continue;
    fallback ??= tool[key];
    if (nonEmptyToolOutput(tool[key])) return tool[key];
  }
  return fallback;
}

function nonEmptyToolOutput(output) {
  if (typeof output === 'string') return output.trim().length > 0;
  if (Array.isArray(output)) return output.length > 0;
  return Boolean(output && typeof output === 'object' && Object.keys(output).length > 0);
}

function observableToolKind(call, output) {
  const input = nonEmptyToolInput(output?.input) ? output.input : call?.input;
  const merged = {
    ...(call || {}),
    ...(output || {}),
    input,
    kind: output?.kind || call?.kind || '',
  };
  const kind = domToolKind(merged);
  if (OBSERVABLE_TOOL_KINDS.has(kind)) return kind;
  return inputCoreValues(input).length > 0 ? kind || 'external' : '';
}

function resultIdentityRequirements(result) {
  if (typeof result === 'string') return result.trim() ? { all: [result.trim()], any_groups: [] } : { all: [], any_groups: [] };
  if (!result || typeof result !== 'object') return { all: [], any_groups: [] };
  const title = ['title', 'headline', 'name'].map((key) => String(result[key] || '').trim()).find(Boolean);
  const provenance = ['url', 'link', 'source'].flatMap((key) => outputTextValues(result[key])).filter(Boolean);
  const fallback = ['content', 'snippet', 'text'].map((key) => String(result[key] || '').trim()).filter(Boolean);
  return {
    all: title ? [title] : [],
    any_groups: provenance.length > 0 ? [provenance] : !title && fallback.length > 0 ? [fallback] : [],
  };
}

export function toolOutputDisplayRequirements(output, kind) {
  const semantic = semanticToolOutput(output);
  const requirements = { all: [], any_groups: [] };
  const append = (next) => {
    requirements.all.push(...next.all);
    requirements.any_groups.push(...next.any_groups);
  };
  const results = Array.isArray(semantic?.results) ? semantic.results : Array.isArray(semantic) ? semantic : null;
  if (kind === 'websearch' && results) {
    for (const result of results) append(resultIdentityRequirements(result));
  } else if (kind === 'websearch') {
    const queries = completedWebSearchQueries(semantic);
    if (queries.length > 0) requirements.any_groups.push(queries);
    else {
      const values = outputTextValues(semantic);
      if (values.length > 0) requirements.any_groups.push(values);
    }
  } else {
    const values = outputTextValues(semantic);
    if (kind === 'bash') requirements.all.push(...values);
    else if (values.length > 0) requirements.any_groups.push(values);
  }
  requirements.all = [...new Set(requirements.all.map((value) => String(value).trim()).filter(Boolean))];
  requirements.any_groups = requirements.any_groups
    .map((group) => [...new Set(group.map((value) => String(value).trim()).filter(Boolean))])
    .filter((group) => group.length > 0);
  return requirements;
}

function displayRequirementsVisible(requirements, text) {
  const normalized = normalizeComparableText(text || '');
  const visible = (value) => {
    const raw = normalizeComparableText(value);
    const escaped = normalizeComparableText(JSON.stringify(String(value)).slice(1, -1));
    return normalized.includes(raw) || normalized.includes(escaped);
  };
  const allVisible = requirements.all.every(visible);
  const groupsVisible = requirements.any_groups.every((group) => group.some(visible));
  return allVisible && groupsVisible && (requirements.all.length > 0 || requirements.any_groups.length > 0);
}

function observableToolDOMEvidence({ call, output, kind, statusGroup }, dom) {
  const input = nonEmptyToolInput(output?.input) ? output.input : call?.input;
  const title = String(output?.title || output?.name || call?.title || call?.name || '');
  const inputValues = inputCoreValues(input);
  const outputRequirements = toolOutputDisplayRequirements(rawToolOutput(output), kind);
  const attributeMatches = (dom?.tools || []).filter((tool) => String(tool.toolId || '') === toolID(call || output || {})
    && String(tool.toolTitle || '') === title
    && String(tool.toolKind || '') === kind
    && toolStatusGroup(tool.toolStatus) === statusGroup);
  const matches = attributeMatches.filter((tool) => inputValues.length > 0
    && inputValues.every((value) => {
      const text = normalizeComparableText(tool.text || '');
      const raw = normalizeComparableText(value);
      const escaped = normalizeComparableText(JSON.stringify(String(value)).slice(1, -1));
      return text.includes(raw) || text.includes(escaped);
    })
    && displayRequirementsVisible(outputRequirements, tool.text || ''));
  return {
    pass: matches.length === 1,
    expected: { id: toolID(call || output || {}), title, kind, status_group: statusGroup, input_values: inputValues, output_requirements: outputRequirements },
    attribute_matches: attributeMatches,
    matches,
  };
}

export function completedObservableToolIntegrity(turn, dom) {
  if (!turnCompleted(turn)) return { pass: true, skipped: true, reason: 'turn is not completed', items: [] };
  const tools = turn?.tools || [];
  const calls = tools.filter((tool) => tool.event_type === 'tool.call');
  const outputs = tools.filter((tool) => tool.event_type === 'tool.output');
  const ids = [...new Set([...calls, ...outputs].map(toolID).filter(Boolean))];
  const items = [];

  for (const tool of [...calls, ...outputs].filter((item) => !toolID(item))) {
    const kind = tool.event_type === 'tool.call' ? observableToolKind(tool, null) : observableToolKind(null, tool);
    if (kind) items.push({ id: '', kind, pass: false, issues: ['missing_tool_id'], call_count: tool.event_type === 'tool.call' ? 1 : 0, output_count: tool.event_type === 'tool.output' ? 1 : 0 });
  }

  for (const id of ids) {
    const matchingCalls = calls.filter((tool) => toolID(tool) === id);
    const matchingOutputs = outputs.filter((tool) => toolID(tool) === id);
    const call = matchingCalls[0] || null;
    const output = matchingOutputs[0] || null;
    const kind = observableToolKind(call, output);
    if (!kind) continue;
    const input = nonEmptyToolInput(output?.input) ? output.input : call?.input;
    const payload = rawToolOutput(output);
    const statusGroup = toolStatusGroup(output?.status);
    const domEvidence = call && output && statusGroup
      ? observableToolDOMEvidence({ call, output, kind, statusGroup }, dom)
      : { pass: false, expected: null, attribute_matches: [], matches: [] };
    const issues = [];
    if (matchingCalls.length !== 1) issues.push(matchingCalls.length === 0 ? 'orphan_output' : 'duplicate_call');
    if (matchingOutputs.length !== 1) issues.push(matchingOutputs.length === 0 ? 'orphan_call' : 'duplicate_output');
    if (!nonEmptyToolInput(input)) issues.push('missing_input');
    if (!statusGroup) issues.push('non_terminal_status');
    if (!nonEmptyToolOutput(payload)) issues.push('missing_output');
    if (!domEvidence.pass) issues.push('dom_mismatch');
    items.push({
      id,
      kind,
      status: String(output?.status || ''),
      status_group: statusGroup,
      call_count: matchingCalls.length,
      output_count: matchingOutputs.length,
      issues,
      dom_evidence: domEvidence,
      pass: issues.length === 0,
    });
  }
  return { pass: items.every((item) => item.pass), skipped: false, items };
}

function inputCoreValues(input, result = []) {
  if (typeof input === 'string') {
    if (input.trim()) result.push(input.trim());
    return result;
  }
  if (Array.isArray(input)) {
    for (const item of input) inputCoreValues(item, result);
    return result;
  }
  if (!input || typeof input !== 'object') return result;
  const coreKeys = new Set(['command', 'cmd', 'script', 'argv', 'query', 'search_query', 'searchquery', 'url', 'uri', 'href']);
  for (const [key, value] of Object.entries(input)) {
    if (coreKeys.has(key.toLowerCase())) inputCoreValues(value, result);
    else if (value && typeof value === 'object') inputCoreValues(value, result);
  }
  return [...new Set(result)];
}

function outputTextValues(output, result = []) {
  if (typeof output === 'string') {
    if (output.trim()) result.push(output.trim());
    return result;
  }
  if (Array.isArray(output)) {
    for (const item of output) outputTextValues(item, result);
    return result;
  }
  if (output && typeof output === 'object') {
    const preferredKeys = ['output', 'stdout', 'stderr', 'text', 'content', 'result', 'results', 'data', 'body', 'response', 'items'];
    const preferredValues = preferredKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(output, key))
      .map((key) => output[key]);
    const values = preferredValues.length > 0 ? preferredValues : Object.values(output);
    for (const value of values) outputTextValues(value, result);
  }
  return [...new Set(result)].sort((left, right) => right.length - left.length);
}

function domToolEvidence(pair, dom) {
  if (!pair?.call || !pair?.output) return { pass: false, expected: null, matches: [] };
  const expected = {
    id: toolID(pair.call),
    title: String(pair.call.title || pair.call.name || ''),
    kind: domToolKind(pair.call),
    status: 'completed|success',
    input_values: inputCoreValues(pair.call.input),
    output_values: outputTextValues(pair.output.output ?? pair.output.text ?? pair.output.content),
  };
  const attributeMatches = (dom?.tools || []).filter((tool) => String(tool.toolId || '') === expected.id
    && String(tool.toolTitle || '') === expected.title
    && String(tool.toolKind || '') === expected.kind
    && ['completed', 'success'].includes(String(tool.toolStatus || '').toLowerCase()));
  const matches = attributeMatches.filter((tool) => {
    const text = normalizeComparableText(tool.text || '');
    const inputVisible = expected.input_values.length > 0
      && expected.input_values.every((value) => text.includes(normalizeComparableText(value)));
    const outputVisible = expected.output_values.length > 0
      && expected.output_values.some((value) => text.includes(normalizeComparableText(value)));
    return inputVisible && outputVisible;
  });
  return { pass: matches.length === 1, expected, attribute_matches: attributeMatches, matches };
}

function realToolEvidence(prompt, pairs, dom) {
  const semanticPairs = pairs.filter((pair) => realToolPairSemantic(prompt, pair));
  const fingerprints = semanticPairs.map(realToolPairFingerprint);
  const duplicateFingerprints = [...new Set(fingerprints.filter((fingerprint, index) => fingerprints.indexOf(fingerprint) !== index))];
  const domEvidence = semanticPairs.map((pair) => domToolEvidence(pair, dom));
  const terminalOK = semanticPairs.length > 0
    && semanticPairs.every((pair) => ['completed', 'success'].includes(String(pair.output?.status || '').toLowerCase()));
  return {
    semanticPairs,
    duplicateFingerprints,
    protocolOK: terminalOK,
    domOK: terminalOK && domEvidence.every((evidence) => evidence.pass),
    domEvidence,
  };
}

function assistantTurnVisibleInDOM(turn, dom) {
  const assistantEvents = (turn?.events || []).filter((event) => event.event_type === 'assistant.message'
    && normalizeRenderedMarkdownText(parseEventData(event).text || ''));
  if (Array.isArray(dom?.assistant_cards)) {
    let previousCardIndex = -1;
    return assistantEvents.length > 0 && assistantEvents.every((event) => {
      const expected = normalizeRenderedMarkdownText(parseEventData(event).text || '');
      const matchingIndexes = [];
      for (let index = 0; index < dom.assistant_cards.length; index++) {
        const card = dom.assistant_cards[index];
        if (String(card.id || '') === String(event.event_id || '')
          && normalizeRenderedMarkdownText(card.text || '').includes(expected)) {
          matchingIndexes.push(index);
        }
      }
      if (!expected || matchingIndexes.length !== 1 || matchingIndexes[0] <= previousCardIndex) return false;
      previousCardIndex = matchingIndexes[0];
      return true;
    });
  }
  const expected = normalizeRenderedMarkdownText((turn?.assistant_texts || []).join(''));
  return Boolean(expected) && normalizeComparableText((dom?.assistant_messages || []).join('')).includes(expected);
}

export function completedTurnEvidence(turn, prompt, mode, dom) {
  const assistantText = (turn?.assistant_texts || []).join(' ');
  const completed = turnCompleted(turn);
  const interrupted = turnInterrupted(turn);
  if (mode === 'mock') {
    const fixture = evaluationPromptFixture(prompt);
    if (!fixture) {
      return {
        completed, interrupted, assistant_text: assistantText,
        assistant_ok: false, assistant_in_dom: false,
        protocol_tool_ok: false, semantic_pair_count: 0,
        dom_tool_ok: false, pair: null,
        dom_evidence: { pass: false, expected: null, matches: [] },
        invalid_prompt: prompt ?? null,
      };
    }
    const pair = expectedToolPair(turn, fixture);
    const exactPair = pair.matchingCalls.length === 1 && pair.matchingOutputs.length === 1 && pair.output
      && ['completed', 'success'].includes(String(pair.output.status || '').toLowerCase()) ? { call: pair.call, output: pair.output } : null;
    const domEvidence = domToolEvidence(exactPair, dom);
    return {
      completed, interrupted, assistant_text: assistantText,
      assistant_ok: normalizeComparableText(assistantText).includes(normalizeComparableText(fixture.finalChunk)),
      assistant_in_dom: assistantTurnVisibleInDOM(turn, dom),
      protocol_tool_ok: Boolean(exactPair), semantic_pair_count: exactPair ? 1 : 0,
      dom_tool_ok: domEvidence.pass, pair: exactPair, dom_evidence: domEvidence,
    };
  }
  const pairs = completedToolPairs(turn);
  const toolEvidence = realToolEvidence(prompt, pairs, dom);
  const observableToolIntegrity = completedObservableToolIntegrity(turn, dom);
  return {
    completed, interrupted, assistant_text: assistantText,
    assistant_ok: semanticResponse(prompt, assistantText),
    assistant_in_dom: assistantTurnVisibleInDOM(turn, dom),
    protocol_tool_ok: toolEvidence.protocolOK,
    semantic_pair_count: toolEvidence.semanticPairs.length,
    duplicate_semantic_fingerprints: toolEvidence.duplicateFingerprints,
    completed_pair_count: pairs.length,
    dom_tool_ok: toolEvidence.domOK,
    pair: toolEvidence.semanticPairs[0] || null,
    pairs: toolEvidence.semanticPairs,
    dom_evidence: toolEvidence.domEvidence,
    observable_tool_integrity: observableToolIntegrity,
  };
}

export function reloadTurnOutcome({ taskEvents = [], taskRecords = [], dom = {}, turn = {}, mode = 'real' } = {}) {
  const summary = summarizeTaskEvents(taskEvents);
  const observed = summary.turns.find((candidate) => turn.turn_id
    ? candidate.turn_id === turn.turn_id
    : candidate.ordinal === turn.ordinal && candidate.prompt === turn.prompt);
  if (observed) {
    const evidence = completedTurnEvidence(observed, turn.prompt, mode, dom);
    if (evidence.interrupted || dom.error || /^(?:failed|error|interrupted)$/i.test(dom.run_status || '')) return 'failed';
    if (evidence.completed) {
	  const toolsSettled = (dom.tools || []).every((tool) => /^(?:completed|success|failed|error)$/i.test(tool.toolStatus || ''));
	  return !dom.working && (dom.assistant_messages || []).length > Number(turn.baseline_assistant_count || 0) && toolsSettled
        ? 'completed' : '';
    }
    return dom.working ? 'running' : '';
  }

  const sessionID = String(turn.task_id || dom.session_id || '');
  const record = taskRecords.find((candidate) => sessionID
    && (String(candidate?.task_id || '') === sessionID || String(candidate?.session_id || '') === sessionID));
  if (!record) return '';
  const status = String(record.status || '').toLowerCase();
  if (dom.error || /^(?:failed|error|interrupted)$/i.test(dom.run_status || '')
    || /^(?:failed|killed|cancelled|stopped|interrupted)$/.test(status)) return 'failed';
  if (/^(?:completed|success)$/.test(status)) {
    const newAssistantText = (dom.assistant_messages || []).slice(Number(turn.baseline_assistant_count || 0)).join(' ');
    const fixture = mode === 'mock' ? evaluationPromptFixture(turn.prompt) : null;
    const assistantComplete = mode === 'mock'
      ? Boolean(fixture) && normalizeComparableText(newAssistantText).includes(normalizeComparableText(fixture.finalChunk))
      : semanticResponse(turn.prompt, newAssistantText);
    const promptVisible = (dom.user_prompts || []).some((prompt) => prompt === turn.prompt);
	const toolsSettled = (dom.tools || []).every((tool) => /^(?:completed|success|failed|error)$/i.test(tool.toolStatus || ''));
	return !dom.working && promptVisible && assistantComplete && toolsSettled ? 'completed' : '';
  }
  return /^(?:created|queued|pending|running|stopping)$/.test(status) && dom.working ? 'running' : '';
}

function historyContains(before, after) {
  const remaining = [...(after || [])];
  for (const prompt of before || []) {
    const index = remaining.indexOf(prompt);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function countTextOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count++;
    offset += needle.length;
  }
  return count;
}

export function assistantHistoryContains(before, after) {
  const remaining = (after || []).map(normalizeComparableText);
  for (const message of before || []) {
    const expected = normalizeComparableText(message);
    const index = remaining.findIndex((candidate) => candidate.includes(expected));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

export function toolHistoryContains(before, after) {
  const afterTools = after || [];
  const ids = afterTools.map((tool) => String(tool.tool_id || '')).filter(Boolean);
  if (new Set(ids).size !== ids.length) return false;
  const allowed = {
    pending: new Set(['pending', 'in_progress', 'running', 'completed', 'success', 'failed', 'error', 'cancelled']),
    in_progress: new Set(['in_progress', 'running', 'completed', 'success', 'failed', 'error', 'cancelled']),
    running: new Set(['running', 'in_progress', 'completed', 'success', 'failed', 'error', 'cancelled']),
    completed: new Set(['completed', 'success']),
    success: new Set(['completed', 'success']),
  };
  return (before || []).every((tool) => {
    const matches = afterTools.filter((candidate) => candidate.tool_id === tool.tool_id);
    if (matches.length !== 1) return false;
    const beforeStatus = String(tool.status || '').toLowerCase();
    const afterStatus = String(matches[0].status || '').toLowerCase();
    const activeBefore = /^(?:pending|in_progress|running)$/.test(beforeStatus);
    if (!activeBefore && (matches[0].title !== tool.title || matches[0].kind !== tool.kind)) return false;
    return !allowed[beforeStatus] || allowed[beforeStatus].has(afterStatus);
  });
}

function providerDiagnosticText(value) {
  const text = String(value || '').trim();
  if (/^Reconnecting\.\.\. \d+\/\d+$/.test(text)) return text;
  const prefix = 'Warning: Model metadata for ';
  const suffix = ' not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
  if (!text.startsWith(prefix)) return '';
  const suffixIndex = text.indexOf(suffix, prefix.length);
  return suffixIndex < 0 ? '' : text.slice(0, suffixIndex + suffix.length);
}

export function evaluateCell(input = {}) {
  let { cell, mode = 'mock', dom, taskEvents, mockRows = [], actionEvidence = [] } = input;
  cell = { actions: [], action_turn_ordinals: [], prompt_sequence: [], ...(cell && typeof cell === 'object' ? cell : {}) };
  dom = dom && typeof dom === 'object' ? dom : { working: true, error: 'DOM evidence missing' };
  taskEvents = Array.isArray(taskEvents) ? taskEvents : [];
  mockRows = Array.isArray(mockRows) ? mockRows : [];
  actionEvidence = Array.isArray(actionEvidence) ? actionEvidence : [];
  const checks = [];
  const summary = summarizeTaskEvents(taskEvents);
  const expectedPrompts = Array.isArray(cell.prompt_sequence) && cell.prompt_sequence.length
    ? cell.prompt_sequence
    : cell.follow_up_prompt ? [cell.prompt, cell.follow_up_prompt] : [cell.prompt];
  const finalPrompt = expectedPrompts.at(-1);
  const expectedFinal = mode === 'mock' ? evaluationPromptFixture(finalPrompt) : null;
  let mockTurnOrdinal = -1;
  const mockRowsByTurn = mockRows.map((row) => {
    if (row.type === 'prompt') mockTurnOrdinal++;
    return { ...row, __turn_ordinal: mockTurnOrdinal };
  });
  const mockPrompts = mockRowsByTurn.filter((row) => row.type === 'prompt').map((row) => row.prompt);
  const promptCounts = Object.fromEntries(expectedPrompts.map((prompt) => [prompt, summary.user_prompts.filter((item) => item === prompt).length]));
  const mockPromptCounts = Object.fromEntries(expectedPrompts.map((prompt) => [prompt, mockPrompts.filter((item) => item === prompt).length]));
  const domPromptCounts = Object.fromEntries(expectedPrompts.map((prompt) => [prompt, (dom.user_prompts || []).filter((item) => normalizeComparableText(item) === normalizeComparableText(prompt)).length]));
  const assistantText = (dom.assistant_messages || []).join('\n');
  const comparableAssistantText = normalizeComparableText(assistantText);
  const finalTurn = summary.turns.findLast((turn) => turn.prompt === finalPrompt);
  const primaryTurn = summary.turns.find((turn) => turn.prompt === cell.prompt);
  const finalAssistantText = (finalTurn?.assistant_texts || []).join(' ');
  const finalEvidence = completedTurnEvidence(finalTurn, finalPrompt, mode, dom);
  const noStartupDiagnostics = !/(?:^|\n)pi v\d|(?:^|\n)Skills\s*\n|\.pi\/agent\/skills\//i.test(assistantText);
  const protocolProviderDiagnostics = summary.events
    .filter((event) => event.event_type === 'assistant.message')
    .map((event) => ({ event_id: event.event_id, text: String(parseEventData(event).text || '') }))
    .filter((event) => providerDiagnosticText(event.text));
  const domProviderDiagnostics = [
    ...(dom.assistant_messages || []).map((text, index) => ({ source: 'assistant_messages', index, text: String(text || '') })),
    ...(dom.assistant_cards || []).map((card, index) => ({ source: 'assistant_cards', index, text: String(card?.text || '') })),
  ].filter((entry) => providerDiagnosticText(entry.text));

  const add = (name, pass, actual, expected) => checks.push({ name, pass: Boolean(pass), actual, expected });
  if (mode === 'mock') {
    const fixtureAvailability = expectedPrompts.map((prompt) => ({ prompt: prompt ?? null, available: Boolean(evaluationPromptFixture(prompt)) }));
    add('mock_prompt_fixtures_available', fixtureAvailability.every((item) => item.available), fixtureAvailability, 'all declared prompts have deterministic fixtures');
  }
  for (const prompt of [...new Set(expectedPrompts)]) {
    const expectedCount = expectedPrompts.filter((item) => item === prompt).length;
    add(`event_prompt_exact_once:${prompt}`, promptCounts[prompt] === expectedCount, promptCounts[prompt], expectedCount);
    add(`dom_prompt_exact_once:${prompt}`, domPromptCounts[prompt] === expectedCount, domPromptCounts[prompt], expectedCount);
    if (mode === 'mock') add(`mock_prompt_exact_once:${prompt}`, mockPromptCounts[prompt] === expectedCount, mockPromptCounts[prompt], expectedCount);
  }
  if (mode === 'mock') {
    const pair = expectedFinal ? expectedToolPair(finalTurn, expectedFinal) : { call: null, output: null, matchingCalls: [], matchingOutputs: [] };
    add('final_assistant_complete', finalEvidence.assistant_ok && finalEvidence.assistant_in_dom, {
      turn_text: finalEvidence.assistant_text, dom_cards: dom.assistant_cards || dom.assistant_messages || [],
    }, expectedFinal?.finalChunk || 'supported exact prompt fixture');
    add('tool_call_exact', Boolean(expectedFinal) && pair.matchingCalls.length === 1, pair.matchingCalls, expectedFinal ? { count: 1, title: expectedFinal.toolTitle, kind: expectedFinal.toolKind, input: expectedFinal.toolInput, tool_id: 'non-empty' } : 'supported exact prompt fixture');
    add('tool_output_exact', Boolean(expectedFinal) && pair.matchingOutputs.length === 1 && Boolean(pair.output), pair.matchingOutputs, expectedFinal ? { count: 1, tool_id: toolID(pair.call || {}), title: expectedFinal.toolTitle, kind: expectedFinal.toolKind, input: expectedFinal.toolInput, output: expectedFinal.toolOutput } : 'supported exact prompt fixture');
    add('tool_terminal_status', ['completed', 'success'].includes(String(pair.output?.status || '').toLowerCase()), pair.output?.status || '', 'completed|success');
    add('tool_dom_exact', finalEvidence.dom_tool_ok, finalEvidence.dom_evidence, 'one same-ID/title/kind terminal DOM card');
  } else {
    add('real_no_mock_protocol', mockRows.length === 0, mockRows, 'no mock protocol rows in real mode');
    const pairs = completedToolPairs(finalTurn);
    const toolEvidence = realToolEvidence(finalPrompt, pairs, dom);
    add('real_final_response_semantic', finalEvidence.assistant_ok, finalAssistantText, `semantic answer for ${finalPrompt}`);
    add('real_final_response_in_dom', finalEvidence.assistant_in_dom, { assistant_text: finalAssistantText, dom: dom.assistant_messages || [] }, 'ordered final-turn assistant chunks visible in DOM');
    add('real_tool_pair_completed', pairs.length > 0, pairs, 'same-ID call/output completed pair');
    add('real_tool_semantic', toolEvidence.protocolOK, {
      pairs: toolEvidence.semanticPairs,
      duplicate_fingerprints: toolEvidence.duplicateFingerprints,
    }, `one or more semantic final-turn tool pairs for ${finalPrompt}`);
    add('tool_terminal_status', toolEvidence.semanticPairs.length > 0
      && toolEvidence.semanticPairs.every((pair) => ['completed', 'success'].includes(String(pair.output?.status || '').toLowerCase())),
    toolEvidence.semanticPairs.map((pair) => pair.output.status), 'every semantic pair completed|success');
    add('real_tool_dom_exact', finalEvidence.dom_tool_ok, finalEvidence.dom_evidence, 'one same-ID/title/kind/input/output terminal DOM card per semantic pair');
    add('real_observable_tool_integrity', finalEvidence.observable_tool_integrity?.pass, finalEvidence.observable_tool_integrity, 'every observable completed-turn tool has one same-ID terminal output and truthful DOM card');
    const completedTurnSemantics = summary.turns.filter(turnCompleted).map((turn) => {
      const evidence = completedTurnEvidence(turn, turn.prompt, mode, dom);
      return { ordinal: turn.ordinal, prompt: turn.prompt, assistant_ok: evidence.assistant_ok,
        tool_ok: evidence.protocol_tool_ok, assistant_in_dom: evidence.assistant_in_dom,
        dom_tool_ok: evidence.dom_tool_ok, semantic_pair_count: evidence.semantic_pair_count,
        dom_evidence: evidence.dom_evidence, observable_tool_integrity: evidence.observable_tool_integrity };
    });
    add('real_all_completed_turns_semantic', completedTurnSemantics.length > 0
      && completedTurnSemantics.every((turn) => turn.assistant_ok && turn.tool_ok && turn.assistant_in_dom && turn.dom_tool_ok), completedTurnSemantics, 'every completed action/recovery turn has semantic assistant and exact terminal tool cards in DOM/history');
    add('real_all_completed_turn_tools_integrity', completedTurnSemantics.length > 0
      && completedTurnSemantics.every((turn) => turn.observable_tool_integrity?.pass), completedTurnSemantics, 'every completed turn has complete observable tool lifecycles and truthful DOM cards');
  }
  add('final_turn_completed', turnCompleted(finalTurn), finalTurn?.terminal_events.map(terminalDescription) || [], 'task.completed|turn.completed');
  const domToolIDs = (dom.tools || []).map((tool) => String(tool.toolId || '')).filter(Boolean);
  add('dom_tool_ids_unique', new Set(domToolIDs).size === domToolIDs.length, domToolIDs, 'unique tool ids');
  const domAssistantMessages = (dom.assistant_messages || []).map(normalizeComparableText).filter(Boolean);
  const domAssistantTimeline = domAssistantMessages.join('');
  if (mode === 'mock') {
    const assistantTurnCounts = [...new Set(expectedPrompts)].map((prompt) => {
      const turns = summary.turns.filter((turn) => turn.prompt === prompt);
      const completed = turns.filter(turnCompleted).length;
      const fixture = evaluationPromptFixture(prompt);
      const finalText = normalizeComparableText(fixture?.finalChunk);
      const firstText = normalizeComparableText(fixture?.firstChunk);
      return {
        prompt,
        fixture_available: Boolean(fixture),
        turns: turns.length,
        completed,
        dom_first_chunks: countTextOccurrences(domAssistantTimeline, firstText),
        dom_final_chunks: countTextOccurrences(domAssistantTimeline, finalText),
      };
    });
    add('mock_assistant_turn_counts', assistantTurnCounts.every((item) => item.fixture_available && item.dom_first_chunks === item.turns && item.dom_final_chunks === item.completed), assistantTurnCounts, 'assistant partial/full card counts match visible/completed turns by prompt');
    const completedToolChecks = summary.turns.filter(turnCompleted).map((turn) => {
      const fixture = evaluationPromptFixture(turn.prompt);
      const pair = fixture ? expectedToolPair(turn, fixture) : { call: null, output: null, matchingCalls: [], matchingOutputs: [] };
      const exactPair = pair.matchingCalls.length === 1 && pair.matchingOutputs.length === 1 && pair.output ? { call: pair.call, output: pair.output } : null;
      const domEvidence = domToolEvidence(exactPair, dom);
      const assistantInDOM = assistantTurnVisibleInDOM(turn, dom);
      const domMatches = fixture ? (dom.tools || []).filter((tool) => String(tool.toolId || '') === toolID(pair.output || pair.call || {})
        && tool.toolTitle === fixture.toolTitle && tool.toolKind === domToolKind(pair.call)
        && ['completed', 'success'].includes(String(tool.toolStatus || '').toLowerCase())) : [];
      return { ordinal: turn.ordinal, prompt: turn.prompt, fixture_available: Boolean(fixture), call_count: pair.matchingCalls.length, output_count: pair.matchingOutputs.length, terminal_status: pair.output?.status || '', dom_count: domMatches.length, dom_evidence: domEvidence, assistant_in_dom: assistantInDOM };
    });
    add('mock_all_completed_turn_tools_exact', completedToolChecks.every((item) => item.fixture_available && item.call_count === 1 && item.output_count === 1
      && ['completed', 'success'].includes(String(item.terminal_status).toLowerCase()) && item.dom_count === 1
      && item.assistant_in_dom), completedToolChecks, 'every completed turn has one exact same-ID tool pair, assistant cards, and one completed DOM tool card');
  }
  add('ui_not_working', dom.working === false, dom.working, false);
  add('ui_no_error', !dom.error, dom.error || '', '');
  add('no_startup_diagnostics', noStartupDiagnostics, assistantText, 'no Pi startup diagnostics');
  add('no_provider_diagnostics_in_protocol_assistant', protocolProviderDiagnostics.length === 0, protocolProviderDiagnostics, 'provider diagnostics appear only as raw events');
  add('no_provider_diagnostics_in_dom', domProviderDiagnostics.length === 0, domProviderDiagnostics, 'provider diagnostics are not rendered as assistant messages');

  for (let actionIndex = 0; actionIndex < cell.actions.length; actionIndex++) {
    const action = cell.actions[actionIndex];
    const evidence = actionEvidence.find((entry) => entry.action === action);
    add(`action_observed:${action}`, evidence?.status === 'observed', evidence || null, 'observed');
    add(`action_precondition:${action}`, evidence?.before?.working === true, evidence?.before?.working, true);
    const precondition = evidence?.preconditions || {};
    const assistantAdvanced = Number(precondition.assistant_count_after) > Number(precondition.assistant_count_before);
    const toolAdvanced = Number(precondition.tool_count_after) > Number(precondition.tool_count_before);
    const activityObservedAt = Number(precondition.activity_observed_at_ms || 0);
    const actionSentAt = Number(evidence?.action_sent_at_ms || 0);
    add(`action_first_activity:${action}`, precondition.first_activity === true, precondition, 'first assistant/tool activity observed');
    add(`action_activity_advanced:${action}`, assistantAdvanced || toolAdvanced, precondition, 'assistant or tool count advanced from the pre-send baseline');
    add(`action_after_first_activity:${action}`, activityObservedAt > 0 && actionSentAt >= activityObservedAt, {
      activity_observed_at_ms: activityObservedAt,
      action_sent_at_ms: actionSentAt,
    }, 'action dispatched at or after observed first activity');
    const actionTurn = summary.turns[evidence?.target_turn_ordinal];
    add(`action_target_turn:${action}`, Boolean(actionTurn && actionTurn.prompt === evidence?.target_prompt
      && (!evidence?.target_turn_id || actionTurn.turn_id === evidence.target_turn_id)
      && cell.action_turn_ordinals?.[actionIndex] === evidence?.target_turn_ordinal), {
      evidence: { ordinal: evidence?.target_turn_ordinal, prompt: evidence?.target_prompt, turn_id: evidence?.target_turn_id },
      observed: actionTurn ? { ordinal: actionTurn.ordinal, prompt: actionTurn.prompt, turn_id: actionTurn.turn_id } : null,
    }, 'action bound to observed active turn');
    if (action === 'reload') {
      const targetTurn = summary.turns[evidence?.target_turn_ordinal];
      add('reload_epoch_advanced', evidence?.after?.frame_epoch > evidence?.before?.frame_epoch, evidence, 'after epoch > before epoch');
      add('reload_session_preserved', Boolean(evidence?.before?.session_id) && evidence?.after?.session_id === evidence?.before?.session_id, evidence, 'same non-empty session');
      add('reload_history_recovered', historyContains(evidence?.before?.user_prompts, evidence?.after?.user_prompts), evidence, 'pre-reload prompts restored');
      add('reload_assistant_history_recovered', assistantHistoryContains(evidence?.before?.assistant_messages, evidence?.after?.assistant_messages), evidence, 'pre-reload assistant text preserved exactly or extended');
      add('reload_tool_history_recovered', toolHistoryContains(evidence?.before?.tools, evidence?.after?.tools), evidence, 'pre-reload tool identities preserved without duplicates or status regression');
      add('reload_socket_reconnected', Number(evidence?.after?.agent_socket_open_count || 0) > 0, {
        matched: evidence?.after?.agent_socket_count || 0, opened: evidence?.after?.agent_socket_open_count || 0,
      }, 'opened /ws/agent socket for restored session/task');
      add('reload_target_turn_completed', turnCompleted(targetTurn), targetTurn?.terminal_events.map(terminalDescription) || [], 'reload target completes successfully');
      if (mode === 'mock') {
        const targetPrompt = targetTurn?.prompt || evidence?.target_prompt;
        const targetFixture = evaluationPromptFixture(targetPrompt);
        const pair = targetTurn && targetFixture ? expectedToolPair(targetTurn, targetFixture) : null;
        add('reload_target_tool_preserved', Boolean(pair?.output), pair || { target_prompt: targetPrompt ?? null, fixture_available: Boolean(targetFixture), target_turn_present: Boolean(targetTurn) }, 'turn-scoped exact tool call/output survives reload');
      } else {
        const pairs = completedToolPairs(targetTurn);
        add('reload_target_tool_preserved', pairs.some((pair) => realToolPairSemantic(targetTurn?.prompt, pair)), pairs, 'turn-scoped semantic tool call/output survives reload');
      }
    }
    if (action === 'restart') {
      add('restart_generation_advanced', evidence?.after?.daemon_generation === evidence?.before?.daemon_generation + 1, evidence, 'generation + 1');
      add('restart_pid_changed', Number(evidence?.before?.daemon_pid || 0) > 0 && evidence?.after?.daemon_pid !== evidence?.before?.daemon_pid, evidence, 'new daemon pid');
      add('restart_new_daemon_online', Number(evidence?.after?.daemon_online_at_ms || 0) >= Number(evidence?.action_sent_at_ms || 0), evidence, 'new generation observed online after restart');
      add('restart_session_preserved', Boolean(evidence?.before?.session_id) && evidence?.after?.session_id === evidence?.before?.session_id, evidence, 'same non-empty session');
      add('restart_history_recovered', historyContains(evidence?.before?.user_prompts, evidence?.after?.user_prompts)
        && assistantHistoryContains(evidence?.before?.assistant_messages, evidence?.after?.assistant_messages)
        && toolHistoryContains(evidence?.before?.tools, evidence?.after?.tools), evidence, 'pre-restart conversation history restored');
      const targetTurn = summary.turns[evidence?.target_turn_ordinal];
      add('restart_old_turn_terminal', turnInterrupted(targetTurn), targetTurn?.terminal_events.map(terminalDescription) || [], 'killed|stopped|interrupted');
    }
  }

  if (cell.actions.includes('stop')) {
    const stopEvidence = actionEvidence.find((entry) => entry.action === 'stop');
    const stopTurn = summary.turns[stopEvidence?.target_turn_ordinal];
    const primaryFixture = mode === 'mock' ? evaluationPromptFixture(stopTurn?.prompt || cell.prompt) : null;
    const precondition = stopEvidence?.preconditions || {};
    add('stop_observed_working', precondition.working === true, precondition, 'working=true');
    add('stop_observed_first_activity', precondition.first_activity === true, precondition, 'first assistant/tool activity');
    if (mode === 'mock') {
      add('stop_observed_mock_barrier', precondition.mock_barrier === true, precondition, 'mock barrier reached');
      const mockCancelRows = mockRowsByTurn.filter((row) => row.type === 'cancel');
      const directTerminalEvidence = cell.runtime === 'direct_acp'
        && stopEvidence?.terminal_observed_after_action === true
        && (!stopEvidence?.terminal_event_id || stopEvidence.terminal_event_id === interruptedTerminal(stopTurn)?.event_id);
      add('stop_protocol_cancel', cell.runtime === 'direct_acp'
        ? directTerminalEvidence
        : mockCancelRows.some((row) => row.__turn_ordinal === stopEvidence?.target_turn_ordinal), {
        runtime: cell.runtime,
        cancel_rows: mockCancelRows,
        terminal_observed_after_action: stopEvidence?.terminal_observed_after_action === true,
        terminal_event_id: interruptedTerminal(stopTurn)?.event_id || '',
        evidence_terminal_event_id: stopEvidence?.terminal_event_id || '',
      }, cell.runtime === 'direct_acp' ? 'correlated backend interrupted terminal' : 'cancel for stopped turn');
      const stoppedAssistant = normalizeComparableText((stopTurn?.assistant_texts || []).join(''));
      const stoppedFinal = normalizeComparableText(primaryFixture?.finalChunk);
      add('stop_target_fixture_available', Boolean(primaryFixture), stopTurn?.prompt || cell.prompt || null, 'supported exact prompt fixture');
      add('stop_primary_final_absent', !stoppedAssistant.includes(stoppedFinal), stopTurn?.assistant_texts || [], 'no stopped-turn final chunk in turn-scoped events');
      add('stop_mock_primary_not_completed', !mockRowsByTurn.some((row) => row.type === 'completed' && row.__turn_ordinal === stopEvidence?.target_turn_ordinal), mockRowsByTurn.filter((row) => row.__turn_ordinal === stopEvidence?.target_turn_ordinal), 'no stopped-turn completed row');
      add('stop_primary_tool_not_completed', !(stopTurn?.tools || []).some((tool) => ['completed', 'success'].includes(String(tool.status || '').toLowerCase())), stopTurn?.tools || [], 'no completed stopped-turn tool at deterministic barrier');
    } else {
      const boundary = Number(stopEvidence?.action_sent_at_ms || 0);
      const terminal = interruptedTerminal(stopTurn);
      const terminalAt = Number(terminal?.__first_received_at || 0);
      const lateAssistant = (stopTurn?.events || []).filter((event) => event.event_type === 'assistant.message' && Number(event.__first_received_at || 0) > terminalAt);
      add('stop_terminal_after_action', stopEvidence?.terminal_observed_after_action === true
        && boundary > 0 && terminalAt >= boundary
        && (!stopEvidence?.terminal_event_id || stopEvidence.terminal_event_id === terminal?.event_id), {
        action_dispatched: boundary > 0, action_sent_at_ms: boundary, terminal_received_at_ms: terminalAt,
        terminal_event_id: terminal?.event_id || '', evidence_terminal_event_id: stopEvidence?.terminal_event_id || '',
      }, 'new correlated interrupted terminal observed after stop action');
      add('stop_no_late_primary_activity', terminalAt > 0 && lateAssistant.length === 0, { terminal_at: terminalAt, late_assistant: lateAssistant }, 'no primary assistant completion after interrupted terminal');
    }
    add('stop_primary_terminal', turnInterrupted(stopTurn), stopTurn?.terminal_events.map(terminalDescription) || [], 'killed|stopped|interrupted');
    add('stop_no_late_primary_completion', !turnCompleted(stopTurn), stopTurn?.terminal_events.map(terminalDescription) || [], 'no completed terminal');
  }
  if (cell.actions.length > 0) {
    add('actual_turn_plan_matches_declared', sameJSON(cell.actual_turn_plan, {
      prompts: cell.prompt_sequence,
      action_turn_ordinals: cell.action_turn_ordinals,
      recovery_turn_ordinal: cell.recovery_turn_ordinal,
    }), cell.actual_turn_plan || null, {
      prompts: cell.prompt_sequence,
      action_turn_ordinals: cell.action_turn_ordinals,
      recovery_turn_ordinal: cell.recovery_turn_ordinal,
    });
    const recoveryOrdinal = cell.recovery_turn_ordinal;
    add('follow_up_new_turn', Boolean(finalTurn && summary.turns.length === expectedPrompts.length && finalTurn.ordinal === recoveryOrdinal), summary.turns.map((turn) => ({ prompt: turn.prompt, turn_id: turn.turn_id })), `recovery turn ordinal ${recoveryOrdinal}`);
    if (mode === 'mock') add('follow_up_completed', finalEvidence.completed && finalEvidence.assistant_ok && finalEvidence.assistant_in_dom
      && finalEvidence.protocol_tool_ok && finalEvidence.dom_tool_ok, finalEvidence, finalPrompt);
    else add('follow_up_completed', finalEvidence.completed && finalEvidence.assistant_ok && finalEvidence.assistant_in_dom
      && finalEvidence.protocol_tool_ok && finalEvidence.dom_tool_ok, finalEvidence, finalPrompt);
  }
  if (mode === 'mock' && cell.actions.length === 1 && cell.actions[0] === 'reload') {
    const primaryFixture = evaluationPromptFixture(cell.prompt);
    add('reload_primary_completed', turnCompleted(primaryTurn)
      && Boolean(primaryFixture)
      && comparableAssistantText.includes(normalizeComparableText(primaryFixture?.finalChunk)), {
      terminal_events: primaryTurn?.terminal_events.map(terminalDescription) || [], assistant_text: assistantText,
    }, 'reload-only primary turn completes with full message');
  }
  return {
    status: checks.every((check) => check.pass) ? 'PASS' : 'FAIL',
    checks,
    observed: {
      prompt_counts: promptCounts,
      dom_prompt_counts: domPromptCounts,
      mock_prompt_counts: mockPromptCounts,
      assistant_text: assistantText,
      tool_events: summary.tools,
      terminal_event_types: summary.terminal_events.map((event) => event.event_type),
      turns: summary.turns.map((turn) => ({
        prompt: turn.prompt,
        turn_id: turn.turn_id,
        assistant_texts: turn.assistant_texts,
        tools: turn.tools,
        terminal_events: turn.terminal_events.map(terminalDescription),
      })),
      dom,
    },
  };
}
