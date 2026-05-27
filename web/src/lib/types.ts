import type { TaskEvent } from "@/lib/agent-events";

export type Workspace = {
  id: string;
  name: string;
  path: string;
};

export type AgentCapability = {
  name: string;
  label: string;
};

export type Device = {
  id: string;
  name: string;
  status: string;
  agent?: string;
  agent_label?: string;
  agents?: AgentCapability[];
  workspaces: Workspace[];
};

export type TaskRecord = {
  task_id: string;
  device_id?: string;
  workspace_id?: string;
  workspace_path?: string;
  agent?: string;
  session_name?: string;
  model_id?: string;
  prompt?: string;
  status?: string;
  session_id?: string;
  started_at?: number;
  updated_at?: number;
  events?: TaskEvent[];
  ui_state?: {
    openFiles: OpenFile[];
    activeFilePath: string;
    fileTree: FileEntry[];
    expandedPaths: string[];
    terminalLines: string[];
    terminalVisible: boolean;
    explorerVisible: boolean;
  };
};

export type FileEntry = {
  id: string;
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
};

export type OpenFile = {
  path: string;
  content: string;
  savedContent: string;
  status?: string;
};

export type WorkspaceResult = {
  request_id: string;
  workspace_id?: string;
  workspace_path?: string;
  path?: string;
  entries?: Array<{ name: string; path: string; is_dir: boolean; size?: number; modified?: number }>;
  content?: string;
  error?: string;
};

export type TerminalResult = {
  request_id: string;
  command?: string;
  output?: string;
  error?: string;
  exit_code: number;
  duration_ms?: number;
};

export type SearchResult = {
  taskId: string;
  title: string;
  subtitle: string;
  preview: string;
};
