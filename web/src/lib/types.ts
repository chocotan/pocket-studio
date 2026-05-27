import type { AgentModel, TaskEvent, TimedTimelineItem } from "@/lib/agent-events";

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
};

export type FileEntry = {
  id: string;
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
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

export type SessionWorkspaceProps = {
  activeAgent: string;
  agentLabel: string;
  availableAgents: AgentCapability[];
  currentModelID: string;
  devices: Device[];
  effectiveWorkspacePath: string;
  explorerVisible: boolean;
  expandedToolResults: Set<string>;
  fileContent: string;
  fileDirty: boolean;
  fileStatus: string;
  fileTree: FileEntry[];
  openFilePath: string;
  prompt: string;
  selectedDevice: Device | undefined;
  selectedDeviceId: string;
  sessionModels: AgentModel[];
  terminalLines: string[];
  terminalRunning: boolean;
  timelineItems: TimedTimelineItem[];
  waitingForAgent: boolean;
};
