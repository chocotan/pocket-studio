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
  features?: string[];
}

/* ── Skill registry & custom agents (daemon-managed, device-scoped) ── */

export interface SkillRef {
  name: string;
  path?: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source: "store" | "shared-global";
  managed: boolean;
  writable: boolean;
  revision: string;
  valid: boolean;
  issue: string;
}

export type CustomAgentBase = "pi" | "kimi" | "opencode" | "claude" | "codex" | "kilo";

export interface CustomAgent {
  id: string;
  name: string;
  description?: string;
  base_agent: CustomAgentBase;
  system_prompt?: string;
  skills: SkillRef[];
  extra_env?: Record<string, string>;
  extra_args?: Record<string, string[]>;
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
