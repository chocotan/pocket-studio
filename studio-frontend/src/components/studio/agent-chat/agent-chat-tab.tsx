import { useState, useEffect, useRef, useMemo } from "react";
import {
  Send,
  Cpu,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  StopCircle,
  ArrowRight,
  Terminal,
  FileText,
  FileEdit,
  FilePlus,
  Wrench,
  Search,
  Circle,
  CircleDot,
  ListChecks
} from "lucide-react";
import { OpenCode, Codex, ClaudeCode, Antigravity, KiloCode } from "@lobehub/icons";
import { getJSON, postJSON, eventStreamURL } from "@/lib/api";
import { makeId } from "../terminal-types";
import { type StudioTab } from "../studio-layout";
import type { Project } from "../studio-dashboard";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  classifyAgentProtocolEvent,
  buildAgentToolCallItems,
  type AgentToolCallItem
} from "@/lib/agent-protocol";

function getUnixTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

function checkSessionEnded(evt: TaskEvent): boolean {
  if (!evt || !evt.raw) return false;
  const rawStr = typeof evt.raw === "object" ? JSON.stringify(evt.raw) : String(evt.raw);
  return rawStr.includes('"stopReason"');
}

function getMetadata(raw: any): Record<string, any> | undefined {
  if (!raw) return undefined;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown-body text-xs leading-relaxed break-words text-slate-800 dark:text-slate-200 [&_p]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-1.5 [&_li]:leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-2 [&_blockquote]:text-slate-500 [&_h1]:text-sm [&_h1]:font-bold [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:font-bold [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mb-1 [&_a]:text-indigo-600 [&_a]:underline [&_table]:w-full [&_table]:text-[11px] [&_th]:border [&_th]:border-slate-300 [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:font-semibold [&_td]:border [&_td]:border-slate-300 [&_td]:px-1.5 [&_td]:py-0.5 [&_hr]:border-slate-300 [&_hr]:my-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => (
            <pre className="bg-slate-950 text-slate-100 p-2.5 rounded-lg overflow-x-auto font-mono text-[10.5px] border border-slate-800 my-1.5 select-text">
              {children}
            </pre>
          ),
          code: ({ className, children, ...props }: any) => {
            const isBlock = /language-/.test(className || "");
            if (isBlock) return <code className={className} {...props}>{children}</code>;
            return <code className="bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 px-1 py-0.5 rounded font-mono text-[10.5px] select-text" {...props}>{children}</code>;
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface TaskEvent {
  task_id: string;
  event_id: string;
  event_type: string;
  source: string;
  sequence: number;
  timestamp: number;
  data?: string;
  raw?: string;
}

interface ChatMessage {
  id: string;
  seq: number;
  kind: "user_prompt" | "assistant_message" | "thought" | "tool_call";
  content: string;
  createdAt: string;
  durationMs?: number;
  toolCall?: AgentToolCallItem;
}

interface AgentChatTabProps {
  project: Project;
  tab: StudioTab;
  active: boolean;
  workspacePath: string;
  onUpdateTabProperties: (tabId: string, props: Partial<StudioTab>) => void;
}

export function AgentChatTab({
  project,
  tab,
  active,
  workspacePath,
  onUpdateTabProperties
}: AgentChatTabProps) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [runStartedAtMs, setRunStartedAtMs] = useState(() => Date.now());
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const sessionId = tab.agentSessionId;
  const agentKind = tab.agentKind || "opencode";

  const agentLogo = useMemo(() => {
    switch (agentKind) {
      case "opencode":
        return <OpenCode width={16} height={16} />;
      case "codex":
        return <Codex width={16} height={16} />;
      case "claude":
        return <ClaudeCode width={16} height={16} />;
      case "agy":
        return <Antigravity width={16} height={16} />;
      case "kilo":
        return <KiloCode width={16} height={16} />;
      default:
        return <Cpu className="h-4 w-4" />;
    }
  }, [agentKind]);

  // Load history when sessionId is set or component mounts
  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setRunning(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");

    getJSON<{ events: { payload: TaskEvent }[] }>(`/api/acpx/events?task_id=${sessionId}&limit=0`)
      .then((res) => {
        if (cancelled) return;
        const historyEvents = (res.events || []).map((env) => env.payload as TaskEvent);
        setEvents(historyEvents);

        // Check if session is currently active
        // If the last event is not complete or task is running, set running to true
        const hasSessionEnded = historyEvents.some(checkSessionEnded);
        setRunning(!hasSessionEnded);
      })
      .catch((err) => {
        if (!cancelled) setError("加载对话历史失败: " + err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Handle EventSource connection for ongoing stream
  useEffect(() => {
    if (!sessionId || !running || !active) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    const lastSeq = events.length > 0 ? Math.max(...events.map((e) => e.sequence)) : 0;
    const url = eventStreamURL("/api/acpx/events", new URLSearchParams({
      task_id: sessionId,
      stream: "true",
      after: String(lastSeq)
    }));

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("task.event", (message: MessageEvent) => {
      try {
        const envelope = JSON.parse(message.data);
        const taskEvent = envelope.payload as TaskEvent;

        setEvents((prev) => {
          if (prev.some((e) => e.event_id === taskEvent.event_id)) {
            return prev;
          }
          const next = [...prev, taskEvent];

          // Check if agent completed its execution
          if (checkSessionEnded(taskEvent)) {
            setRunning(false);
          }
          return next;
        });
      } catch (err) {
        console.error("SSE parse error:", err);
      }
    });

    es.onerror = () => {
      // Auto-reconnect will be handled by EventSource naturally
      console.warn("EventSource encountered an error, reconnecting...");
    };

    return () => {
      es.close();
      if (eventSourceRef.current === es) {
        eventSourceRef.current = null;
      }
    };
  }, [sessionId, running, active, events.length]);

  // Auto scroll to bottom
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  useEffect(() => {
    if (!running) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const messages = useMemo<ChatMessage[]>(() => {
    if (events.length === 0) return [];

    const sorted = [...events].sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const list: ChatMessage[] = [];

    const agentEvents = sorted.map((evt) => {
      const dataPayload = getMetadata(evt.data);
      const rawMetadata = getMetadata(evt.raw);
      return { evt, dataPayload, rawMetadata };
    });

    const toolCallEvents = agentEvents
      .filter(({ evt }) =>
        evt.event_type === "tool.call" ||
        evt.event_type === "tool.output" ||
        evt.event_type === "permission.request"
      )
      .map(({ evt, rawMetadata }) => ({
        id: evt.event_id,
        seq: Number(evt.sequence),
        kind: "tool_call" as const,
        content: "",
        createdAt: new Date(evt.timestamp * 1000).toISOString(),
        metadata: rawMetadata
      }));

    const toolCallItems = buildAgentToolCallItems(toolCallEvents);
    const toolCallById = new Map(toolCallItems.map((tc) => [tc.id, tc]));
    const emittedToolIds = new Set<string>();
    let lastActivityStartedMs = sorted[0]?.timestamp ? sorted[0].timestamp * 1000 : Date.now();

    for (const { evt, dataPayload, rawMetadata } of agentEvents) {
      const createdAt = new Date(evt.timestamp * 1000).toISOString();
      const seq = Number(evt.sequence);

      switch (evt.event_type) {
        case "task.started": {
          lastActivityStartedMs = evt.timestamp * 1000;
          break;
        }
        case "user.prompt": {
          let prompt = "";
          if (dataPayload) {
            prompt = String(dataPayload.prompt || "");
          } else if (typeof evt.data === "string") {
            try {
              prompt = JSON.parse(evt.data).prompt || evt.data;
            } catch {
              prompt = evt.data;
            }
          }
          if (prompt) {
            list.push({ id: evt.event_id, seq, kind: "user_prompt", content: prompt, createdAt });
            lastActivityStartedMs = evt.timestamp * 1000;
          }
          break;
        }
        case "assistant.message": {
          const text = String(dataPayload?.text || "");
          if (text) {
            list.push({ id: evt.event_id, seq, kind: "assistant_message", content: text, createdAt });
          }
          break;
        }
        case "assistant.thinking": {
          const text = String(dataPayload?.text || "");
          if (text) {
            list.push({
              id: evt.event_id,
              seq,
              kind: "thought",
              content: text,
              createdAt,
              durationMs: evt.timestamp * 1000 - lastActivityStartedMs
            });
            lastActivityStartedMs = evt.timestamp * 1000;
          }
          break;
        }
        case "tool.call":
        case "tool.output":
        case "permission.request": {
          // Multiple tool.* events can refer to the same tool call (call -> output).
          // buildAgentToolCallItems merges them by toolCallId; render once at the
          // first occurrence to preserve chronological position.
          const classified = rawMetadata ? classifyAgentProtocolEvent(rawMetadata) : null;
          let toolId = evt.event_id;
          if (classified && classified.metadata) {
            const update = (classified.metadata as Record<string, unknown>);
            const params = update.params as Record<string, unknown> | undefined;
            const innerUpdate = (params?.update ?? params?.toolCall) as Record<string, unknown> | undefined;
            const idCandidate = innerUpdate?.toolCallId ?? innerUpdate?.tool_call_id ?? innerUpdate?.id;
            if (typeof idCandidate === "string" && idCandidate) toolId = idCandidate;
          }
          const tc = toolCallById.get(toolId) ?? toolCallById.get(evt.event_id);
          if (tc && !emittedToolIds.has(tc.id)) {
            emittedToolIds.add(tc.id);
            list.push({
              id: `tc-${tc.id}`,
              seq,
              kind: "tool_call",
              content: tc.title,
              createdAt,
              toolCall: tc
            });
          }
          break;
        }
        default:
          break;
      }
    }

    return list;
  }, [events]);

  const currentRunStartedMs = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (evt.event_type === "user.prompt" || evt.event_type === "task.started") {
        return evt.timestamp * 1000;
      }
    }
    return runStartedAtMs;
  }, [events, runStartedAtMs]);

  async function startConversation(promptText: string) {
    if (!promptText.trim() || loading || running) return;

    setError("");
    setLoading(true);

    let activeSessionId = sessionId;

    try {
      if (!activeSessionId) {
        // Create new session ID
        activeSessionId = makeId("acpx");
        
        // Dispatch session.create
        const createEnv = {
          id: makeId("msg"),
          type: "session.create",
          version: 1,
          timestamp: getUnixTimestamp(),
          from: "web",
          to: { device_id: project.device_id },
          payload: {
            task_id: activeSessionId,
            workspace_path: workspacePath,
            agent: agentKind === "kilo" ? "kilocode" : agentKind,
            session_name: activeSessionId
          }
        };

        const createRes = await postJSON<{ success: boolean }>("/api/acpx/command", createEnv);
        if (!createRes.success) {
          throw new Error("创建 Agent 会话失败");
        }

        // Update layout state
        onUpdateTabProperties(tab.id, {
          agentSessionId: activeSessionId,
          title: `Agent对话 (${agentKind})`
        });
      }

      // Dispatch prompt task.dispatch
      const dispatchEnv = {
        id: makeId("msg"),
        type: "task.dispatch",
        version: 1,
        timestamp: getUnixTimestamp(),
        from: "web",
        to: { device_id: project.device_id },
        payload: {
          task_id: activeSessionId,
          workspace_path: workspacePath,
          agent: agentKind === "kilo" ? "kilocode" : agentKind,
          prompt: promptText,
          resume_session_id: activeSessionId,
          session_name: activeSessionId
        }
      };

      const dispatchRes = await postJSON<{ success: boolean }>("/api/acpx/command", dispatchEnv);
      if (!dispatchRes.success) {
        throw new Error("启动 Agent 运行失败");
      }

      setRunStartedAtMs(Date.now());
      setInput("");
      setRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行出错");
    } finally {
      setLoading(false);
    }
  }

  async function cancelRun() {
    if (!sessionId || !running) return;

    try {
      const stopEnv = {
        id: makeId("msg"),
        type: "task.stop",
        version: 1,
        timestamp: getUnixTimestamp(),
        from: "web",
        to: { device_id: project.device_id },
        payload: {
          task_id: sessionId,
          reason: "user_cancel"
        }
      };
      await postJSON("/api/acpx/command", stopEnv);
      setRunning(false);
    } catch (err) {
      setError("停止 Agent 运行失败: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  const suggestions = [
    { label: "分析项目结构", text: "帮我分析一下这个项目的文件结构和设计模块" },
    { label: "代码设计解释", text: "解释一下这个项目里有关状态管理和 layout 切分的设计" },
    { label: "寻找潜在漏洞", text: "检查项目里的 API 请求和异常处理，看看有没有什么潜在漏洞" }
  ];

  return (
    <div className="flex h-full flex-col bg-card text-card-foreground select-none relative">
      {/* Error Message */}
      {error && (
        <div className="mx-3 mt-2 rounded-lg border border-red-200/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Main chat flow */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 select-text">
        {!sessionId && events.length === 0 ? (
          /* Landing Screen */
          <div className="h-full flex flex-col items-center justify-center p-6 text-center max-w-lg mx-auto select-none">
            <div className="h-12 w-12 rounded-2xl bg-indigo-50 border border-indigo-150/50 flex items-center justify-center mb-4 dark:bg-indigo-950/20 dark:border-indigo-900/35 animate-fade-in shadow-sm">
              <span className="text-indigo-650 dark:text-indigo-400">{agentLogo}</span>
            </div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">
              与 {agentKind} 开始新的智能对话
            </h2>
            <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed max-w-[280px] dark:text-slate-500">
              基于 ACPX 协议环境，随时在当前工作区为您实现深度代码阅读、分析与命令执行。
            </p>

            <div className="mt-6 w-full space-y-2 select-none">
              {suggestions.map((item, index) => (
                <button
                  key={index}
                  onClick={() => {
                    setInput(item.text);
                    startConversation(item.text);
                  }}
                  className="w-full p-2.5 rounded-xl border border-border/80 bg-card hover:bg-slate-50/50 dark:hover:bg-slate-900/40 text-left text-[11px] text-slate-600 dark:text-slate-350 transition-all flex items-center justify-between group cursor-pointer shadow-sm"
                >
                  <span className="truncate pr-4 font-medium">{item.label}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-slate-400 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Timeline */
          <div className="space-y-2">
            {(() => {
              const rendered: React.ReactNode[] = [];
              let i = 0;
              while (i < messages.length) {
                const msg = messages[i];
                if (msg.kind === "tool_call" && msg.toolCall) {
                  const toolName = (msg.toolCall.title || msg.toolCall.kind || "").toLowerCase();
                  if (toolName.includes("todo")) {
                    const todos = extractTodos(msg.toolCall);
                    if (todos) {
                      rendered.push(<TodoWidget key={msg.id} todos={todos} />);
                      i++;
                      continue;
                    }
                  }
                  if (toolName.includes("task") || toolName.includes("subagent") || toolName.includes("agent")) {
                    const subagent = extractSubagent(msg.toolCall);
                    if (subagent) {
                      rendered.push(<SubagentEntry key={msg.id} item={subagent} nowMs={nowMs} />);
                      i++;
                      continue;
                    }
                  }
                  const group: ChatMessage[] = [msg];
                  while (i + 1 < messages.length && messages[i + 1].kind === "tool_call") {
                    i++;
                    group.push(messages[i]);
                  }
                  if (group.length <= 1) {
                    rendered.push(<ToolCallCard key={msg.id} item={msg.toolCall} nowMs={nowMs} />);
                  } else {
                    rendered.push(
                      <ToolCallGroup key={`g-${msg.id}`} items={group} nowMs={nowMs} />
                    );
                  }
                } else if (msg.kind === "user_prompt") {
                  rendered.push(
                    <div key={msg.id} className="flex justify-end select-text">
                      <div className="max-w-[85%] rounded-2xl bg-indigo-600 text-white px-3.5 py-2 text-[12px] font-medium leading-relaxed shadow-sm whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    </div>
                  );
                } else if (msg.kind === "thought") {
                  rendered.push(
                    <CollapsibleSection key={msg.id} title={`思考 ${formatElapsedMs(msg.durationMs ?? 0)}`}>
                      {msg.content}
                    </CollapsibleSection>
                  );
                } else if (msg.kind === "assistant_message") {
                  rendered.push(
                    <div key={msg.id} className="max-w-[90%] rounded-2xl border border-border/50 bg-slate-50/50 dark:bg-slate-900/30 px-3.5 py-2.5 shadow-sm select-text">
                      <Markdown content={msg.content} />
                    </div>
                  );
                }
                i++;
              }
              return rendered;
            })()}
            {loading && (
              <div className="px-2 py-1 text-[11px] text-muted-foreground animate-pulse">
                准备运行中...
              </div>
            )}
            {running && !loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-emerald-600 dark:text-emerald-400 select-none">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="font-medium">思考中... {formatElapsedMs(nowMs - currentRunStartedMs)}</span>
              </div>
            )}
            <div ref={eventsEndRef} />
          </div>
        )}
      </div>

      {/* Input box */}
      <div className="p-3 border-t border-border/60 bg-muted/5 shrink-0 z-10 select-none">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (running) return;
            startConversation(input);
          }}
          className="relative border border-border bg-card rounded-xl shadow-sm focus-within:ring-1 focus-within:ring-indigo-500 focus-within:border-indigo-500 transition-all p-2 flex flex-col gap-1.5"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (running) {
                  cancelRun();
                } else {
                  startConversation(input);
                }
              }
            }}
            placeholder={running ? "运行中，回车可中断..." : `给 ${agentKind} 发送消息... (Ctrl+Enter 发送)`}
            className="w-full bg-transparent border-0 ring-0 focus:ring-0 resize-none text-[12px] placeholder-slate-400 outline-none leading-relaxed min-h-[44px] max-h-[160px] select-text px-1"
          />
          <div className="flex justify-between items-center px-1">
            <span className="text-[10px] text-slate-400 font-medium select-none flex items-center gap-1.5">
              {agentLogo}
              <span>{agentKind}</span>
            </span>
            {running ? (
              <button
                type="button"
                onClick={cancelRun}
                title="中断运行"
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-600 text-white hover:bg-rose-700 transition-colors cursor-pointer select-none"
              >
                <StopCircle className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || loading}
                title="发送"
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-650 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-700 transition-colors cursor-pointer select-none"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function formatElapsedMs(ms: number): string {
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
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function diffOutputRecord(output: unknown) {
  const record = getRecord(output);
  return record?.type === "diff" ? record : null;
}

function countLines(value: unknown) {
  return typeof value === "string" && value
    ? value.split(/\r?\n/).length
    : 0;
}

function extractToolTarget(item: AgentToolCallItem) {
  const input = getRecord(item.input);
  const outputDiff = diffOutputRecord(item.output);
  const outputPath = getStringField(outputDiff, ["path"]);
  const inputPath = getStringField(input, ["path", "file_path", "filePath", "filename"]);
  const paths = getArrayField(input, ["paths", "locations", "files"]);
  const args = getArrayField(input, ["args", "arguments"]);
  const command =
    typeof item.input === "string"
      ? item.input.trim()
      : getStringField(input, ["command", "cmd"]);
  const commandWithArgs = [command, args?.map(stringifyValue).filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
  const query = getStringField(input, ["query", "pattern", "search"]);
  const url = getStringField(input, ["url", "uri", "href"]);
  const target = inputPath || outputPath || (paths ? String(paths[0]) : "") || query || url || "";
  return { command: commandWithArgs || command, input, inputPath, outputDiff, outputPath, paths, query, url, target };
}

function describeToolCall(item: AgentToolCallItem) {
  const { command, input, outputDiff, query, url, target } = extractToolTarget(item);
  const normalizedTitle = item.title.toLowerCase();
  const kind = (item.kind || normalizedTitle).toLowerCase();
  const outputLineCount = countLines(item.output);
  const inputLineCount = countLines(getStringField(input, ["content", "text", "newText"]));

  if (kind.includes("search") || kind.includes("grep") || kind.includes("glob") || query) {
    return {
      icon: Search,
      accent: "violet",
      action: kind.includes("glob") ? "匹配文件" : "搜索",
      target: query || target || "查询匹配项",
      detail: "",
    };
  }
  if (kind.includes("fetch") || kind.includes("web") || url) {
    return {
      icon: Search,
      accent: "violet",
      action: "获取网页",
      target: url || target || "网页内容",
      detail: "",
    };
  }
  if (kind.includes("execute") || kind.includes("bash") || command) {
    return {
      icon: Terminal,
      accent: "emerald",
      action: "执行命令",
      target: command || "命令执行",
      detail: "",
    };
  }
  if (kind.includes("read")) {
    return {
      icon: FileText,
      accent: "sky",
      action: "读取文件",
      target,
      detail: "",
    };
  }
  if (kind.includes("write") || kind.includes("create")) {
    return {
      icon: FilePlus,
      accent: "emerald",
      action: "创建文件",
      target,
      detail: "",
    };
  }
  if (kind.includes("edit") || outputDiff) {
    const diffKind = String(outputDiff?.kind || "");
    const action = diffKind === "create" || diffKind === "add" ? "创建文件" : "修改文件";
    const oldLines = countLines(outputDiff?.oldText);
    const newLines = countLines(outputDiff?.newText);
    return {
      icon: action === "创建文件" ? FilePlus : FileEdit,
      accent: action === "创建文件" ? "emerald" : "amber",
      action,
      target,
      detail: "",
    };
  }
  return {
    icon: Wrench,
    accent: "slate",
    action: item.kind || "工具调用",
    target: target || item.title || "查看详情",
    detail: "",
  };
}

function ToolCallGroup({ items, nowMs }: { items: ChatMessage[]; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const firstItem = items[0]?.toolCall;
  const firstDesc = useMemo(
    () => firstItem ? describeToolCall(firstItem) : null,
    [firstItem]
  );
  if (!firstItem || !firstDesc) return null;
  const Icon = firstDesc.icon;
  const accent = toolAccentClasses[firstDesc.accent as keyof typeof toolAccentClasses];
  const pendingCount = items.filter(
    (m) => m.toolCall && m.toolCall.status !== "completed" && m.toolCall.status !== "success" && m.toolCall.status !== "failed" && m.toolCall.status !== "error"
  ).length;

  return (
    <div className="max-w-[90%]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer select-none rounded"
      >
        <Icon className={`h-3 w-3 shrink-0 ${accent.icon}`} />
        <span className="shrink-0 font-medium">{firstDesc.action}</span>
        <span className="text-slate-400 dark:text-slate-500">
          {items.length} 项操作
        </span>
        {pendingCount > 0 && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
          </span>
        )}
        <ChevronDown className={`h-3 w-3 shrink-0 text-slate-300 transition-transform ml-auto ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="ml-4 mt-0.5 space-y-1.5 border-l border-slate-200/60 dark:border-slate-800/60 pl-2.5">
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
    card: "border-emerald-100 dark:border-emerald-950/50 bg-emerald-50/10 dark:bg-emerald-950/5",
    icon: "text-emerald-600 dark:text-emerald-400",
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
  },
  sky: {
    card: "border-sky-100 dark:border-sky-950/50 bg-sky-50/10 dark:bg-sky-950/5",
    icon: "text-sky-600 dark:text-sky-400",
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20",
  },
  amber: {
    card: "border-amber-100 dark:border-amber-950/50 bg-amber-50/10 dark:bg-amber-950/5",
    icon: "text-amber-600 dark:text-amber-400",
    badge: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
  },
  violet: {
    card: "border-violet-100 dark:border-violet-950/50 bg-violet-50/10 dark:bg-violet-950/5",
    icon: "text-violet-600 dark:text-violet-400",
    badge: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20",
  },
  slate: {
    card: "border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/30",
    icon: "text-slate-500 dark:text-slate-400",
    badge: "bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20",
  },
} as const;

function extractTodos(item: AgentToolCallItem): Array<{ content: string; status?: string }> | null {
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
    .filter((t): t is { content: string; status?: string } => t !== null);
}

function TodoWidget({ todos }: { todos: Array<{ content: string; status?: string }> }) {
  const [open, setOpen] = useState(true);
  const completed = todos.filter((t) => t.status === "completed" || t.status === "success").length;
  return (
    <div className="max-w-[90%] my-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer select-none rounded"
      >
        <ListChecks className="h-3 w-3 shrink-0 text-indigo-500" />
        <span className="shrink-0 font-medium">任务清单</span>
        <span className="text-slate-400 dark:text-slate-500">{completed}/{todos.length}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-slate-300 transition-transform ml-auto ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <ul className="ml-5 mt-0.5 space-y-0.5">
          {todos.map((todo, idx) => {
            const isDone = todo.status === "completed" || todo.status === "success";
            const isInProgress = todo.status === "in_progress" || todo.status === "in-progress";
            return (
              <li key={idx} className="flex items-start gap-1.5 text-[10.5px] text-slate-600 dark:text-slate-400">
                <span className="pt-0.5 shrink-0">
                  {isDone ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  ) : isInProgress ? (
                    <CircleDot className="h-3 w-3 text-indigo-500" />
                  ) : (
                    <Circle className="h-3 w-3 text-slate-300 dark:text-slate-600" />
                  )}
                </span>
                <span className={isDone ? "line-through text-slate-400 dark:text-slate-600" : ""}>
                  {todo.content}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function extractSubagent(item: AgentToolCallItem) {
  const input = getRecord(item.input);
  if (!input) return null;
  const description = String(input.description ?? input.prompt ?? input.task ?? "");
  const subagentType = String(input.subagent_type ?? input.agent_type ?? input.type ?? "");
  if (!description) return null;
  return { description, subagentType, output: item.output, status: item.status, createdAt: item.createdAt };
}

function SubagentEntry({ item, nowMs }: { item: { description: string; subagentType: string; output: unknown; status?: string; createdAt: string }; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const isDone = item.status === "completed" || item.status === "success";
  const isFailed = item.status === "failed" || item.status === "error";

  const resultText = useMemo(() => {
    if (!item.output) return "";
    if (typeof item.output === "string") return item.output;
    const rec = getRecord(item.output);
    if (rec && typeof rec.text === "string") return rec.text;
    if (rec && typeof rec.content === "string") return rec.content;
    try { return JSON.stringify(item.output, null, 2); } catch { return String(item.output); }
  }, [item.output]);

  const elapsed = useMemo(() => {
    const start = new Date(item.createdAt).getTime();
    if (!Number.isFinite(start)) return "";
    const end = isDone || isFailed ? start + 1000 : nowMs;
    return formatElapsedMs(end - start);
  }, [item.createdAt, isDone, isFailed, nowMs]);

  return (
    <div className="max-w-[90%] my-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer select-none rounded"
      >
        <Cpu className={`h-3 w-3 shrink-0 ${isFailed ? "text-rose-500" : isDone ? "text-emerald-500" : "text-indigo-500"}`} />
        <span className="shrink-0 font-medium">{item.subagentType || "子代理"}</span>
        <span className="min-w-0 truncate text-slate-400 dark:text-slate-500">{item.description}</span>
        {elapsed && <span className="shrink-0 text-slate-400/70">{elapsed}</span>}
        {resultText && <ChevronDown className={`h-3 w-3 shrink-0 text-slate-300 transition-transform ml-auto ${open ? "" : "-rotate-90"}`} />}
      </button>
      {open && resultText && (
        <div className="ml-5 mt-0.5 border-l border-slate-200/60 dark:border-slate-800/60 pl-2.5">
          <div className="max-h-48 overflow-y-auto rounded-md bg-slate-50/50 dark:bg-slate-900/30 p-2 text-[10.5px] text-slate-600 dark:text-slate-400 whitespace-pre-wrap select-text">
            {resultText}
          </div>
        </div>
      )}
    </div>
  );
}

// Collapsible Thoughts block
function CollapsibleSection({ title, children }: { title: string; children: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50/50 dark:bg-slate-900/30 overflow-hidden my-2 max-w-[90%]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-3 py-1.5 text-left text-[11px] font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100/50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer select-none"
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`} />
          {title}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-1 border-t border-slate-250/20 dark:border-slate-800/50 font-mono text-[10px] leading-relaxed text-slate-500 dark:text-slate-400 max-h-60 overflow-y-auto whitespace-pre-wrap select-text">
          {children}
        </div>
      )}
    </div>
  );
}

// Interactive tool calls component
function ToolCallCard({ item, nowMs }: { item: AgentToolCallItem; nowMs: number }) {
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
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-500"></span>
      </span>
    );
  }, [item.status]);

  const readableInput = useMemo(() => {
    if (!item.input) return "";
    if (typeof item.input === "string") return item.input;
    try {
      return JSON.stringify(item.input, null, 2);
    } catch {
      return String(item.input);
    }
  }, [item.input]);

  const readableOutput = useMemo(() => {
    if (!item.output) return "";
    if (typeof item.output === "string") return item.output;
    try {
      return JSON.stringify(item.output, null, 2);
    } catch {
      return String(item.output);
    }
  }, [item.output]);

  const description = useMemo(() => describeToolCall(item), [item]);
  const accent = toolAccentClasses[description.accent as keyof typeof toolAccentClasses];
  const Icon = description.icon;
  const outputDiff = diffOutputRecord(item.output);
  const elapsed = useMemo(() => {
    const start = new Date(item.createdAt).getTime();
    const end = item.completedAt ? new Date(item.completedAt).getTime() : nowMs;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
    return formatElapsedMs(end - start);
  }, [item.createdAt, item.completedAt, nowMs]);

  return (
    <div className="max-w-[90%]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1.5 py-0.5 text-left text-[10.5px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer select-none rounded"
      >
        <Icon className={`h-3 w-3 shrink-0 ${accent.icon}`} />
        <span className="shrink-0 font-medium">{description.action}</span>
        <span className="min-w-0 truncate font-mono text-slate-400 dark:text-slate-500">
          {compactMiddle(description.target, 80)}
        </span>
        {elapsed && <span className="shrink-0 text-slate-400/70">{elapsed}</span>}
        {statusLogo}
        <ChevronDown className={`h-3 w-3 shrink-0 text-slate-300 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="ml-4 mt-0.5 pb-1 space-y-1.5 border-l border-slate-200/60 dark:border-slate-800/60 pl-2.5">
          {description.action === "执行命令" && description.target && (
            <div className="rounded-md border border-emerald-500/20 bg-slate-950 p-2.5 font-mono text-[10.5px] text-emerald-300 select-text overflow-x-auto">
              $ {description.target}
            </div>
          )}
          {outputDiff && (
            <div className="space-y-1">
              <div className="text-[9.5px] font-bold text-slate-400 dark:text-slate-500 uppercase select-none">文件变更</div>
              <div className="grid gap-2 md:grid-cols-2">
                {typeof outputDiff.oldText === "string" && (
                  <pre className="max-h-52 overflow-auto rounded-md border border-rose-500/20 bg-rose-950/10 p-2 font-mono text-[10px] text-rose-700 dark:text-rose-300 whitespace-pre-wrap select-text">
                    {outputDiff.oldText || "∅"}
                  </pre>
                )}
                {typeof outputDiff.newText === "string" && (
                  <pre className="max-h-52 overflow-auto rounded-md border border-emerald-500/20 bg-emerald-950/10 p-2 font-mono text-[10px] text-emerald-700 dark:text-emerald-300 whitespace-pre-wrap select-text">
                    {outputDiff.newText || "∅"}
                  </pre>
                )}
              </div>
            </div>
          )}
          {readableInput && (
            <div className="space-y-1">
              <div className="text-[9.5px] font-bold text-slate-400 dark:text-slate-500 uppercase select-none">输入参数</div>
              <pre className="bg-slate-100/60 dark:bg-slate-800/40 p-2 rounded-md font-mono text-[10px] text-slate-700 dark:text-slate-300 overflow-x-auto max-h-60 whitespace-pre-wrap select-text border border-slate-200/60 dark:border-slate-700/40">
                {readableInput}
              </pre>
            </div>
          )}
          {readableOutput && !outputDiff && (
            <div className="space-y-1">
              <div className="text-[9.5px] font-bold text-slate-400 dark:text-slate-500 uppercase select-none">输出结果</div>
              <pre className="bg-slate-100/60 dark:bg-slate-800/40 p-2 rounded-md font-mono text-[10px] text-slate-700 dark:text-slate-300 overflow-x-auto max-h-60 whitespace-pre-wrap select-text border border-slate-200/60 dark:border-slate-700/40">
                {readableOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
