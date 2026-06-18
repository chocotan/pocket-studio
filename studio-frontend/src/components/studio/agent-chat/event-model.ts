import {
  buildAgentToolCallItems,
  extractAgentConfigOptionsFromEvents,
  extractAgentModelsFromEvents,
} from "@/lib/agent-protocol";
import type { ChatMessage, TaskEvent } from "./types";

export function getUnixTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export function isTerminalTaskEvent(evt: TaskEvent): boolean {
  return (
    evt.event_type === "task.completed" ||
    evt.event_type === "task.failed" ||
    evt.event_type === "task.killed" ||
    evt.event_type === "task.stopped" ||
    evt.event_type === "turn.completed" ||
    evt.event_type === "turn.failed"
  );
}

type EventRecord = Record<string, unknown>;

export function getMetadata(raw: unknown): EventRecord | undefined {
  if (!raw) return undefined;
  if (typeof raw === "object") return raw as EventRecord;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function toAgentEvent(evt: TaskEvent) {
  return {
    id: evt.event_id,
    seq: Number(evt.sequence),
    kind: evt.event_type,
    content: "",
    createdAt: new Date(evt.timestamp * 1000).toISOString(),
    metadata: getMetadata(evt.raw) ?? getMetadata(evt.data),
  };
}

export function modelListFromTaskEvents(events: TaskEvent[]) {
  return extractAgentModelsFromEvents(events.map(toAgentEvent));
}

export function configOptionsFromTaskEvents(events: TaskEvent[]) {
  return extractAgentConfigOptionsFromEvents(events.map(toAgentEvent));
}

export function eventDisplayRank(eventType: string) {
  switch (eventType) {
    case "user.prompt":
      return 0;
    case "task.started":
      return 1;
    default:
      return 2;
  }
}

function isLocalEvent(evt: TaskEvent) {
  return evt.event_id.startsWith("local-");
}

export function sortTaskEventsForDisplay(events: TaskEvent[]) {
  return [...events].sort((left, right) => {
    const leftSeq = Number(left.sequence || 0);
    const rightSeq = Number(right.sequence || 0);
    if (!isLocalEvent(left) && !isLocalEvent(right) && leftSeq > 0 && rightSeq > 0 && leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }
    const timeDiff = Number(left.timestamp || 0) - Number(right.timestamp || 0);
    if (timeDiff !== 0) return timeDiff;
    const rankDiff = eventDisplayRank(left.event_type) - eventDisplayRank(right.event_type);
    if (rankDiff !== 0) return rankDiff;
    return leftSeq - rightSeq;
  });
}

export function mergeTaskEvents(prev: TaskEvent[], nextEvents: TaskEvent[]) {
  const existingIds = new Set(prev.map((event) => event.event_id));
  const merged = [...prev];
  for (const event of nextEvents) {
    if (existingIds.has(event.event_id)) {
      continue;
    }
    let isDuplicate = false;
    if (event.event_type === "user.prompt") {
      const eventPrompt = getMetadata(event.data)?.prompt;
      if (eventPrompt) {
        for (let index = 0; index < merged.length; index++) {
          const existing = merged[index];
          if (existing.event_type === "user.prompt") {
            const existingPrompt = getMetadata(existing.data)?.prompt;
            if (
              existingPrompt === eventPrompt &&
              Math.abs(existing.timestamp - event.timestamp) < 10
            ) {
              if (existing.event_id.startsWith("local-user.prompt-")) {
                merged[index] = {
                  ...event,
                  sequence: existing.sequence,
                  timestamp: existing.timestamp,
                };
                existingIds.add(event.event_id);
                existingIds.delete(existing.event_id);
              }
              isDuplicate = true;
              break;
            }
          }
        }
      }
    }
    if (!isDuplicate) {
      existingIds.add(event.event_id);
      merged.push(event);
    }
  }
  return merged;
}

export function makeLocalUserPromptEvent(taskID: string, prompt: string): TaskEvent {
  const now = getUnixTimestamp();
  return {
    task_id: taskID,
    event_id: `local-user.prompt-${now}-${Math.random().toString(16).slice(2)}`,
    event_type: "user.prompt",
    source: "web",
    sequence: now,
    timestamp: now,
    data: JSON.stringify({ prompt }),
    raw: JSON.stringify({ local: true, eventType: "user.prompt", prompt }),
  };
}

export function conversationEvents(events: TaskEvent[], taskID: string) {
  void taskID;
  return events.filter((event) =>
    event.event_type === "user.prompt" ||
    event.event_type === "assistant.thinking" ||
    event.event_type === "assistant.message" ||
    event.event_type === "tool.call" ||
    event.event_type === "tool.output" ||
    event.event_type === "permission.request"
  );
}

function streamEventKey(event: TaskEvent) {
  if (event.event_type !== "assistant.message" && event.event_type !== "assistant.thinking") {
    return "";
  }
  const data = getMetadata(event.data);
  const streamId = typeof data?.stream_id === "string" ? data.stream_id : "";
  return streamId ? `${event.event_type}:${streamId}` : "";
}

export function compactStreamEvents(events: TaskEvent[]) {
  const sorted = sortTaskEventsForDisplay(events);
  const compacted: TaskEvent[] = [];
  const streamIndex = new Map<string, number>();
  const streamText = new Map<string, string>();

  for (const event of sorted) {
    const key = streamEventKey(event);
    if (!key) {
      compacted.push(event);
      continue;
    }

    const data = getMetadata(event.data) || {};
    const text = String(data.text || "");
    const nextText = data.append === true ? (streamText.get(key) || "") + text : text;
    const nextEvent: TaskEvent = {
      ...event,
      data: JSON.stringify({ ...data, text: nextText, replace: true, append: undefined }),
    };
    streamText.set(key, nextText);

    const existingIndex = streamIndex.get(key);
    if (existingIndex === undefined) {
      streamIndex.set(key, compacted.length);
      compacted.push(nextEvent);
    } else {
      compacted[existingIndex] = {
        ...nextEvent,
        event_id: compacted[existingIndex].event_id,
        sequence: compacted[existingIndex].sequence,
        timestamp: compacted[existingIndex].timestamp,
      };
    }
  }

  return compacted;
}

export function normalizeTextForDedup(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

export function getToolEventId(
  dataPayload: EventRecord | undefined,
  metadata: EventRecord | undefined,
  fallback: string
) {
  const direct =
    dataPayload?.toolCallId ??
    dataPayload?.tool_call_id ??
    dataPayload?.tool_use_id ??
    dataPayload?.id ??
    metadata?.toolCallId ??
    metadata?.tool_call_id ??
    metadata?.tool_use_id ??
    metadata?.id;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const params = metadata?.params as EventRecord | undefined;
  const update = (params?.update ?? params?.toolCall) as EventRecord | undefined;
  const nested =
    update?.toolCallId ??
    update?.tool_call_id ??
    update?.tool_use_id ??
    update?.id;
  return typeof nested === "string" && nested.trim() ? nested.trim() : fallback;
}

export function normalizeToolEventMetadata(
  eventType: string,
  dataPayload: EventRecord | undefined,
  rawMetadata: EventRecord | undefined,
  fallbackId: string
) {
  if (eventType === "tool.call") {
    const toolId = getToolEventId(dataPayload, rawMetadata, fallbackId);
    return {
      ...(rawMetadata || {}),
      ...(dataPayload || {}),
      id: toolId,
      toolCallId: toolId,
      tool_call_id: toolId,
      title: dataPayload?.name ?? rawMetadata?.name ?? rawMetadata?.title,
      name: dataPayload?.name ?? rawMetadata?.name,
      input: dataPayload?.input ?? rawMetadata?.input,
      status: dataPayload?.status ?? rawMetadata?.status,
    };
  }
  if (eventType === "tool.output") {
    const toolId = getToolEventId(dataPayload, rawMetadata, fallbackId);
    const isError = dataPayload?.is_error === true || dataPayload?.isError === true;
    const output =
      dataPayload?.text ??
      dataPayload?.output ??
      dataPayload?.result ??
      rawMetadata?.tool_use_result ??
      rawMetadata?.output ??
      rawMetadata?.result;
    return {
      ...(rawMetadata || {}),
      ...(dataPayload || {}),
      id: toolId,
      toolCallId: toolId,
      tool_call_id: toolId,
      output,
      status: isError ? "failed" : "completed",
    };
  }
  return rawMetadata ?? dataPayload;
}

export function deriveChatMessages(events: TaskEvent[], taskID: string): ChatMessage[] {
  if (events.length === 0) return [];

  const sorted = compactStreamEvents(conversationEvents(events, taskID));
  const list: ChatMessage[] = [];
  const agentEvents = sorted.map((evt) => {
    const dataPayload = getMetadata(evt.data);
    const rawMetadata = getMetadata(evt.raw);
    const normalizedToolMetadata =
      evt.event_type === "tool.call" || evt.event_type === "tool.output" || evt.event_type === "permission.request"
        ? normalizeToolEventMetadata(evt.event_type, dataPayload, rawMetadata, evt.event_id)
        : rawMetadata;
    return { evt, dataPayload, normalizedToolMetadata };
  });

  let currentTurn: typeof agentEvents = [];

  const flushTurn = () => {
    if (currentTurn.length === 0) return;
    appendTurnMessages(currentTurn, list);
    currentTurn = [];
  };

  for (const event of agentEvents) {
    if (event.evt.event_type === "user.prompt") {
      flushTurn();
    }
    currentTurn.push(event);
  }
  flushTurn();

  return list;
}

function appendTurnMessages(
  turnEvents: Array<{
    evt: TaskEvent;
    dataPayload: EventRecord | undefined;
    normalizedToolMetadata: EventRecord | undefined;
  }>,
  list: ChatMessage[]
) {
  const toolCallEvents = turnEvents
    .filter(({ evt }) =>
      evt.event_type === "tool.call" ||
      evt.event_type === "tool.output" ||
      evt.event_type === "permission.request"
    )
    .map(({ evt, normalizedToolMetadata }) => ({
      id: evt.event_id,
      seq: Number(evt.sequence),
      kind: "tool_call" as const,
      content: "",
      createdAt: new Date(evt.timestamp * 1000).toISOString(),
      metadata: normalizedToolMetadata
    }));

  const toolCallItems = buildAgentToolCallItems(toolCallEvents);
  const toolCallById = new Map(toolCallItems.map((tc) => [tc.id, tc]));
  const emittedToolIds = new Set<string>();
  const assistantMessagesInTurn = new Set<string>();
  const thoughtsInTurn = new Set<string>();
  const assistantStreamMessages = new Map<string, ChatMessage>();
  const thoughtStreamMessages = new Map<string, ChatMessage>();
  let lastActivityStartedMs = turnEvents[0]?.evt.timestamp ? turnEvents[0].evt.timestamp * 1000 : 0;

  for (const { evt, dataPayload, normalizedToolMetadata } of turnEvents) {
    const createdAt = new Date(evt.timestamp * 1000).toISOString();
    const seq = Number(evt.sequence);

    switch (evt.event_type) {
      case "task.started": {
        lastActivityStartedMs = evt.timestamp * 1000;
        break;
      }
      case "user.prompt": {
        const prompt = String(dataPayload?.prompt || "");
        if (prompt) {
          list.push({ id: evt.event_id, seq, kind: "user_prompt", content: prompt, createdAt });
          lastActivityStartedMs = evt.timestamp * 1000;
          assistantMessagesInTurn.clear();
          thoughtsInTurn.clear();
        }
        break;
      }
      case "assistant.message": {
        const text = String(dataPayload?.text || "");
        const streamId = typeof dataPayload?.stream_id === "string" ? dataPayload.stream_id : "";
        if (text && streamId) {
          const previous = assistantStreamMessages.get(streamId);
          if (previous) {
            previous.content = dataPayload?.append === true ? previous.content + text : text;
          } else {
            const message: ChatMessage = { id: evt.event_id, seq, kind: "assistant_message", content: text, createdAt, streamId };
            assistantStreamMessages.set(streamId, message);
            list.push(message);
          }
        } else {
          const signature = normalizeTextForDedup(text);
          if (text && !assistantMessagesInTurn.has(signature)) {
            assistantMessagesInTurn.add(signature);
            const last = list[list.length - 1];
            if (last?.kind === "assistant_message" && text.startsWith(last.content)) {
              last.content = text;
            } else {
              list.push({ id: evt.event_id, seq, kind: "assistant_message", content: text, createdAt });
            }
          }
        }
        break;
      }
      case "assistant.thinking": {
        const text = String(dataPayload?.text || "");
        const streamId = typeof dataPayload?.stream_id === "string" ? dataPayload.stream_id : "";
        if (text && streamId) {
          const previous = thoughtStreamMessages.get(streamId);
          if (previous) {
            previous.content = dataPayload?.append === true ? previous.content + text : text;
            previous.durationMs = evt.timestamp * 1000 - lastActivityStartedMs;
          } else {
            const message: ChatMessage = {
              id: evt.event_id,
              seq,
              kind: "thought",
              content: text,
              createdAt,
              durationMs: evt.timestamp * 1000 - lastActivityStartedMs,
              streamId
            };
            thoughtStreamMessages.set(streamId, message);
            list.push(message);
          }
        } else {
          const signature = normalizeTextForDedup(text);
          if (text && !thoughtsInTurn.has(signature)) {
            thoughtsInTurn.add(signature);
            const last = list[list.length - 1];
            if (last?.kind === "thought" && text.startsWith(last.content)) {
              last.content = text;
              last.durationMs = evt.timestamp * 1000 - lastActivityStartedMs;
            } else {
              list.push({
                id: evt.event_id,
                seq,
                kind: "thought",
                content: text,
                createdAt,
                durationMs: evt.timestamp * 1000 - lastActivityStartedMs
              });
            }
            lastActivityStartedMs = evt.timestamp * 1000;
          }
        }
        break;
      }
      case "tool.call":
      case "tool.output":
      case "permission.request": {
        const toolId = getToolEventId(dataPayload, normalizedToolMetadata, evt.event_id);
        const tc = toolCallById.get(toolId) ?? toolCallById.get(evt.event_id);
        if (tc && !emittedToolIds.has(tc.id)) {
          emittedToolIds.add(tc.id);
          list.push({
            id: `tc-${tc.id}`,
            seq,
            kind: "tool_call",
            content: tc.title,
            createdAt,
            toolCall: tc
          });
        }
        break;
      }
      default:
        break;
    }
  }
}
