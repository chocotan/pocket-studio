import { describeEvent, eventTimeSeconds, normalizePayload, type TaskEvent } from "@/lib/agent-events";
import type { Device, FileEntry, SearchResult, TaskRecord, Workspace, WorkspaceResult } from "@/lib/types";

export function withEventTimestamp(event: TaskEvent, envelopeTimestamp?: number): TaskEvent {
  return {
    ...event,
    timestamp: event.timestamp || envelopeTimestamp || Math.floor(Date.now() / 1000),
    received_at: Math.floor(Date.now() / 1000)
  };
}

export function formatRecordTime(value: number | undefined) {
  if (!value) return "--";
  return new Date(value * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function latestEventTime(record: TaskRecord | undefined) {
  const events = record?.events || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = eventTimeSeconds(events[index]);
    if (value) return value;
  }
  return 0;
}

export function searchSessionRecords(taskIds: string[], records: Map<string, TaskRecord>, query: string): SearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const results: SearchResult[] = [];
  for (const taskId of taskIds) {
    const record = records.get(taskId);
    if (!record) continue;
    const title = sessionDisplayTitle(record, taskId);
    const subtitle = [agentDisplayName(record.agent || ""), record.workspace_path || ""].filter(Boolean).join(" / ");
    const chunks = [
      title,
      subtitle,
      record.prompt || "",
      ...(record.events || []).map((event) => searchTextFromEvent(event))
    ].filter(Boolean);
    const haystack = chunks.join("\n").toLowerCase();
    if (!haystack.includes(normalized)) continue;
    const preview = bestSearchPreview(chunks, normalized);
    results.push({ taskId, title, subtitle, preview });
  }
  return results.slice(0, 50);
}

export function searchTextFromEvent(event: TaskEvent) {
  const description = describeEvent(event);
  const data = normalizePayload(event.data);
  const raw = normalizePayload(event.raw);
  return [description.title, description.summary, data.prompt, data.text, raw.text, raw.content].map((value) => {
    if (!value) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }).filter(Boolean).join("\n");
}

export function bestSearchPreview(chunks: string[], normalizedQuery: string) {
  const match = chunks.find((chunk) => chunk.toLowerCase().includes(normalizedQuery)) || chunks.find(Boolean) || "";
  const collapsed = match.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 180) return collapsed;
  const index = Math.max(0, collapsed.toLowerCase().indexOf(normalizedQuery));
  const start = Math.max(0, index - 60);
  return `${start > 0 ? "..." : ""}${collapsed.slice(start, start + 180)}...`;
}

export function isWaitingForAgent(record: TaskRecord | undefined, events: TaskEvent[]) {
  if (!record) return false;
  const status = record.status || "";
  if (status !== "running" && status !== "creating" && status !== "stopping") return false;
  let lastUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event_type === "user.prompt") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return status === "creating" || status === "running";
  for (let index = lastUserIndex + 1; index < events.length; index += 1) {
    const type = events[index].event_type;
    if (type === "task.completed" || type === "task.failed" || type === "task.killed") {
      return false;
    }
  }
  return true;
}

export function statusFromEvent(type: string, fallback = "running") {
  if (type === "session.created" || type === "acpx.session") return fallback === "running" || fallback === "stopping" ? fallback : "created";
  if (type === "task.completed") return "completed";
  if (type === "task.failed") return "failed";
  if (type === "task.killed") return "killed";
  if (type === "task.stopping") return "stopping";
  if (type === "model.list" || type === "model.updated" || type === "model.update_failed" || type === "metric.updated" || type === "acpx.raw") return fallback;
  return fallback || "running";
}

export function statusBadgeVariant(status: string | undefined) {
  switch (status) {
    case "completed":
    case "created":
      return "success";
    case "failed":
    case "killed":
      return "destructive";
    case "stopping":
      return "warning";
    default:
      return "secondary";
  }
}

export function statusLabel(status: string | undefined) {
  switch (status) {
    case "completed":
      return "完成";
    case "created":
      return "已创建";
    case "creating":
      return "创建中";
    case "failed":
      return "失败";
    case "killed":
      return "已停止";
    case "stopping":
      return "停止中";
    case "running":
      return "运行中";
    default:
      return "待开始";
  }
}

export function sessionDisplayTitle(record: TaskRecord | undefined, fallback = "") {
  return workspaceNameFromPath(record?.workspace_path || "") || record?.prompt || fallbackTitle(fallback) || "未命名会话";
}

export function fallbackTitle(value: string) {
  if (!value || /^(ses|tsk)_/.test(value)) return "";
  return value;
}

export function isDuplicateEvent(items: TaskEvent[], event: TaskEvent) {
  if (event.event_id && items.some((item) => item.event_id === event.event_id)) return true;
  if (event.event_type !== "user.prompt") return false;
  const prompt = String(normalizePayload(event.data).prompt || "");
  return items.some((item) => item.event_type === "user.prompt" && String(normalizePayload(item.data).prompt || "") === prompt);
}

export function sessionNameFor(workspace: Workspace, agent: string) {
  const base = (workspace.id || workspace.name || "workspace").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const safeAgent = (agent || "agent").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `${base || "workspace"}-${safeAgent || "agent"}`;
}

export function uniqueSessionNameFor(workspace: Workspace, agent: string) {
  return `${sessionNameFor(workspace, agent)}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
}

export function workspaceForPath(path: string, selected?: Workspace): Workspace {
  const cleanPath = path.trim();
  if (selected?.path === cleanPath) return selected;
  return {
    id: workspaceIDFromPath(cleanPath),
    name: workspaceNameFromPath(cleanPath),
    path: cleanPath
  };
}

export function mergeTreeEntries(current: FileEntry[], parentPath: string, entries: NonNullable<WorkspaceResult["entries"]>, rootName = "workspace"): FileEntry[] {
  const children = entries.map((entry) => ({
    id: entry.path,
    name: entry.name,
    path: entry.path,
    is_dir: entry.is_dir,
    children: entry.is_dir ? [] : undefined
  }));
  if (!current.length || parentPath === ".") {
    const existingRoot = current.find((node) => node.path === ".");
    const name = existingRoot?.name && existingRoot.name !== "." ? existingRoot.name : rootName;
    return [{ id: ".", name, path: ".", is_dir: true, children }];
  }
  const visit = (nodes: FileEntry[]): FileEntry[] => nodes.map((node) => {
    if (node.path === parentPath) return { ...node, children };
    if (node.children) return { ...node, children: visit(node.children) };
    return node;
  });
  return visit(current);
}

export function languageForPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    go: "go",
    py: "python",
    css: "css",
    html: "html",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell"
  };
  return map[ext] || "plaintext";
}

export function defaultWorkspacePath(device: Device | undefined) {
  const root = device?.workspaces?.[0]?.path || "~/Agent";
  return joinWorkspacePath(root, "project001");
}

export function joinWorkspacePath(root: string, name: string) {
  const cleanRoot = root.trim().replace(/[\\/]+$/g, "");
  return `${cleanRoot || "~/Agent"}/${name}`;
}

export function workspaceIDFromPath(path: string) {
  const clean = path.trim().replace(/^~[\\/]/, "home/").replace(/[\\/]+/g, "-").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "workspace";
}

export function workspaceNameFromPath(path: string) {
  if (!path.trim()) return "";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "workspace";
}

export function agentDisplayName(agent: string) {
  const normalized = agent.toLowerCase().trim();
  const labels: Record<string, string> = {
    claude: "Claude Code",
    claude_code: "Claude Code",
    "claude-code": "Claude Code",
    codex: "Codex",
    gemini: "Gemini",
    cursor: "Cursor Agent",
    copilot: "GitHub Copilot",
    openclaw: "OpenClaw",
    pi: "Pi",
    droid: "Factory Droid",
    "factory-droid": "Factory Droid",
    factorydroid: "Factory Droid",
    qwen: "Qwen Code",
    opencode: "OpenCode"
  };
  return labels[normalized] || agent || "Agent";
}

export type RouteState = {
  view: "dashboard" | "project";
  projectId: string;
};

export function routeFromLocation(): RouteState {
  const path = window.location.pathname;
  const match = path.match(/^\/project\/([^/]+)\/home$/) || path.match(/^\/project\/([^/]+)$/);
  if (match) return { view: "project", projectId: decodeURIComponent(match[1]) };
  return { view: "dashboard", projectId: "" };
}

export function currentProjectIdFromPath() {
  return routeFromLocation().projectId;
}

export function pushRoute(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
}
