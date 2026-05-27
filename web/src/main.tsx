import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor from "@monaco-editor/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerminal } from "@xterm/xterm";
import ReactMarkdown from "react-markdown";
import { Tree, type NodeApi } from "react-arborist";
import { Group, Panel, Separator } from "react-resizable-panels";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Code2,
  FileText,
  Folder,
  FolderOpen,
  Info,
  LoaderCircle,
  LogOut,
  Menu,
  Monitor,
  PanelLeft,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Send,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  attachTimelineTiming,
  buildTimelineItems,
  describeEvent,
  displayTitle,
  eventTimeSeconds,
  extractACPXSessionStatus,
  extractSessionIDFromEvent,
  extractSessionModels,
  extractSessionUsage,
  formatACPXTtl,
  formatACPXStatus,
  formatContextUsage,
  formatEventTime,
  formatTurnUsage,
  formatUsageCost,
  isVisibleEvent,
  latestModelID,
  messageTone,
  normalizePayload,
  toolInput,
  toolName,
  toolOutputForEvent,
  toolStatusLabel,
  toolTitle,
  toolUseSummary,
  type AgentModel,
  type TaskEvent,
  type TimedTimelineItem,
  type TimelineItem
} from "@/lib/agent-events";
import { postJSON } from "@/lib/api";
import type { AgentCapability, Device, FileEntry, SearchResult, TaskRecord, TerminalResult, Workspace, WorkspaceResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type ViewMode = "dashboard" | "task";

type RouteState = {
  view: ViewMode;
  taskId: string;
};

function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [tasks, setTasks] = useState<string[]>([]);
  const [taskRecords, setTaskRecords] = useState<Map<string, TaskRecord>>(new Map());
  const [currentTaskId, setCurrentTaskId] = useState("");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [status, setStatus] = useState("idle");
  const [prompt, setPrompt] = useState("");
  const [view, setView] = useState<ViewMode>("dashboard");
  const [conn, setConn] = useState("Connecting...");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [rawEvent, setRawEvent] = useState<TaskEvent | null>(null);
  const [expandedToolResults, setExpandedToolResults] = useState<Set<string>>(new Set());
  const [fileTree, setFileTree] = useState<FileEntry[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(["."]));
  const [openFilePath, setOpenFilePath] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [savedFileContent, setSavedFileContent] = useState("");
  const [fileStatus, setFileStatus] = useState("");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [appSidebarVisible, setAppSidebarVisible] = useState(true);
  const [explorerVisible, setExplorerVisible] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const eventsRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const selectedDevice = devices.find((device) => device.id === selectedDeviceId);
  const selectedWorkspace = selectedDevice?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const currentRecord = currentTaskId ? taskRecords.get(currentTaskId) : undefined;
  const effectiveWorkspacePath = workspacePath.trim() || currentRecord?.workspace_path || "";
  const availableAgents = selectedDevice?.agents?.length
    ? selectedDevice.agents
    : [{ name: selectedDevice?.agent || "claude", label: selectedDevice?.agent_label || agentDisplayName(selectedDevice?.agent || "claude") }];
  const activeAgent = selectedAgent || currentRecord?.agent || selectedDevice?.agent || availableAgents[0]?.name || "claude";
  const agentLabel = availableAgents.find((agent) => agent.name === activeAgent)?.label || agentDisplayName(activeAgent);
  const timelineItems = useMemo(() => buildTimelineItems(events), [events]);
  const timedTimelineItems = useMemo(() => attachTimelineTiming(timelineItems), [timelineItems]);
  const waitingForAgent = useMemo(() => isWaitingForAgent(currentRecord, events), [currentRecord, events]);
  const sessionUsage = useMemo(() => extractSessionUsage(events), [events]);
  const sessionModels = useMemo(() => extractSessionModels(events), [events]);
  const acpxSessionStatus = useMemo(() => extractACPXSessionStatus(events), [events]);
  const currentModelID = currentRecord?.model_id || latestModelID(events) || "";
  const emptyStartView = view === "task" && timedTimelineItems.length === 0 && !waitingForAgent;
  const searchResults = useMemo(() => searchSessionRecords(tasks, taskRecords, searchQuery), [tasks, taskRecords, searchQuery]);

  useEffect(() => {
    const applyRoute = () => {
      const route = routeFromLocation();
      setView(route.view);
      setCurrentTaskId(route.taskId || "");
    };
    applyRoute();
    window.addEventListener("popstate", applyRoute);
    return () => window.removeEventListener("popstate", applyRoute);
  }, []);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let closed = false;
    let ws: WebSocket;

    const connect = () => {
      ws = new WebSocket(`${proto}//${location.host}/ws/web`);
      wsRef.current = ws;
      ws.onopen = () => setConn("Connected");
      ws.onclose = () => {
        setConn("Disconnected");
        if (!closed) setTimeout(connect, 1200);
      };
      ws.onmessage = (message) => {
        const env = JSON.parse(message.data);
        if (env.type === "server.state") {
          const nextDevices = env.payload?.devices || [];
          setDevices(nextDevices);
          ingestTasks(env.payload?.tasks || []);
          setSelectedDeviceId((current) => current || nextDevices[0]?.id || "");
          setSelectedWorkspaceId((current) => current || nextDevices[0]?.workspaces?.[0]?.id || "");
          setSelectedAgent((current) => current || nextDevices[0]?.agents?.[0]?.name || nextDevices[0]?.agent || "claude");
          return;
        }
        if (env.type === "task.event") {
          const payload = withEventTimestamp(env.payload as TaskEvent, env.timestamp);
          if (!payload?.task_id) return;
          mergeTaskEvent(payload);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  useEffect(() => {
    const record = currentTaskId ? taskRecords.get(currentTaskId) : undefined;
    if (!record) return;
    shouldStickToBottomRef.current = true;
    setEvents(record.events ? [...record.events] : []);
    setStatus(record.status || "running");
    setExpandedToolResults(new Set());
  }, [currentTaskId]);

  useEffect(() => {
    const record = currentTaskId ? taskRecords.get(currentTaskId) : undefined;
    if (!record) return;
    setEvents(record.events ? [...record.events] : []);
    setStatus(record.status || "running");
  }, [currentTaskId, taskRecords]);

  useEffect(() => {
    const node = eventsRef.current;
    if (!node || !shouldStickToBottomRef.current) return;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight;
      });
    });
  }, [currentTaskId, events.length, timelineItems.length]);

  function updateStickToBottom() {
    const node = eventsRef.current;
    if (!node) return;
    shouldStickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  function navigateHome() {
    setCurrentTaskId("");
    setEvents([]);
    setStatus("idle");
    setView("dashboard");
    setSidebarOpen(false);
    pushRoute("/home");
  }

  function navigateSession(taskId: string) {
    shouldStickToBottomRef.current = true;
    setCurrentTaskId(taskId);
    setView("task");
    setSidebarOpen(false);
    pushRoute(`/session/${encodeURIComponent(taskId)}`);
  }

  function startBlankSession() {
    const device = selectedDevice || devices[0];
    if (device) {
      const path = workspacePath.trim() || defaultWorkspacePath(device);
      setSelectedDeviceId(device.id);
      setSelectedWorkspaceId(device.workspaces[0]?.id || "");
      setWorkspacePath(path);
      setSelectedAgent(selectedAgent || device.agents?.[0]?.name || device.agent || "claude");
    }
    setCurrentTaskId("");
    setEvents([]);
    setPrompt("");
    setStatus("idle");
    setView("task");
    setSidebarOpen(false);
    pushRoute(`/session/${encodeURIComponent(`new_${Date.now().toString(36)}`)}`);
  }

  function ingestTasks(records: TaskRecord[]) {
    setTaskRecords((prev) => {
      const next = new Map(prev);
      for (const record of records) {
        if (record?.task_id) next.set(record.task_id, record);
      }
      const sorted = [...next.values()]
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
        .map((record) => record.task_id);
      setTasks(sorted);
      return next;
    });
  }

  function mergeTaskEvent(event: TaskEvent) {
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(event.task_id) || { task_id: event.task_id, status: "running", events: [] };
      const sessionID = extractSessionIDFromEvent(event);
      if (sessionID) record.session_id = sessionID;
      record.status = statusFromEvent(event.event_type, record.status);
      record.updated_at = Math.floor(Date.now() / 1000);
      record.events = record.events || [];
      if (!isDuplicateEvent(record.events, event)) record.events.push(event);
      next.set(event.task_id, record);
      setTasks((current) => current.includes(event.task_id) ? current : [event.task_id, ...current]);
      return next;
    });
  }

  function dispatchTask() {
    const text = prompt.trim();
    if (!text || !selectedDevice || !effectiveWorkspacePath || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const workspace = workspaceForPath(effectiveWorkspacePath, selectedWorkspace);
    const shouldContinue = Boolean(currentTaskId && currentRecord);
    const taskId = shouldContinue ? currentTaskId : `ses_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const sessionName = currentRecord?.session_name || uniqueSessionNameFor(workspace, activeAgent);
    const modelID = currentRecord?.model_id || latestModelID(events) || "";
    const userEvent: TaskEvent = { task_id: taskId, event_type: "user.prompt", source: "web", timestamp: Math.floor(Date.now() / 1000), data: { prompt: text } };

    setCurrentTaskId(taskId);
    setView("task");
    pushRoute(`/session/${encodeURIComponent(taskId)}`);
    setStatus("running");
    setPrompt("");
    setTasks((current) => current.includes(taskId) ? current : [taskId, ...current]);
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(taskId) || { task_id: taskId, events: [] };
      record.workspace_id = workspace.id;
      record.workspace_path = effectiveWorkspacePath;
      record.device_id = selectedDevice.id;
      record.agent = activeAgent;
      record.session_name = sessionName;
      if (modelID) record.model_id = modelID;
      record.prompt = text;
      record.status = "running";
      record.events = shouldContinue ? [...(record.events || []), userEvent] : [userEvent];
      next.set(taskId, record);
      return next;
    });

    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "task.dispatch",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: selectedDevice.id },
      payload: {
        task_id: taskId,
        workspace_id: workspace.id,
        workspace_path: effectiveWorkspacePath,
        agent: activeAgent,
        session_name: sessionName,
        model_id: modelID,
        prompt: text,
        parent_task_id: shouldContinue ? currentTaskId : "",
        resume_session_id: currentRecord?.session_id || "",
        options: {
          auto_shell: true,
          allowed_tools: ["file", "bash"],
          timeout_seconds: 3600
        }
      }
    }));
  }

  function startNewSession() {
    const path = workspacePath.trim();
    if (!selectedDevice || !path || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const workspace = workspaceForPath(path);
    const agent = activeAgent || selectedDevice.agent || availableAgents[0]?.name || "claude";
    const taskId = `ses_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const sessionName = uniqueSessionNameFor(workspace, agent);
    setSelectedWorkspaceId(workspace?.id || "");
    setWorkspacePath(path);
    setSelectedAgent(agent);
    navigateSession(taskId);
    setEvents([]);
    setStatus("creating");
    setPrompt("");
    setExpandedToolResults(new Set());
    const now = Math.floor(Date.now() / 1000);
    setTasks((current) => current.includes(taskId) ? current : [taskId, ...current]);
    setTaskRecords((prev) => {
      const next = new Map(prev);
      next.set(taskId, {
        task_id: taskId,
        device_id: selectedDevice.id,
        workspace_id: workspace.id,
        workspace_path: path,
        agent,
        session_name: sessionName,
        prompt: "",
        status: "creating",
        started_at: now,
        updated_at: now,
        events: []
      });
      return next;
    });
    setNewSessionOpen(false);
    setSidebarOpen(false);
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "session.create",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: selectedDevice.id },
      payload: {
        task_id: taskId,
        workspace_id: workspace.id,
        workspace_path: path,
        agent,
        session_name: sessionName,
        options: {
          auto_shell: true,
          allowed_tools: ["file", "bash"],
          timeout_seconds: 3600
        }
      }
    }));
  }

  function prepareDeviceSession(device: Device) {
    setSelectedDeviceId(device.id);
    setSelectedWorkspaceId(device.workspaces[0]?.id || "");
    setWorkspacePath(defaultWorkspacePath(device));
    setSelectedAgent(device.agents?.[0]?.name || device.agent || "claude");
    setNewSessionOpen(true);
  }

  function openTask(taskId: string) {
    const record = taskRecords.get(taskId);
    if (record) {
      setWorkspacePath(record.workspace_path || "");
      setSelectedAgent(record.agent || selectedAgent);
      if (record.workspace_id) setSelectedWorkspaceId(record.workspace_id);
      const device = devices.find((item) => item.workspaces.some((workspace) => workspace.id === record.workspace_id));
      if (device) setSelectedDeviceId(device.id);
    }
    navigateSession(taskId);
  }

  function stopTask() {
    if (!currentTaskId || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "task.stop",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      payload: { task_id: currentTaskId, reason: "user_requested" }
    }));
    setStatus("stopping");
  }

  function deleteSession(taskId: string, afterDelete: "home" | "next" = "home") {
    const record = taskRecords.get(taskId);
    if (!record || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const deviceId = record.device_id || selectedDeviceId;
    if (!deviceId) return;
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "session.delete",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: deviceId },
      payload: {
        task_id: taskId,
        agent: record.agent || activeAgent,
        session_name: record.session_name || "",
        workspace_id: record.workspace_id || "",
        workspace_path: record.workspace_path || ""
      }
    }));
    setTaskRecords((prev) => {
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
    setTasks((current) => current.filter((item) => item !== taskId));
    if (currentTaskId === taskId) {
      if (afterDelete === "next") {
        const nextTask = tasks.find((item) => item !== taskId) || "";
        if (nextTask) openTask(nextTask);
        else navigateHome();
      } else {
        navigateHome();
      }
    }
  }

  function setTaskModel(modelID: string) {
    if (!currentTaskId || !modelID || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(currentTaskId);
      if (record) {
        next.set(currentTaskId, { ...record, model_id: modelID });
      }
      return next;
    });
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "task.set_model",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      payload: { task_id: currentTaskId, model_id: modelID }
    }));
  }

  async function sendWorkspaceList(path = ".") {
    if (!selectedDevice || !effectiveWorkspacePath) return;
    try {
      const result = await postJSON<WorkspaceResult>(`/api/workspace/list?device_id=${encodeURIComponent(selectedDevice.id)}`, {
        request_id: `fs_${Date.now()}`,
        workspace_id: selectedWorkspaceId,
        workspace_path: effectiveWorkspacePath,
        path
      });
      handleWorkspaceResult(result);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendWorkspaceRead(path: string) {
    if (!selectedDevice || !effectiveWorkspacePath) return;
    setOpenFilePath(path);
    setFileStatus("读取中");
    try {
      const result = await postJSON<WorkspaceResult>(`/api/workspace/read?device_id=${encodeURIComponent(selectedDevice.id)}`, {
        request_id: `read_${Date.now()}`,
        workspace_id: selectedWorkspaceId,
        workspace_path: effectiveWorkspacePath,
        path
      });
      handleWorkspaceResult(result);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendWorkspaceWrite() {
    if (!selectedDevice || !effectiveWorkspacePath || !openFilePath) return;
    setFileStatus("保存中");
    try {
      const result = await postJSON<WorkspaceResult>(`/api/workspace/write?device_id=${encodeURIComponent(selectedDevice.id)}`, {
        request_id: `write_${Date.now()}`,
        workspace_id: selectedWorkspaceId,
        workspace_path: effectiveWorkspacePath,
        path: openFilePath,
        content: fileContent
      });
      handleWorkspaceResult(result);
      setFileStatus("已保存");
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendTerminalRun(command: string) {
    const text = command.trim();
    if (!text || !selectedDevice || !effectiveWorkspacePath) return;
    setTerminalRunning(true);
    setTerminalLines((current) => [...current, `$ ${text}`]);
    try {
      const result = await postJSON<TerminalResult>(`/api/terminal/run?device_id=${encodeURIComponent(selectedDevice.id)}`, {
        request_id: `term_${Date.now()}`,
        workspace_id: selectedWorkspaceId,
        workspace_path: effectiveWorkspacePath,
        command: text
      });
      handleTerminalResult(result);
    } catch (error) {
      setTerminalRunning(false);
      setTerminalLines((current) => [...current, error instanceof Error ? error.message : String(error)]);
    }
  }

  function handleWorkspaceResult(result: WorkspaceResult) {
    if (result.error) {
      setFileStatus(result.error);
      return;
    }
    if (result.entries) {
      setFileTree((current) => mergeTreeEntries(current, result.path || ".", result.entries || []));
      setExpandedPaths((current) => new Set(current).add(result.path || "."));
    }
    if (typeof result.content === "string" && result.path) {
      setOpenFilePath(result.path);
      setFileContent(result.content);
      setSavedFileContent(result.content);
      setFileStatus("已打开");
    }
  }

  function handleTerminalResult(result: TerminalResult) {
    setTerminalRunning(false);
    setTerminalLines((current) => [
      ...current,
      result.output || result.error || "",
      `[exit ${result.exit_code}]`
    ].filter((line) => line !== ""));
  }

  const sessionTitle = sessionDisplayTitle(currentRecord, currentTaskId) || (effectiveWorkspacePath ? workspaceNameFromPath(effectiveWorkspacePath) : "新会话");

  return (
    <div className={cn("app-shell grid h-dvh overflow-hidden max-lg:grid-cols-1", appSidebarVisible ? "grid-cols-[260px_minmax(0,1fr)]" : "grid-cols-[0_minmax(0,1fr)]")}>
      <aside className={cn("app-sidebar grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] border-r max-lg:fixed max-lg:inset-y-3 max-lg:left-3 max-lg:z-50 max-lg:hidden max-lg:w-72 max-lg:rounded-lg max-lg:border max-lg:shadow-xl", !appSidebarVisible && "hidden", sidebarOpen && "max-lg:grid")}>
        <div className="sidebar-brand flex h-20 items-center gap-3 px-5">
          <div className="brand-mark grid size-10 place-items-center rounded-lg text-xs font-semibold">AB</div>
          <div className="min-w-0">
            <div className="truncate font-semibold leading-tight">AgentBridge</div>
            <div className="truncate text-xs text-muted-foreground">Remote coding agents</div>
          </div>
        </div>
        <nav className="sidebar-nav border-b px-4 pb-5">
          <NavButton active={emptyStartView} icon={Plus} label="新会话" onClick={startBlankSession} />
          <NavButton active={view === "dashboard"} icon={Monitor} label="工作台" onClick={navigateHome} />
          <NavButton active={searchOpen} icon={Search} label="搜索" onClick={() => setSearchOpen(true)} />
        </nav>
        <SidebarSessions
          tasks={tasks}
          taskRecords={taskRecords}
          currentTaskId={currentTaskId}
          onOpenTask={openTask}
          onDeleteTask={(taskId) => deleteSession(taskId, "next")}
        />
        <div className="sidebar-footer border-t p-4">
          <ConnectionBadge conn={conn} />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button className="justify-start" variant="ghost" size="sm" onClick={() => setInspectorOpen(true)}><Settings />设置</Button>
            <Button className="justify-start" variant="ghost" size="sm" disabled><LogOut />退出</Button>
          </div>
        </div>
      </aside>

      <main className="app-main grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <header className={cn("app-header flex min-h-14 items-center justify-between gap-4 px-6 max-sm:px-4", !emptyStartView && "app-header-bordered")}>
          <div className="flex min-w-0 items-center gap-3">
            <Button className="hidden max-lg:inline-flex" variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu /></Button>
            <Button className="max-lg:hidden" variant="ghost" size="icon" onClick={() => setAppSidebarVisible((value) => !value)} aria-label={appSidebarVisible ? "隐藏左侧菜单" : "显示左侧菜单"}>
              <PanelLeft />
            </Button>
            {view === "task" && (
              <Button variant="ghost" size="icon" onClick={navigateHome} aria-label="返回工作台">
                <ArrowLeft />
              </Button>
            )}
            <div className={cn("min-w-0", emptyStartView && "sr-only")}>
              <h1 className="truncate text-base font-semibold">{view === "dashboard" ? "工作台" : sessionTitle}</h1>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {view === "dashboard"
                  ? `${devices.length} 台设备在线，${tasks.length} 个会话`
                  : [agentLabel, effectiveWorkspacePath].filter(Boolean).join(" / ")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button className="hidden max-lg:inline-flex" variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏"><PanelLeft /></Button>
            {view === "task" ? (
              <Button variant="outline" onClick={() => setInspectorOpen(true)}><Info />详情</Button>
            ) : null}
          </div>
        </header>

        {view === "dashboard" ? (
          <Dashboard
            devices={devices}
            tasks={tasks}
            taskRecords={taskRecords}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={(device) => {
              setSelectedDeviceId(device.id);
              setSelectedWorkspaceId(device.workspaces[0]?.id || "");
              setSelectedAgent(device.agents?.[0]?.name || device.agent || "claude");
            }}
            onCreateFromDevice={prepareDeviceSession}
            onDeleteTask={(taskId) => deleteSession(taskId, "home")}
            onOpenTask={openTask}
          />
        ) : (
          <SessionWorkspace
            activeAgent={activeAgent}
            agentLabel={agentLabel}
            availableAgents={availableAgents}
            currentRecord={currentRecord}
            currentModelID={currentModelID}
            devices={devices}
            effectiveWorkspacePath={effectiveWorkspacePath}
            eventsRef={eventsRef}
            explorerVisible={explorerVisible}
            expandedToolResults={expandedToolResults}
            fileContent={fileContent}
            fileDirty={fileContent !== savedFileContent}
            fileStatus={fileStatus}
            fileTree={fileTree}
            openFilePath={openFilePath}
            prompt={prompt}
            selectedDevice={selectedDevice}
            selectedDeviceId={selectedDeviceId}
            sessionModels={sessionModels}
            terminalLines={terminalLines}
            terminalRunning={terminalRunning}
            timelineItems={timedTimelineItems}
            waitingForAgent={waitingForAgent}
            onScroll={updateStickToBottom}
            onDispatch={dispatchTask}
            onAgentChange={setSelectedAgent}
            onDeviceChange={(deviceId) => {
              const device = devices.find((item) => item.id === deviceId);
              setSelectedDeviceId(deviceId);
              setSelectedWorkspaceId(device?.workspaces[0]?.id || "");
              if (device && !workspacePath.trim()) setWorkspacePath(defaultWorkspacePath(device));
              setSelectedAgent(device?.agents?.[0]?.name || device?.agent || "claude");
            }}
            onModelChange={setTaskModel}
            onNewSession={() => setNewSessionOpen(true)}
            onPromptChange={setPrompt}
            onRaw={setRawEvent}
            onCloseFile={() => {
              setOpenFilePath("");
              setFileContent("");
              setSavedFileContent("");
              setFileStatus("");
            }}
            onRefreshFiles={() => sendWorkspaceList(".")}
            onRunTerminalCommand={sendTerminalRun}
            onStopTask={stopTask}
            onFileChange={setFileContent}
            onFileOpen={(entry) => {
              if (entry.is_dir) {
                setExpandedPaths((current) => new Set(current).add(entry.path));
                sendWorkspaceList(entry.path);
              } else {
                sendWorkspaceRead(entry.path);
              }
            }}
            onFileSave={sendWorkspaceWrite}
            onToggleExplorer={() => setExplorerVisible((value) => !value)}
            onWorkspacePathChange={setWorkspacePath}
            onToggleToolResult={(id) => {
              setExpandedToolResults((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
          />
        )}
      </main>

      {inspectorOpen && (
        <div className="fixed inset-0 z-40 bg-background/80" onClick={() => setInspectorOpen(false)}>
          <aside className="inspector-panel absolute right-0 top-0 grid h-full w-[420px] max-w-[92vw] grid-rows-[auto_auto_minmax(0,1fr)] border-l shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b p-4">
              <h2 className="font-semibold">当前任务</h2>
              <Button variant="ghost" size="icon" onClick={() => setInspectorOpen(false)}><X /></Button>
            </div>
            <div className="flex flex-col gap-3 border-b p-4">
              <Metric label="状态" value={status} />
              <Metric label="Agent" value={agentLabel} />
              <Metric label="设备" value={selectedDevice?.name || "-"} />
              <Metric label="目录" value={effectiveWorkspacePath || "-"} />
              <Metric label="acpx 状态" value={formatACPXStatus(acpxSessionStatus)} />
              <Metric label="TTL" value={formatACPXTtl(acpxSessionStatus)} />
              <Metric label="事件" value={String(events.length)} />
              <Metric label="上下文" value={formatContextUsage(sessionUsage)} />
              <Metric label="费用" value={formatUsageCost(sessionUsage)} />
              <Metric label="本轮 Token" value={formatTurnUsage(sessionUsage)} />
              <Button className="w-full" variant="destructive" disabled={!currentTaskId} onClick={stopTask}><Square />停止任务</Button>
            </div>
            <div className="min-h-0 overflow-auto p-4">
              <h2 className="mb-2 text-xs font-medium uppercase text-muted-foreground">执行流</h2>
              {events.slice().reverse().map((event, index) => (
                <button
                  key={`${event.event_id || index}`}
                  className={cn("execution-event flex w-full items-center justify-between gap-2 border-b py-2 text-left text-xs text-muted-foreground hover:text-foreground", !isVisibleEvent(event) && "execution-event-muted")}
                  title="查看原始事件"
                  onClick={() => setRawEvent(event)}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{describeEvent(event).title} {event.sequence ? `#${event.sequence}` : ""}</span>
                    <span className="block text-[11px] text-muted-foreground/80">{formatEventTime(event)}</span>
                  </span>
                  <Badge variant="outline">Raw</Badge>
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}

      {searchOpen && (
        <SearchDialog
          query={searchQuery}
          results={searchResults}
          taskRecords={taskRecords}
          onClose={() => setSearchOpen(false)}
          onOpenTask={(taskId) => {
            setSearchOpen(false);
            openTask(taskId);
          }}
          onQueryChange={setSearchQuery}
        />
      )}

      <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
        <NewSessionDialog
          devices={devices}
          selectedDeviceId={selectedDeviceId}
          workspacePath={workspacePath}
          selectedAgent={activeAgent}
          onDeviceChange={(deviceId) => {
            const device = devices.find((item) => item.id === deviceId);
            setSelectedDeviceId(deviceId);
            setSelectedWorkspaceId(device?.workspaces[0]?.id || "");
            setWorkspacePath(defaultWorkspacePath(device));
            setSelectedAgent(device?.agents?.[0]?.name || device?.agent || "claude");
          }}
          onWorkspacePathChange={setWorkspacePath}
          onAgentChange={setSelectedAgent}
          onCreate={startNewSession}
        />
      </Dialog>
      {rawEvent && <RawDialog event={rawEvent} onClose={() => setRawEvent(null)} />}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <code className="truncate font-mono text-xs text-foreground">{value}</code>
    </div>
  );
}

function SearchDialog({
  query,
  results,
  taskRecords,
  onClose,
  onOpenTask,
  onQueryChange
}: {
  query: string;
  results: SearchResult[];
  taskRecords: Map<string, TaskRecord>;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onQueryChange: (value: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-background/80" onClick={onClose}>
      <div className="search-panel absolute left-1/2 top-20 grid w-[720px] max-w-[calc(100vw-2rem)] -translate-x-1/2 grid-rows-[auto_minmax(0,1fr)] rounded-xl border shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="border-b p-4">
          <div className="flex items-center gap-2 rounded-lg border bg-background px-3">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
              }}
              placeholder="搜索对话内容、工具结果、目录或 Agent"
            />
          </div>
        </div>
        <div className="min-h-0 max-h-[60vh] overflow-auto p-2">
          {query.trim() === "" ? (
            <div className="p-6 text-center text-sm text-muted-foreground">输入关键词搜索所有对话内容。</div>
          ) : results.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">没有匹配结果。</div>
          ) : results.map((result) => (
            <button
              key={result.taskId}
              className="search-result w-full rounded-lg px-3 py-3 text-left"
              type="button"
              onClick={() => onOpenTask(result.taskId)}
            >
              <span className="block truncate text-sm font-medium">
                <HighlightedText text={result.title} query={query} />
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                <HighlightedText text={result.subtitle || taskRecords.get(result.taskId)?.workspace_path || "未设置目录"} query={query} />
              </span>
              <span className="mt-2 block line-clamp-2 text-xs leading-5 text-muted-foreground">
                <HighlightedText text={result.preview} query={query} />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const terms = searchHighlightTerms(query);
  if (!terms.length || !text) return <>{text}</>;
  const matcher = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return (
    <>
      {text.split(matcher).map((part, index) => {
        const isMatch = terms.some((term) => part.toLowerCase() === term.toLowerCase());
        return isMatch ? (
          <mark className="search-highlight" key={`${part}-${index}`}>
            {part}
          </mark>
        ) : (
          <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
        );
      })}
    </>
  );
}

function searchHighlightTerms(query: string) {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const terms = trimmed.split(/\s+/).filter(Boolean);
  return terms.length > 1 ? [trimmed, ...terms] : terms;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ComposerModelSelect({
  currentModelID,
  models,
  onChange
}: {
  currentModelID: string;
  models: AgentModel[];
  onChange: (modelID: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (models.length === 0) {
    return (
      <div className="min-w-0 truncate text-xs text-muted-foreground">
        模型 {currentModelID || "默认"}
      </div>
    );
  }
  const visibleModels = currentModelID && !models.some((model) => model.modelId === currentModelID)
    ? [{ modelId: currentModelID, name: currentModelID }, ...models]
    : models;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = normalizedQuery
    ? visibleModels.filter((model) => [model.name, model.modelId, model.description].some((value) => String(value || "").toLowerCase().includes(normalizedQuery)))
    : visibleModels;
  return (
    <div className="relative flex min-w-0 items-center gap-2 text-xs text-muted-foreground" ref={rootRef}>
      <span className="shrink-0">模型</span>
      <Button
        className="h-7 w-[220px] max-w-[52vw] justify-start truncate bg-background px-2 text-xs font-normal"
        variant="outline"
        size="sm"
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setQuery("");
        }}
      >
        <span className="truncate">{currentModelID || "选择模型"}</span>
      </Button>
      {open && (
        <div className="model-popover absolute bottom-9 left-8 z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-md border p-2 shadow-lg">
          <div className="model-search flex items-center gap-2 rounded-md border px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              placeholder="搜索模型"
            />
          </div>
          <div className="mt-2 max-h-64 overflow-auto">
            {filteredModels.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">没有匹配的模型</div>
            ) : filteredModels.map((model) => (
              <button
                className={cn("model-option w-full rounded-md px-2 py-1.5 text-left", model.modelId === currentModelID && "model-option-active")}
                key={model.modelId}
                type="button"
                onClick={() => {
                  onChange(model.modelId);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span className="block truncate text-xs font-medium">{model.modelId}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NavButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button className={cn("sidebar-nav-button w-full justify-start", active && "sidebar-nav-button-active")} variant="ghost" onClick={onClick}>
      <Icon />
      {label}
    </Button>
  );
}

function ConnectionBadge({ conn }: { conn: string }) {
  const connected = conn === "Connected";
  return (
    <div className="connection-card flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs">
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <span className={cn("size-2 rounded-full bg-primary", !connected && "bg-destructive")} aria-hidden="true" />
        <span className="truncate">Server</span>
      </span>
      <Badge variant={connected ? "success" : "destructive"}>{connected ? "已连接" : "离线"}</Badge>
    </div>
  );
}

function SidebarSessions({
  tasks,
  taskRecords,
  currentTaskId,
  onOpenTask,
  onDeleteTask
}: {
  tasks: string[];
  taskRecords: Map<string, TaskRecord>;
  currentTaskId: string;
  onOpenTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-5">
        <h2 className="text-sm font-medium text-muted-foreground">对话</h2>
        <Badge variant="secondary">{tasks.length}</Badge>
      </div>
      <div className="min-h-0 overflow-auto px-3 pb-3">
        {tasks.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-xs leading-5 text-muted-foreground">
            暂无会话。请在工作台选择设备后创建。
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {tasks.map((taskId) => (
              <SidebarSessionItem
                key={taskId}
                active={taskId === currentTaskId}
                record={taskRecords.get(taskId)}
                taskId={taskId}
                onDelete={() => onDeleteTask(taskId)}
                onOpen={() => onOpenTask(taskId)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SidebarSessionItem({
  active,
  record,
  taskId,
  onDelete,
  onOpen
}: {
  active: boolean;
  record: TaskRecord | undefined;
  taskId: string;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const title = sessionDisplayTitle(record, taskId);
  const subtitle = [agentDisplayName(record?.agent || ""), workspaceNameFromPath(record?.workspace_path || "")].filter(Boolean).join(" / ");
  const confirmDelete = () => {
    if (window.confirm(`确认删除会话「${title}」吗？`)) onDelete();
  };
  return (
    <button
      type="button"
      className={cn(
        "sidebar-session group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-3 py-2.5 text-left",
        active && "sidebar-session-active"
      )}
      onClick={onOpen}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle || "未设置目录"}</span>
      </span>
      <Button
        className="session-delete-button h-7 w-7 px-0"
        variant="ghost"
        size="sm"
        title="删除会话"
        aria-label="删除会话"
        onClick={(event) => {
          event.stopPropagation();
          confirmDelete();
        }}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </button>
  );
}

function Dashboard({
  devices,
  tasks,
  taskRecords,
  selectedDeviceId,
  onSelectDevice,
  onCreateFromDevice,
  onDeleteTask,
  onOpenTask,
}: {
  devices: Device[];
  tasks: string[];
  taskRecords: Map<string, TaskRecord>;
  selectedDeviceId: string;
  onSelectDevice: (device: Device) => void;
  onCreateFromDevice: (device: Device) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const sessionsByDevice = new Map<string, string[]>();
  const fallbackDeviceId = devices[0]?.id || "";
  for (const taskId of tasks) {
    const record = taskRecords.get(taskId);
    const device = devices.find((item) => item.id === record?.device_id) || devices.find((item) => record?.workspace_id && item.workspaces.some((workspace) => workspace.id === record.workspace_id));
    const deviceId = device?.id || fallbackDeviceId;
    if (!deviceId) continue;
    sessionsByDevice.set(deviceId, [...(sessionsByDevice.get(deviceId) || []), taskId]);
  }
  return (
    <section className="dashboard-canvas min-h-0 overflow-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-6 max-sm:p-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">远程 Agent 工作台</h2>
          <p className="mt-2 text-sm text-muted-foreground">按设备管理远程编程会话，查看机器支持的 Agent，并直接创建会话。</p>
        </div>

        <Card className="dashboard-panel">
          <CardHeader>
            <CardTitle>我的设备</CardTitle>
            <CardDescription>{devices.length === 0 ? "等待 daemon 连接" : "会话入口在左侧列表，这里按设备展示归属和创建入口"}</CardDescription>
          </CardHeader>
          <CardContent>
            {devices.length === 0 ? (
              <EmptyState title="暂无设备" description="启动 daemon 后会显示在这里。" />
            ) : (
              <div className="overflow-hidden rounded-md border">
                <div className="device-table-head grid grid-cols-[minmax(180px,1.2fr)_minmax(220px,1.8fr)_120px_120px] gap-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground max-lg:hidden">
                  <span>机器</span>
                  <span>支持的编程 Agent</span>
                  <span>状态</span>
                  <span className="text-right">创建会话</span>
                </div>
                <div className="divide-y">
                  {devices.map((device) => (
                    <DeviceTreeRow
                      key={device.id}
                      device={device}
                      selected={device.id === selectedDeviceId}
                      taskIds={sessionsByDevice.get(device.id) || []}
                      taskRecords={taskRecords}
                      onSelect={() => onSelectDevice(device)}
                      onCreate={() => onCreateFromDevice(device)}
                      onDeleteTask={onDeleteTask}
                      onOpenTask={onOpenTask}
                    />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </section>
  );
}

function DeviceTreeRow({
  device,
  selected,
  taskIds,
  taskRecords,
  onSelect,
  onCreate,
  onDeleteTask,
  onOpenTask
}: {
  device: Device;
  selected: boolean;
  taskIds: string[];
  taskRecords: Map<string, TaskRecord>;
  onSelect: () => void;
  onCreate: () => void;
  onDeleteTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const agents = (device.agents || []).map((agent) => agent.label || agentDisplayName(agent.name));
  const online = device.status !== "disconnected" && device.status !== "offline";
  return (
    <div className={cn("device-row", selected && "device-row-selected")}>
      <div className="grid grid-cols-[minmax(180px,1.2fr)_minmax(220px,1.8fr)_120px_120px] items-center gap-3 px-4 py-3 max-lg:grid-cols-1">
        <button className="flex min-w-0 items-center gap-3 text-left" onClick={onSelect}>
          <span className="device-icon grid size-9 shrink-0 place-items-center rounded-md border"><Monitor /></span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{device.name || device.id}</span>
            <span className="block truncate text-xs text-muted-foreground">{device.id}</span>
          </span>
        </button>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {agents.length === 0 ? <Badge variant="secondary">未检测到 Agent</Badge> : agents.map((agent) => <Badge key={agent} variant="outline">{agent}</Badge>)}
        </div>
        <Badge className="w-fit" variant={online ? "success" : "secondary"}>{online ? "在线" : "离线"}</Badge>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onCreate}><Plus />创建会话</Button>
        </div>
      </div>
      <div className="device-sessions border-t px-4 py-2">
        {taskIds.length === 0 ? (
          <div className="py-2 text-xs text-muted-foreground">暂无会话</div>
        ) : (
          <div className="flex flex-col gap-1">
            {taskIds.map((taskId) => (
              <SessionDeviceItem
                key={taskId}
                taskId={taskId}
                record={taskRecords.get(taskId)}
                onDelete={() => onDeleteTask(taskId)}
                onOpen={() => onOpenTask(taskId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionDeviceItem({ taskId, record, onDelete, onOpen }: { taskId: string; record: TaskRecord | undefined; onDelete: () => void; onOpen: () => void }) {
  const title = sessionDisplayTitle(record, taskId);
  const createdAt = formatRecordTime(record?.started_at);
  const latestAt = formatRecordTime(record?.updated_at || latestEventTime(record));
  const confirmDelete = () => {
    if (window.confirm(`确认删除会话「${title}」吗？`)) onDelete();
  };
  return (
    <button
      type="button"
      className="session-device-item group grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 text-left"
      onClick={onOpen}
    >
      <span className="ml-2 h-full border-l" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{agentDisplayName(record?.agent || "")} / {record?.workspace_path || taskId}</span>
        <span className="block truncate text-xs text-muted-foreground">创建 {createdAt} / 最新 {latestAt}</span>
      </span>
      <Button
        className="session-delete-button h-7 w-7 px-0"
        variant="ghost"
        size="sm"
        title="删除会话"
        aria-label="删除会话"
        onClick={(event) => {
          event.stopPropagation();
          confirmDelete();
        }}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </button>
  );
}

function SessionWorkspace({
  activeAgent,
  agentLabel,
  availableAgents,
  currentRecord,
  currentModelID,
  devices,
  effectiveWorkspacePath,
  eventsRef,
  explorerVisible,
  expandedToolResults,
  fileContent,
  fileDirty,
  fileStatus,
  fileTree,
  openFilePath,
  prompt,
  selectedDevice,
  selectedDeviceId,
  sessionModels,
  terminalLines,
  terminalRunning,
  timelineItems,
  waitingForAgent,
  onDispatch,
  onAgentChange,
  onDeviceChange,
  onModelChange,
  onNewSession,
  onScroll,
  onPromptChange,
  onRaw,
  onCloseFile,
  onRefreshFiles,
  onRunTerminalCommand,
  onStopTask,
  onFileChange,
  onFileOpen,
  onFileSave,
  onToggleExplorer,
  onWorkspacePathChange,
  onToggleToolResult
}: {
  activeAgent: string;
  agentLabel: string;
  availableAgents: AgentCapability[];
  currentRecord: TaskRecord | undefined;
  currentModelID: string;
  devices: Device[];
  effectiveWorkspacePath: string;
  eventsRef: React.RefObject<HTMLDivElement | null>;
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
  onDispatch: () => void;
  onAgentChange: (agent: string) => void;
  onDeviceChange: (deviceId: string) => void;
  onModelChange: (modelID: string) => void;
  onNewSession: () => void;
  onScroll: () => void;
  onPromptChange: (value: string) => void;
  onRaw: (event: TaskEvent) => void;
  onCloseFile: () => void;
  onRefreshFiles: () => void;
  onRunTerminalCommand: (command: string) => void;
  onStopTask: () => void;
  onFileChange: (content: string) => void;
  onFileOpen: (entry: FileEntry) => void;
  onFileSave: () => void;
  onToggleExplorer: () => void;
  onWorkspacePathChange: (value: string) => void;
  onToggleToolResult: (id: string) => void;
}) {
  const canSend = Boolean(prompt.trim() && selectedDevice && effectiveWorkspacePath);
  const emptySession = timelineItems.length === 0 && !waitingForAgent;
  return (
    <section className="ide-workbench min-h-0">
      {emptySession ? (
        <div className="session-canvas min-h-0 overflow-auto px-6 py-5 max-sm:px-4">
          <StartSessionPanel
            activeAgent={activeAgent}
            agentLabel={agentLabel}
            availableAgents={availableAgents}
            canSend={canSend}
            currentModelID={currentModelID}
            devices={devices}
            effectiveWorkspacePath={effectiveWorkspacePath}
            isLoading={waitingForAgent}
            models={sessionModels}
            prompt={prompt}
            selectedDevice={selectedDevice}
            selectedDeviceId={selectedDeviceId}
            onAgentChange={onAgentChange}
            onDeviceChange={onDeviceChange}
            onDispatch={onDispatch}
            onModelChange={onModelChange}
            onPromptChange={onPromptChange}
            onWorkspacePathChange={onWorkspacePathChange}
          />
        </div>
      ) : (
        <Group className="h-full w-full" orientation="horizontal" resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}>
          {explorerVisible ? (
            <>
              <Panel defaultSize="34%" minSize="18%" maxSize="52%">
                <WorkspacePanel
                  content={fileContent}
                  dirty={fileDirty}
                  fileTree={fileTree}
                  openFilePath={openFilePath}
                  status={fileStatus}
                  workspacePath={effectiveWorkspacePath}
                  onChange={onFileChange}
                  onCloseFile={onCloseFile}
                  onOpen={onFileOpen}
                  onRefresh={onRefreshFiles}
                  onSave={onFileSave}
                />
              </Panel>
              <Separator className="resize-handle" id="workspace-chat-separator" />
            </>
          ) : null}
          <Panel defaultSize={explorerVisible ? "66%" : "100%"} minSize="45%">
            <Group className="h-full w-full" orientation="vertical" resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}>
              <Panel defaultSize="66%" minSize="35%">
                <ChatPane
                  agentLabel={agentLabel}
                  currentModelID={currentModelID}
                  eventsRef={eventsRef}
                  explorerVisible={explorerVisible}
                  expandedToolResults={expandedToolResults}
                  prompt={prompt}
                  sessionModels={sessionModels}
                  timelineItems={timelineItems}
                  waitingForAgent={waitingForAgent}
                  canSend={canSend}
                  onDispatch={onDispatch}
                  onModelChange={onModelChange}
                  onPromptChange={onPromptChange}
                  onRaw={onRaw}
                  onScroll={onScroll}
                  onStopTask={onStopTask}
                  onToggleExplorer={onToggleExplorer}
                  onToggleToolResult={onToggleToolResult}
                />
              </Panel>
              <Separator className="resize-handle-horizontal" id="chat-terminal-separator" />
              <Panel defaultSize="34%" minSize="18%" maxSize="55%">
                <TerminalPane lines={terminalLines} running={terminalRunning} onRun={onRunTerminalCommand} />
              </Panel>
            </Group>
          </Panel>
        </Group>
      )}
    </section>
  );
}

function StartSessionPanel({
  activeAgent,
  agentLabel,
  availableAgents,
  canSend,
  currentModelID,
  devices,
  effectiveWorkspacePath,
  isLoading,
  models,
  prompt,
  selectedDevice,
  selectedDeviceId,
  onAgentChange,
  onDeviceChange,
  onDispatch,
  onModelChange,
  onPromptChange,
  onWorkspacePathChange
}: {
  activeAgent: string;
  agentLabel: string;
  availableAgents: AgentCapability[];
  canSend: boolean;
  currentModelID: string;
  devices: Device[];
  effectiveWorkspacePath: string;
  isLoading: boolean;
  models: AgentModel[];
  prompt: string;
  selectedDevice: Device | undefined;
  selectedDeviceId: string;
  onAgentChange: (agent: string) => void;
  onDeviceChange: (deviceId: string) => void;
  onDispatch: () => void;
  onModelChange: (modelID: string) => void;
  onPromptChange: (value: string) => void;
  onWorkspacePathChange: (value: string) => void;
}) {
  return (
    <div className="start-session min-h-[calc(100dvh-8rem)]">
      <div className="start-session-inner">
        <h2 className="start-session-title">Hi，今天有什么安排？</h2>
        <div className="start-controls">
          <label className="start-control">
            <span>机器</span>
            <Select value={selectedDeviceId || "none"} onValueChange={onDeviceChange}>
              <SelectTrigger><SelectValue placeholder="选择机器" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {devices.length === 0 && <SelectItem value="none" disabled>暂无机器</SelectItem>}
                  {devices.map((device) => <SelectItem key={device.id} value={device.id}>{device.name || device.id}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className="start-control">
            <span>Agent</span>
            <Select value={activeAgent || "none"} onValueChange={onAgentChange}>
              <SelectTrigger><SelectValue placeholder="选择 Agent" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {availableAgents.length === 0 && <SelectItem value="none" disabled>暂无 Agent</SelectItem>}
                  {availableAgents.map((agent) => <SelectItem key={agent.name} value={agent.name}>{agent.label || agentDisplayName(agent.name)}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className="start-control start-control-path">
            <span>工作目录</span>
            <Input value={effectiveWorkspacePath} onChange={(event) => onWorkspacePathChange(event.target.value)} placeholder={selectedDevice ? defaultWorkspacePath(selectedDevice) : "/path/to/project"} />
          </label>
        </div>
        <div className="start-composer">
          <Textarea
            className="start-composer-input resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.ctrlKey || event.metaKey || event.shiftKey) return;
              event.preventDefault();
              onDispatch();
            }}
            placeholder={`${agentLabel || "Agent"}，发消息、修改代码或分析项目...`}
          />
          <div className="start-composer-actions">
            <div className="start-composer-tools">
              <ComposerModelSelect currentModelID={currentModelID} models={models} onChange={onModelChange} />
            </div>
            <Button className="start-send-button" disabled={!canSend || isLoading} size="icon" type="button" onClick={onDispatch} aria-label="发送">
              {isLoading ? <LoaderCircle className="animate-spin" /> : <Send />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspacePanel({
  content,
  dirty,
  fileTree,
  openFilePath,
  status,
  workspacePath,
  onChange,
  onCloseFile,
  onOpen,
  onRefresh,
  onSave
}: {
  content: string;
  dirty: boolean;
  fileTree: FileEntry[];
  openFilePath: string;
  status: string;
  workspacePath: string;
  onChange: (content: string) => void;
  onCloseFile: () => void;
  onOpen: (entry: FileEntry) => void;
  onRefresh: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    if (workspacePath) onRefresh();
  }, [workspacePath]);
  const data = fileTree.length ? fileTree : [{ id: ".", name: workspaceNameFromPath(workspacePath) || "workspace", path: ".", is_dir: true, children: [] }];
  return (
    <section className="workspace-panel">
      <Group className="h-full w-full" orientation="vertical" resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}>
        <Panel defaultSize={openFilePath ? "38%" : "100%"} minSize="20%">
          <aside className="workspace-explorer">
            <div className="workspace-panel-header">
              <span>资源管理器</span>
              <Button className="h-7 w-7 px-0" variant="ghost" size="sm" onClick={onRefresh} aria-label="刷新文件树"><RefreshCw className="size-3.5" /></Button>
            </div>
            <div className="workspace-root truncate" title={workspacePath}>{workspacePath || "未选择目录"}</div>
            <div className="workspace-tree">
              <Tree<FileEntry>
                data={data}
                idAccessor="id"
                childrenAccessor="children"
                openByDefault={false}
                rowHeight={28}
                width="100%"
                height={720}
                onActivate={(node) => onOpen(node.data)}
              >
                {FileNode}
              </Tree>
            </div>
          </aside>
        </Panel>
        {openFilePath ? (
          <>
            <Separator className="resize-handle-horizontal" id="explorer-editor-separator" />
            <Panel defaultSize="62%" minSize="28%">
              <EditorPane content={content} dirty={dirty} path={openFilePath} status={status} onChange={onChange} onClose={onCloseFile} onSave={onSave} />
            </Panel>
          </>
        ) : null}
      </Group>
    </section>
  );
}

function FileNode({ node, style }: { node: NodeApi<FileEntry>; style: React.CSSProperties }) {
  const Icon = node.data.is_dir ? (node.isOpen ? FolderOpen : Folder) : FileText;
  return (
    <div
      className={cn("file-node", node.isSelected && "file-node-selected")}
      style={{ ...style, paddingLeft: `${node.level * 14 + 8}px` }}
      onClick={() => {
        if (node.data.is_dir) node.toggle();
        node.activate();
      }}
    >
      {node.data.is_dir ? <ChevronRight className={cn("file-chevron", node.isOpen && "file-chevron-open")} /> : <span className="file-chevron-placeholder" />}
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{node.data.name}</span>
    </div>
  );
}

function ChatPane({
  agentLabel,
  currentModelID,
  eventsRef,
  explorerVisible,
  expandedToolResults,
  prompt,
  sessionModels,
  timelineItems,
  waitingForAgent,
  canSend,
  onDispatch,
  onModelChange,
  onPromptChange,
  onRaw,
  onScroll,
  onStopTask,
  onToggleExplorer,
  onToggleToolResult
}: {
  agentLabel: string;
  currentModelID: string;
  eventsRef: React.RefObject<HTMLDivElement | null>;
  explorerVisible: boolean;
  expandedToolResults: Set<string>;
  prompt: string;
  sessionModels: AgentModel[];
  timelineItems: TimedTimelineItem[];
  waitingForAgent: boolean;
  canSend: boolean;
  onDispatch: () => void;
  onModelChange: (modelID: string) => void;
  onPromptChange: (value: string) => void;
  onRaw: (event: TaskEvent) => void;
  onScroll: () => void;
  onStopTask: () => void;
  onToggleExplorer: () => void;
  onToggleToolResult: (id: string) => void;
}) {
  return (
    <section className="chat-pane">
      <div className="pane-header chat-header">
        <div className="flex items-center gap-2">
          <Button className="h-7 px-2 text-xs" variant="ghost" size="sm" onClick={onToggleExplorer}>
            <PanelLeft className="size-3.5" />{explorerVisible ? "隐藏资源" : "显示资源"}
          </Button>
          <span>对话</span>
        </div>
        <Button className="h-7 px-2 text-xs" variant="outline" size="sm" disabled={!waitingForAgent} onClick={onStopTask}>
          <Square className="size-3.5" />停止
        </Button>
      </div>
      <div className="session-canvas min-h-0 overflow-auto px-4 py-4" ref={eventsRef} onScroll={onScroll}>
        {timelineItems.map((item, index) => {
          if (item.kind === "tool") {
            return <ToolBlock key={item.uiKey} item={item} resultExpanded={expandedToolResults.has(item.uiKey)} onToggleResult={() => onToggleToolResult(item.uiKey)} onRaw={onRaw} />;
          }
          if (item.kind === "permission") return <PermissionBlock key={item.uiKey} item={item} onRaw={onRaw} />;
          if (item.kind === "commands") return <CommandsBlock key={item.uiKey} item={item} onRaw={onRaw} />;
          if (item.kind === "mode") return <ModeBlock key={item.uiKey} item={item} onRaw={onRaw} />;
          if (item.itemKind === "thinking") return <ThinkingBlock key={`${item.event.event_id || index}`} item={item} onRaw={onRaw} />;
          return <MessageBlock key={`${item.event.event_id || index}`} item={item} agentLabel={agentLabel} onRaw={onRaw} />;
        })}
        {waitingForAgent ? <AgentLoadingBlock agentLabel={agentLabel} /> : null}
      </div>
      <Composer canSend={canSend} currentModelID={currentModelID} isLoading={waitingForAgent} models={sessionModels} prompt={prompt} onDispatch={onDispatch} onModelChange={onModelChange} onPromptChange={onPromptChange} />
    </section>
  );
}

function EditorPane({
  content,
  dirty,
  path,
  status,
  onChange,
  onClose,
  onSave
}: {
  content: string;
  dirty: boolean;
  path: string;
  status: string;
  onChange: (content: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <section className="editor-pane">
      <div className="pane-header editor-header">
        <span className="truncate">{path || "未打开文件"}</span>
        <div className="flex items-center gap-2">
          {status && <span className="text-xs text-muted-foreground">{status}</span>}
          <Button className="h-7 px-2 text-xs" variant="outline" size="sm" disabled={!path || !dirty} onClick={onSave}><Save className="size-3.5" />保存</Button>
          <Button className="h-7 w-7 px-0" variant="ghost" size="sm" disabled={!path} onClick={onClose} aria-label="关闭文件"><X className="size-3.5" /></Button>
        </div>
      </div>
      {path ? (
        <Editor
          height="100%"
          path={path}
          value={content}
          language={languageForPath(path)}
          theme="vs"
          options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true }}
          onChange={(value) => onChange(value || "")}
        />
      ) : (
        <div className="editor-empty">从左侧目录选择文件查看或编辑。</div>
      )}
    </section>
  );
}

function TerminalPane({ lines, running, onRun }: { lines: string[]; running: boolean; onRun: (command: string) => void }) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [command, setCommand] = useState("");

  useEffect(() => {
    if (!terminalRef.current || termRef.current) return;
    const term = new XTerminal({ cursorBlink: true, fontSize: 13, convertEol: true, theme: { background: "#ffffff", foreground: "#1d2129" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    for (const line of lines.slice(-200)) term.writeln(line);
    if (running) term.writeln("运行中...");
  }, [lines, running]);

  return (
    <section className="terminal-pane">
      <div className="pane-header terminal-header">
        <span className="inline-flex items-center gap-2"><TerminalIcon className="size-3.5" />终端</span>
        {running ? <span className="text-xs text-muted-foreground">运行中</span> : null}
      </div>
      <div className="terminal-output" ref={terminalRef} />
      <div className="terminal-input-row">
        <span>$</span>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            onRun(command);
            setCommand("");
          }}
          placeholder="在当前工作目录执行命令"
        />
      </div>
    </section>
  );
}

function Composer({
  canSend,
  currentModelID,
  isLoading,
  models,
  prompt,
  onDispatch,
  onModelChange,
  onPromptChange
}: {
  canSend: boolean;
  currentModelID: string;
  isLoading: boolean;
  models: AgentModel[];
  prompt: string;
  onDispatch: () => void;
  onModelChange: (modelID: string) => void;
  onPromptChange: (value: string) => void;
}) {
  return (
    <div className="composer-bar border-t p-4">
      <div className="composer-box mx-auto max-w-5xl rounded-lg border shadow-sm">
        <Textarea
          className="min-h-24 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            event.preventDefault();
            onDispatch();
          }}
          placeholder="描述要让 Agent 完成的开发任务，Enter 发送，Ctrl+Enter 换行"
        />
        <div className="composer-actions flex items-center justify-between gap-3 border-t px-3 py-2">
          <ComposerModelSelect
            currentModelID={currentModelID}
            models={models}
            onChange={onModelChange}
          />
          <Button disabled={!canSend || isLoading} onClick={onDispatch}>
            {isLoading ? <LoaderCircle className="animate-spin" /> : <Send />}
            {isLoading ? "处理中" : "发送"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AgentLoadingBlock({ agentLabel }: { agentLabel: string }) {
  return (
    <div className="agent-loading-row mx-auto mb-3 flex max-w-5xl justify-start">
      <div className="agent-loading inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <LoaderCircle className="size-4 animate-spin" />
        <span>{agentLabel || "Agent"} 正在处理</span>
      </div>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-md border border-dashed p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function NewSessionDialog({
  devices,
  selectedDeviceId,
  workspacePath,
  selectedAgent,
  onDeviceChange,
  onWorkspacePathChange,
  onAgentChange,
  onCreate
}: {
  devices: Device[];
  selectedDeviceId: string;
  workspacePath: string;
  selectedAgent: string;
  onDeviceChange: (deviceId: string) => void;
  onWorkspacePathChange: (path: string) => void;
  onAgentChange: (agent: string) => void;
  onCreate: () => void;
}) {
  const device = devices.find((item) => item.id === selectedDeviceId);
  const agents = device?.agents?.length
    ? device.agents
    : [{ name: device?.agent || "claude", label: device?.agent_label || agentDisplayName(device?.agent || "claude") }];
  const selectedPath = workspacePath.trim();
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>新建会话</DialogTitle>
        <DialogDescription>选择客户机、Agent，并填写客户机上的项目工作目录。</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <label className="grid gap-2 text-sm font-medium">
          设备
          <Select value={selectedDeviceId || "none"} onValueChange={onDeviceChange}>
            <SelectTrigger><SelectValue placeholder="选择设备" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {devices.length === 0 && <SelectItem value="none" disabled>暂无设备</SelectItem>}
                {devices.map((item) => <SelectItem key={item.id} value={item.id}>{item.name || item.id}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-2 text-sm font-medium">
          Agent
          <Select value={selectedAgent || "none"} onValueChange={onAgentChange}>
            <SelectTrigger><SelectValue placeholder="选择 Agent" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {agents.length === 0 && <SelectItem value="none" disabled>暂无可用 Agent</SelectItem>}
                {agents.map((agent) => <SelectItem key={agent.name} value={agent.name}>{agent.label || agentDisplayName(agent.name)}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-2 text-sm font-medium">
          项目工作目录
          <Input
            value={workspacePath}
            onChange={(event) => onWorkspacePathChange(event.target.value)}
            placeholder={defaultWorkspacePath(device)}
          />
        </label>
        <div className="agent-path-preview flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          <Code2 className="size-4" />
          <span className="truncate">{agentDisplayName(selectedAgent)} / {selectedPath || "填写项目工作目录"}</span>
        </div>
        <Button disabled={!device || !selectedPath || !selectedAgent || selectedAgent === "none"} onClick={onCreate}><Plus />创建会话</Button>
      </div>
    </DialogContent>
  );
}

function MessageBlock({
  item,
  agentLabel,
  onRaw
}: {
  item: Extract<TimelineItem, { kind: "message" }>;
  agentLabel: string;
  onRaw: (event: TaskEvent) => void;
}) {
  const tone = messageTone(item.itemKind);
  const title = displayTitle(item, agentLabel);
  const event = item.event;
  const isUser = tone === "user";
  const isAssistant = tone === "assistant";
  return (
    <div className={cn(
      "message-item group mx-auto mb-3 flex max-w-5xl",
      isUser ? "justify-end" : "justify-start",
      isAssistant && "message-item-assistant",
      tone === "error" && "message-item-error"
    )}>
      <div className={cn(
        "message-bubble min-w-0",
        tone === "assistant" && "message-assistant",
        tone === "user" && "message-user",
        tone === "error" && "message-error"
      )}>
        <div className="min-w-0">
          <div className="message-meta-row flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {!isUser && <span className="text-xs font-medium text-muted-foreground">{title}</span>}
              <span className="message-time truncate text-xs text-muted-foreground">{formatEventTime(event)}</span>
            </div>
            <Button className="message-raw h-6 shrink-0 px-2 opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(event)}>Raw</Button>
          </div>
          {tone === "assistant"
            ? <MarkdownMessage text={item.summary} />
            : <p className="whitespace-pre-wrap break-words text-sm leading-6">{item.summary}</p>}
          {item.meta && item.meta.length > 0 && <MetaRows rows={item.meta} />}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({ item, onRaw }: { item: Extract<TimelineItem, { kind: "message" }>; onRaw: (event: TaskEvent) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="thinking-summary group mx-auto mb-2 max-w-5xl">
      <div className="thinking-header" onClick={() => setExpanded((value) => !value)}>
        <span className="thinking-icon"><Brain className="size-3.5" /></span>
        <span className="thinking-label">Thinking</span>
        <ChevronRight className={cn("thinking-arrow size-3", expanded && "thinking-arrow-open")} />
        <Button
          className="message-raw ml-1 h-6 px-2 opacity-0 transition-opacity group-hover:opacity-100"
          variant="ghost"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onRaw(item.event);
          }}
        >
          Raw
        </Button>
      </div>
      {expanded && <div className="thinking-body">{item.summary}</div>}
    </div>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-body text-sm leading-6">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function ToolBlock({
  item,
  resultExpanded,
  onToggleResult,
  onRaw
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  resultExpanded: boolean;
  onToggleResult: () => void;
  onRaw: (event: TaskEvent) => void;
}) {
  const toolUse = item.call;
  const name = toolName(toolUse);
  const input = toolInput(toolUse);
  const output = toolOutputForEvent(item.result);
  const hasError = Boolean(output?.isError);
  const summary = toolUseSummary(input, toolUse?.locations);
  const statusLabel = toolStatusLabel(toolUse, Boolean(item.result), hasError);
  const inputJSON = JSON.stringify(input, null, 2);
  const running = !item.result && !hasError;
  return (
    <div className="tool-summary group mx-auto mb-2 max-w-5xl">
      <div className="tool-header">
        <button className="tool-main" type="button" onClick={output ? onToggleResult : undefined}>
          <span className={cn("tool-status-dot", running && "tool-status-running", hasError && "tool-status-error", item.result && !hasError && "tool-status-done")}>
            {running ? <LoaderCircle className="size-3 animate-spin" /> : hasError ? <CircleAlert className="size-3" /> : <CheckCircle2 className="size-3" />}
          </span>
          <span className="tool-title truncate">{toolTitle(name, input, toolUse?.kind)}</span>
          {summary && summary !== "{}" ? <span className="tool-description truncate">{summary}</span> : null}
          <span className="tool-status-label">{statusLabel}</span>
          {output ? <ChevronRight className={cn("tool-arrow size-3", resultExpanded && "tool-arrow-open")} /> : null}
        </button>
        <Button className="message-raw h-6 px-2 opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(item.result || item.event)}>Raw</Button>
      </div>
      {toolUse?.locations?.length ? (
        <div className="tool-locations">
          {toolUse.locations.map((location, index) => location.path ? <code className="tool-location" key={`${location.path}-${index}`}>{location.path}</code> : null)}
        </div>
      ) : null}
      {resultExpanded && output && (
        <div className="tool-detail-panel">
          <div className="tool-detail-section">
            <div className="tool-detail-label">执行工具内容</div>
            <pre className="tool-detail-content">{inputJSON || "-"}</pre>
          </div>
          <div className="tool-detail-section">
            <div className="tool-detail-label">执行工具结果</div>
            <pre className={cn("tool-detail-content", hasError && "tool-detail-content-error")}>{output.summary || "-"}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function PermissionBlock({ item, onRaw }: { item: Extract<TimelineItem, { kind: "permission" }>; onRaw: (event: TaskEvent) => void }) {
  const request = item.request;
  return (
    <div className="system-summary group mx-auto mb-2 max-w-5xl">
      <div className="system-header">
        <span className="system-title">权限请求</span>
        <span className="system-description truncate">{request.title}</span>
        <Badge variant="success">已自动允许</Badge>
        <Button className="h-6 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(item.event)}>Raw</Button>
      </div>
    </div>
  );
}

function CommandsBlock({ item, onRaw }: { item: Extract<TimelineItem, { kind: "commands" }>; onRaw: (event: TaskEvent) => void }) {
  const [expanded, setExpanded] = useState(false);
  const visibleCommands = expanded ? item.commands : item.commands.slice(0, 8);
  const hiddenCount = Math.max(0, item.commands.length - visibleCommands.length);
  return (
    <div className="system-summary group mx-auto mb-2 max-w-5xl">
      <div className="system-header">
        <span className="system-title">可用命令</span>
        <div className="system-chips">
          {visibleCommands.map((command) => <code className="command-chip" key={command.name}>{command.name}</code>)}
        </div>
        {item.commands.length > 8 ? (
          <button className="system-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起" : `展开 ${hiddenCount}`}
          </button>
        ) : null}
        <Button className="h-6 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(item.event)}>Raw</Button>
      </div>
    </div>
  );
}

function ModeBlock({ item, onRaw }: { item: Extract<TimelineItem, { kind: "mode" }>; onRaw: (event: TaskEvent) => void }) {
  const mode = item.modes.find((entry) => entry.id === item.modeID);
  return (
    <div className="system-summary group mx-auto mb-2 max-w-5xl">
      <div className="system-header">
        <span className="system-title">模式</span>
        <Badge variant="secondary">{item.modeID || "-"}</Badge>
        {mode?.description ? <span className="system-description truncate">{mode.description}</span> : null}
        <Button className="h-6 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(item.event)}>Raw</Button>
      </div>
    </div>
  );
}

function MetaRows({ rows }: { rows: [string, string][] }) {
  return <div className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">{rows.map(([key, value]) => <React.Fragment key={key}><span>{key}</span><code className="truncate font-mono text-foreground">{value}</code></React.Fragment>)}</div>;
}

function RawDialog({ event, onClose }: { event: TaskEvent; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4" onClick={onClose}>
      <div className="raw-dialog grid max-h-[86vh] w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)] rounded-lg border shadow-lg" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold">原始事件</h2>
          <Button variant="ghost" size="icon" onClick={onClose}><X /></Button>
        </div>
        <pre className="raw-dialog-body overflow-auto p-4 text-xs leading-6">{JSON.stringify(event.raw || event.data || event, null, 2)}</pre>
      </div>
    </div>
  );
}

function withEventTimestamp(event: TaskEvent, envelopeTimestamp?: number): TaskEvent {
  return {
    ...event,
    timestamp: event.timestamp || envelopeTimestamp || Math.floor(Date.now() / 1000),
    received_at: Math.floor(Date.now() / 1000)
  };
}

function formatRecordTime(value: number | undefined) {
  if (!value) return "--";
  return new Date(value * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function latestEventTime(record: TaskRecord | undefined) {
  const events = record?.events || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = eventTimeSeconds(events[index]);
    if (value) return value;
  }
  return 0;
}

function searchSessionRecords(taskIds: string[], records: Map<string, TaskRecord>, query: string): SearchResult[] {
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

function searchTextFromEvent(event: TaskEvent) {
  const description = describeEvent(event);
  const data = normalizePayload(event.data);
  const raw = normalizePayload(event.raw);
  return [description.title, description.summary, data.prompt, data.text, raw.text, raw.content].map((value) => {
    if (!value) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }).filter(Boolean).join("\n");
}

function bestSearchPreview(chunks: string[], normalizedQuery: string) {
  const match = chunks.find((chunk) => chunk.toLowerCase().includes(normalizedQuery)) || chunks.find(Boolean) || "";
  const collapsed = match.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 180) return collapsed;
  const index = Math.max(0, collapsed.toLowerCase().indexOf(normalizedQuery));
  const start = Math.max(0, index - 60);
  return `${start > 0 ? "..." : ""}${collapsed.slice(start, start + 180)}...`;
}

function isWaitingForAgent(record: TaskRecord | undefined, events: TaskEvent[]) {
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

function statusFromEvent(type: string, fallback = "running") {
  if (type === "session.created" || type === "acpx.session") return fallback === "running" || fallback === "stopping" ? fallback : "created";
  if (type === "task.completed") return "completed";
  if (type === "task.failed") return "failed";
  if (type === "task.killed") return "killed";
  if (type === "task.stopping") return "stopping";
  if (type === "model.list" || type === "model.updated" || type === "model.update_failed" || type === "metric.updated" || type === "acpx.raw") return fallback;
  return fallback || "running";
}

function statusBadgeVariant(status: string | undefined) {
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

function statusLabel(status: string | undefined) {
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

function sessionDisplayTitle(record: TaskRecord | undefined, fallback = "") {
  return workspaceNameFromPath(record?.workspace_path || "") || record?.prompt || fallbackTitle(fallback) || "未命名会话";
}

function fallbackTitle(value: string) {
  if (!value || /^(ses|tsk)_/.test(value)) return "";
  return value;
}

function isDuplicateEvent(items: TaskEvent[], event: TaskEvent) {
  if (event.event_id && items.some((item) => item.event_id === event.event_id)) return true;
  if (event.event_type !== "user.prompt") return false;
  const prompt = String(normalizePayload(event.data).prompt || "");
  return items.some((item) => item.event_type === "user.prompt" && String(normalizePayload(item.data).prompt || "") === prompt);
}

function sessionNameFor(workspace: Workspace, agent: string) {
  const base = (workspace.id || workspace.name || "workspace").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const safeAgent = (agent || "agent").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `${base || "workspace"}-${safeAgent || "agent"}`;
}

function uniqueSessionNameFor(workspace: Workspace, agent: string) {
  return `${sessionNameFor(workspace, agent)}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
}

function workspaceForPath(path: string, selected?: Workspace): Workspace {
  const cleanPath = path.trim();
  if (selected?.path === cleanPath) return selected;
  return {
    id: workspaceIDFromPath(cleanPath),
    name: workspaceNameFromPath(cleanPath),
    path: cleanPath
  };
}

function mergeTreeEntries(current: FileEntry[], parentPath: string, entries: NonNullable<WorkspaceResult["entries"]>): FileEntry[] {
  const children = entries.map((entry) => ({
    id: entry.path,
    name: entry.name,
    path: entry.path,
    is_dir: entry.is_dir,
    children: entry.is_dir ? [] : undefined
  }));
  if (!current.length || parentPath === ".") {
    return [{ id: ".", name: ".", path: ".", is_dir: true, children }];
  }
  const visit = (nodes: FileEntry[]): FileEntry[] => nodes.map((node) => {
    if (node.path === parentPath) return { ...node, children };
    if (node.children) return { ...node, children: visit(node.children) };
    return node;
  });
  return visit(current);
}

function languageForPath(path: string) {
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

function defaultWorkspacePath(device: Device | undefined) {
  const root = device?.workspaces?.[0]?.path || "~/Agent";
  return joinWorkspacePath(root, "project001");
}

function joinWorkspacePath(root: string, name: string) {
  const cleanRoot = root.trim().replace(/[\\/]+$/g, "");
  return `${cleanRoot || "~/Agent"}/${name}`;
}

function workspaceIDFromPath(path: string) {
  const clean = path.trim().replace(/^~[\\/]/, "home/").replace(/[\\/]+/g, "-").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "workspace";
}

function workspaceNameFromPath(path: string) {
  if (!path.trim()) return "";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "workspace";
}

function agentDisplayName(agent: string) {
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

function routeFromLocation(): RouteState {
  const path = window.location.pathname;
  const match = path.match(/^\/session\/([^/]+)$/);
  if (match) return { view: "task", taskId: decodeURIComponent(match[1]) };
  return { view: "dashboard", taskId: "" };
}

function currentTaskIdFromPath() {
  return routeFromLocation().taskId;
}

function pushRoute(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
}

createRoot(document.getElementById("root")!).render(<App />);
