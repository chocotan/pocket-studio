import type { AgentToolCallItem } from "@/lib/agent-protocol";

export interface TaskEvent {
  task_id: string;
  event_id: string;
  event_type: string;
  source: string;
  sequence: number;
  timestamp: number;
  provider_timestamp_ms?: number;
  data?: string;
  raw?: string;
}

export interface ChatAttachment {
  type: "image";
  name: string;
  path: string;
  mime_type: string;
  previewUrl?: string;
}

export interface ChatMessage {
  id: string;
  seq: number;
  kind: "user_prompt" | "assistant_message" | "thought" | "tool_call" | "run_duration";
  content: string;
  createdAt: string;
  durationMs?: number;
  streamId?: string;
  turnId?: string;
  toolCall?: AgentToolCallItem;
  attachments?: ChatAttachment[];
}

export type AgentRunStatus = "idle" | "sending" | "running";
