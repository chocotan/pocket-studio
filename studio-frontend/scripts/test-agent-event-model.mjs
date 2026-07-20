import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

function taskEvent(eventId, eventType, sequence, timestamp, data) {
  return {
    task_id: 'task-1',
    event_id: eventId,
    event_type: eventType,
    source: 'test',
    sequence,
    timestamp,
    data: JSON.stringify(data),
  };
}

try {
  const eventModel = await vite.ssrLoadModule('/src/components/studio/agent-chat/event-model.ts');
  const reducer = await vite.ssrLoadModule('/src/components/studio/agent-chat/message-reducer.ts');
  const agentProtocol = await vite.ssrLoadModule('/src/lib/agent-protocol.ts');
  const chatWidgets = await vite.ssrLoadModule('/src/components/studio/agent-chat/chat-widgets.tsx');
  const dispatchPayload = await vite.ssrLoadModule('/src/components/studio/agent-chat/dispatch-payload.ts');
  const directACPDispatch = dispatchPayload.buildDirectACPDispatchPayload({
    taskId: 'task-model',
    turnId: 'turn-model',
    workspacePath: '/workspace',
    agent: 'codex',
    prompt: 'keep the session model',
    attachments: [],
    sessionName: 'session-model',
    modelId: 'stale-model-from-tab',
  });
  assert.equal(
    'model_id' in directACPDispatch,
    false,
    'Direct ACP prompts must not override the WS session model with persisted tab state',
  );
  const user = taskEvent('user', 'user.prompt', 1, 200, {
    prompt: '磁盘剩余空间多少', turn_id: 'turn-0', acpx_turn_index: 0, acpx_event_key: 'turn:0:user.prompt:0',
  });
  const start = taskEvent('start', 'task.started', 2, 150, {
    _seq: 2, turn_id: 'turn-0', acpx_turn_index: 0, acpx_event_key: 'turn:0:task.started:0',
  });
  const call = taskEvent('call', 'tool.call', 4, 500, {
    _seq: 4, acpx_turn_index: 0, acpx_event_key: 'turn:0:tool.call:tool-1',
    tool_use_id: 'tool-1', title: 'bash', name: 'bash', kind: 'execute', status: 'pending', input: { command: 'df -h' },
  });
  const first = taskEvent('first', 'assistant.message', 5, 400, {
    _seq: 5, acpx_turn_index: 0, acpx_event_key: 'turn:0:assistant.message:0',
    stream_id: 'assistant-1', replace: true, text: '磁盘检查进行中。',
  });
  const output = taskEvent('output', 'tool.output', 13, 300, {
    _seq: 6, acpx_turn_index: 0, acpx_event_key: 'turn:0:tool.output:tool-1',
    tool_use_id: 'tool-1', title: 'bash', name: 'bash', kind: 'execute', status: 'completed',
    input: { command: 'df -h' }, output: { output: 'Filesystem Size Used Avail Use% /dev/sda 100G 40G 60G 40%' },
  });
  const tail = taskEvent('tail', 'assistant.message', 14, 100, {
    _seq: 7, acpx_turn_index: 0, acpx_event_key: 'turn:0:assistant.message:1',
    stream_id: 'assistant-2', replace: true, text: '当前磁盘剩余 60G。',
  });
  const done = taskEvent('done', 'task.completed', 17, 50, {
    _seq: 10, acpx_turn_index: 0, acpx_event_key: 'turn:0:task.completed:0', exit_code: 0,
  });

  let merged = [];
  for (const event of [tail, done, user, start, call, first, output]) {
    merged = eventModel.mergeTaskEvents(merged, [event]);
  }
  assert.deepEqual(
    eventModel.sortTaskEventsForDisplay(merged).map((event) => event.event_id),
    ['user', 'start', 'call', 'first', 'output', 'tail', 'done'],
    'live completion arriving before history must still follow ACP logical order',
  );

  const state = reducer.buildMessageStateFromEvents(merged, 'task-1');
  const imageAttachment = {
    type: 'image', name: 'photo.png', path: 'photo.png', mime_type: 'image/png',
  };
  const localImagePrompt = eventModel.makeLocalUserPromptEvent(
    'task-image', 'turn-image', 'describe this', 1, undefined, [imageAttachment],
  );
  const localImageMessage = reducer.buildMessageStateFromEvents([localImagePrompt], 'task-image').messages[0];
  assert.deepEqual(
    localImageMessage.attachments,
    [imageAttachment],
    'optimistic user messages must retain image attachments',
  );
  const imagePromptEcho = taskEvent('image-echo', 'user.prompt', 2, 201, {
    prompt: 'describe this', turn_id: 'turn-image', attachments: [imageAttachment],
  });
  const echoedImageMessage = reducer.buildMessageStateFromEvents(
    [localImagePrompt, imagePromptEcho],
    'task-image',
  ).messages[0];
  assert.equal(echoedImageMessage.id, 'image-echo');
  assert.deepEqual(
    echoedImageMessage.attachments,
    [imageAttachment],
    'server prompt history must retain image attachments',
  );
  const legacyEcho = taskEvent('legacy-image-echo', 'user.prompt', 2, 201, {
    prompt: 'describe this', turn_id: 'turn-image',
  });
  assert.deepEqual(
    reducer.buildMessageStateFromEvents([localImagePrompt, legacyEcho], 'task-image').messages[0].attachments,
    [imageAttachment],
    'an older server echo must not erase optimistic image attachments',
  );
  assert.deepEqual(
    state.messages.filter((message) => message.kind === 'assistant_message').map((message) => message.content),
    ['磁盘检查进行中。', '当前磁盘剩余 60G。'],
  );
  const whitespaceAssistant = taskEvent('assistant-whitespace', 'assistant.message', 15, 110, {
    _seq: 8, acpx_turn_index: 0, acpx_event_key: 'turn:0:assistant.message:whitespace',
    stream_id: 'assistant-whitespace-stream', replace: true, text: '\n\n',
  });
  assert.deepEqual(
    reducer.buildMessageStateFromEvents([...merged, whitespaceAssistant], 'task-1').messages
      .filter((message) => message.kind === 'assistant_message').map((message) => message.content),
    ['磁盘检查进行中。', '当前磁盘剩余 60G。'],
    'whitespace-only assistant events must not render empty message cards',
  );
  assert.equal(state.runStartedAtMs, 0, 'history task.started must not reopen a completed turn');
  assert.deepEqual(
    eventModel.getTaskRunTiming(merged, 'acpx'),
    {
      activeStartedAtMs: 0, latestStartedTurnId: 'turn-0', latestStartedEventId: 'start',
      latestTerminalTurnId: 'turn-0', latestTerminalEventId: 'done',
    },
    'terminal history must retain which turn start was observed while reporting no active run',
  );
  const liveTurnOneStart = taskEvent('live-turn-1-start', 'task.started', 20, 700, {
    _seq: 20, turn_id: 'turn-1', acpx_turn_index: 1, acpx_event_key: 'turn:1:task.started:0',
  });
  const syntheticFutureStart = taskEvent('synthetic-future-start', 'task.started', 3, 701, {
    source: 'acpx.history', turn_id: 'history-turn-0', acpx_turn_index: 2,
    acpx_event_key: 'turn:2:task.started:0',
  });
  const syntheticFutureDone = taskEvent('synthetic-future-done', 'task.completed', 10, 702, {
    source: 'acpx.history', turn_id: 'history-turn-0', acpx_turn_index: 2,
    acpx_event_key: 'turn:2:task.completed:0', stop_reason: 'history',
  });
  assert.equal(
    eventModel.getTaskRunTiming([
      ...merged, liveTurnOneStart, syntheticFutureStart, syntheticFutureDone,
    ], 'acpx').activeStartedAtMs,
    700000,
    'synthetic history lifecycle must not hide a real active turn with a lower turn index',
  );
  const liveTurnOneDone = taskEvent('live-turn-1-done', 'task.completed', 21, 703, {
    _seq: 21, turn_id: 'turn-1', acpx_turn_index: 1, acpx_event_key: 'turn:1:task.completed:0',
  });
  assert.equal(
    eventModel.getTaskRunTiming([
      ...merged, liveTurnOneStart, syntheticFutureStart, syntheticFutureDone, liveTurnOneDone,
    ], 'acpx').activeStartedAtMs,
    0,
    'the real terminal must close the active turn even when synthetic future history is present',
  );
  assert.equal(
    state.messages.find((message) => message.kind === 'tool_call')?.toolCall?.status,
    'completed',
    'tool output must follow the call and render terminal',
  );

  const replayedSearchCall = taskEvent('search-call', 'tool.call', 17, 800, {
    _seq: 10, acpx_turn_index: 0, acpx_event_key: 'turn:0:tool.call:search-1',
    tool_use_id: 'search-1', name: 'Web search', kind: 'search', status: 'in_progress',
    input: { type: 'webSearch', query: '', action: { type: 'other' } },
  });
  const liveSearchOutput = taskEvent('search-output', 'tool.output', 8, 801, {
    _seq: 9, acpx_turn_index: 0, acpx_event_key: 'turn:0:tool.output:search-1',
    tool_use_id: 'search-1', name: 'Web search: Elon Musk latest news', kind: 'search', status: 'completed',
    input: { type: 'webSearch', query: 'Elon Musk latest news', action: { type: 'search' } },
    output: { type: 'webSearch', query: 'Elon Musk latest news', status: 'completed' },
  });
  assert.deepEqual(
    eventModel.sortTaskEventsForDisplay([liveSearchOutput, replayedSearchCall]).map((event) => event.event_id),
    ['search-call', 'search-output'],
    'a replayed tool call must stay before its live output even when provider logical sequence regresses',
  );
  const recoveredSearch = reducer.buildMessageStateFromEvents(
    [liveSearchOutput, replayedSearchCall],
    'task-1',
  ).messages.find((message) => message.kind === 'tool_call')?.toolCall;
  assert.equal(recoveredSearch?.title, 'Web search: Elon Musk latest news');
  assert.deepEqual(recoveredSearch?.input, {
    type: 'webSearch', query: 'Elon Musk latest news', action: { type: 'search' },
  });
  assert.deepEqual(recoveredSearch?.output, {
    type: 'webSearch', query: 'Elon Musk latest news', status: 'completed',
  });
  assert.equal(recoveredSearch?.status, 'completed');

  const openCodeToolItems = agentProtocol.buildAgentToolCallItems([
    {
      id: 'opencode-call', seq: 1, kind: 'tool_call', content: '', createdAt: '2026-07-14T00:00:00.000Z',
      metadata: {
        tool_use_id: 'opencode-tool-1', title: 'df -h', kind: 'execute', status: 'pending',
        input: { command: 'df -h' },
      },
    },
    {
      id: 'opencode-output', seq: 2, kind: 'tool_call', content: '', createdAt: '2026-07-14T00:00:01.000Z',
      metadata: {
        tool_use_id: 'opencode-tool-1', status: 'completed',
        output: { output: 'Filesystem Size Used Avail Use% /dev/sda 475G 204G 247G 46%' },
      },
    },
  ]);
  assert.equal(openCodeToolItems.length, 1);
  assert.equal(
    openCodeToolItems[0].kind,
    'bash',
    'a final OpenCode tool.output without kind/input must preserve the canonical command kind from tool.call',
  );
  assert.equal(
    agentProtocol.resolveAgentToolKind(openCodeToolItems[0]),
    'bash',
    'the DOM data-tool-kind resolver must use the same canonical command kind',
  );
  const piTextOutput = {
    content: [{ type: 'text', text: 'Filesystem Size Used Avail\n/dev/sda 475G 204G 247G\n' }],
  };
  assert.equal(
    chatWidgets.readableToolOutput(piTextOutput),
    'Filesystem Size Used Avail\n/dev/sda 475G 204G 247G\n',
    'Pi ACP text content must render as terminal text instead of protocol JSON',
  );
  assert.equal(
    chatWidgets.readableToolOutput({ content: [{ type: 'content', content: { type: 'text', text: 'nested output' } }] }),
    'nested output',
    'nested ACP content wrappers must preserve text order',
  );
  const mixedPiOutput = { content: [
    { type: 'text', text: 'visible text' },
    { type: 'image', url: 'https://example.test/image.png' },
  ] };
  assert.equal(
    chatWidgets.readableToolOutput(mixedPiOutput),
    JSON.stringify(mixedPiOutput, null, 2),
    'mixed ACP content must remain structured so unknown evidence is not discarded',
  );

  const claudeSearchItems = agentProtocol.buildAgentToolCallItems([
    {
      id: 'claude-search-call', seq: 1, kind: 'tool_call', content: 'websearch', createdAt: '2026-07-14T00:00:00.000Z',
      metadata: {
        jsonrpc: '2.0', method: 'session/update', tool_use_id: 'claude-search-1',
        name: '"Elon Musk news July 2026"', kind: 'fetch', status: 'pending', input: { query: 'Elon Musk news July 2026' },
        params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'claude-search-1', _meta: { claudeCode: { toolName: 'WebSearch' } } } },
      },
    },
    {
      id: 'claude-search-output', seq: 2, kind: 'tool_call', content: 'websearch', createdAt: '2026-07-14T00:00:01.000Z',
      metadata: {
        jsonrpc: '2.0', method: 'session/update', tool_use_id: 'claude-search-1',
        name: '"Elon Musk news July 2026"', kind: 'fetch', status: 'completed', input: { query: 'Elon Musk news July 2026' },
        output: 'Musk search results',
        params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'claude-search-1', status: 'completed', rawOutput: 'Musk search results', _meta: { claudeCode: { toolName: 'WebSearch' } } } },
      },
    },
  ]);
  assert.equal(claudeSearchItems.length, 1);
  assert.equal(claudeSearchItems[0].title, '"Elon Musk news July 2026"', 'generic WebSearch updates must preserve the call title');
  assert.equal(agentProtocol.resolveAgentToolKind(claudeSearchItems[0]), 'websearch');
  assert.deepEqual(claudeSearchItems[0].input, { query: 'Elon Musk news July 2026' });
  assert.equal(claudeSearchItems[0].output, 'Musk search results');

  const codexSearchInput = {
    type: 'webSearch', id: 'codex-search-1', query: 'Elon Musk latest news July 15 2026',
    action: {
      type: 'search', query: 'Elon Musk latest news July 15 2026',
      queries: ['Elon Musk latest news July 15 2026', 'Elon Musk latest Reuters July 2026'],
    },
  };
  const codexSearchOutput = {
    type: 'webSearch', status: 'completed', action: codexSearchInput.action,
    query: codexSearchInput.query, queries: codexSearchInput.action.queries,
  };
  const codexSearchItems = agentProtocol.buildAgentToolCallItems([
    {
      id: 'codex-search-call', seq: 1, kind: 'tool_call', content: 'Web search', createdAt: '2026-07-14T00:00:00.000Z',
      metadata: {
        tool_use_id: 'codex-search-1', name: 'Web search: Elon Musk latest news July 15 2026', kind: 'search',
        status: 'completed', input: codexSearchInput, output: null,
      },
    },
    {
      id: 'codex-search-output', seq: 2, kind: 'tool_call', content: 'Web search', createdAt: '2026-07-14T00:00:01.000Z',
      metadata: {
        tool_use_id: 'codex-search-1', name: 'Web search: Elon Musk latest news July 15 2026', kind: 'search',
        status: 'completed', input: codexSearchInput, output: codexSearchOutput,
      },
    },
  ]);
  assert.equal(codexSearchItems.length, 1, 'a completed Codex webSearch raw item must become one merged tool card');
  assert.equal(codexSearchItems[0].title, 'Web search: Elon Musk latest news July 15 2026');
  assert.equal(agentProtocol.resolveAgentToolKind(codexSearchItems[0]), 'websearch');
  assert.deepEqual(codexSearchItems[0].input, codexSearchInput);
  assert.deepEqual(codexSearchItems[0].output, codexSearchOutput, 'the card must show provider completion metadata without invented results');

  const codexTerminalItems = agentProtocol.buildAgentToolCallItems([
    {
      id: 'codex-terminal-call', seq: 1, kind: 'tool_call', content: 'Terminal', createdAt: '2026-07-14T00:00:00.000Z',
      metadata: {
        jsonrpc: '2.0', method: 'session/update', tool_use_id: 'codex-terminal-1', name: 'df -h .', kind: 'execute',
        status: 'in_progress', input: { command: 'df -h .', cwd: '/workspace' },
        params: { update: { sessionUpdate: 'tool_call', toolCallId: 'codex-terminal-1', title: 'df -h .', kind: 'execute', rawInput: { command: 'df -h .', cwd: '/workspace' } } },
      },
    },
    {
      id: 'codex-terminal-delta', seq: 2, kind: 'tool_call', content: 'Terminal', createdAt: '2026-07-14T00:00:01.000Z',
      metadata: {
        jsonrpc: '2.0', method: 'session/update', tool_use_id: 'codex-terminal-1', name: 'df -h .', kind: 'execute',
        status: 'in_progress', input: { command: 'df -h .', cwd: '/workspace' }, output: 'Filesystem Size Used Avail\n', append: true,
        params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'codex-terminal-1', _meta: { terminal_output_delta: { data: 'Filesystem Size Used Avail\n', terminal_id: 'codex-terminal-1' } } } },
      },
    },
    {
      id: 'codex-terminal-output', seq: 3, kind: 'tool_call', content: 'Terminal', createdAt: '2026-07-14T00:00:02.000Z',
      metadata: {
        jsonrpc: '2.0', method: 'session/update', tool_use_id: 'codex-terminal-1', name: 'df -h .', kind: 'execute',
        status: 'completed', input: { command: 'df -h .', cwd: '/workspace' }, output: { formatted_output: 'Filesystem Size Used Avail\n', exit_code: 0 },
        params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'codex-terminal-1', status: 'completed', rawOutput: { formatted_output: 'Filesystem Size Used Avail\n', exit_code: 0 } } },
      },
    },
  ]);
  assert.equal(codexTerminalItems.length, 1);
  assert.equal(codexTerminalItems[0].title, 'df -h .', 'terminal deltas must preserve the concrete command title');
  assert.equal(agentProtocol.resolveAgentToolKind(codexTerminalItems[0]), 'bash');
  assert.deepEqual(codexTerminalItems[0].input, { command: 'df -h .', cwd: '/workspace' });
  assert.equal(String(codexTerminalItems[0].output).includes('Filesystem Size Used Avail'), true);

  const liveStart = { ...start, sequence: 9, timestamp: 250 };
  const replayedStart = { ...start, sequence: 2, timestamp: 150 };
  const replayMerge = eventModel.mergeTaskEvents([liveStart], [replayedStart]);
  assert.equal(replayMerge[0].sequence, 9, 'same-ID history replay must not lower transport sequence');
  assert.equal(replayMerge[0].timestamp, 250, 'same-ID history replay must not lower transport timestamp');

  const historyDone = taskEvent('history-done', 'task.completed', 6, 600, {
    acpx_turn_index: 0, acpx_event_key: 'turn:0:task.completed:0', exit_code: 0,
  });
  assert.deepEqual(
    eventModel.sortTaskEventsForDisplay([first, historyDone]).map((event) => event.event_id),
    ['first', 'history-done'],
    'history terminal without _seq must remain after live content with _seq',
  );

  const sameTimestamp = 700;
  const oldUser = { ...user, timestamp: sameTimestamp };
  const oldTail = { ...tail, timestamp: sameTimestamp };
  const oldDone = { ...done, timestamp: sameTimestamp };
  const newLocal = {
    ...eventModel.makeLocalUserPromptEvent('task-1', 'turn-1', '来点马斯克新闻', 18, 1),
    timestamp: sameTimestamp,
  };
  const newStart = taskEvent('start-1', 'task.started', 19, sameTimestamp, {
    _seq: 2, turn_id: 'turn-1', acpx_turn_index: 1, acpx_event_key: 'turn:1:task.started:0',
  });
  const newDone = taskEvent('done-1', 'task.completed', 20, sameTimestamp, {
    _seq: 10, turn_id: 'turn-1', acpx_turn_index: 1, acpx_event_key: 'turn:1:task.completed:0', exit_code: 0,
  });
  assert.deepEqual(
    eventModel.sortTaskEventsForDisplay([oldUser, oldTail, oldDone, newLocal, newStart]).map((event) => event.event_id),
    ['user', 'tail', 'done', newLocal.event_id, 'start-1'],
    'indexed optimistic prompt must stay after the previous turn and before its own start at the same timestamp',
  );
  assert.deepEqual(
    eventModel.getTaskRunTiming([oldUser, oldTail, oldDone, newLocal, newStart, newDone], 'acpx'),
    {
      activeStartedAtMs: 0, latestStartedTurnId: 'turn-1', latestStartedEventId: 'start-1',
      latestTerminalTurnId: 'turn-1', latestTerminalEventId: 'done-1',
    },
    'a batched start and terminal must identify the awaited turn without leaving it active',
  );
  const oldActiveTiming = eventModel.getTaskRunTiming([oldUser, start], 'acpx');
  assert.equal(
    eventModel.taskRunTimingMatchesAwaitedTurn(oldActiveTiming, 'turn-1', 'start'),
    false,
    'an active previous turn must not acknowledge an optimistic queued turn',
  );
  const oldTerminalTiming = eventModel.getTaskRunTiming([oldUser, start, oldDone, newLocal], 'acpx');
  assert.equal(
    eventModel.taskRunTimingMatchesAwaitedTurn(oldTerminalTiming, 'turn-1', 'start'),
    false,
    'the previous turn terminal must preserve the awaited new turn',
  );
  const newActiveTiming = eventModel.getTaskRunTiming([oldUser, start, oldDone, newLocal, newStart], 'acpx');
  assert.equal(
    eventModel.taskRunTimingMatchesAwaitedTurn(newActiveTiming, 'turn-1', 'start'),
    true,
    'only the matching new start may acknowledge the awaited turn',
  );
  const terminalWithoutStart = taskEvent('done-without-start', 'task.completed', 20, sameTimestamp, {
    acpx_turn_index: 1, acpx_event_key: 'turn:1:task.completed:0', exit_code: 0,
  });
  const terminalOnlyTiming = eventModel.getTaskRunTiming([oldUser, start, oldDone, newLocal, terminalWithoutStart], 'acpx');
  assert.equal(
    eventModel.taskRunTimingMatchesAwaitedTurn(terminalOnlyTiming, 'turn-1', 'start'),
    true,
    'a matching terminal must acknowledge the awaited turn when its start is absent',
  );
  const startWithoutTurn = taskEvent('start-without-turn', 'task.started', 30, sameTimestamp, {});
  const fallbackTiming = eventModel.getTaskRunTiming([oldUser, start, oldDone, newLocal, startWithoutTurn], 'direct_acp');
  assert.equal(
    eventModel.taskRunTimingMatchesAwaitedTurn(fallbackTiming, 'direct-turn-1', 'start'),
    true,
    'a new start event id is the explicit fallback when the transport omits turn_id',
  );
  const killedWithoutTurnId = taskEvent('killed-without-turn-id', 'task.killed', 7, sameTimestamp, {
    _seq: 7, acpx_turn_index: 0, acpx_event_key: 'turn:0:task.killed:0', reason: 'user_requested',
  });
  const completedWithoutTurnId = taskEvent('completed-without-turn-id', 'task.completed', 18, sameTimestamp, {
    _seq: 18, acpx_turn_index: 1, acpx_event_key: 'turn:1:task.completed:0', exit_code: 0,
  });
  const thirdLocal = {
    ...eventModel.makeLocalUserPromptEvent('task-1', 'turn-2', '磁盘剩余空间多少', 21, 2),
    timestamp: sameTimestamp,
  };
  const thirdStart = taskEvent('start-2', 'task.started', 25, sameTimestamp, {
    _seq: 20, turn_id: 'turn-2', acpx_turn_index: 2, acpx_event_key: 'turn:2:task.started:0',
  });
  const replayedMultiTurn = [
    oldUser, start, killedWithoutTurnId,
    newLocal, newStart, completedWithoutTurnId,
    thirdLocal, thirdStart,
  ];
  const thirdActiveTiming = eventModel.getTaskRunTiming(replayedMultiTurn, 'acpx');
  assert.ok(thirdActiveTiming.activeStartedAtMs > 0, 'a new indexed start must remain active after older no-turn-id terminals replay');
  assert.equal(thirdActiveTiming.latestStartedTurnId, 'turn-2');
  assert.equal(thirdActiveTiming.latestTerminalTurnId, 'turn-1', 'terminal turn id must be recovered from its own turn index');
  assert.equal(
    eventModel.taskRunTimingMatchesAwaitedTurn(thirdActiveTiming, 'turn-2', 'start-1'),
    true,
    'the awaited third turn must acknowledge its matching start after reload history',
  );
  const thirdCompleted = taskEvent('done-2', 'task.completed', 33, sameTimestamp, {
    _seq: 26, acpx_turn_index: 2, acpx_event_key: 'turn:2:task.completed:0', exit_code: 0,
  });
  const thirdTerminalTiming = eventModel.getTaskRunTiming([...replayedMultiTurn, thirdCompleted], 'acpx');
  assert.equal(thirdTerminalTiming.activeStartedAtMs, 0, 'the third turn terminal must clear working');
  assert.equal(thirdTerminalTiming.latestTerminalTurnId, 'turn-2');
  const directEvent = (event, turnId) => {
    const data = JSON.parse(event.data);
    delete data._seq;
    delete data.acpx_turn_index;
    delete data.acpx_event_key;
    data.turn_id = turnId;
    return { ...event, data: JSON.stringify(data), timestamp: sameTimestamp };
  };
  const directOldUser = directEvent({ ...user, sequence: 1 }, 'direct-turn-0');
  const directOldTail = directEvent({ ...tail, sequence: 14 }, 'direct-turn-0');
  const directOldDone = directEvent({ ...done, sequence: 17 }, 'direct-turn-0');
  const directNewLocal = {
    ...eventModel.makeLocalUserPromptEvent('task-1', 'direct-turn-1', '来点马斯克新闻', 18),
    timestamp: sameTimestamp,
  };
  const directNewStart = directEvent(taskEvent('direct-start-1', 'task.started', 19, sameTimestamp, {}), 'direct-turn-1');
  assert.deepEqual(
    eventModel.sortTaskEventsForDisplay([directOldUser, directOldTail, directOldDone, directNewLocal, directNewStart]).map((event) => event.event_id),
    ['user', 'tail', 'done', directNewLocal.event_id, 'direct-start-1'],
    'Direct ACP remains transport ordered when all events are intentionally unindexed',
  );

  const directRestartOldStart = taskEvent('direct-restart-old-start', 'task.started', 20, 1_000, {
    _seq: 15, turn_id: 'direct-restart-old-turn',
  });
  const directRestartSyntheticFailure = taskEvent('direct-restart-old-failed', 'task.failed', 26, 1_001, {
    turn_id: 'direct-restart-old-turn', error: 'task interrupted: daemon no longer running this task', reason: 'interrupted',
  });
  const directRestartPrompt = taskEvent('direct-restart-prompt', 'user.prompt', 27, 1_003, {
    prompt: '磁盘剩余空间多少', turn_id: 'direct-restart-recovery-turn',
  });
  directRestartPrompt.source = 'web';
  const directRestartRecoveryStart = taskEvent('direct-restart-recovery-start', 'task.started', 32, 1_004, {
    _seq: 25, turn_id: 'direct-restart-recovery-turn',
  });
  const directRestartActiveTiming = eventModel.getTaskRunTiming([
    directRestartOldStart,
    directRestartSyntheticFailure,
    directRestartPrompt,
    directRestartRecoveryStart,
  ], 'direct_acp');
  assert.ok(
    directRestartActiveTiming.activeStartedAtMs > 0,
    'Direct ACP recovery start must remain active when its producer _seq is lower than an older synthetic terminal transport sequence',
  );
  assert.equal(directRestartActiveTiming.latestStartedTurnId, 'direct-restart-recovery-turn');
  assert.equal(directRestartActiveTiming.latestTerminalTurnId, 'direct-restart-old-turn');
  assert.equal(
    eventModel.taskRunTimingMatchesAwaitedTurn(
      directRestartActiveTiming,
      'direct-restart-recovery-turn',
      'direct-restart-old-start',
    ),
    true,
    'Direct ACP recovery start must acknowledge the awaited turn after daemon replacement',
  );
  const directRestartRecoveryDone = taskEvent('direct-restart-recovery-done', 'task.completed', 42, 1_005, {
    _seq: 35,
  });
  assert.equal(
    eventModel.getTaskRunTiming([
      directRestartOldStart,
      directRestartSyntheticFailure,
      directRestartPrompt,
      directRestartRecoveryStart,
      directRestartRecoveryDone,
    ], 'direct_acp').activeStartedAtMs,
    0,
    'Direct ACP recovery terminal must clear working after the recovered turn completes',
  );

  const mixedDirectUser = taskEvent('mixed-direct-user', 'user.prompt', 1, sameTimestamp, {
    prompt: '来点马斯克新闻', turn_id: 'mixed-direct-turn-0',
  });
  const mixedDirectStart = taskEvent('mixed-direct-start', 'task.started', 7, sameTimestamp, {
    _seq: 4, turn_id: 'mixed-direct-turn-0', agent_runtime: 'direct_acp',
  });
  const mixedDirectCall = taskEvent('mixed-direct-call', 'tool.call', 10, sameTimestamp, {
    _seq: 7, acpx_turn_index: 0, acpx_event_key: 'turn:0:tool.call:mixed-direct-tool',
    tool_use_id: 'mixed-direct-tool', title: 'search: Elon Musk latest news', name: 'search',
    kind: 'fetch', status: 'pending', input: { query: 'Elon Musk latest news' },
  });
  const mixedDirectMessage = taskEvent('mixed-direct-message', 'assistant.message', 11, sameTimestamp, {
    _seq: 8, stream_id: 'mixed-direct-stream', replace: true, text: '正在整理马斯克新闻。',
  });
  const mixedDirectOutput = taskEvent('mixed-direct-output', 'tool.output', 12, sameTimestamp, {
    _seq: 8, acpx_turn_index: 0, acpx_event_key: 'turn:0:tool.output:mixed-direct-tool',
    tool_use_id: 'mixed-direct-tool', title: 'search: Elon Musk latest news', name: 'search',
    kind: 'fetch', status: 'completed', input: { query: 'Elon Musk latest news' },
    output: { results: [{ title: 'Mock Musk headline' }] },
  });
  const mixedDirectDone = taskEvent('mixed-direct-done', 'task.completed', 13, sameTimestamp, {
    _seq: 9, exit_code: 0,
  });
  const mixedDirectEvents = [
    mixedDirectCall, mixedDirectOutput, mixedDirectUser,
    mixedDirectStart, mixedDirectMessage, mixedDirectDone,
  ];
  assert.deepEqual(
    eventModel.sortTaskEventsForDisplay(mixedDirectEvents).map((event) => event.event_id),
    [
      'mixed-direct-user', 'mixed-direct-start', 'mixed-direct-call',
      'mixed-direct-message', 'mixed-direct-output', 'mixed-direct-done',
    ],
    'partial Direct ACP turn indexes must not move tool events before the unindexed prompt',
  );
  assert.deepEqual(
    reducer.buildMessageStateFromEvents(mixedDirectEvents, 'task-1').messages.map((message) => message.kind),
    ['user_prompt', 'tool_call', 'assistant_message', 'run_duration'],
    'Direct ACP mixed metadata must render the prompt before its tool card and assistant reply',
  );

  const restartUser0 = taskEvent('restart-user-0', 'user.prompt', 2, 1_000, {
    acpx_turn_index: 0, acpx_event_key: 'turn:0:user.prompt:0',
    prompt: '磁盘剩余空间多少', turn_id: 'restart-turn-0',
  });
  restartUser0.source = 'web';
  const restartStart0 = taskEvent('restart-start-0', 'task.started', 9, 1_000, {
    _seq: 2, acpx_turn_index: 0, acpx_event_key: 'turn:0:task.started:0', turn_id: 'restart-turn-0',
  });
  const restartFailed0 = taskEvent('restart-failed-0', 'task.failed', 13, 1_001, {
    acpx_turn_index: 0, acpx_event_key: 'turn:0:task.failed:0', turn_id: 'restart-turn-0',
    error: 'task interrupted: daemon no longer running this task', reason: 'interrupted',
  });
  const restartUser1 = taskEvent('restart-user-1', 'user.prompt', 14, 1_003, {
    acpx_turn_index: 1, acpx_event_key: 'turn:1:user.prompt:0',
    prompt: '来点马斯克新闻', turn_id: 'restart-turn-1',
  });
  restartUser1.source = 'web';
  const restartStart1 = taskEvent('restart-start-1', 'task.started', 8, 1_003, {
    _seq: 8, acpx_turn_index: 1, acpx_event_key: 'turn:1:task.started:0', turn_id: 'restart-turn-1',
  });
  const restartReplay = [restartUser0, restartStart0, restartFailed0, restartUser1, restartStart1];
  assert.deepEqual(
    eventModel.sortTaskEventsForDisplay(restartReplay).map((event) => event.event_id),
    ['restart-user-0', 'restart-start-0', 'restart-failed-0', 'restart-user-1', 'restart-start-1'],
    'daemon sequence reset must not move a restarted ACPX turn before the interrupted turn',
  );
  const restartTiming = eventModel.getTaskRunTiming(restartReplay, 'acpx');
  assert.ok(restartTiming.activeStartedAtMs > 0, 'the restarted ACPX turn must stay working before completion');
  assert.equal(restartTiming.latestStartedTurnId, 'restart-turn-1');
  assert.equal(restartTiming.latestTerminalTurnId, 'restart-turn-0');

  const importedHistory = [
    taskEvent('imported-user-0', 'user.prompt', 1, 2_000, {
      prompt: 'first', imported_history: true,
    }),
    taskEvent('imported-assistant-0', 'assistant.message', 2, 2_000, {
      text: 'first reply', imported_history: true,
    }),
    taskEvent('imported-user-1', 'user.prompt', 3, 2_000, {
      prompt: 'second', imported_history: true,
    }),
    taskEvent('imported-assistant-1', 'assistant.message', 4, 2_000, {
      text: 'second reply', imported_history: true,
    }),
  ];
  const importedMessages = reducer.buildMessageStateFromEvents(importedHistory, 'task-imported').messages;
  assert.deepEqual(
    importedMessages.map((message) => message.kind),
    ['user_prompt', 'assistant_message', 'run_duration', 'user_prompt', 'assistant_message', 'run_duration'],
    'provider history without lifecycle timing must still delimit every completed turn',
  );
  assert.equal(importedMessages.at(-1).durationMs, undefined, 'missing provider timing must not be fabricated');

  const timedImportedHistory = importedHistory.slice(0, 2).map((event, index) => ({
    ...event,
    provider_timestamp_ms: 2_000_000 + index * 7_000,
  }));
  const timedImportedMessages = reducer.buildMessageStateFromEvents(timedImportedHistory, 'task-imported-timed').messages;
  assert.equal(
    timedImportedMessages.at(-1).durationMs,
    7_000,
    'provider replay timestamps must derive the completed historical turn duration',
  );

  console.log('agent event model tests: PASS');
} finally {
  await vite.close();
}
