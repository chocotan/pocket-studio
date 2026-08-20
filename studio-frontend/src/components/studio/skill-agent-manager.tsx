import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpCircle,
  Bot,
  Check,
  FilePlus2,
  FileText,
  FolderClosed,
  FolderPlus,
  GitBranch,
  HardDriveDownload,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { postJSON } from "../../lib/api";
import type { CustomAgent, SkillSummary } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

/* ── API helpers ─────────────────────────────────────────────── */

interface ApiResultBase {
  error?: string;
}

async function skillApi<T extends ApiResultBase>(deviceId: string, path: string, body: unknown): Promise<T> {
  const result = await postJSON<T>(`${path}?device_id=${encodeURIComponent(deviceId)}`, body ?? {});
  if (result && typeof result.error === "string" && result.error !== "") {
    throw new Error(result.error);
  }
  return result;
}

interface FileEntryItem {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  modified?: number;
}

/* ── Shared bits ─────────────────────────────────────────────── */

const BASE_AGENTS: { value: CustomAgent["base_agent"]; label: string }[] = [
  { value: "pi", label: "Pi" },
  { value: "kimi", label: "Kimi" },
  { value: "opencode", label: "OpenCode" },
  { value: "claude", label: "Claude Code" },
  { value: "kilo", label: "Kilo Code" },
  { value: "codex", label: "Codex" },
];

function baseAgentLabel(value: string): string {
  return BASE_AGENTS.find((item) => item.value === value)?.label || value;
}

function SourceBadge({ source }: { source: SkillSummary["source"] }) {
  if (source === "store") {
    return (
      <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 shrink-0">
        受管
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 shrink-0">
      共享全局
    </Badge>
  );
}

const selectClassName =
  "h-8 w-full rounded-xl border border-border bg-muted/40 px-2.5 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer";

const textareaClassName =
  "w-full rounded-xl border border-border bg-muted/40 px-2.5 py-2 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20";

function ErrorBanner({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-xs font-semibold text-destructive">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="break-all">{message}</span>
    </div>
  );
}

function SectionTabBar<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { value: T; label: string; icon: React.ReactNode }[];
  active: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex w-fit items-center gap-1 rounded-lg bg-muted/60 p-1 text-xs">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={`px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer ${
            active === tab.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-1.5">
            {tab.icon}
            {tab.label}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────── */

export function SkillAgentManagerContent({ deviceId }: { deviceId: string }) {
  const [tab, setTab] = useState<"library" | "agents" | "editor">("library");
  const [catalog, setCatalog] = useState<SkillSummary[]>([]);
  const [agents, setAgents] = useState<CustomAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [editTarget, setEditTarget] = useState("");

  const loadCatalog = useCallback(async () => {
    if (!deviceId) return;
    const result = await skillApi<{ skills?: SkillSummary[] } & ApiResultBase>(deviceId, "/api/skill/catalog", {});
    setCatalog(Array.isArray(result.skills) ? result.skills : []);
  }, [deviceId]);

  const loadAgents = useCallback(async () => {
    if (!deviceId) return;
    const result = await skillApi<{ agents?: CustomAgent[] } & ApiResultBase>(deviceId, "/api/agent/list", {});
    setAgents(Array.isArray(result.agents) ? result.agents : []);
  }, [deviceId]);

  const reloadAll = useCallback(async () => {
    if (!deviceId) {
      setCatalog([]);
      setAgents([]);
      return;
    }
    setLoading(true);
    setPageError("");
    try {
      await Promise.all([loadCatalog(), loadAgents()]);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId, loadCatalog, loadAgents]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  const openEditor = useCallback((skillName: string) => {
    setEditTarget(skillName);
    setTab("editor");
  }, []);

  if (!deviceId) {
    return (
      <div className="flex min-h-60 flex-col items-center justify-center p-6 text-center text-muted-foreground">
        <Sparkles className="mb-3 h-8 w-8 text-muted-foreground/40" />
        <span className="text-sm font-bold text-foreground">请选择一台开发机</span>
        <span className="mt-1 text-xs">技能与自定义 Agent 按设备隔离管理。</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <SectionTabBar
          tabs={[
            { value: "library", label: "技能库", icon: <Sparkles className="h-3 w-3 text-violet-500" /> },
            { value: "agents", label: "自定义 Agent", icon: <Bot className="h-3 w-3 text-emerald-500" /> },
            { value: "editor", label: "技能编辑", icon: <FileText className="h-3 w-3 text-sky-500" /> },
          ]}
          active={tab}
          onChange={setTab}
        />
        <button
          type="button"
          onClick={() => void reloadAll()}
          className="flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          title="刷新"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {pageError && (
        <div className="mb-3">
          <ErrorBanner message={pageError} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "library" && (
          <SkillLibraryTab
            deviceId={deviceId}
            catalog={catalog}
            onChanged={reloadAll}
            onEdit={openEditor}
          />
        )}
        {tab === "agents" && (
          <CustomAgentsTab deviceId={deviceId} catalog={catalog} agents={agents} onChanged={reloadAll} />
        )}
        {tab === "editor" && (
          <SkillEditorTab
            deviceId={deviceId}
            catalog={catalog}
            skillName={editTarget}
            onSkillChange={setEditTarget}
            onChanged={reloadAll}
          />
        )}
      </div>
    </div>
  );
}

/* ── 技能库 ──────────────────────────────────────────────────── */

function SkillLibraryTab({
  deviceId,
  catalog,
  onChanged,
  onEdit,
}: {
  deviceId: string;
  catalog: SkillSummary[];
  onChanged: () => Promise<void>;
  onEdit: (skillName: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return catalog;
    return catalog.filter(
      (skill) =>
        skill.name.toLowerCase().includes(keyword) ||
        (skill.description || "").toLowerCase().includes(keyword) ||
        // Directory name may differ from the frontmatter name (git-installed
        // skills); match it too so users can find a skill by its repo name.
        (skill.path || "").toLowerCase().includes(keyword)
    );
  }, [catalog, search]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-44 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索技能名称或描述…"
            className="h-8 rounded-xl border-border bg-muted/40 pl-8 text-xs focus:border-primary/50 focus:ring-primary/20"
          />
        </div>
        <Button type="button" size="sm" className="h-8 rounded-lg text-xs" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          新建技能
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => setGitOpen(true)}>
          <GitBranch className="h-3.5 w-3.5" />
          从 Git 安装
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => setLocalOpen(true)}>
          <HardDriveDownload className="h-3.5 w-3.5" />
          从本地导入
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center text-xs text-muted-foreground">
          {catalog.length === 0 ? "当前设备还没有技能，点击上方按钮新建或安装。" : "没有匹配的技能。"}
        </div>
      ) : (
        <div className="grid gap-1.5">
          {filtered.map((skill) => (
            <div
              key={`${skill.source}:${skill.path}`}
              className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-card p-2.5 transition-colors hover:bg-muted/40"
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                  skill.source === "store"
                    ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                    : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-xs font-bold text-foreground">{skill.name}</span>
                    {(() => {
                      const dirName = (skill.path || "").split("/").filter(Boolean).pop() || "";
                      return dirName && dirName !== skill.name ? (
                        <span className="shrink-0 truncate text-[10px] text-muted-foreground">({dirName})</span>
                      ) : null;
                    })()}
                  </span>
                  <SourceBadge source={skill.source} />
                  {!skill.valid && (
                    <span className="flex items-center gap-0.5 text-[9px] font-semibold text-amber-600" title={skill.issue}>
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {skill.issue || "格式问题"}
                    </span>
                  )}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {skill.description || skill.path}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onEdit(skill.name)}
                  className="flex h-6 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
                  title="编辑技能文件"
                >
                  <Pencil className="h-3 w-3" />
                  编辑
                </button>
                {skill.managed && (
                  <button
                    type="button"
                    disabled={busy === `upgrade:${skill.name}`}
                    onClick={() =>
                      void run(`upgrade:${skill.name}`, async () => {
                        await skillApi(deviceId, "/api/skill/store/upgrade", { name: skill.name });
                      })
                    }
                    className="flex h-6 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 cursor-pointer"
                    title="git pull 升级到最新（仅限 Git 安装的技能）"
                  >
                    {busy === `upgrade:${skill.name}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ArrowUpCircle className="h-3 w-3" />
                    )}
                    升级
                  </button>
                )}
                {skill.managed &&
                  (confirmDelete === skill.name ? (
                    <button
                      type="button"
                      disabled={busy === `delete:${skill.name}`}
                      onClick={() =>
                        void run(`delete:${skill.name}`, async () => {
                          await skillApi(deviceId, "/api/skill/store/remove", { name: skill.name });
                          setConfirmDelete("");
                        })
                      }
                      className="flex h-6 items-center gap-1 rounded-lg bg-destructive/10 px-2 text-[10px] font-semibold text-destructive transition-colors hover:bg-destructive/20 cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                      确认删除
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(skill.name)}
                      className="flex h-6 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive cursor-pointer"
                      title="删除该受管技能"
                    >
                      <Trash2 className="h-3 w-3" />
                      删除
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateSkillDialog
        deviceId={deviceId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onDone={onChanged}
      />
      <InstallSkillDialog
        deviceId={deviceId}
        mode="git"
        open={gitOpen}
        onOpenChange={setGitOpen}
        onDone={onChanged}
      />
      <InstallSkillDialog
        deviceId={deviceId}
        mode="local"
        open={localOpen}
        onOpenChange={setLocalOpen}
        onDone={onChanged}
      />
    </div>
  );
}

function CreateSkillDialog({
  deviceId,
  open,
  onOpenChange,
  onDone,
}: {
  deviceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState<"store" | "shared">("store");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setLocation("store");
      setError("");
    }
  }, [open]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await skillApi(deviceId, "/api/skill/create", { name: name.trim(), description: description.trim(), location });
      await onDone();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100dvw-2rem)] sm:max-w-md p-0 overflow-hidden border-border/80 shadow-2xl rounded-2xl animate-scale-in">
        <DialogHeader className="px-6 py-4 bg-muted/50 border-b border-border/70">
          <DialogTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <div className="h-6.5 w-6.5 rounded-lg bg-accent border border-primary/15 flex items-center justify-center">
              <Plus className="h-3.5 w-3.5 text-primary" />
            </div>
            新建技能
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 p-6">
          {error && <ErrorBanner message={error} />}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">名称</Label>
            <Input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-skill（小写字母、数字、连字符）"
              className="h-9 rounded-xl border-border bg-muted/40 font-mono text-xs focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">描述</Label>
            <Input
              required
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个技能做什么、什么时候用"
              className="h-9 rounded-xl border-border bg-muted/40 text-xs focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">存放位置</Label>
            <select
              value={location}
              onChange={(event) => setLocation(event.target.value as "store" | "shared")}
              className={selectClassName}
            >
              <option value="store">受管 Store（推荐，只有引用它的 Agent 可见）</option>
              <option value="shared">共享全局 ~/.agents/skills</option>
            </select>
            {location === "shared" && (
              <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-600">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                共享全局技能可能被普通 Agent 会话自动发现
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 pt-1">
            <DialogClose
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground cursor-pointer"
            >
              取消
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving} className="h-8 rounded-lg text-xs">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InstallSkillDialog({
  deviceId,
  mode,
  open,
  onOpenChange,
  onDone,
}: {
  deviceId: string;
  mode: "git" | "local";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setRef("");
      setName("");
      setError("");
    }
  }, [open]);

  const isGit = mode === "git";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await skillApi(deviceId, "/api/skill/store/install", {
        source: mode,
        ref: ref.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      await onDone();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100dvw-2rem)] sm:max-w-md p-0 overflow-hidden border-border/80 shadow-2xl rounded-2xl animate-scale-in">
        <DialogHeader className="px-6 py-4 bg-muted/50 border-b border-border/70">
          <DialogTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <div className="h-6.5 w-6.5 rounded-lg bg-accent border border-primary/15 flex items-center justify-center">
              {isGit ? (
                <GitBranch className="h-3.5 w-3.5 text-primary" />
              ) : (
                <HardDriveDownload className="h-3.5 w-3.5 text-primary" />
              )}
            </div>
            {isGit ? "从 Git 安装技能" : "从本地导入技能"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 p-6">
          {error && <ErrorBanner message={error} />}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
              {isGit ? "Git 仓库地址" : "本地目录路径"}
            </Label>
            <Input
              required
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              placeholder={isGit ? "https://github.com/org/my-skill.git" : "/path/to/skill（须包含 SKILL.md）"}
              className="h-9 rounded-xl border-border bg-muted/40 font-mono text-xs focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
              技能名称（可选）
            </Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="留空自动从来源推断"
              className="h-9 rounded-xl border-border bg-muted/40 font-mono text-xs focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            安装进受管 Store，不会写入任何 CLI 的全局技能目录；只有引用它的自定义 Agent 会话可见。
          </p>
          <DialogFooter className="gap-2 pt-1">
            <DialogClose
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground cursor-pointer"
            >
              取消
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving} className="h-8 rounded-lg text-xs">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {isGit ? "安装" : "导入"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── 自定义 Agent ────────────────────────────────────────────── */

function CustomAgentsTab({
  deviceId,
  catalog,
  agents,
  onChanged,
}: {
  deviceId: string;
  catalog: SkillSummary[];
  agents: CustomAgent[];
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomAgent | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(agent: CustomAgent) {
    setEditing(agent);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          自定义 Agent = 底层 CLI + 技能集 + 系统提示词，由守护进程统一管理，启动会话时按 ID 引用。
        </p>
        <Button type="button" size="sm" className="h-8 shrink-0 rounded-lg text-xs" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5" />
          新建 Agent
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center text-xs text-muted-foreground">
          还没有自定义 Agent，点击右上角「新建 Agent」创建第一个。
        </div>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex flex-col gap-2 rounded-xl border border-border/80 bg-card p-3 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-bold text-foreground">{agent.name}</span>
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 shrink-0">
                      {baseAgentLabel(agent.base_agent)}
                    </Badge>
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {agent.description || agent.id}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Sparkles className="h-3 w-3" />
                  {agent.skills.length} 个技能
                </span>
                {agent.system_prompt && agent.system_prompt.trim() !== "" && (
                  <span className="flex items-center gap-1" title="已配置系统提示词">
                    <MessageSquareText className="h-3 w-3 text-primary" />
                    提示词
                  </span>
                )}
              </div>
              <div className="flex items-center justify-end gap-1 border-t border-border/60 pt-2">
                <button
                  type="button"
                  onClick={() => openEdit(agent)}
                  className="flex h-6 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
                >
                  <Pencil className="h-3 w-3" />
                  编辑
                </button>
                {confirmDelete === agent.id ? (
                  <button
                    type="button"
                    disabled={busy === agent.id}
                    onClick={() => {
                      setBusy(agent.id);
                      setError("");
                      void skillApi(deviceId, "/api/agent/delete", { agent_id: agent.id })
                        .then(onChanged)
                        .then(() => setConfirmDelete(""))
                        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                        .finally(() => setBusy(""));
                    }}
                    className="flex h-6 items-center gap-1 rounded-lg bg-destructive/10 px-2 text-[10px] font-semibold text-destructive transition-colors hover:bg-destructive/20 cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                    确认删除
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(agent.id)}
                    className="flex h-6 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <AgentEditDialog
        deviceId={deviceId}
        catalog={catalog}
        agent={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onDone={onChanged}
      />
    </div>
  );
}

function AgentEditDialog({
  deviceId,
  catalog,
  agent,
  open,
  onOpenChange,
  onDone,
}: {
  deviceId: string;
  catalog: SkillSummary[];
  agent: CustomAgent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseAgent, setBaseAgent] = useState<CustomAgent["base_agent"]>("pi");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(agent?.name || "");
      setDescription(agent?.description || "");
      setBaseAgent(agent?.base_agent || "pi");
      setSystemPrompt(agent?.system_prompt || "");
      setSelectedSkills(new Set((agent?.skills || []).map((skill) => skill.name)));
      setError("");
    }
  }, [open, agent]);

  function toggleSkill(skillName: string) {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillName)) {
        next.delete(skillName);
      } else {
        next.add(skillName);
      }
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const skills = catalog
        .filter((skill) => selectedSkills.has(skill.name))
        .map((skill) => ({ name: skill.name, path: skill.path }));
      await skillApi(deviceId, "/api/agent/save", {
        agent: {
          id: agent?.id || "",
          name: name.trim(),
          description: description.trim(),
          base_agent: baseAgent,
          system_prompt: systemPrompt,
          skills,
        },
      });
      await onDone();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100dvw-2rem)] sm:max-w-lg p-0 overflow-hidden border-border/80 shadow-2xl rounded-2xl animate-scale-in">
        <DialogHeader className="px-6 py-4 bg-muted/50 border-b border-border/70">
          <DialogTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <div className="h-6.5 w-6.5 rounded-lg bg-accent border border-primary/15 flex items-center justify-center">
              <Bot className="h-3.5 w-3.5 text-primary" />
            </div>
            {agent ? "编辑 Agent" : "新建 Agent"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="max-h-[70dvh] space-y-3 overflow-y-auto p-6">
          {error && <ErrorBanner message={error} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">名称</Label>
              <Input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="小说创作"
                className="h-9 rounded-xl border-border bg-muted/40 text-xs focus:border-primary/50 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">底层 CLI</Label>
              <select
                value={baseAgent}
                onChange={(event) => setBaseAgent(event.target.value as CustomAgent["base_agent"])}
                className={selectClassName}
              >
                {BASE_AGENTS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">描述</Label>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个 Agent 用来做什么"
              className="h-9 rounded-xl border-border bg-muted/40 text-xs focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">系统提示词</Label>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={4}
              placeholder="塑造 Agent 的身份与工作方式，例如：你是资深网文编辑，擅长爽文节奏与章节钩子……"
              className={textareaClassName}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
              技能（{selectedSkills.size} 已选）
            </Label>
            {catalog.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/30 p-3 text-center text-[10px] text-muted-foreground">
                当前设备还没有技能，先去「技能库」新建或安装。
              </div>
            ) : (
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-border/70 bg-muted/20 p-2">
                {catalog.map((skill) => (
                  <label
                    key={`${skill.source}:${skill.path}`}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSkills.has(skill.name)}
                      onChange={() => toggleSkill(skill.name)}
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-semibold text-foreground">{skill.name}</span>
                        <SourceBadge source={skill.source} />
                      </span>
                      {skill.description && (
                        <span className="block truncate text-[10px] text-muted-foreground">{skill.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 pt-1">
            <DialogClose
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground cursor-pointer"
            >
              取消
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving} className="h-8 rounded-lg text-xs">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── 技能编辑 ────────────────────────────────────────────────── */

function SkillEditorTab({
  deviceId,
  catalog,
  skillName,
  onSkillChange,
  onChanged,
}: {
  deviceId: string;
  catalog: SkillSummary[];
  skillName: string;
  onSkillChange: (name: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [entries, setEntries] = useState<FileEntryItem[]>([]);
  const [treeError, setTreeError] = useState("");
  const [activePath, setActivePath] = useState("");
  const [content, setContent] = useState("");
  const [revision, setRevision] = useState("");
  const [binary, setBinary] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState("");
  const [deleteTarget, setDeleteTarget] = useState("");

  const loadTree = useCallback(async () => {
    if (!deviceId || !skillName) {
      setEntries([]);
      return;
    }
    setTreeError("");
    try {
      const result = await skillApi<{ entries?: FileEntryItem[] } & ApiResultBase>(
        deviceId,
        "/api/skill/file/tree",
        { name: skillName }
      );
      setEntries(Array.isArray(result.entries) ? result.entries : []);
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    }
  }, [deviceId, skillName]);

  useEffect(() => {
    setActivePath("");
    setContent("");
    setRevision("");
    setBinary(false);
    setDirty(false);
    setConflict(false);
    setNotice("");
    setError("");
    void loadTree();
  }, [loadTree]);

  async function openFile(path: string, isDir: boolean) {
    if (isDir) return;
    setBusy(true);
    setError("");
    setNotice("");
    setConflict(false);
    try {
      const result = await skillApi<{
        content?: string;
        revision?: string;
        binary?: boolean;
      } & ApiResultBase>(deviceId, "/api/skill/file/read", { name: skillName, path });
      setActivePath(path);
      setBinary(Boolean(result.binary));
      setContent(result.binary ? "" : result.content || "");
      setRevision(result.revision || "");
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveFile(forceRevision?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await skillApi<{ revision?: string; conflict?: boolean } & ApiResultBase>(
        deviceId,
        "/api/skill/file/write",
        {
          name: skillName,
          path: activePath,
          content,
          expected_revision: forceRevision ?? revision,
        }
      );
      if (result.conflict) {
        setConflict(true);
        return;
      }
      setRevision(result.revision || "");
      setConflict(false);
      setDirty(false);
      setNotice("已保存");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConflictOverwrite() {
    // Last-writer-wins: read the current server revision, then write our content.
    setBusy(true);
    setError("");
    try {
      const latest = await skillApi<{ revision?: string } & ApiResultBase>(
        deviceId,
        "/api/skill/file/read",
        { name: skillName, path: activePath }
      );
      await saveFile(latest.revision || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={skillName}
          onChange={(event) => onSkillChange(event.target.value)}
          className={`${selectClassName} max-w-64`}
        >
          <option value="">选择要编辑的技能…</option>
          {catalog.map((skill) => (
            <option key={`${skill.source}:${skill.path}`} value={skill.name}>
              {skill.name}（{skill.source === "store" ? "受管" : "共享全局"}）
            </option>
          ))}
        </select>
        {skillName && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 rounded-lg text-xs"
            onClick={() => setCreateOpen(true)}
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            新建文件
          </Button>
        )}
      </div>

      {!skillName ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center text-xs text-muted-foreground">
          选择一个技能后开始编辑其文件。
        </div>
      ) : treeError ? (
        <ErrorBanner message={treeError} />
      ) : (
        <div className="grid gap-2 md:grid-cols-[minmax(12rem,16rem)_1fr]">
          {/* File tree */}
          <div className="max-h-80 overflow-y-auto rounded-xl border border-border/70 bg-muted/20 p-1.5 md:max-h-[50dvh]">
            {entries.length === 0 ? (
              <div className="p-3 text-center text-[10px] text-muted-foreground">空目录</div>
            ) : (
              entries.map((entry) => {
                const depth = entry.path.split("/").length - 1;
                const active = activePath === entry.path;
                return (
                  <div
                    key={entry.path}
                    className={`group flex h-6 items-center gap-1 rounded-lg pr-1 text-xs transition-colors ${
                      active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                    style={{ paddingLeft: `${8 + depth * 14}px` }}
                  >
                    <button
                      type="button"
                      onClick={() => void openFile(entry.path, entry.is_dir)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 cursor-pointer text-left"
                    >
                      {entry.is_dir ? (
                        <FolderClosed className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className={`truncate ${entry.is_dir ? "font-semibold" : ""}`}>{entry.name}</span>
                    </button>
                    {entry.path !== "SKILL.md" && (
                      <span className="invisible flex shrink-0 items-center group-hover:visible">
                        <button
                          type="button"
                          onClick={() => setRenameTarget(entry.path)}
                          className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-pointer"
                          title="重命名"
                        >
                          <Pencil className="h-2.5 w-2.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(entry.path)}
                          className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-destructive cursor-pointer"
                          title="删除"
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Editor */}
          <div className="flex min-h-60 flex-col rounded-xl border border-border/70 bg-muted/20 p-2">
            {!activePath ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-[10px] text-muted-foreground">
                点击左侧文件开始编辑
              </div>
            ) : binary ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
                二进制文件，不支持编辑
              </div>
            ) : (
              <>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px] text-muted-foreground">{activePath}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {notice && <span className="text-[10px] font-semibold text-emerald-600">{notice}</span>}
                    {dirty && <span className="text-[10px] text-amber-600">未保存</span>}
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !dirty}
                      onClick={() => void saveFile()}
                      className="h-7 rounded-lg text-xs"
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      保存
                    </Button>
                  </div>
                </div>
                {conflict && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] font-semibold text-amber-700">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    文件已被其他来源修改。
                    <button
                      type="button"
                      onClick={() => void openFile(activePath, false)}
                      className="rounded-md bg-muted px-2 py-0.5 text-foreground hover:bg-muted/70 cursor-pointer"
                    >
                      重新加载（放弃我的修改）
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleConflictOverwrite()}
                      className="rounded-md bg-amber-500/20 px-2 py-0.5 hover:bg-amber-500/30 cursor-pointer"
                    >
                      以我的内容覆盖
                    </button>
                  </div>
                )}
                {error && <div className="mb-1.5"><ErrorBanner message={error} /></div>}
                <textarea
                  value={content}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setDirty(true);
                    setNotice("");
                  }}
                  spellCheck={false}
                  className="min-h-48 flex-1 resize-y rounded-lg border border-border/60 bg-card p-2.5 font-mono text-xs leading-relaxed text-foreground focus:border-primary/50 focus:outline-none md:min-h-[38dvh]"
                />
              </>
            )}
          </div>
        </div>
      )}

      <FileCreateDialog
        deviceId={deviceId}
        skillName={skillName}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onDone={loadTree}
      />
      <FileRenameDialog
        deviceId={deviceId}
        skillName={skillName}
        path={renameTarget}
        onClose={() => setRenameTarget("")}
        onDone={async () => {
          await loadTree();
          if (activePath === renameTarget) setActivePath("");
        }}
      />
      <FileDeleteDialog
        deviceId={deviceId}
        skillName={skillName}
        path={deleteTarget}
        onClose={() => setDeleteTarget("")}
        onDone={async () => {
          await loadTree();
          if (activePath === deleteTarget) {
            setActivePath("");
            setContent("");
          }
        }}
      />
    </div>
  );
}

function FileCreateDialog({
  deviceId,
  skillName,
  open,
  onOpenChange,
  onDone,
}: {
  deviceId: string;
  skillName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [isDir, setIsDir] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setPath("");
      setIsDir(false);
      setError("");
    }
  }, [open]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await skillApi(deviceId, "/api/skill/file/create", { name: skillName, path: path.trim(), is_dir: isDir });
      await onDone();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100dvw-2rem)] sm:max-w-md p-0 overflow-hidden border-border/80 shadow-2xl rounded-2xl animate-scale-in">
        <DialogHeader className="px-6 py-4 bg-muted/50 border-b border-border/70">
          <DialogTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <div className="h-6.5 w-6.5 rounded-lg bg-accent border border-primary/15 flex items-center justify-center">
              <FilePlus2 className="h-3.5 w-3.5 text-primary" />
            </div>
            新建文件
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 p-6">
          {error && <ErrorBanner message={error} />}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">相对路径</Label>
            <Input
              required
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="references/guide.md 或 scripts/run.sh"
              className="h-9 rounded-xl border-border bg-muted/40 font-mono text-xs focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={isDir}
              onChange={(event) => setIsDir(event.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-primary"
            />
            <span className="flex items-center gap-1.5">
              <FolderPlus className="h-3.5 w-3.5 text-amber-500" />
              创建为目录
            </span>
          </label>
          <DialogFooter className="gap-2 pt-1">
            <DialogClose
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground cursor-pointer"
            >
              取消
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving} className="h-8 rounded-lg text-xs">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FileRenameDialog({
  deviceId,
  skillName,
  path,
  onClose,
  onDone,
}: {
  deviceId: string;
  skillName: string;
  path: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (path) {
      setNewPath(path);
      setError("");
    }
  }, [path]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await skillApi(deviceId, "/api/skill/file/rename", { name: skillName, path, new_path: newPath.trim() });
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={path !== ""} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100dvw-2rem)] sm:max-w-md p-0 overflow-hidden border-border/80 shadow-2xl rounded-2xl animate-scale-in">
        <DialogHeader className="px-6 py-4 bg-muted/50 border-b border-border/70">
          <DialogTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <div className="h-6.5 w-6.5 rounded-lg bg-accent border border-primary/15 flex items-center justify-center">
              <Pencil className="h-3.5 w-3.5 text-primary" />
            </div>
            重命名
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 p-6">
          {error && <ErrorBanner message={error} />}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">新路径</Label>
            <Input
              required
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              className="h-9 rounded-xl border-border bg-muted/40 font-mono text-xs focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <DialogFooter className="gap-2 pt-1">
            <DialogClose
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground cursor-pointer"
            >
              取消
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving} className="h-8 rounded-lg text-xs">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              重命名
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FileDeleteDialog({
  deviceId,
  skillName,
  path,
  onClose,
  onDone,
}: {
  deviceId: string;
  skillName: string;
  path: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (path) setError("");
  }, [path]);

  async function handleDelete() {
    setSaving(true);
    setError("");
    try {
      await skillApi(deviceId, "/api/skill/file/delete", { name: skillName, path });
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={path !== ""} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100dvw-2rem)] sm:max-w-sm p-0 overflow-hidden border-border/80 shadow-2xl rounded-2xl animate-scale-in">
        <DialogHeader className="px-6 py-4 bg-muted/50 border-b border-border/70">
          <DialogTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <div className="h-6.5 w-6.5 rounded-lg bg-destructive/10 border border-destructive/15 flex items-center justify-center">
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </div>
            删除文件
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-6">
          {error && <ErrorBanner message={error} />}
          <p className="text-xs text-muted-foreground">
            确定删除 <span className="font-mono font-semibold text-foreground">{path}</span> 吗？此操作不可恢复。
          </p>
          <DialogFooter className="gap-2 pt-1">
            <DialogClose
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground cursor-pointer"
            >
              取消
            </DialogClose>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={saving}
              onClick={() => void handleDelete()}
              className="h-8 rounded-lg text-xs"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              删除
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
