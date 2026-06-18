import type { AgentToolCallItem } from "@/lib/agent-protocol";

export interface TaskEvent {
  task_id: string;
  event_id: string;
  event_type: string;
  source: string;
  sequence: number;
  timestamp: number;
  data?: string;
  raw?: string;
}

export interface ChatMessage {
  id: string;
  seq: number;
  kind: "user_prompt" | "assistant_message" | "thought" | "tool_call";
  content: string;
  createdAt: string;
  durationMs?: number;
  streamId?: string;
  toolCall?: AgentToolCallItem;
}

export type AgentRunStatus = "idle" | "sending" | "running";
