export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export interface DeviceAgent {
  name: string;
  label: string;
}

export interface Device {
  id: string;
  name: string;
  agent?: string;
  agent_label?: string;
  agents?: DeviceAgent[];
  workspaces?: Workspace[];
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

export interface OpenFile {
  path: string;
  content: string;
  status?: string;
}
