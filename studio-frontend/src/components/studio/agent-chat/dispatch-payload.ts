import type { ChatAttachment } from "./types";

interface DirectACPDispatchPayloadInput {
  taskId: string;
  turnId: string;
  workspacePath: string;
  agent: string;
  prompt: string;
  attachments: ChatAttachment[];
  sessionName: string;
}

export function buildDirectACPDispatchPayload({
  taskId,
  turnId,
  workspacePath,
  agent,
  prompt,
  attachments,
  sessionName,
}: DirectACPDispatchPayloadInput): Record<string, unknown> {
  return {
    task_id: taskId,
    turn_id: turnId,
    workspace_path: workspacePath,
    agent,
    agent_runtime: "direct_acp",
    prompt,
    attachments: attachments.map((attachment) => ({
      type: attachment.type,
      name: attachment.name,
      path: attachment.path,
      mime_type: attachment.mime_type,
    })),
    session_name: sessionName,
  };
}
