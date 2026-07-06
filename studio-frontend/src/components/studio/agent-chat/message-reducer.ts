import { buildAgentToolCallItems } from "@/lib/agent-protocol";
import type { ChatMessage, TaskEvent } from "./types";
import {
  compactStreamEvents,
  conversationEvents,
  getMetadata,
  getToolEventId,
  normalizeTextForDedup,
  normalizeToolEventMetadata,
  sortTaskEventsForDisplay,
} from "./event-model";

type EventRecord = Record<string, unknown>;

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

function terminalStatusForEvent(eventType: string) {
  return eventType === "turn.completed" || eventType === "task.completed" ? "completed" : "failed";
}

function finalizeOpenMessages(state: MessageState, evt: TaskEvent) {
  const endedAtMs = evt.timestamp * 1000 || Date.now();
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
    createdAt: new Date(evt.timestamp * 1000).toISOString(),
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
  state.lastActivityStartedMs = evt.timestamp * 1000;
  state.assistantStreams.clear();
  state.thoughtStreams.clear();
  state.assistantSignatures.clear();
  state.thoughtSignatures.clear();
}

function applyAssistantMessage(state: MessageState, evt: TaskEvent, dataPayload: EventRecord | undefined) {
  const text = String(dataPayload?.text || "");
  if (!text) return;
  const seq = Number(evt.sequence);
  const createdAt = new Date(evt.timestamp * 1000).toISOString();
  const streamId = typeof dataPayload?.stream_id === "string" ? dataPayload.stream_id : "";

  if (streamId) {
    const existingId = state.assistantStreams.get(streamId);
    if (existingId) {
      const index = state.byId.get(existingId);
      const previous = index === undefined ? undefined : state.messages[index];
      const content = dataPayload?.append === true ? (previous?.content || "") + text : text;
      setMessageContent(state, existingId, content);
      return;
    }
    const id = evt.event_id;
    state.assistantStreams.set(streamId, id);
    appendMessage(state, { id, seq, kind: "assistant_message", content: text, createdAt, streamId });
    return;
  }

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
  const createdAt = new Date(evt.timestamp * 1000).toISOString();
  const streamId = typeof dataPayload?.stream_id === "string" ? dataPayload.stream_id : "";
  const durationMs = evt.timestamp * 1000 - state.lastActivityStartedMs;

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
  state.lastActivityStartedMs = evt.timestamp * 1000;
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
    createdAt: new Date(evt.timestamp * 1000).toISOString(),
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
    createdAt: existingIndex === undefined ? new Date(evt.timestamp * 1000).toISOString() : state.messages[existingIndex].createdAt,
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
      state.lastActivityStartedMs = evt.timestamp * 1000;
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
  const state = createMessageState();
  for (const event of compactStreamEvents(sortTaskEventsForDisplay(conversationEvents(events, taskID)))) {
    applyMessageEvent(state, event);
  }
  return state;
}
