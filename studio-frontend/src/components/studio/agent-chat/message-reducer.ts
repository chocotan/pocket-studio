import { buildAgentToolCallItems } from "@/lib/agent-protocol";
import type { ChatMessage, TaskEvent } from "./types";
import {
  compactStreamEvents,
  getMetadata,
  getToolEventId,
  normalizeTextForDedup,
  normalizeToolEventMetadata,
  sortTaskEventsForDisplay,
} from "./event-model";

type EventRecord = Record<string, unknown>;

function taskEventTimeMs(evt: TaskEvent) {
  const providerTime = Number(evt.provider_timestamp_ms || 0);
  return providerTime > 0 ? providerTime : Number(evt.timestamp || 0) * 1000;
}

type MessageState = {
  messages: ChatMessage[];
  byId: Map<string, number>;
  assistantStreams: Map<string, string>;
  thoughtStreams: Map<string, string>;
  assistantSignatures: Set<string>;
  thoughtSignatures: Set<string>;
  pendingToolEvents: Array<{
    id: string;
    seq: number;
    kind: "tool_call";
    content: string;
    createdAt: string;
    metadata?: EventRecord;
  }>;
  emittedToolIds: Set<string>;
  lastActivityStartedMs: number;
  runStartedAtMs: number;
};

function isLocalUserPromptMessage(message: ChatMessage) {
  return message.kind === "user_prompt" && message.id.startsWith("local-user.prompt-");
}

function userPromptTurnID(evt: TaskEvent, dataPayload: EventRecord | undefined) {
  if (typeof dataPayload?.turn_id === "string") return dataPayload.turn_id;
  const raw = getMetadata(evt.raw);
  return typeof raw?.turn_id === "string" ? raw.turn_id : "";
}

function cloneState(prev: MessageState): MessageState {
  return {
    messages: [...prev.messages],
    byId: new Map(prev.byId),
    assistantStreams: new Map(prev.assistantStreams),
    thoughtStreams: new Map(prev.thoughtStreams),
    assistantSignatures: new Set(prev.assistantSignatures),
    thoughtSignatures: new Set(prev.thoughtSignatures),
    pendingToolEvents: [...prev.pendingToolEvents],
    emittedToolIds: new Set(prev.emittedToolIds),
    lastActivityStartedMs: prev.lastActivityStartedMs,
    runStartedAtMs: prev.runStartedAtMs,
  };
}

export function createMessageState(): MessageState {
  return {
    messages: [],
    byId: new Map(),
    assistantStreams: new Map(),
    thoughtStreams: new Map(),
    assistantSignatures: new Set(),
    thoughtSignatures: new Set(),
    pendingToolEvents: [],
    emittedToolIds: new Set(),
    lastActivityStartedMs: 0,
    runStartedAtMs: 0,
  };
}

function appendMessage(state: MessageState, message: ChatMessage) {
  state.messages.push(message);
  rebuildMessageIndex(state);
}

function rebuildMessageIndex(state: MessageState) {
  state.byId.clear();
  state.messages.forEach((message, index) => {
    state.byId.set(message.id, index);
  });
}

function setMessageContent(state: MessageState, id: string, content: string, durationMs?: number) {
  const index = state.byId.get(id);
  if (index === undefined) return false;
  state.messages[index] = {
    ...state.messages[index],
    content,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  return true;
}

function isTerminalToolStatus(status: unknown) {
  return status === "completed" || status === "success" || status === "failed" || status === "error";
}

function isRunTerminalEvent(eventType: string) {
  return (
    eventType === "turn.completed" ||
    eventType === "turn.failed" ||
    eventType === "task.completed" ||
    eventType === "task.failed" ||
    eventType === "task.killed" ||
    eventType === "task.stopped"
  );
}

function terminalStatusForEvent(eventType: string) {
  return eventType === "turn.completed" || eventType === "task.completed" ? "completed" : "failed";
}

function finalizeOpenMessages(state: MessageState, evt: TaskEvent) {
  const endedAtMs = taskEventTimeMs(evt) || Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const status = terminalStatusForEvent(evt.event_type);

  state.messages = state.messages.map((message) => {
    if (message.kind === "thought") {
      const startMs = new Date(message.createdAt).getTime();
      if (Number.isFinite(startMs) && (message.durationMs === undefined || message.durationMs <= 0)) {
        return { ...message, durationMs: Math.max(0, endedAtMs - startMs) };
      }
      return message;
    }
    if (message.kind === "tool_call" && message.toolCall && !isTerminalToolStatus(message.toolCall.status)) {
      return {
        ...message,
        toolCall: {
          ...message.toolCall,
          status,
          completedAt: message.toolCall.completedAt || endedAt,
        },
      };
    }
    return message;
  });

  state.pendingToolEvents = state.pendingToolEvents.map((event) => ({
    ...event,
    metadata: {
      ...(event.metadata || {}),
      status,
      completedAt: endedAt,
      completed_at: endedAt,
    },
  }));
  rebuildMessageIndex(state);

  const startedAtMs = state.runStartedAtMs;
  if (startedAtMs > 0 && endedAtMs >= startedAtMs) {
    appendMessage(state, {
      id: evt.event_id,
      seq: Number(evt.sequence),
      kind: "run_duration",
      content: "",
      createdAt: endedAt,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
    });
  }
  state.runStartedAtMs = 0;
}

function applyUserPrompt(state: MessageState, evt: TaskEvent, dataPayload: EventRecord | undefined) {
  const prompt = String(dataPayload?.prompt || "");
  if (!prompt) return;
  const turnID = userPromptTurnID(evt, dataPayload);
  const message: ChatMessage = {
    id: evt.event_id,
    seq: Number(evt.sequence),
    kind: "user_prompt",
    content: prompt,
    createdAt: new Date(taskEventTimeMs(evt)).toISOString(),
    ...(turnID ? { turnId: turnID } : {}),
  };
  if (!evt.event_id.startsWith("local-user.prompt-")) {
    const duplicateIndex = state.messages.findIndex((item) =>
      isLocalUserPromptMessage(item) &&
      turnID !== "" &&
      item.turnId === turnID
    );
    if (duplicateIndex >= 0) {
      const previous = state.messages[duplicateIndex];
      state.byId.delete(state.messages[duplicateIndex].id);
      state.messages[duplicateIndex] = { ...message, seq: previous.seq, createdAt: previous.createdAt };
      rebuildMessageIndex(state);
    } else {
      appendMessage(state, message);
    }
  } else {
    appendMessage(state, message);
  }
  state.lastActivityStartedMs = taskEventTimeMs(evt);
  if (state.runStartedAtMs <= 0) {
    state.runStartedAtMs = taskEventTimeMs(evt);
  }
  state.assistantStreams.clear();
  state.thoughtStreams.clear();
  state.assistantSignatures.clear();
  state.thoughtSignatures.clear();
}

function applyAssistantMessage(state: MessageState, evt: TaskEvent, dataPayload: EventRecord | undefined) {
  const text = String(dataPayload?.text || "");
  const hasVisibleText = text.trim().length > 0;
  const seq = Number(evt.sequence);
  const createdAt = new Date(taskEventTimeMs(evt)).toISOString();
  const streamId = typeof dataPayload?.stream_id === "string" ? dataPayload.stream_id : "";

  if (streamId) {
    const existingId = state.assistantStreams.get(streamId);
    if (existingId) {
      const index = state.byId.get(existingId);
      const previous = index === undefined ? undefined : state.messages[index];
      if (dataPayload?.append === true) setMessageContent(state, existingId, (previous?.content || "") + text);
      else if (hasVisibleText) setMessageContent(state, existingId, text);
      return;
    }
    if (!hasVisibleText) return;
    const id = evt.event_id;
    state.assistantStreams.set(streamId, id);
    appendMessage(state, { id, seq, kind: "assistant_message", content: text, createdAt, streamId });
    return;
  }

  if (!hasVisibleText) return;
  const signature = normalizeTextForDedup(text);
  if (!signature || state.assistantSignatures.has(signature)) return;
  state.assistantSignatures.add(signature);
  const last = state.messages[state.messages.length - 1];
  if (last?.kind === "assistant_message" && text.startsWith(last.content)) {
    setMessageContent(state, last.id, text);
    return;
  }
  appendMessage(state, { id: evt.event_id, seq, kind: "assistant_message", content: text, createdAt });
}

function applyThought(state: MessageState, evt: TaskEvent, dataPayload: EventRecord | undefined) {
  const text = String(dataPayload?.text || "");
  if (!text) return;
  const seq = Number(evt.sequence);
  const createdAt = new Date(taskEventTimeMs(evt)).toISOString();
  const streamId = typeof dataPayload?.stream_id === "string" ? dataPayload.stream_id : "";
  const durationMs = taskEventTimeMs(evt) - state.lastActivityStartedMs;

  if (streamId) {
    const existingId = state.thoughtStreams.get(streamId);
    if (existingId) {
      const index = state.byId.get(existingId);
      const previous = index === undefined ? undefined : state.messages[index];
      const content = dataPayload?.append === true ? (previous?.content || "") + text : text;
      setMessageContent(state, existingId, content, durationMs);
      return;
    }
    const id = evt.event_id;
    state.thoughtStreams.set(streamId, id);
    appendMessage(state, { id, seq, kind: "thought", content: text, createdAt, durationMs, streamId });
    return;
  }

  const signature = normalizeTextForDedup(text);
  if (!signature || state.thoughtSignatures.has(signature)) return;
  state.thoughtSignatures.add(signature);
  const last = state.messages[state.messages.length - 1];
  if (last?.kind === "thought" && text.startsWith(last.content)) {
    setMessageContent(state, last.id, text, durationMs);
    return;
  }
  appendMessage(state, {
    id: evt.event_id,
    seq,
    kind: "thought",
    content: text,
    createdAt,
    durationMs,
  });
  state.lastActivityStartedMs = taskEventTimeMs(evt);
}

function applyToolEvent(
  state: MessageState,
  evt: TaskEvent,
  dataPayload: EventRecord | undefined,
  rawMetadata: EventRecord | undefined
) {
  const metadata = normalizeToolEventMetadata(evt.event_type, dataPayload, rawMetadata, evt.event_id);
  const toolId = getToolEventId(dataPayload, metadata, evt.event_id);
  state.pendingToolEvents.push({
    id: evt.event_id,
    seq: Number(evt.sequence),
    kind: "tool_call",
    content: "",
    createdAt: new Date(taskEventTimeMs(evt)).toISOString(),
    metadata,
  });

  const toolCallItems = buildAgentToolCallItems(state.pendingToolEvents);
  const item = toolCallItems.find((candidate) => candidate.id === toolId || candidate.id === evt.event_id);
  if (!item) return;

  const messageId = `tc-${item.id}`;
  const existingIndex = state.byId.get(messageId);
  const message: ChatMessage = {
    id: messageId,
    seq: existingIndex === undefined ? Number(evt.sequence) : state.messages[existingIndex].seq,
    kind: "tool_call",
    content: item.title,
    createdAt: existingIndex === undefined ? new Date(taskEventTimeMs(evt)).toISOString() : state.messages[existingIndex].createdAt,
    toolCall: item,
  };

  if (existingIndex === undefined) {
    state.emittedToolIds.add(item.id);
    appendMessage(state, message);
  } else {
    state.messages[existingIndex] = message;
    rebuildMessageIndex(state);
  }
}

function applyMessageEvent(state: MessageState, evt: TaskEvent) {
  if (state.byId.has(evt.event_id)) return;
  const dataPayload = getMetadata(evt.data);
  const rawMetadata = getMetadata(evt.raw);

  switch (evt.event_type) {
    case "turn.completed":
    case "turn.failed":
    case "task.completed":
    case "task.failed":
    case "task.killed":
    case "task.stopped":
      finalizeOpenMessages(state, evt);
      return;
    case "task.started":
      state.lastActivityStartedMs = taskEventTimeMs(evt);
      state.runStartedAtMs = taskEventTimeMs(evt);
      return;
    case "user.prompt":
      applyUserPrompt(state, evt, dataPayload);
      return;
    case "assistant.message":
      applyAssistantMessage(state, evt, dataPayload);
      return;
    case "assistant.thinking":
      applyThought(state, evt, dataPayload);
      return;
    case "tool.call":
    case "tool.output":
    case "permission.request":
      applyToolEvent(state, evt, dataPayload, rawMetadata);
      return;
    default:
      return;
  }
}

export function applyTaskEventToMessageState(prev: MessageState, event: TaskEvent): MessageState {
  const next = cloneState(prev);
  applyMessageEvent(next, event);
  return next;
}

export function buildMessageStateFromEvents(events: TaskEvent[], taskID: string): MessageState {
  void taskID;
  const state = createMessageState();
  for (const event of orderEventsForMessageState(compactStreamEvents(sortTaskEventsForDisplay(events)))) {
    applyMessageEvent(state, event);
  }
  const importedPromptIDs = new Set(events.filter((event) => (
    event.event_type === "user.prompt" && getMetadata(event.data)?.imported_history === true
  )).map((event) => event.event_id));
  if (importedPromptIDs.size > 0) {
    addImportedRunDurations(state, importedPromptIDs);
  }
  return state;
}

function addImportedRunDurations(state: MessageState, importedPromptIDs: Set<string>) {
  const messages: ChatMessage[] = [];
  let activePromptID = "";
  let activePromptCreatedAt = "";
  let lastTurnItemCreatedAt = "";

  const finishImportedTurn = () => {
    if (!activePromptID) return;
    const startedAtMs = new Date(activePromptCreatedAt).getTime();
    const completedAtMs = new Date(lastTurnItemCreatedAt || activePromptCreatedAt).getTime();
    const hasProviderTiming = completedAtMs > startedAtMs;
    messages.push({
      id: `history-duration-${activePromptID}`,
      seq: messages.at(-1)?.seq ?? 0,
      kind: "run_duration",
      content: "",
      createdAt: messages.at(-1)?.createdAt || activePromptCreatedAt,
      ...(hasProviderTiming ? { durationMs: completedAtMs - startedAtMs } : {}),
    });
    activePromptID = "";
    activePromptCreatedAt = "";
    lastTurnItemCreatedAt = "";
  };

  for (const message of state.messages) {
    if (message.kind === "user_prompt") {
      finishImportedTurn();
      if (importedPromptIDs.has(message.id)) {
        activePromptID = message.id;
        activePromptCreatedAt = message.createdAt;
      }
    } else if (message.kind === "run_duration" && activePromptID) {
      activePromptID = "";
      activePromptCreatedAt = "";
      lastTurnItemCreatedAt = "";
    }
    messages.push(message);
    if (activePromptID && message.kind !== "user_prompt") {
      lastTurnItemCreatedAt = message.createdAt;
    }
  }
  finishImportedTurn();
  state.messages = messages;
  rebuildMessageIndex(state);
}

function orderEventsForMessageState(events: TaskEvent[]) {
  const ordered: TaskEvent[] = [];
  let deferredTerminals: TaskEvent[] = [];
  const flushTerminals = () => {
    if (deferredTerminals.length === 0) return;
    ordered.push(...deferredTerminals);
    deferredTerminals = [];
  };

  for (const event of events) {
    if (event.event_type === "user.prompt" || event.event_type === "task.started") {
      flushTerminals();
      ordered.push(event);
      continue;
    }
    if (isRunTerminalEvent(event.event_type)) {
      deferredTerminals.push(event);
      continue;
    }
    ordered.push(event);
  }
  flushTerminals();
  return ordered;
}
