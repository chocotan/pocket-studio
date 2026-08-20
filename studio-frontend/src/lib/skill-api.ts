// Skill registry & custom agent API client. All calls are device-scoped:
// the skill store lives on the machine the daemon runs on, so every request
// carries ?device_id=<id> and the server relays to that device's daemon.

import { postJSON } from "./api";
import type { CustomAgent, SkillRef, SkillSummary } from "./types";

async function skillPost<T>(path: string, deviceId: string, body: unknown): Promise<T> {
  // postJSON already attaches the auth header (access_token) and resolves the
  // server base URL; skill APIs only add the device_id query param.
  return postJSON<T>(`${path}?device_id=${encodeURIComponent(deviceId)}`, body);
}

export function fetchSkillCatalog(deviceId: string): Promise<{ skills: SkillSummary[] }> {
  return skillPost("/api/skill/catalog", deviceId, {});
}

export function createSkill(deviceId: string, name: string, description: string, location: "store" | "shared"): Promise<{ skill: SkillSummary }> {
  return skillPost("/api/skill/create", deviceId, { name, description, location });
}

export function installSkillFromGit(deviceId: string, ref: string, name?: string): Promise<{ skill: SkillSummary }> {
  return skillPost("/api/skill/store/install", deviceId, { source: "git", ref, name });
}

export function installSkillFromLocal(deviceId: string, ref: string): Promise<{ skill: SkillSummary }> {
  return skillPost("/api/skill/store/install", deviceId, { source: "local", ref });
}

export function removeSkill(deviceId: string, name: string): Promise<{ removed: boolean }> {
  return skillPost("/api/skill/store/remove", deviceId, { name });
}

export function upgradeSkill(deviceId: string, name: string, force = false): Promise<{ skill: SkillSummary }> {
  return skillPost("/api/skill/store/upgrade", deviceId, { name, force });
}

export interface SkillFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
}

export function fetchSkillFileTree(deviceId: string, name: string): Promise<{ root: string; entries: SkillFileEntry[] }> {
  return skillPost("/api/skill/file/tree", deviceId, { name });
}

export interface SkillFileContent {
  content: string;
  revision: string;
  binary: boolean;
  size: number;
}

export function readSkillFile(deviceId: string, name: string, path: string): Promise<SkillFileContent> {
  return skillPost("/api/skill/file/read", deviceId, { name, path });
}

export interface SkillWriteResult {
  revision: string;
  conflict?: boolean;
}

export function writeSkillFile(
  deviceId: string,
  name: string,
  path: string,
  content: string,
  expectedRevision: string,
): Promise<SkillWriteResult> {
  return skillPost("/api/skill/file/write", deviceId, { name, path, content, expected_revision: expectedRevision });
}

export function createSkillFile(deviceId: string, name: string, path: string, isDir = false): Promise<void> {
  return skillPost("/api/skill/file/create", deviceId, { name, path, is_dir: isDir });
}

export function renameSkillFile(deviceId: string, name: string, path: string, newPath: string): Promise<void> {
  return skillPost("/api/skill/file/rename", deviceId, { name, path, new_path: newPath });
}

export function deleteSkillFile(deviceId: string, name: string, path: string): Promise<void> {
  return skillPost("/api/skill/file/delete", deviceId, { name, path });
}

/* ── Custom agents ── */

export function fetchCustomAgents(deviceId: string): Promise<{ agents: CustomAgent[] }> {
  return skillPost("/api/agent/list", deviceId, {});
}

export function saveCustomAgent(deviceId: string, agent: CustomAgent): Promise<{ agent: CustomAgent }> {
  return skillPost("/api/agent/save", deviceId, { agent });
}

export function deleteCustomAgent(deviceId: string, agentId: string): Promise<{ deleted: boolean }> {
  return skillPost("/api/agent/delete", deviceId, { agent_id: agentId });
}

export function customAgentBaseLabel(base: string): string {
  switch (base) {
    case "pi": return "Pi";
    case "kimi": return "Kimi";
    case "opencode": return "OpenCode";
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "kilo": return "Kilo Code";
    default: return base;
  }
}

export type { CustomAgent, SkillRef, SkillSummary };
