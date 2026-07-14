import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  Cpu,
  FileEdit,
  FilePlus,
  FileText,
  ListChecks,
  Search,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { normalizeAgentToolName, type AgentToolCallItem } from "@/lib/agent-protocol";
import type { ChatMessage } from "./types";

type MarkdownCodeProps = {
  className?: string;
  children?: React.ReactNode;
};

export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown-body text-xs leading-relaxed break-words text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-1.5 [&_li]:leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:border-border/80 [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground [&_h1]:text-sm [&_h1]:font-bold [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:font-bold [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mb-1 [&_a]:text-primary [&_a]:underline [&_table]:w-full [&_table]:text-[11px] [&_th]:border [&_th]:border-border/80 [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:font-semibold [&_td]:border [&_td]:border-border/80 [&_td]:px-1.5 [&_td]:py-0.5 [&_hr]:border-border/60 [&_hr]:my-2">
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => (
            <pre className="markdown-code-block p-2.5 rounded-lg overflow-x-auto font-mono text-[10.5px] border my-1.5 select-text">
              {children}
            </pre>
          ),
          code: ({ className, children, ...props }: MarkdownCodeProps) => {
            const isBlock = /language-/.test(className || "");
            if (isBlock) return <code className={className} {...props}>{children}</code>;
            return <code className="markdown-inline-code px-1.5 py-0.5 rounded font-mono text-[10.5px] select-text" {...props}>{children}</code>;
          },
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function WorkingStatus({ elapsedMs }: { elapsedMs: number }) {
  return (
    <div className="px-1 py-1 text-[11px] font-semibold text-primary select-none">
      <span className="agent-working-word" aria-label="Working">
        {"Working".split("").map((char, index) => (
          <span key={`${char}-${index}`} style={{ animationDelay: `${index * 70}ms` }}>
            {char}
          </span>
        ))}
      </span>
      <span className="ml-1.5 text-primary/80">{formatElapsedMs(elapsedMs)}</span>
    </div>
  );
}

export function RunDurationStatus({ elapsedMs }: { elapsedMs: number }) {
  return (
    <div className="flex items-center gap-2 px-1 py-2 text-[11px] font-medium text-muted-foreground/70 select-none">
      <span className="h-px w-3 shrink-0 bg-muted-foreground/35" />
      <span className="shrink-0">Worked for {formatWorkedDurationMs(elapsedMs)}</span>
      <span className="h-px min-w-8 flex-1 bg-muted-foreground/35" />
    </div>
  );
}

function formatWorkedDurationMs(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function formatElapsedMs(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}分 ${seconds}秒`;
  }
  return `${seconds}秒`;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return getRecord(value);
  try {
    const parsed = JSON.parse(value);
    return getRecord(parsed);
  } catch {
    return null;
  }
}

function getStringField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifyValue).filter(Boolean).join(" ");
  const record = getRecord(value);
  if (!record) return "";
  return getStringField(record, ["command", "cmd", "path", "file_path", "filePath", "query", "pattern", "url", "name", "title"]);
}

function firstLine(value: string) {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() || value.trim();
}

function getArrayField(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }
  return null;
}

function compactMiddle(value: string, max = 96) {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function diffOutputRecord(output: unknown) {
  const record = getRecord(output);
  return record?.type === "diff" ? record : null;
}

type DiffChange = {
  kind?: string;
  newText?: string;
  oldText?: string;
  patch?: string;
  path?: string;
};

function diffChanges(outputDiff: Record<string, unknown> | null): DiffChange[] {
  if (!outputDiff) return [];
  const changes = Array.isArray(outputDiff.changes) ? outputDiff.changes : [];
  const normalized: DiffChange[] = [];
  for (const item of changes) {
    const record = getRecord(item);
    if (!record) continue;
    normalized.push({
      kind: getStringField(record, ["kind", "type", "operation"]) || undefined,
      newText: typeof record.newText === "string" ? record.newText : getStringField(record, ["new_text", "new_string", "content"]),
      oldText: typeof record.oldText === "string" ? record.oldText : getStringField(record, ["old_text", "old_string"]),
      patch: getStringField(record, ["patch", "diff", "unifiedDiff", "unified_diff"]),
      path: getStringField(record, ["path", "file_path", "filePath", "filename"]),
    });
  }
  if (normalized.length > 0) return normalized;
  const path = getStringField(outputDiff, ["path"]);
  const patch = getStringField(outputDiff, ["patch", "diff", "unifiedDiff", "unified_diff"]);
  const oldText = typeof outputDiff.oldText === "string" ? outputDiff.oldText : undefined;
  const newText = typeof outputDiff.newText === "string" ? outputDiff.newText : undefined;
  if (path || patch || oldText !== undefined || newText !== undefined) {
    return [{ kind: getStringField(outputDiff, ["kind"]), newText, oldText, patch, path }];
  }
  return [];
}

function extractToolTarget(item: AgentToolCallItem) {
  const input = parseRecord(item.input);
  const outputDiff = diffOutputRecord(item.output);
  const changes = diffChanges(outputDiff);
  const outputPath = getStringField(outputDiff, ["path"]) || changes.find((change) => change.path)?.path || "";
  const inputPath = getStringField(input, ["path", "file_path", "filePath", "notebook_path", "filename"]);
  const paths = getArrayField(input, ["paths", "locations", "files"]);
  const args = getArrayField(input, ["args", "arguments"]);
  const command =
    typeof item.input === "string"
      ? firstLine(item.input)
      : getStringField(input, ["command", "cmd", "script"]);
  const commandWithArgs = [command, args?.map(stringifyValue).filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
  const query = getStringField(input, ["query", "search_query", "searchQuery", "pattern", "search"]);
  const url = getStringField(input, ["url", "uri", "href"]);
  const target = inputPath || outputPath || (paths ? String(paths[0]) : "") || query || url || "";
  return { changes, command: commandWithArgs || command, input, inputPath, outputDiff, outputPath, paths, query, url, target };
}

function describeToolCall(item: AgentToolCallItem) {
  const { changes, command, outputDiff, query, url, target } = extractToolTarget(item);
  const titleKind = normalizeAgentToolName(item.title || "");
  const kind = normalizeAgentToolName(item.kind || item.title || "");
  const effectiveKind = kind !== "tool" ? kind : titleKind;

  if (effectiveKind === "websearch" || effectiveKind === "webfetch" || url) {
    return { icon: Search, accent: "violet", action: effectiveKind === "websearch" ? "搜索网页" : "获取网页", target: url || query || target || "网页内容" };
  }
  if (effectiveKind === "grep" || effectiveKind === "glob" || effectiveKind.includes("search") || query) {
    return { icon: Search, accent: "violet", action: effectiveKind === "glob" ? "匹配文件" : "搜索", target: query || target || "查询匹配项" };
  }
  if (effectiveKind === "bash" || effectiveKind === "exec_command" || command) {
    return { icon: Terminal, accent: "emerald", action: "执行命令", target: command || "命令执行" };
  }
  if (effectiveKind === "read") {
    return { icon: FileText, accent: "sky", action: "读取文件", target };
  }
  if (effectiveKind === "write") {
    return { icon: FilePlus, accent: "emerald", action: "创建文件", target };
  }
  if (effectiveKind === "apply_patch" || effectiveKind === "edit" || outputDiff) {
    const diffKind = String(outputDiff?.kind || changes[0]?.kind || "");
    const isCreate = diffKind === "create" || diffKind === "add" || effectiveKind === "write";
    const actionName = isCreate ? "创建文件" : changes.length > 1 ? `修改 ${changes.length} 个文件` : "修改文件";
    return { icon: isCreate ? FilePlus : FileEdit, accent: isCreate ? "emerald" : "amber", action: actionName, target };
  }
  let action = item.kind || "工具调用";
  if (action.toLowerCase() === "other") {
    action = "tool";
  }
  return { icon: Wrench, accent: "slate", action, target: target || item.title || "查看详情" };
}

function readableToolOutput(output: AgentToolCallItem["output"]) {
  if (!output) return "";
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          const text = parsed.text ?? parsed.output ?? parsed.result;
          if (typeof text === "string") return text;
          if (parsed.content) {
            return stringifyValue(parsed.content);
          }
        }
      } catch {
        return output;
      }
    }
    return output;
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function readableToolInput(input: AgentToolCallItem["input"], kind: string) {
  if (!input) return "";
  const inputRecord = parseRecord(input);
  if (inputRecord && ["edit", "write", "apply_patch", "bash", "exec_command"].includes(kind)) {
    const compact: Record<string, unknown> = {};
    for (const key of [
      "file_path",
      "filePath",
      "path",
      "notebook_path",
      "filename",
      "command",
      "cmd",
      "description",
      "query",
      "search_query",
      "searchQuery",
      "pattern",
      "url",
    ]) {
      if (inputRecord[key] !== undefined) compact[key] = inputRecord[key];
    }
    if (Object.keys(compact).length > 0) {
      try {
        return JSON.stringify(compact, null, 2);
      } catch {
        return "";
      }
    }
    return "";
  }
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function changePathLabel(change: DiffChange, index: number) {
  return change.path || `变更 ${index + 1}`;
}

function DiffChangePreview({ change, index }: { change: DiffChange; index: number }) {
  const hasPatch = !!change.patch;
  const hasOldNew = change.oldText !== undefined || change.newText !== undefined;
  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-muted/15">
      <div className="flex items-center gap-2 border-b border-border/50 px-2.5 py-1.5 text-[10px] text-muted-foreground">
        <FileEdit className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{changePathLabel(change, index)}</span>
        {change.kind && (
          <span className="ml-auto shrink-0 rounded border border-border/60 bg-card/70 px-1.5 py-0.5 text-[9.5px]">
            {change.kind}
          </span>
        )}
      </div>
      {hasPatch ? (
        <pre className="max-h-72 overflow-auto p-2.5 font-mono text-[10px] leading-relaxed text-foreground/85 whitespace-pre-wrap select-text">
          {change.patch}
        </pre>
      ) : hasOldNew ? (
        <div className="grid gap-0 md:grid-cols-2">
          <pre className="max-h-64 overflow-auto border-b border-border/50 bg-rose-950/5 p-2.5 font-mono text-[10px] leading-relaxed text-rose-700 dark:text-rose-300 whitespace-pre-wrap select-text md:border-b-0 md:border-r">
            {change.oldText || "empty"}
          </pre>
          <pre className="max-h-64 overflow-auto bg-emerald-950/5 p-2.5 font-mono text-[10px] leading-relaxed text-emerald-700 dark:text-emerald-300 whitespace-pre-wrap select-text">
            {change.newText || "empty"}
          </pre>
        </div>
      ) : (
        <div className="px-2.5 py-2 text-[10.5px] text-muted-foreground">无可展示的变更内容</div>
      )}
    </div>
  );
}

function ToolDiffPreview({ outputDiff }: { outputDiff: Record<string, unknown> }) {
  const changes = diffChanges(outputDiff);
  const patch = getStringField(outputDiff, ["patch", "diff", "unifiedDiff", "unified_diff"]);
  if (patch && changes.length === 0) {
    return (
      <div className="space-y-1">
        <div className="text-[9.5px] font-bold text-muted-foreground/65 uppercase select-none">文件变更</div>
        <pre className="max-h-80 overflow-auto rounded-md border border-border/60 bg-muted/20 p-2.5 font-mono text-[10px] leading-relaxed text-foreground/85 whitespace-pre-wrap select-text">
          {patch}
        </pre>
      </div>
    );
  }
  if (changes.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[9.5px] font-bold text-muted-foreground/65 uppercase select-none">
        <span>文件变更</span>
        {changes.length > 1 && (
          <span className="rounded border border-border/60 bg-muted/30 px-1.5 py-0.5 font-mono text-[9px] font-medium normal-case">
            {changes.length} files
          </span>
        )}
      </div>
      <div className="space-y-2">
        {changes.map((change, index) => (
          <DiffChangePreview key={`${change.path || "change"}-${index}`} change={change} index={index} />
        ))}
      </div>
    </div>
  );
}

export function ToolCallGroup({ items, nowMs }: { items: ChatMessage[]; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const firstItem = items[0]?.toolCall;
  const firstDesc = useMemo(() => firstItem ? describeToolCall(firstItem) : null, [firstItem]);
  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const msg of items) {
      if (!msg.toolCall) continue;
      const action = describeToolCall(msg.toolCall).action;
      counts.set(action, (counts.get(action) || 0) + 1);
    }
    const parts = Array.from(counts.entries()).map(([action, count]) =>
      count > 1 ? `${action} ${count} 次` : action
    );
    return parts.join("、") || `${items.length} 项操作`;
  }, [items]);
  if (!firstItem || !firstDesc) return null;
  const Icon = firstDesc.icon;
  const accent = toolAccentClasses[firstDesc.accent as keyof typeof toolAccentClasses];
  const pendingCount = items.filter(
    (m) => m.toolCall && m.toolCall.status !== "completed" && m.toolCall.status !== "success" && m.toolCall.status !== "failed" && m.toolCall.status !== "error"
  ).length;

  return (
    <div className="w-full max-w-none">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none rounded"
      >
        <Icon className={`h-3 w-3 shrink-0 ${accent.icon}`} />
        <span className="min-w-0 truncate font-medium">{summary}</span>
        <span className="shrink-0 text-muted-foreground/60">{items.length} 项</span>
        {pendingCount > 0 && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/70 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
        )}
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform ml-auto ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="ml-4 mt-0.5 space-y-1.5 border-l border-border/60 pl-2.5">
          {items.map((m) =>
            m.toolCall ? <ToolCallCard key={m.id} item={m.toolCall} nowMs={nowMs} /> : null
          )}
        </div>
      )}
    </div>
  );
}

const toolAccentClasses = {
  emerald: {
    icon: "text-emerald-600 dark:text-emerald-400",
  },
  sky: {
    icon: "text-sky-600 dark:text-sky-400",
  },
  amber: {
    icon: "text-amber-600 dark:text-amber-400",
  },
  violet: {
    icon: "text-violet-600 dark:text-violet-400",
  },
  slate: {
    icon: "text-slate-500 dark:text-slate-400",
  },
} as const;

export function extractTodos(item: AgentToolCallItem): Array<{ content: string; status?: string }> | null {
  const input = getRecord(item.input);
  if (!input) return null;
  const todos = input.todos ?? input.todo_list ?? input.items;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  return todos
    .map((t: unknown) => {
      if (typeof t === "string") return { content: t, status: "pending" };
      const rec = getRecord(t);
      if (!rec) return null;
      const content = String(rec.content ?? rec.description ?? rec.text ?? "");
      if (!content) return null;
      return { content, status: String(rec.status ?? rec.state ?? "pending") };
    })
    .filter((t): t is { content: string; status: string } => t !== null);
}

export function TodoWidget({ todos }: { todos: Array<{ content: string; status?: string }> }) {
  const [open, setOpen] = useState(true);
  const completed = todos.filter((t) => t.status === "completed" || t.status === "success").length;
  return (
    <div className="my-1 w-full max-w-none">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none rounded"
      >
        <ListChecks className="h-3 w-3 shrink-0 text-primary" />
        <span className="shrink-0 font-medium">任务清单</span>
        <span className="text-muted-foreground/60">{completed}/{todos.length}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform ml-auto ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <ul className="ml-5 mt-0.5 space-y-0.5">
          {todos.map((todo, idx) => {
            const isDone = todo.status === "completed" || todo.status === "success";
            const isInProgress = todo.status === "in_progress" || todo.status === "in-progress";
            return (
              <li key={idx} className="flex items-start gap-1.5 text-[10.5px] text-muted-foreground/90">
                <span className="pt-0.5 shrink-0">
                  {isDone ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  ) : isInProgress ? (
                    <CircleDot className="h-3 w-3 text-primary" />
                  ) : (
                    <Circle className="h-3 w-3 text-muted-foreground/30" />
                  )}
                </span>
                <span className={isDone ? "line-through text-muted-foreground/50" : ""}>{todo.content}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function extractSubagent(item: AgentToolCallItem) {
  const input = getRecord(item.input);
  if (!input) return null;
  const description = String(input.description ?? input.prompt ?? input.task ?? "");
  const subagentType = String(input.subagent_type ?? input.agent_type ?? input.type ?? "");
  if (!description) return null;
  return { description, subagentType, output: item.output, status: item.status, createdAt: item.createdAt };
}

export function SubagentEntry({ item, nowMs }: { item: { description: string; subagentType: string; output: unknown; status?: string; createdAt: string }; nowMs: number }) {
  const isDone = item.status === "completed" || item.status === "success";
  const isFailed = item.status === "failed" || item.status === "error";
  const isRunning = !isDone && !isFailed;
  const [open, setOpen] = useState(isRunning);

  const resultText = useMemo(() => {
    return readableToolOutput(item.output);
  }, [item.output]);

  useEffect(() => {
    if (isRunning) setOpen(true);
  }, [isRunning, resultText]);

  const elapsed = useMemo(() => {
    const start = new Date(item.createdAt).getTime();
    if (!Number.isFinite(start)) return "";
    const end = isDone || isFailed ? start + 1000 : nowMs;
    return formatElapsedMs(end - start);
  }, [item.createdAt, isDone, isFailed, nowMs]);

  return (
    <div className="my-1 w-full max-w-none">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none rounded"
      >
        <Cpu className={`h-3 w-3 shrink-0 ${isFailed ? "text-rose-500" : isDone ? "text-emerald-500" : "text-primary"}`} />
        <span className="shrink-0 font-medium">{item.subagentType || "子代理"}</span>
        <span className="min-w-0 truncate text-muted-foreground/60">{item.description}</span>
        {elapsed && <span className="shrink-0 text-muted-foreground/50">{elapsed}</span>}
        {isRunning && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/70 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
        )}
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform ml-auto ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="ml-5 mt-0.5 border-l border-border/60 pl-2.5">
          <div className="max-h-48 overflow-y-auto rounded-md bg-muted/35 p-2 text-[10.5px] text-muted-foreground whitespace-pre-wrap select-text">
            {resultText || (isRunning ? "等待子代理输出..." : "无输出")}
          </div>
        </div>
      )}
    </div>
  );
}

export function CollapsibleSection({ durationMs, children }: { durationMs?: number; children: string }) {
  const [open, setOpen] = useState(false);

  const formattedDuration = useMemo(() => {
    if (durationMs === undefined || durationMs === null || durationMs <= 0) return "";
    return formatElapsedMs(durationMs);
  }, [durationMs]);

  const preview = useMemo(() => {
    if (!children) return "";
    const singleLine = children.replace(/\s+/g, " ").trim();
    return compactMiddle(singleLine, 80);
  }, [children]);

  return (
    <div className="w-full max-w-none">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none rounded"
      >
        <Brain className="h-3 w-3 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="shrink-0 font-medium text-foreground/80">思考中</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground/60">{preview}</span>
        {formattedDuration && (
          <span className="shrink-0 text-muted-foreground/50">{formattedDuration}</span>
        )}
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="ml-4 mt-0.5 pb-1 space-y-1.5 border-l border-border/60 pl-2.5">
          <div className="rounded-md bg-muted/10 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground max-h-80 overflow-y-auto whitespace-pre-wrap select-text">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}


export function ToolCallCard({ item, nowMs }: { item: AgentToolCallItem; nowMs: number }) {
  const [open, setOpen] = useState(false);

  const statusLogo = useMemo(() => {
    if (item.status === "completed" || item.status === "success") {
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
    }
    if (item.status === "failed" || item.status === "error") {
      return <XCircle className="h-3.5 w-3.5 text-rose-500 shrink-0" />;
    }
    return (
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/70 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
      </span>
    );
  }, [item.status]);

  const description = useMemo(() => describeToolCall(item), [item]);
  const accent = toolAccentClasses[description.accent as keyof typeof toolAccentClasses];
  const Icon = description.icon;
  const outputDiff = diffOutputRecord(item.output);
  const kind = normalizeAgentToolName(item.kind || item.title || "");
  const readableInput = useMemo(() => readableToolInput(item.input, kind), [item.input, kind]);
  const readableOutput = readableToolOutput(item.output);
  const elapsed = useMemo(() => {
    const start = new Date(item.createdAt).getTime();
    const end = item.completedAt ? new Date(item.completedAt).getTime() : nowMs;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
    return formatElapsedMs(end - start);
  }, [item.createdAt, item.completedAt, nowMs]);

  return (
    <div className="w-full max-w-none">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none rounded"
      >
        <Icon className={`h-3 w-3 shrink-0 ${accent.icon}`} />
        <span className="shrink-0 font-medium">{description.action}</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground/60">{compactMiddle(description.target, 80)}</span>
        {elapsed && <span className="shrink-0 text-muted-foreground/50">{elapsed}</span>}
        {statusLogo}
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="ml-4 mt-0.5 pb-1 space-y-1.5 border-l border-border/60 pl-2.5">
          {description.action === "执行命令" && description.target && (
            <div className="rounded-md border border-emerald-500/20 bg-slate-950 p-2.5 font-mono text-[10.5px] text-emerald-300 select-text overflow-x-auto">
              $ {description.target}
            </div>
          )}
          {outputDiff && <ToolDiffPreview outputDiff={outputDiff} />}
          {readableInput && (
            <div className="space-y-1">
              <div className="text-[9.5px] font-bold text-muted-foreground/65 uppercase select-none">输入参数</div>
              <pre className="bg-muted/40 p-2 rounded-md font-mono text-[10px] text-foreground/85 overflow-x-auto max-h-60 whitespace-pre-wrap select-text border border-border/60">
                {readableInput}
              </pre>
            </div>
          )}
          {readableOutput && !outputDiff && (
            <div className="space-y-1">
              <div className="text-[9.5px] font-bold text-muted-foreground/65 uppercase select-none">输出结果</div>
              <pre className="bg-muted/40 p-2 rounded-md font-mono text-[10px] text-foreground/85 overflow-x-auto max-h-60 whitespace-pre-wrap select-text border border-border/60">
                {readableOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
