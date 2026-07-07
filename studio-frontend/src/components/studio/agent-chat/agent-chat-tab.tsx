import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import {
  Send,
  Cpu,
  AlertCircle,
  StopCircle,
  ArrowRight,
  Loader2,
  X
} from "lucide-react";
import { Antigravity, ClaudeCode, Codex, Cursor, GithubCopilot, KiloCode, Kimi, OpenClaw, OpenCode, Qwen } from "@lobehub/icons/es/icons";
import { agentNameForRuntime, makeId, terminalKindFromAgentKind } from "../terminal-types";
import { type StudioTab } from "../studio-layout";
import type { Project } from "../studio-dashboard";
import { agentChatWebSocketURL } from "./direct-websocket";
import type { AgentConfigOption } from "@/lib/agent-protocol";
import {
  configOptionsFromTaskEvents,
  getMetadata,
  getUnixTimestamp,
  isTerminalTaskEvent,
  makeLocalUserPromptEvent,
  mergeTaskEvents,
  modelListFromTaskEvents,
  sortTaskEventsForDisplay,
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
  RunDurationStatus,
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

function pushAgentChatDebug(entry: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const target = window as typeof window & {
    __agent_chat_debug?: unknown[];
    __debug_log?: unknown[];
  };
  const item = {
    at: new Date().toISOString(),
    ...entry,
  };
  target.__agent_chat_debug = Array.isArray(target.__agent_chat_debug)
    ? target.__agent_chat_debug
    : [];
  target.__agent_chat_debug.push(item);
  target.__debug_log = Array.isArray(target.__debug_log) ? target.__debug_log : [];
  target.__debug_log.push(item);
}

function envelopeTaskId(envelope: AgentEnvelope) {
  const taskId = envelope.payload.task_id;
  return typeof taskId === "string" ? taskId : "";
}

function getRunTiming(events: TaskEvent[], agentRuntime: string) {
  let activeStartedAtMs = 0;
  for (const event of sortTaskEventsForDisplay(events)) {
    if (event.event_type === "task.started") {
      const timestampMs = Number(event.timestamp || 0) * 1000;
      activeStartedAtMs = timestampMs > 0 ? timestampMs : 0;
    } else if (isTerminalTaskEvent(event, agentRuntime)) {
      activeStartedAtMs = 0;
    }
  }
  return { activeStartedAtMs };
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
  workspacePath,
  onUpdateTabProperties
}: AgentChatTabProps) {
  const sessionId = tab.agentSessionId;
  const sessionName = tab.agentSessionName || sessionId;
  const agentKind = tab.agentKind || "opencode";
  const agentRuntime = tab.agentRuntime || (agentKind === "codex" || agentKind === "kilo" ? "direct_acp" : "acpx");
  const agentRuntimeLabel = agentRuntime === "direct_acp" ? "Direct ACP" : "Agent";
  const supportsModelSelection = agentRuntime === "direct_acp" || agentRuntime === "acpx";
  const projectId = project.id;
  const projectDeviceId = project.device_id;
  const projectDirectMode = Boolean(project.direct_mode);
  const projectDirectEndpointURL = project.direct_endpoint?.terminal_ws_url || "";
  const projectDirectEndpointToken = project.direct_endpoint?.token || "";
  const projectDirectEndpointTokenRef = useRef(projectDirectEndpointToken);
  const agentSocketProject = useMemo(() => ({
    id: projectId,
    direct_mode: projectDirectMode,
    direct_endpoint: projectDirectEndpointURL
      ? { terminal_ws_url: projectDirectEndpointURL }
      : undefined,
  }), [projectDirectEndpointURL, projectDirectMode, projectId]);

  const [events, setEvents] = useState<TaskEvent[]>([]);
  const messageState = useMemo(() => {
    return buildMessageStateFromEvents(events, sessionId || "");
  }, [events, sessionId]);
  const messages = messageState.messages;
  const [input, setInput] = useState("");
  const [runStatus, setRunStatus] = useState<AgentRunStatus>("idle");
  const [error, setError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(() => Boolean(sessionId));
  const [historyLoadedOnce, setHistoryLoadedOnce] = useState(() => !sessionId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [localRunStartedAtMs, setLocalRunStartedAtMs] = useState(0);
  const [modelUpdating, setModelUpdating] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");
  const dismissedErrorRef = useRef("");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
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
  const historyLoadedOnceRef = useRef(historyLoadedOnce);
  const previousSessionIdRef = useRef(sessionId || "");
  const pendingSessionCreatesRef = useRef<Set<string>>(new Set());
  const pendingSessionResolveRef = useRef<((sessionId: string) => void) | null>(null);
  const pendingSessionRejectRef = useRef<((error: Error) => void) | null>(null);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);



  useEffect(() => {
    onUpdateTabPropertiesRef.current = onUpdateTabProperties;
  }, [onUpdateTabProperties]);

  useEffect(() => {
    projectDirectEndpointTokenRef.current = projectDirectEndpointToken;
  }, [projectDirectEndpointToken]);

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
    to: { device_id: projectDeviceId },
    payload: {
      task_id: activeSessionId,
      workspace_path: workspacePath,
      agent: agentNameForRuntime(agentKind, agentRuntime),
      agent_runtime: agentRuntime,
      session_name: activeSessionName
    }
  }), [agentKind, agentRuntime, projectDeviceId, workspacePath]);

  const flushPendingEnvelopes = useCallback((socket: WebSocket, activeSessionId: string) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const pending = pendingEnvelopesRef.current;
    if (pending.length === 0) return;

    const remaining: AgentEnvelope[] = [];
    const ready: AgentEnvelope[] = [];
    for (const envelope of pending) {
      const taskId = envelopeTaskId(envelope);
      if (!taskId || taskId === activeSessionId) {
        ready.push(envelope);
      } else {
        remaining.push(envelope);
      }
    }
    pendingEnvelopesRef.current = remaining;

    pushAgentChatDebug({
      phase: "ws.flush",
      taskId: activeSessionId,
      sent: ready.length,
      remaining: remaining.length,
    });
    for (const envelope of ready) {
      socket.send(JSON.stringify(envelope));
    }
  }, []);

  const resetHistoryForSocketOpen = useCallback((activeSessionId: string) => {
    setEvents([]);
    lastEventSeqRef.current = 0;
    historyLoadedOnceRef.current = false;
    setHistoryLoading(true);
    setHistoryLoadedOnce(false);
    sessionCreateSentRef.current.delete(activeSessionId);
    pushAgentChatDebug({
      phase: "history.reset",
      taskId: activeSessionId,
      reason: "ws.opening",
    });
  }, []);

  const openAgentSocket = useCallback((activeSessionId: string, activeSessionName: string) => {
    const socketProject = agentSocketProject.direct_endpoint
      ? {
        ...agentSocketProject,
        direct_endpoint: {
          ...agentSocketProject.direct_endpoint,
          token: projectDirectEndpointTokenRef.current,
        },
      }
      : agentSocketProject;
    const { url: socketURL, transport } = agentChatWebSocketURL(socketProject, activeSessionId);
    resetHistoryForSocketOpen(activeSessionId);
    const socket = new WebSocket(socketURL);
    socketRef.current = socket;
    socketTaskIdRef.current = activeSessionId;
    setError("");
    let closed = false;

    pushAgentChatDebug({
      phase: "ws.opening",
      taskId: activeSessionId,
      sessionName: activeSessionName,
      transport,
    });

    let pingInterval: number | null = null;

    socket.onopen = () => {
      if (closed) return;
      pushAgentChatDebug({
        phase: "ws.open",
        taskId: activeSessionId,
        pending: pendingEnvelopesRef.current.length,
      });
      if (supportsModelSelection && !sessionCreateSentRef.current.has(activeSessionId)) {
        const createEnvelope = buildSessionCreateEnvelope(activeSessionId, activeSessionName || activeSessionId);
        pendingSessionCreatesRef.current.delete(activeSessionId);
        sessionCreateSentRef.current.add(activeSessionId);
        socket.send(JSON.stringify(createEnvelope));
        pushAgentChatDebug({
          phase: "ws.send",
          taskId: activeSessionId,
          envelopeType: createEnvelope.type,
          reason: "session.create",
        });
      }
      flushPendingEnvelopes(socket, activeSessionId);

      if (pingInterval !== null) window.clearInterval(pingInterval);
      pingInterval = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 10000);
    };

    socket.onmessage = (message) => {
      if (closed || socketRef.current !== socket) return;
      try {
        const envelope = JSON.parse(String(message.data));
        if (envelope?.type === "pong") return;
        if (envelope?.type === "task.event") {
          const taskEvent = envelope.payload as TaskEvent;
          if (!taskEvent || taskEvent.task_id !== activeSessionId) return;
          pushAgentChatDebug({
            phase: "ws.message",
            taskId: activeSessionId,
            eventType: taskEvent.event_type,
            sequence: taskEvent.sequence,
          });
          if (taskEvent.event_type === "acpx.session") {
            const meta = getMetadata(taskEvent.data) || {};
            const nextName = String(meta.name || meta.agentSessionId || activeSessionName || "").trim();
            if (pendingSessionResolveRef.current) {
              const resolveSession = pendingSessionResolveRef.current;
              pendingSessionResolveRef.current = null;
              pendingSessionRejectRef.current = null;
              onUpdateTabPropertiesRef.current(tab.id, {
                agentSessionName: nextName || activeSessionName,
              });
              resolveSession(activeSessionId);
              return;
            }
            if (nextName && nextName !== activeSessionName) {
              onUpdateTabPropertiesRef.current(tab.id, {
                agentSessionName: nextName || activeSessionName,
              });
              return;
            }
          }
          if (taskEvent.sequence > lastEventSeqRef.current) {
            lastEventSeqRef.current = taskEvent.sequence;
          }
          setEvents((prev) => {
            if (prev.some((event) => event.event_id === taskEvent.event_id)) {
              return prev;
            }
            return mergeTaskEvents(prev, [taskEvent]);
          });
          if (isTerminalTaskEvent(taskEvent, agentRuntime)) {
            if (taskEvent.event_type === "task.failed") {
              const meta = getMetadata(taskEvent.data) || {};
              showError(String(meta.message || meta.error || "任务执行失败"));
            }
          }
        } else if (envelope?.type === "task.history.ready") {
          const payload = envelope.payload || {};
          const taskId = typeof payload.task_id === "string" ? payload.task_id : "";
          if (!taskId || taskId === activeSessionId) {
            pushAgentChatDebug({
              phase: "history.ready",
              taskId: activeSessionId,
              hasEvents: payload.has_events === true,
            });
            setHistoryLoading(false);
            setHistoryLoadedOnce(true);
          }
        } else if (envelope?.type === "server.error") {
          const payload = envelope.payload || {};
          const message = String(payload.message || payload.code || "Agent 通信失败");
          pushAgentChatDebug({
            phase: "ws.server_error",
            taskId: activeSessionId,
            message,
          });
          pendingSessionRejectRef.current?.(new Error(message));
          pendingSessionResolveRef.current = null;
          pendingSessionRejectRef.current = null;
          showError(message);
          setHistoryLoading(false);
          setHistoryLoadedOnce(true);
          setRunStatus("idle");
          setModelUpdating(false);
        }
      } catch (err) {
        console.error("ACPX websocket parse error:", err);
        pushAgentChatDebug({
          phase: "ws.parse_error",
          taskId: activeSessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    socket.onerror = () => {
      pushAgentChatDebug({
        phase: "ws.error",
        taskId: activeSessionId,
      });
      if (socketRef.current === socket) {
        setHistoryLoading(false);
        setHistoryLoadedOnce(true);
      }
      if (!closed) showError("Agent WebSocket 连接失败");
    };
    socket.onclose = (event) => {
      if (pingInterval !== null) {
        window.clearInterval(pingInterval);
        pingInterval = null;
      }
      pushAgentChatDebug({
        phase: "ws.close",
        taskId: activeSessionId,
        code: event.code,
        reason: event.reason,
      });
      if (socketRef.current === socket) {
        socketRef.current = null;
        setHistoryLoading(false);
        setHistoryLoadedOnce(true);
      }
    };

    return {
      socket,
      close: () => {
        closed = true;
        if (pingInterval !== null) {
          window.clearInterval(pingInterval);
          pingInterval = null;
        }
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        socket.close();
      },
    };
  }, [
    agentSocketProject,
    agentRuntime,
    buildSessionCreateEnvelope,
    flushPendingEnvelopes,
    resetHistoryForSocketOpen,
    showError,
    supportsModelSelection,
    tab.id,
  ]);

  const agentLogo = useMemo(() => {
    switch (terminalKindFromAgentKind(agentKind)) {
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
      case "qwen":
        return <Qwen width={16} height={16} />;
      case "kimi":
        return <Kimi width={16} height={16} />;
      case "copilot":
        return <GithubCopilot width={16} height={16} />;
      case "cursor":
        return <Cursor width={16} height={16} />;
      case "openclaw":
        return <OpenClaw width={16} height={16} />;
      default:
        return <Cpu className="h-4 w-4" />;
    }
  }, [agentKind]);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setRunStatus("idle");
      setHistoryLoading(false);
      setHistoryLoadedOnce(true);
      lastEventSeqRef.current = 0;
      socketTaskIdRef.current = "";
      pendingEnvelopesRef.current = [];
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      return;
    }

    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      setHistoryLoadedOnce(false);
    }
    const socketHandle = openAgentSocket(sessionId, sessionName || sessionId);

    return () => {
      socketHandle.close();
    };
    // sessionName is intentionally excluded: the backend re-emits "acpx.session"
    // (updating tab.agentSessionName) on every turn's session ensure, not just the
    // first. Reconnecting the socket each time drops in-flight events for the
    // turn that's currently streaming, which is what left the tab stuck on
    // "Working" and made replayed history interleave with live events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAgentSocket, sessionId]);

  useLayoutEffect(() => {
    const justLoaded = !historyLoadedOnceRef.current && historyLoadedOnce;
    historyLoadedOnceRef.current = historyLoadedOnce;
    if (!justLoaded) return;
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      return;
    }
    eventsEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [historyLoadedOnce, messages.length]);

  // Auto scroll to bottom
  useEffect(() => {
    if (historyLoading && !historyLoadedOnce) return;
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, historyLoadedOnce, historyLoading]);

  useEffect(() => {
    if (runStatus === "idle") return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runStatus]);

  const runTiming = useMemo(() => {
    return getRunTiming(events, agentRuntime);
  }, [agentRuntime, events]);
  const backendRunStartedAtMs = runTiming.activeStartedAtMs;

  useEffect(() => {
    if (backendRunStartedAtMs > 0) {
      setRunStatus("running");
      awaitingNewTurnRef.current = false;
      return;
    }

    // No "started-but-not-terminated" turn in the event stream. But if the
    // user just optimistically sent a message (sending), the backend's
    // task.started for this turn hasn't arrived yet — keep showing "Working"
    // instead of flickering back to idle. Any non-sending state means we are
    // genuinely between turns → idle.
    setRunStatus(() => {
      if (awaitingNewTurnRef.current) return "sending";
      awaitingNewTurnRef.current = false;
      return "idle";
    });
  }, [backendRunStartedAtMs, events.length]);

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
  const hasActiveBackendTurn = backendRunStartedAtMs > 0;
  const workingStartedAtMs = hasActiveBackendTurn ? backendRunStartedAtMs : localRunStartedAtMs || nowMs;
  const showHistoryLoading = historyLoading && !historyLoadedOnce;

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
    pushAgentChatDebug({
      phase: "send.request",
      taskId: sessionTaskId,
      envelopeType: envelope.type,
      socketExists: !!socket,
      socketTaskId: socketTaskIdRef.current,
      readyState: socket ? socket.readyState : "N/A",
    });
    if (
      socket &&
      socketTaskIdRef.current === sessionTaskId &&
      socket.readyState === WebSocket.OPEN
    ) {
      pushAgentChatDebug({
        phase: "ws.send",
        taskId: sessionTaskId,
        envelopeType: envelope.type,
        reason: "socket.open",
      });
      socket.send(JSON.stringify(envelope));
      return;
    }
    pendingEnvelopesRef.current.push(envelope);
    pushAgentChatDebug({
      phase: "send.queued",
      taskId: sessionTaskId,
      envelopeType: envelope.type,
      pending: pendingEnvelopesRef.current.length,
      socketTaskId: socketTaskIdRef.current,
      readyState: socket ? socket.readyState : "N/A",
    });
    if (
      !socket ||
      socketTaskIdRef.current !== sessionTaskId ||
      socket.readyState === WebSocket.CLOSING ||
      socket.readyState === WebSocket.CLOSED
    ) {
      if (socket && socket.readyState !== WebSocket.CLOSING) {
        socket.close();
      }
      openAgentSocket(sessionTaskId, sessionName || sessionTaskId);
    }
  }, [openAgentSocket, sessionName]);

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

  const removeQueuedPrompt = useCallback((index: number) => {
    setQueuedPrompts((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = prev.filter((_, itemIndex) => itemIndex !== index);
      queuedPromptsRef.current = next;
      return next;
    });
  }, []);

  const clearQueuedPrompts = useCallback(() => {
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
  }, []);

  async function dispatchPrompt(promptText: string) {
    clearErrorForNewAction();
    setRunStatus("sending");
    setLocalRunStartedAtMs(Date.now());
    // Mark that we are awaiting the new turn's task.started event.
    // While this flag is true, late-arriving terminal events from the
    // previous turn will be ignored.
    awaitingNewTurnRef.current = true;

    try {
      const activeSessionId = await ensureSession();
      const activeSessionName = sessionName || activeSessionId;
      pushAgentChatDebug({
        phase: "dispatch.start",
        taskId: activeSessionId,
        promptLength: promptText.length,
        runStatus,
        hasActiveBackendTurn,
      });
      const turnId = makeId("turn");
      const maxSeq = events.reduce((max, ev) => Math.max(max, Number(ev.sequence || 0)), 0);
      const localUserEvent = makeLocalUserPromptEvent(activeSessionId, turnId, promptText, maxSeq + 1);
      setEvents((prev) => mergeTaskEvents(prev, [localUserEvent]));

      if (selectedModelIdRef.current && typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(`pocket-studio-last-model::${agentRuntime}::${agentKind}`, selectedModelIdRef.current);
      }

      // Dispatch prompt task.dispatch
      const dispatchPayload: Record<string, unknown> = {
        task_id: activeSessionId,
        turn_id: turnId,
        workspace_path: workspacePath,
        agent: agentNameForRuntime(agentKind, agentRuntime),
        agent_runtime: agentRuntime,
        prompt: promptText,
        model_id: messages.length === 0 ? selectedModelIdRef.current : ""
      };
      dispatchPayload.session_name = activeSessionName;
      const dispatchEnv = {
        id: makeId("msg"),
        type: "task.dispatch",
        version: 1,
        timestamp: getUnixTimestamp(),
        from: "web",
        to: { device_id: projectDeviceId },
        payload: dispatchPayload
      };

      sendAgentEnvelope(activeSessionId, dispatchEnv);

      setInput("");
      setRunStatus("running");
    } catch (err) {
      showError(err instanceof Error ? err.message : "执行出错");
      setRunStatus("idle");
      setLocalRunStartedAtMs(0);
    }
  }

  useEffect(() => {
    dispatchPromptRef.current = dispatchPrompt;
  });

  async function startConversation(promptText: string) {
    const prompt = promptText.trim();
    if (!prompt) return;
    pushAgentChatDebug({
      phase: "submit",
      promptLength: prompt.length,
      runStatus,
      isRunning,
      hasActiveBackendTurn,
      sessionId,
    });
    if (isRunning && hasActiveBackendTurn) {
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
      clearQueuedPrompts();
      awaitingNewTurnRef.current = false;
      setLocalRunStartedAtMs(0);
      const stopEnv = {
        id: makeId("msg"),
        type: "task.stop",
        version: 1,
        timestamp: getUnixTimestamp(),
        from: "web",
        to: { device_id: projectDeviceId },
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
        to: { device_id: projectDeviceId },
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
        to: { device_id: projectDeviceId },
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
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-2 select-text">
        {showHistoryLoading ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center select-none">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/70" />
            <div className="mt-3 text-[11px] font-medium text-muted-foreground">
              加载中
            </div>
          </div>
        ) : !showWorking && messages.length === 0 ? (
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
          <div className="w-full min-w-0 space-y-1.5">
            {(() => {
              const rendered: React.ReactNode[] = [];
              let i = 0;
              while (i < messages.length) {
                const msg = messages[i];
                if (msg.kind === "user_prompt") {
                  rendered.push(
                    <div key={msg.id} className="flex justify-start select-text">
                      <div className="max-w-full rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-[12px] font-medium leading-relaxed shadow-sm whitespace-pre-wrap">
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
                    <div key={msg.id} className="w-full max-w-none rounded-xl border border-border/60 bg-muted/20 px-3 py-2 shadow-sm select-text">
                      <Markdown content={msg.content} />
                    </div>
                  );
                  i++;
                } else if (msg.kind === "run_duration") {
                  rendered.push(
                    <RunDurationStatus key={msg.id} elapsedMs={msg.durationMs || 0} />
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
              <WorkingStatus elapsedMs={nowMs - workingStartedAtMs} />
            )}

            <div ref={eventsEndRef} />
          </div>
        )}
      </div>

      {/* Input box */}
      <div className="p-3 border-t border-border/60 bg-muted/5 shrink-0 z-10 select-none">
        {queuedPrompts.length > 0 && (
          <div className="mb-2 rounded-xl border border-dashed border-primary/25 bg-primary/5 px-3 py-2 text-[11px] text-primary">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-semibold text-primary/90">队列中 {queuedPrompts.length} 条</span>
              <button
                type="button"
                onClick={clearQueuedPrompts}
                className="h-5 shrink-0 rounded px-1.5 text-[10px] font-semibold text-primary/80 hover:bg-primary/10 hover:text-primary cursor-pointer"
              >
                清空队列
              </button>
            </div>
            <div className="max-h-32 space-y-1 overflow-y-auto pr-0.5">
              {queuedPrompts.map((prompt, index) => (
                <div
                  key={`${index}-${prompt}`}
                  className="flex items-start gap-2 rounded-lg border border-primary/10 bg-card/65 px-2 py-1.5 text-primary/85"
                >
                  <span className="mt-0.5 h-4 min-w-4 rounded bg-primary/10 px-1 text-center text-[9.5px] font-semibold leading-4 text-primary/75">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-foreground/80">
                    {prompt}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeQueuedPrompt(index)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-red-500/10 hover:text-red-600 cursor-pointer"
                    aria-label={`删除队列消息 ${index + 1}`}
                    title="删除"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
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
