import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Send,
  Cpu,
  AlertCircle,
  StopCircle,
  ArrowRight,
  X
} from "lucide-react";
import { OpenCode, Codex, ClaudeCode, Antigravity, KiloCode } from "@lobehub/icons";
import { websocketURL } from "@/lib/api";
import { agentNameForRuntime, makeId } from "../terminal-types";
import { type StudioTab } from "../studio-layout";
import type { Project } from "../studio-dashboard";
import type { AgentConfigOption } from "@/lib/agent-protocol";
import {
  configOptionsFromTaskEvents,
  getMetadata,
  getUnixTimestamp,
  isTerminalTaskEvent,
  makeLocalUserPromptEvent,
  mergeTaskEvents,
  modelListFromTaskEvents,
} from "./event-model";
import {
  buildMessageStateFromEvents,
} from "./message-reducer";
import {
  CollapsibleSection,
  Markdown,
  SubagentEntry,
  TodoWidget,
  ToolCallCard,
  ToolCallGroup,
  WorkingStatus,
  extractSubagent,
  extractTodos,
} from "./chat-widgets";
import type { AgentRunStatus, ChatMessage, TaskEvent } from "./types";

type AgentEnvelope = {
  id: string;
  type: string;
  version: number;
  timestamp: number;
  from: string;
  to: { device_id: string };
  payload: Record<string, unknown>;
};

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
  workspacePath,
  onUpdateTabProperties
}: AgentChatTabProps) {
  const sessionId = tab.agentSessionId;
  const sessionName = tab.agentSessionName || sessionId;
  const agentKind = tab.agentKind || "opencode";
  const agentRuntime = tab.agentRuntime || "acpx";
  const agentRuntimeLabel = agentRuntime === "direct_acp" ? "Direct ACP" : "Agent";
  const supportsModelSelection = agentRuntime === "direct_acp" || agentRuntime === "acpx";

  const [events, setEvents] = useState<TaskEvent[]>([]);
  const messageState = useMemo(() => {
    return buildMessageStateFromEvents(events, sessionId || "");
  }, [events, sessionId]);
  const [input, setInput] = useState("");
  const [runStatus, setRunStatus] = useState<AgentRunStatus>("idle");
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [runStartedAtMs, setRunStartedAtMs] = useState(() => Date.now());
  const [modelUpdating, setModelUpdating] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");
  const dismissedErrorRef = useRef("");
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const socketTaskIdRef = useRef("");
  const onUpdateTabPropertiesRef = useRef(onUpdateTabProperties);
  const pendingEnvelopesRef = useRef<AgentEnvelope[]>([]);
  const sessionCreateSentRef = useRef<Set<string>>(new Set());
  const ensureSessionRef = useRef<Promise<string> | null>(null);
  const queuedPromptsRef = useRef<string[]>([]);
  const dispatchingQueuedRef = useRef(false);
  const dispatchPromptRef = useRef<(promptText: string) => Promise<void>>(async () => {});
  const lastEventSeqRef = useRef(0);
  const awaitingNewTurnRef = useRef(false);
  const pendingSessionCreatesRef = useRef<Set<string>>(new Set());
  const pendingSessionResolveRef = useRef<((sessionId: string) => void) | null>(null);
  const pendingSessionRejectRef = useRef<((error: Error) => void) | null>(null);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);



  useEffect(() => {
    onUpdateTabPropertiesRef.current = onUpdateTabProperties;
  }, [onUpdateTabProperties]);

  const showError = useCallback((message: string) => {
    const text = message.trim();
    if (!text || dismissedErrorRef.current === text) return;
    setError(text);
  }, []);

  const clearErrorForNewAction = useCallback(() => {
    dismissedErrorRef.current = "";
    setError("");
  }, []);

  const dismissError = useCallback(() => {
    dismissedErrorRef.current = error.trim();
    setError("");
  }, [error]);

  const buildSessionCreateEnvelope = useCallback((activeSessionId: string, activeSessionName: string) => ({
    id: makeId("msg"),
    type: "session.create",
    version: 1,
    timestamp: getUnixTimestamp(),
    from: "web",
    to: { device_id: project.device_id },
    payload: {
      task_id: activeSessionId,
      workspace_path: workspacePath,
      agent: agentNameForRuntime(agentKind, agentRuntime),
      agent_runtime: agentRuntime,
      session_name: activeSessionName
    }
  }), [agentKind, agentRuntime, project.device_id, workspacePath]);

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

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setRunStatus("idle");
      lastEventSeqRef.current = 0;
      socketTaskIdRef.current = "";
      pendingEnvelopesRef.current = [];
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      return;
    }

    let closed = false;
    const socket = new WebSocket(websocketURL("/ws/acpx", new URLSearchParams({ task_id: sessionId })));
    socketRef.current = socket;
    socketTaskIdRef.current = sessionId;
    setError("");

    socket.onopen = () => {
      if (closed) return;
      if (supportsModelSelection && pendingSessionCreatesRef.current.has(sessionId)) {
        pendingSessionCreatesRef.current.delete(sessionId);
        sessionCreateSentRef.current.add(sessionId);
        socket.send(JSON.stringify(buildSessionCreateEnvelope(sessionId, sessionName || sessionId)));
      }
      const pending = pendingEnvelopesRef.current;
      pendingEnvelopesRef.current = [];
      for (const envelope of pending) {
        socket.send(JSON.stringify(envelope));
      }
    };

    socket.onmessage = (message) => {
      try {
        const envelope = JSON.parse(String(message.data));
        if (envelope?.type === "task.event") {
          const taskEvent = envelope.payload as TaskEvent;
          if (!taskEvent || taskEvent.task_id !== sessionId) return;
          if (taskEvent.event_type === "acpx.session") {
            const meta = getMetadata(taskEvent.data) || {};
            const nextName = String(meta.name || meta.agentSessionId || sessionName || "").trim();
            if (pendingSessionResolveRef.current) {
              const resolveSession = pendingSessionResolveRef.current;
              pendingSessionResolveRef.current = null;
              pendingSessionRejectRef.current = null;
              onUpdateTabPropertiesRef.current(tab.id, {
                agentSessionName: nextName || sessionName,
              });
              resolveSession(sessionId);
              return;
            }
            if (nextName && nextName !== sessionName) {
              onUpdateTabPropertiesRef.current(tab.id, {
                agentSessionName: nextName || sessionName,
              });
              return;
            }
          }
          if (taskEvent.sequence > lastEventSeqRef.current) {
            lastEventSeqRef.current = taskEvent.sequence;
          }
          setEvents((prev) => {
            const base = taskEvent.event_type === "user.prompt"
              ? prev.filter((event) => !event.event_id.startsWith("local-user.prompt-"))
              : prev;
            if (base.some((event) => event.event_id === taskEvent.event_id)) {
              return base;
            }
            return mergeTaskEvents(base, [taskEvent]);
          });
          if (isTerminalTaskEvent(taskEvent)) {
            setRunStatus("idle");
            awaitingNewTurnRef.current = false;
            if (taskEvent.event_type === "task.failed") {
              const meta = getMetadata(taskEvent.data) || {};
              showError(String(meta.message || meta.error || "任务执行失败"));
            }
          } else if (taskEvent.event_type === "task.started") {
            setRunStatus("running");
            awaitingNewTurnRef.current = false;
          }
        } else if (envelope?.type === "server.error") {
          const payload = envelope.payload || {};
          const message = String(payload.message || payload.code || "Agent 通信失败");
          pendingSessionRejectRef.current?.(new Error(message));
          pendingSessionResolveRef.current = null;
          pendingSessionRejectRef.current = null;
          showError(message);
          setRunStatus("idle");
          setModelUpdating(false);
        }
      } catch (err) {
        console.error("ACPX websocket parse error:", err);
      }
    };

    socket.onerror = () => {
      if (!closed) showError("Agent WebSocket 连接失败");
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };

    return () => {
      closed = true;
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket.close();
    };
  }, [buildSessionCreateEnvelope, sessionId, sessionName, showError, supportsModelSelection, tab.id]);

  // Auto scroll to bottom
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  useEffect(() => {
    if (runStatus === "idle") return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runStatus]);


  useEffect(() => {
    if (runStatus === "idle") return;
    let lastStarted = 0;
    let lastTerminal = 0;
    const runStartedSec = Math.floor(runStartedAtMs / 1000);
    for (const event of events) {
      const ts = event.timestamp || 0;
      if (ts > 0 && ts < runStartedSec) continue;
      if (event.event_type === "task.started") {
        lastStarted = Math.max(lastStarted, ts);
      } else if (isTerminalTaskEvent(event)) {
        lastTerminal = Math.max(lastTerminal, ts);
      }
    }
    if (lastTerminal >= lastStarted && lastTerminal > 0) {
      setRunStatus("idle");
      awaitingNewTurnRef.current = false;
    }
  }, [events, runStartedAtMs, runStatus]);

  const messages = messageState.messages;

  const modelList = useMemo(() => {
    return modelListFromTaskEvents(events);
  }, [events]);
  const configOptions = useMemo(() => {
    return configOptionsFromTaskEvents(events);
  }, [events]);
  const modelConfigOption = configOptions.find((option) =>
    option.category === "model" || option.id === "model"
  );

  const getStoredModelId = useCallback(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem(`pocket-studio-last-model::${agentRuntime}::${agentKind}`) || "";
    }
    return "";
  }, [agentRuntime, agentKind]);

  const selectedModelId = tab.agentModelId || getStoredModelId() || modelConfigOption?.currentValue || modelList.currentModelId || "";
  const selectedModel = modelList.models.find((model) => model.id === selectedModelId) || modelList.models[0];
  const selectedModelIdRef = useRef(selectedModelId);
  const showAgentModelControl = supportsModelSelection;
  const showDirectACPConfigOptions = agentRuntime === "direct_acp" && configOptions.length > 0;
  const isRunning = runStatus !== "idle";
  const showWorking = isRunning;

  useEffect(() => {
    selectedModelIdRef.current = selectedModelId;
  }, [selectedModelId]);

  useEffect(() => {
    if (!tab.agentModelId) {
      const stored = getStoredModelId();
      if (stored) {
        onUpdateTabPropertiesRef.current(tab.id, { agentModelId: stored });
      }
    }
  }, [tab.id, tab.agentModelId, getStoredModelId]);

  const sendAgentEnvelope = useCallback((sessionTaskId: string, envelope: AgentEnvelope) => {
    const socket = socketRef.current;
    const logInfo = {
      taskId: sessionTaskId,
      envelopeType: envelope.type,
      socketExists: !!socket,
      socketTaskId: socketTaskIdRef.current,
      readyState: socket ? socket.readyState : "N/A"
    };
    if (typeof window !== "undefined") {
      if (!(window as any).__debug_log) (window as any).__debug_log = [];
      (window as any).__debug_log.push(logInfo);
    }
    console.log("[DEBUG sendAgentEnvelope]", logInfo);
    if (
      socket &&
      socketTaskIdRef.current === sessionTaskId &&
      socket.readyState === WebSocket.OPEN
    ) {
      if (typeof window !== "undefined") {
        (window as any).__debug_log.push("Sending directly");
      }
      socket.send(JSON.stringify(envelope));
      return;
    }
    if (typeof window !== "undefined") {
      (window as any).__debug_log.push("Pushing to pending. Pending size: " + pendingEnvelopesRef.current.length);
    }
    pendingEnvelopesRef.current.push(envelope);
  }, []);

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    if (ensureSessionRef.current) return ensureSessionRef.current;

    const activeSessionName = makeId("acpx");
    const promise = new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (pendingSessionRejectRef.current === reject) {
          pendingSessionResolveRef.current = null;
          pendingSessionRejectRef.current = null;
          reject(new Error("创建 ACPX 会话超时"));
        }
      }, 15_000);
      pendingSessionResolveRef.current = resolve;
      pendingSessionRejectRef.current = (error) => {
        window.clearTimeout(timer);
        reject(error);
      };
      pendingSessionResolveRef.current = (value) => {
        window.clearTimeout(timer);
        resolve(value);
      };
      onUpdateTabPropertiesRef.current(tab.id, {
        agentSessionId: activeSessionName,
        agentSessionName: activeSessionName,
        title: `${agentRuntimeLabel}对话 (${agentKind})`
      });
      pendingSessionCreatesRef.current.add(activeSessionName);
    });
    ensureSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      if (ensureSessionRef.current === promise) {
        ensureSessionRef.current = null;
        pendingSessionResolveRef.current = null;
        pendingSessionRejectRef.current = null;
      }
    }
  }, [
    agentKind,
    agentRuntimeLabel,
    sessionId,
    tab.id
  ]);

  useEffect(() => {
    if (sessionId || !supportsModelSelection) return;
    let cancelled = false;
    clearErrorForNewAction();
    ensureSession()
      .catch((err) => {
        if (!cancelled) showError("加载模型列表失败: " + (err instanceof Error ? err.message : String(err)));
      })
      .finally(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [clearErrorForNewAction, ensureSession, sessionId, showError, supportsModelSelection]);

  useEffect(() => {
    if (!showAgentModelControl) return;
    setCustomModelInput((prev) => prev || selectedModelId);
  }, [selectedModelId, showAgentModelControl]);

  const enqueuePrompt = useCallback((promptText: string) => {
    const prompt = promptText.trim();
    if (!prompt) return;
    setQueuedPrompts((prev) => {
      const next = [...prev, prompt];
      queuedPromptsRef.current = next;
      return next;
    });
    setInput("");
  }, []);

  const popQueuedPrompt = useCallback(() => {
    const [prompt = "", ...next] = queuedPromptsRef.current;
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
    return prompt;
  }, []);

  async function dispatchPrompt(promptText: string) {
    clearErrorForNewAction();
    setRunStatus("sending");
    setRunStartedAtMs(Date.now());
    // Mark that we are awaiting the new turn's task.started event.
    // While this flag is true, late-arriving terminal events from the
    // previous turn will be ignored.
    awaitingNewTurnRef.current = true;

    try {
      const activeSessionId = await ensureSession();
      const localUserEvent = makeLocalUserPromptEvent(activeSessionId, promptText);
      setEvents((prev) => mergeTaskEvents(prev, [localUserEvent]));

      if (selectedModelIdRef.current && typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(`pocket-studio-last-model::${agentRuntime}::${agentKind}`, selectedModelIdRef.current);
      }

      // Dispatch prompt task.dispatch
      const dispatchPayload: Record<string, unknown> = {
        task_id: activeSessionId,
        workspace_path: workspacePath,
        agent: agentNameForRuntime(agentKind, agentRuntime),
        agent_runtime: agentRuntime,
        prompt: promptText,
        resume_session_id: activeSessionId,
        model_id: messages.length === 0 ? selectedModelIdRef.current : ""
      };
      if (sessionName) {
        dispatchPayload.session_name = sessionName;
      }
      const dispatchEnv = {
        id: makeId("msg"),
        type: "task.dispatch",
        version: 1,
        timestamp: getUnixTimestamp(),
        from: "web",
        to: { device_id: project.device_id },
        payload: dispatchPayload
      };

      sendAgentEnvelope(activeSessionId, dispatchEnv);

      setInput("");
      setRunStatus("running");
    } catch (err) {
      showError(err instanceof Error ? err.message : "执行出错");
      setRunStatus("idle");
    }
  }

  useEffect(() => {
    dispatchPromptRef.current = dispatchPrompt;
  });

  async function startConversation(promptText: string) {
    const prompt = promptText.trim();
    if (!prompt) return;
    if (isRunning) {
      enqueuePrompt(prompt);
      return;
    }
    await dispatchPrompt(prompt);
  }

  useEffect(() => {
    if (isRunning || queuedPrompts.length === 0 || dispatchingQueuedRef.current) return;
    const prompt = popQueuedPrompt();
    if (!prompt) return;
    dispatchingQueuedRef.current = true;
    dispatchPromptRef.current(prompt).finally(() => {
      dispatchingQueuedRef.current = false;
    });
  }, [isRunning, popQueuedPrompt, queuedPrompts.length]);

  async function cancelRun() {
    if (!sessionId || !isRunning) return;

    try {
      queuedPromptsRef.current = [];
      setQueuedPrompts([]);
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
      sendAgentEnvelope(sessionId, stopEnv);
      setRunStatus("idle");
    } catch (err) {
      showError("停止 Agent 运行失败: " + (err instanceof Error ? err.message : String(err)));
      setRunStatus("idle");
    }
  }

  async function setModel(modelId: string) {
    modelId = modelId.trim();
    if (!modelId || modelUpdating) return;
    if (modelConfigOption) {
      await setConfigOption(modelConfigOption, modelId);
      return;
    }
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(`pocket-studio-last-model::${agentRuntime}::${agentKind}`, modelId);
    }
    if (modelId === selectedModelId) {
      onUpdateTabPropertiesRef.current(tab.id, { agentModelId: modelId });
      return;
    }
    setModelUpdating(true);
    clearErrorForNewAction();
    try {
      const activeSessionId = await ensureSession();
      const env = {
        id: makeId("msg"),
        type: "task.set_model",
        version: 1,
        timestamp: getUnixTimestamp(),
        from: "web",
        to: { device_id: project.device_id },
        payload: {
          task_id: activeSessionId,
          model_id: modelId
        }
      };
      sendAgentEnvelope(activeSessionId, env);
      onUpdateTabPropertiesRef.current(tab.id, { agentModelId: modelId });
    } catch (err) {
      showError("切换模型失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setModelUpdating(false);
    }
  }

  async function setConfigOption(option: AgentConfigOption, value: string) {
    value = value.trim();
    if (!option.id || !value || modelUpdating) return;
    const isModel = option.category === "model" || option.id === "model";
    setModelUpdating(true);
    clearErrorForNewAction();
    try {
      const activeSessionId = await ensureSession();
      const env = {
        id: makeId("msg"),
        type: "task.set_config_option",
        version: 1,
        timestamp: getUnixTimestamp(),
        from: "web",
        to: { device_id: project.device_id },
        payload: {
          task_id: activeSessionId,
          config_id: option.id,
          value
        }
      };
      sendAgentEnvelope(activeSessionId, env);
      if (isModel) {
        onUpdateTabPropertiesRef.current(tab.id, { agentModelId: value });
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem(`pocket-studio-last-model::${agentRuntime}::${agentKind}`, value);
        }
      }
    } catch (err) {
      showError("切换配置失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setModelUpdating(false);
    }
  }

  const getToolCallType = useCallback((msg: ChatMessage) => {
    if (msg.kind !== "tool_call" || !msg.toolCall) return "none";
    const toolName = (msg.toolCall.title || msg.toolCall.kind || "").toLowerCase();
    if (toolName.includes("todo")) {
      const todos = extractTodos(msg.toolCall);
      if (todos) return "todo";
    }
    if (toolName.includes("task") || toolName.includes("subagent") || toolName.includes("agent")) {
      const subagent = extractSubagent(msg.toolCall);
      if (subagent) return "subagent";
    }
    return "regular_tool_call";
  }, []);

  const suggestions = [
    { label: "今天上海天气怎么样", text: "今天上海天气怎么样" },
    { label: "来点马斯克新闻", text: "来点马斯克新闻" },
    { label: "磁盘剩余空间多少", text: "磁盘剩余空间多少" }
  ];

  return (
    <div className="flex h-full flex-col bg-card text-card-foreground select-none relative">
      {/* Error Message */}
      {error && (
        <div className="mx-3 mt-2 rounded-lg border border-red-200/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={dismissError}
            className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-red-600/70 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400/75 dark:hover:text-red-300"
            aria-label="关闭异常信息"
            title="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main chat flow */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2 select-text">
        {!showWorking && messages.length === 0 ? (
          /* Landing Screen */
          <div className="h-full flex flex-col items-center justify-center p-6 text-center max-w-lg mx-auto select-none">
            <div className="h-12 w-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4 animate-fade-in shadow-sm">
              <span className="text-primary">{agentLogo}</span>
            </div>
            <h2 className="text-sm font-bold text-foreground">
              与 {agentRuntimeLabel} {agentKind} 开始新的智能对话
            </h2>
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed max-w-[280px]">
              基于 ACPX 协议环境，随时在当前工作区为您实现深度 code 阅读、分析与命令执行。
            </p>

            <div className="mt-6 w-full space-y-2 select-none">
              {suggestions.map((item, index) => (
                <button
                  key={index}
                  onClick={() => {
                    setInput(item.text);
                    startConversation(item.text);
                  }}
                  className="w-full p-2.5 rounded-xl border border-border bg-card hover:bg-muted/40 text-left text-[11px] text-muted-foreground transition-all flex items-center justify-between group cursor-pointer shadow-sm"
                >
                  <span className="truncate pr-4 font-medium text-foreground/80">{item.label}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Timeline */
          <div className="space-y-1.5">
            {(() => {
              const rendered: React.ReactNode[] = [];
              let i = 0;
              while (i < messages.length) {
                const msg = messages[i];
                if (msg.kind === "user_prompt") {
                  rendered.push(
                    <div key={msg.id} className="flex justify-start select-text">
                      <div className="max-w-[85%] rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-[12px] font-medium leading-relaxed shadow-sm whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    </div>
                  );
                  i++;
                } else if (msg.kind === "thought") {
                  rendered.push(
                    <CollapsibleSection key={msg.id} durationMs={msg.durationMs}>
                      {msg.content}
                    </CollapsibleSection>
                  );
                  i++;
                } else if (msg.kind === "assistant_message") {
                  rendered.push(
                    <div key={msg.id} className="max-w-[90%] rounded-xl border border-border/60 bg-muted/20 px-3 py-2 shadow-sm select-text">
                      <Markdown content={msg.content} />
                    </div>
                  );
                  i++;
                } else if (msg.kind === "tool_call" && msg.toolCall) {
                  const toolCallType = getToolCallType(msg);
                  if (toolCallType === "todo") {
                    const todos = extractTodos(msg.toolCall);
                    if (todos) {
                      rendered.push(<TodoWidget key={msg.id} todos={todos} />);
                    }
                    i++;
                  } else if (toolCallType === "subagent") {
                    const subagent = extractSubagent(msg.toolCall);
                    if (subagent) {
                      rendered.push(<SubagentEntry key={msg.id} item={subagent} nowMs={nowMs} />);
                    }
                    i++;
                  } else {
                    // Regular tool calls
                    const group: ChatMessage[] = [msg];
                    while (
                      i + 1 < messages.length &&
                      getToolCallType(messages[i + 1]) === "regular_tool_call"
                    ) {
                      i++;
                      group.push(messages[i]);
                    }
                    if (group.length === 1) {
                      rendered.push(
                        <ToolCallCard key={msg.id} item={msg.toolCall} nowMs={nowMs} />
                      );
                    } else {
                      rendered.push(
                        <ToolCallGroup key={`g-${msg.id}`} items={group} nowMs={nowMs} />
                      );
                    }
                    i++;
                  }
                } else {
                  i++;
                }
              }
              return rendered;
            })()}
            {showWorking && (
              <WorkingStatus elapsedMs={nowMs - runStartedAtMs} />
            )}

            <div ref={eventsEndRef} />
          </div>
        )}
      </div>

      {/* Input box */}
      <div className="p-3 border-t border-border/60 bg-muted/5 shrink-0 z-10 select-none">
        {queuedPrompts.length > 0 && (
          <div className="mb-2 rounded-xl border border-dashed border-primary/25 bg-primary/5 px-3.5 py-2 text-[11px] text-primary flex items-center justify-between">
            <div className="min-w-0 flex-1 truncate">
              <span className="font-semibold text-primary/90">队列中 {queuedPrompts.length} 条</span>
              <span className="mx-2 text-primary/30">|</span>
              <span className="text-primary/80">下一条: {queuedPrompts[0]}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                queuedPromptsRef.current = [];
                setQueuedPrompts([]);
              }}
              className="text-[10px] text-primary/80 hover:text-primary hover:underline font-semibold ml-2 cursor-pointer shrink-0"
            >
              清空队列
            </button>
          </div>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            startConversation(input);
          }}
          className="relative border border-border bg-card rounded-xl shadow-sm focus-within:ring-1 focus-within:ring-primary focus-within:border-primary transition-all p-2 flex flex-col gap-1.5"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                startConversation(input);
              }
            }}
            placeholder={isRunning ? "运行中，发送后会加入前端队列..." : `给 ${agentRuntimeLabel} ${agentKind} 发送消息...`}
            className="w-full bg-transparent border-0 ring-0 focus:ring-0 resize-none text-[12px] text-foreground placeholder-muted-foreground/50 outline-none leading-relaxed min-h-[44px] max-h-[160px] select-text px-1"
          />
          <div className="flex justify-between items-center px-1">
            <span className="text-[10px] text-muted-foreground/75 font-medium select-none flex items-center gap-1.5">
              {agentLogo}
              <span>{agentRuntimeLabel} / {agentKind}</span>
            </span>
            <div className="flex items-center gap-1.5">
              {showDirectACPConfigOptions && configOptions.map((option) => (
                <select
                  key={option.id}
                  value={option.currentValue || option.options[0]?.id || ""}
                  disabled={isRunning || modelUpdating}
                  title={option.description || option.name}
                  onChange={(event) => setConfigOption(option, event.target.value)}
                  className="h-7 max-w-40 rounded-lg border border-border bg-muted/30 px-2 text-[10.5px] font-medium text-muted-foreground outline-none hover:bg-muted/50 disabled:opacity-45"
                >
                  {option.options.map((choice) => (
                    <option key={choice.id} value={choice.id} title={choice.description}>
                      {choice.name || choice.id}
                    </option>
                  ))}
                </select>
              ))}
              {!showDirectACPConfigOptions && showAgentModelControl && modelList.models.length > 0 && (
                <select
                  value={selectedModel?.id || ""}
                  disabled={isRunning || modelUpdating}
                  title="选择模型"
                  onChange={(event) => setModel(event.target.value)}
                  className="h-7 max-w-48 rounded-lg border border-border bg-muted/30 px-2 text-[10.5px] font-medium text-muted-foreground outline-none hover:bg-muted/50 disabled:opacity-45"
                >
                  {modelList.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))}
                </select>
              )}
              {!showDirectACPConfigOptions && showAgentModelControl && modelList.models.length === 0 && (
                <div className="flex items-center gap-1">
                  <input
                    value={customModelInput}
                    onChange={(event) => setCustomModelInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        setModel(customModelInput);
                      }
                    }}
                    disabled={isRunning || modelUpdating}
                    placeholder="模型"
                    title={`${agentRuntimeLabel} 模型 ID`}
                    className="h-7 w-28 rounded-lg border border-border bg-muted/30 px-2 text-[10.5px] font-medium text-muted-foreground outline-none hover:bg-muted/50 disabled:opacity-45"
                  />
                  <button
                    type="button"
                    onClick={() => setModel(customModelInput)}
                    disabled={!customModelInput.trim() || isRunning || modelUpdating}
                    title="应用模型"
                    className="h-7 rounded-lg border border-border bg-muted/35 px-2 text-[10px] font-semibold text-muted-foreground hover:bg-muted/55 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    模型
                  </button>
                </div>
              )}
              {isRunning && !input.trim() ? (
                <button
                  type="button"
                  onClick={cancelRun}
                  title="中断运行"
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15 transition-all cursor-pointer select-none"
                >
                  <StopCircle className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  title={isRunning ? "加入队列" : "发送"}
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-all cursor-pointer select-none"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
