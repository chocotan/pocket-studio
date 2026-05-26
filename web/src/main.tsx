import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  Bot,
  Code2,
  Info,
  Menu,
  Monitor,
  Plus,
  Send,
  Square,
  Terminal,
  X
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import "./styles.css";

type Workspace = {
  id: string;
  name: string;
  path: string;
};

type AgentCapability = {
  name: string;
  label: string;
};

type Device = {
  id: string;
  name: string;
  status: string;
  agent?: string;
  agent_label?: string;
  agents?: AgentCapability[];
  workspaces: Workspace[];
};

type TaskEvent = {
  task_id: string;
  event_id?: string;
  event_type: string;
  source?: string;
  sequence?: number;
  timestamp?: number;
  received_at?: number;
  data?: unknown;
  raw?: unknown;
};

type TaskRecord = {
  task_id: string;
  device_id?: string;
  workspace_id?: string;
  workspace_path?: string;
  agent?: string;
  session_name?: string;
  prompt?: string;
  status?: string;
  session_id?: string;
  started_at?: number;
  updated_at?: number;
  events?: TaskEvent[];
};

type TimelineItem =
  | { kind: "event"; event: TaskEvent }
  | { kind: "tool"; id?: string; uiKey: string; event: TaskEvent; call: ToolUse | null; result: TaskEvent | null };

type TimedTimelineItem = TimelineItem & {
  elapsedSeconds?: number;
};

type ToolUse = {
  id?: string;
  tool_use_id?: string;
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: string;
  input?: Record<string, unknown>;
  rawInput?: Record<string, unknown>;
};

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
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [rawEvent, setRawEvent] = useState<TaskEvent | null>(null);
  const [expandedToolResults, setExpandedToolResults] = useState<Set<string>>(new Set());
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

  useEffect(() => {
    const applyRoute = () => {
      const route = routeFromLocation();
      setView(route.view);
      if (route.taskId) setCurrentTaskId(route.taskId);
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
          if (!currentTaskIdFromPath()) {
            setCurrentTaskId((current) => current || payload.task_id);
            setView("task");
          }
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
    });
  }, [currentTaskId, events.length, timelineItems.length]);

  function updateStickToBottom() {
    const node = eventsRef.current;
    if (!node) return;
    shouldStickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  function navigateHome() {
    setView("dashboard");
    setSidebarOpen(false);
    pushRoute("/home");
  }

  function navigateSession(taskId: string) {
    setCurrentTaskId(taskId);
    setView("task");
    setSidebarOpen(false);
    pushRoute(`/session/${encodeURIComponent(taskId)}`);
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
      setCurrentTaskId((current) => current || sorted[0] || "");
      return next;
    });
  }

  function mergeTaskEvent(event: TaskEvent) {
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(event.task_id) || { task_id: event.task_id, status: "running", events: [] };
      const sessionID = extractSessionIDFromEvent(event);
      if (sessionID) record.session_id = sessionID;
      record.status = statusFromEvent(event.event_type);
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
    const resumeSessionId = currentRecord?.session_id || "";
    const workspace = workspaceForPath(effectiveWorkspacePath, selectedWorkspace);
    const taskId = resumeSessionId && currentTaskId ? currentTaskId : `tsk_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
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
      record.session_name = sessionNameFor(workspace, activeAgent);
      record.prompt = text;
      record.session_id = resumeSessionId || record.session_id;
      record.status = "running";
      record.events = resumeSessionId ? [...(record.events || []), userEvent] : [userEvent];
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
        session_name: sessionNameFor(workspace, activeAgent),
        prompt: text,
        parent_task_id: resumeSessionId ? currentTaskId : "",
        resume_session_id: resumeSessionId,
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
    const sessionName = sessionNameFor(workspace, agent);
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

  const sessionTitle = sessionDisplayTitle(currentRecord, currentTaskId) || (effectiveWorkspacePath ? workspaceNameFromPath(effectiveWorkspacePath) : "新会话");

  return (
    <div className="grid h-dvh grid-cols-[248px_minmax(0,1fr)] overflow-hidden bg-muted max-lg:grid-cols-1">
      <aside className={cn("grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] border-r bg-background max-lg:fixed max-lg:inset-y-3 max-lg:left-3 max-lg:hidden max-lg:w-72 max-lg:rounded-lg max-lg:border max-lg:shadow-xl", sidebarOpen && "max-lg:grid")}>
        <div className="flex h-16 items-center gap-3 border-b px-4">
          <div className="grid size-9 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">AB</div>
          <div className="min-w-0">
            <div className="truncate font-semibold leading-tight">AgentBridge</div>
            <div className="truncate text-xs text-muted-foreground">远程编程 Agent 控制台</div>
          </div>
        </div>
        <nav className="border-b p-3">
          <NavButton active={view === "dashboard"} icon={Monitor} label="工作台" onClick={navigateHome} />
        </nav>
        <SidebarSessions
          tasks={tasks}
          taskRecords={taskRecords}
          currentTaskId={currentTaskId}
          onOpenTask={openTask}
        />
        <div className="border-t p-3">
          <ConnectionBadge conn={conn} />
        </div>
      </aside>

      <main className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <header className="flex min-h-16 items-center justify-between gap-4 border-b bg-background px-6 max-sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button className="hidden max-lg:inline-flex" variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu /></Button>
            {view === "task" && (
              <Button variant="ghost" size="icon" onClick={navigateHome} aria-label="返回工作台">
                <ArrowLeft />
              </Button>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">{view === "dashboard" ? "工作台" : sessionTitle}</h1>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {view === "dashboard"
                  ? `${devices.length} 台设备在线，${tasks.length} 个会话`
                  : [agentLabel, effectiveWorkspacePath].filter(Boolean).join(" / ")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
            onOpenTask={openTask}
          />
        ) : (
          <SessionWorkspace
            agentLabel={agentLabel}
            currentRecord={currentRecord}
            effectiveWorkspacePath={effectiveWorkspacePath}
            eventsRef={eventsRef}
            expandedToolResults={expandedToolResults}
            prompt={prompt}
            selectedDevice={selectedDevice}
            timelineItems={timedTimelineItems}
            onScroll={updateStickToBottom}
            onDispatch={dispatchTask}
            onNewSession={() => setNewSessionOpen(true)}
            onPromptChange={setPrompt}
            onRaw={setRawEvent}
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
          <aside className="absolute right-0 top-0 grid h-full w-[420px] max-w-[92vw] grid-rows-[auto_auto_minmax(0,1fr)] border-l bg-background shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b p-4">
              <h2 className="font-semibold">当前任务</h2>
              <Button variant="ghost" size="icon" onClick={() => setInspectorOpen(false)}><X /></Button>
            </div>
            <div className="flex flex-col gap-3 border-b p-4">
              <Metric label="状态" value={status} />
              <Metric label="Agent" value={agentLabel} />
              <Metric label="设备" value={selectedDevice?.name || "-"} />
              <Metric label="目录" value={effectiveWorkspacePath || "-"} />
              <Metric label="事件" value={String(events.length)} />
              <Button className="w-full" variant="destructive" disabled={!currentTaskId} onClick={stopTask}><Square />停止任务</Button>
            </div>
            <div className="min-h-0 overflow-auto p-4">
              <h2 className="mb-2 text-xs font-medium uppercase text-muted-foreground">执行流</h2>
              {events.slice().reverse().map((event, index) => (
                <button
                  key={`${event.event_id || index}`}
                  className={cn("flex w-full items-center justify-between gap-2 border-b py-2 text-left text-xs text-muted-foreground hover:text-foreground", !isMainEvent(event) && "bg-muted/40")}
                  title="查看原始事件"
                  onClick={() => setRawEvent(event)}
                >
                  <span>{describeEvent(event).title} {event.sequence ? `#${event.sequence}` : ""}</span>
                  <Badge variant="outline">Raw</Badge>
                </button>
              ))}
            </div>
          </aside>
        </div>
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
    <Button className="w-full justify-start" variant={active ? "secondary" : "ghost"} onClick={onClick}>
      <Icon />
      {label}
    </Button>
  );
}

function ConnectionBadge({ conn }: { conn: string }) {
  const connected = conn === "Connected";
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-xs">
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
  onOpenTask
}: {
  tasks: string[];
  taskRecords: Map<string, TaskRecord>;
  currentTaskId: string;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h2 className="text-xs font-medium uppercase text-muted-foreground">会话列表</h2>
        <Badge variant="secondary">{tasks.length}</Badge>
      </div>
      <div className="min-h-0 overflow-auto px-2 pb-3">
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
  onOpen
}: {
  active: boolean;
  record: TaskRecord | undefined;
  taskId: string;
  onOpen: () => void;
}) {
  const title = sessionDisplayTitle(record, taskId);
  const subtitle = [agentDisplayName(record?.agent || ""), workspaceNameFromPath(record?.workspace_path || "")].filter(Boolean).join(" / ");
  return (
    <button
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent",
        active && "bg-accent text-accent-foreground"
      )}
      onClick={onOpen}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle || "未设置目录"}</span>
      </span>
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
  onOpenTask,
}: {
  devices: Device[];
  tasks: string[];
  taskRecords: Map<string, TaskRecord>;
  selectedDeviceId: string;
  onSelectDevice: (device: Device) => void;
  onCreateFromDevice: (device: Device) => void;
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
    <section className="min-h-0 overflow-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-6 max-sm:p-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">远程 Agent 工作台</h2>
          <p className="mt-2 text-sm text-muted-foreground">按设备管理远程编程会话，查看机器支持的 Agent，并直接创建会话。</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>我的设备</CardTitle>
            <CardDescription>{devices.length === 0 ? "等待 daemon 连接" : "会话入口在左侧列表，这里按设备展示归属和创建入口"}</CardDescription>
          </CardHeader>
          <CardContent>
            {devices.length === 0 ? (
              <EmptyState title="暂无设备" description="启动 daemon 后会显示在这里。" />
            ) : (
              <div className="overflow-hidden rounded-md border">
                <div className="grid grid-cols-[minmax(180px,1.2fr)_minmax(220px,1.8fr)_120px_120px] gap-3 border-b bg-muted/60 px-4 py-2 text-xs font-medium text-muted-foreground max-lg:hidden">
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
  onOpenTask
}: {
  device: Device;
  selected: boolean;
  taskIds: string[];
  taskRecords: Map<string, TaskRecord>;
  onSelect: () => void;
  onCreate: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const agents = (device.agents || []).map((agent) => agent.label || agentDisplayName(agent.name));
  const online = device.status !== "disconnected" && device.status !== "offline";
  return (
    <div className={cn("bg-background", selected && "bg-accent/40")}>
      <div className="grid grid-cols-[minmax(180px,1.2fr)_minmax(220px,1.8fr)_120px_120px] items-center gap-3 px-4 py-3 max-lg:grid-cols-1">
        <button className="flex min-w-0 items-center gap-3 text-left" onClick={onSelect}>
          <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-card"><Monitor /></span>
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
      <div className="border-t bg-muted/25 px-4 py-2">
        {taskIds.length === 0 ? (
          <div className="py-2 text-xs text-muted-foreground">暂无会话</div>
        ) : (
          <div className="flex flex-col gap-1">
            {taskIds.map((taskId) => (
              <SessionDeviceItem
                key={taskId}
                taskId={taskId}
                record={taskRecords.get(taskId)}
                onOpen={() => onOpenTask(taskId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionDeviceItem({ taskId, record, onOpen }: { taskId: string; record: TaskRecord | undefined; onOpen: () => void }) {
  const title = sessionDisplayTitle(record, taskId);
  const createdAt = formatRecordTime(record?.started_at);
  const latestAt = formatRecordTime(record?.updated_at || latestEventTime(record));
  return (
    <button className="grid w-full grid-cols-[24px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-background" onClick={onOpen}>
      <span className="ml-2 h-full border-l" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{agentDisplayName(record?.agent || "")} / {record?.workspace_path || taskId}</span>
        <span className="block truncate text-xs text-muted-foreground">创建 {createdAt} / 最新 {latestAt}</span>
      </span>
    </button>
  );
}

function SessionWorkspace({
  agentLabel,
  currentRecord,
  effectiveWorkspacePath,
  eventsRef,
  expandedToolResults,
  prompt,
  selectedDevice,
  timelineItems,
  onDispatch,
  onNewSession,
  onScroll,
  onPromptChange,
  onRaw,
  onToggleToolResult
}: {
  agentLabel: string;
  currentRecord: TaskRecord | undefined;
  effectiveWorkspacePath: string;
  eventsRef: React.RefObject<HTMLDivElement | null>;
  expandedToolResults: Set<string>;
  prompt: string;
  selectedDevice: Device | undefined;
  timelineItems: TimedTimelineItem[];
  onDispatch: () => void;
  onNewSession: () => void;
  onScroll: () => void;
  onPromptChange: (value: string) => void;
  onRaw: (event: TaskEvent) => void;
  onToggleToolResult: (id: string) => void;
}) {
  const canSend = Boolean(prompt.trim() && selectedDevice && effectiveWorkspacePath);
  return (
    <section className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
      <div className="min-h-0 overflow-auto px-6 py-5 max-sm:px-4" ref={eventsRef} onScroll={onScroll}>
        <div className="mx-auto max-w-5xl">
          {timelineItems.length === 0 ? (
            <EmptySessionState
              agentLabel={agentLabel}
              effectiveWorkspacePath={effectiveWorkspacePath}
              selectedDevice={selectedDevice}
              onNewSession={onNewSession}
            />
          ) : timelineItems.map((item, index) => (
            item.kind === "tool"
              ? (
                <ToolBlock
                  key={item.uiKey}
                  item={item}
                  resultExpanded={expandedToolResults.has(item.uiKey)}
                  onToggleResult={() => onToggleToolResult(item.uiKey)}
                  onRaw={onRaw}
                />
              )
              : <MessageBlock key={`${item.event.event_id || index}`} event={item.event} elapsedSeconds={item.elapsedSeconds} onRaw={onRaw} />
          ))}
        </div>
      </div>
      <Composer
        canSend={canSend}
        prompt={prompt}
        onDispatch={onDispatch}
        onPromptChange={onPromptChange}
      />
    </section>
  );
}

function EmptySessionState({
  agentLabel,
  effectiveWorkspacePath,
  selectedDevice,
  onNewSession
}: {
  agentLabel: string;
  effectiveWorkspacePath: string;
  selectedDevice: Device | undefined;
  onNewSession: () => void;
}) {
  return (
    <div className="grid min-h-96 place-items-center text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        <div className="grid size-12 place-items-center rounded-lg border bg-card">
          <Bot />
        </div>
        <div>
          <h2 className="text-lg font-semibold">准备发送第一条任务</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {selectedDevice && effectiveWorkspacePath
              ? `${agentLabel} 将在 ${effectiveWorkspacePath} 中执行。`
              : "先创建会话，选择客户机、已安装 Agent 和项目工作目录。"}
          </p>
        </div>
        {!selectedDevice || !effectiveWorkspacePath ? <Button onClick={onNewSession}><Plus />新建会话</Button> : null}
      </div>
    </div>
  );
}

function Composer({
  canSend,
  prompt,
  onDispatch,
  onPromptChange
}: {
  canSend: boolean;
  prompt: string;
  onDispatch: () => void;
  onPromptChange: (value: string) => void;
}) {
  return (
    <div className="border-t bg-background p-4">
      <div className="mx-auto max-w-5xl rounded-lg border bg-card shadow-sm">
        <Textarea
          className="min-h-24 resize-y border-0 shadow-none focus-visible:ring-0"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") onDispatch();
          }}
          placeholder="描述要让 Agent 完成的开发任务，Ctrl+Enter 发送"
        />
        <div className="flex items-center justify-end gap-3 border-t px-3 py-2">
          <Button disabled={!canSend} onClick={onDispatch}><Send />发送</Button>
        </div>
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
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <Code2 className="size-4" />
          <span className="truncate">{agentDisplayName(selectedAgent)} / {selectedPath || "填写项目工作目录"}</span>
        </div>
        <Button disabled={!device || !selectedPath || !selectedAgent || selectedAgent === "none"} onClick={onCreate}><Plus />创建会话</Button>
      </div>
    </DialogContent>
  );
}

function MessageBlock({ event, elapsedSeconds, onRaw }: { event: TaskEvent; elapsedSeconds?: number; onRaw: (event: TaskEvent) => void }) {
  const view = describeEvent(event);
  return (
    <Card className={cn("mx-auto mb-2 max-w-5xl", messageTone(event.event_type) === "error" && "border-destructive/30 bg-destructive/5", messageTone(event.event_type) === "thinking" && "bg-muted/50")}>
      <CardContent className="p-3">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="outline">{view.title}</Badge>
            <span className="truncate text-xs text-muted-foreground">{formatEventTime(event)} · {formatElapsed(elapsedSeconds)}</span>
          </div>
          <Button className="shrink-0" variant="ghost" size="sm" onClick={() => onRaw(event)}>Raw</Button>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{view.summary}</p>
        {view.meta && view.meta.length > 0 && <MetaRows rows={view.meta} />}
      </CardContent>
    </Card>
  );
}

function messageTone(type: string) {
  if (type === "user.prompt") return "user";
  if (type === "assistant.thinking") return "thinking";
  if (type === "task.failed" || type === "task.killed" || type === "server.error") return "error";
  return "assistant";
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
  const callPayload = normalizePayload(item.event.raw);
  const toolUse = item.call || extractToolUse(callPayload);
  const resultPayload = item.result ? normalizePayload(item.result.raw) : {};
  const resultMeta = (resultPayload.tool_use_result || {}) as Record<string, unknown>;
  const name = toolUse.name || toolUse.title || toolUse.kind || "tool";
  const input = toolUse.input || toolUse.rawInput || {};
  const output = item.result ? describeToolOutput(normalizePayload(item.result.data), resultPayload) : null;
  const hasError = Boolean(resultMeta.is_error || resultMeta.stderr);
  return (
    <Card className="mx-auto mb-2 max-w-5xl">
      <CardHeader className="flex-row items-center justify-between gap-3 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 text-muted-foreground" />
          <CardTitle className="truncate text-sm">{toolTitle(name, input)}</CardTitle>
          <span className="shrink-0 text-xs text-muted-foreground">{formatEventTime(item.event)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={item.result ? (hasError ? "destructive" : "success") : "warning"}>{item.result ? (hasError ? "失败" : "完成") : "执行中"}</Badge>
          {output && <Button variant="ghost" size="sm" onClick={onToggleResult}>{resultExpanded ? "隐藏结果" : "展开结果"}</Button>}
          <Button variant="ghost" size="sm" onClick={() => onRaw(item.result || item.event)}>Raw</Button>
        </div>
      </CardHeader>
      <CardContent className="p-3">
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">工具输入</div>
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{toolUseSummary(name, input)}</p>
        <MetaRows rows={[["工具", name], toolTarget(name, input) ? ["目标", toolTarget(name, input)] : null].filter(Boolean) as [string, string][]} />
      </CardContent>
      {output && resultExpanded && (
        <CardContent className="border-t bg-muted/40 p-3">
          <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">工具结果</div>
          <pre className="max-h-80 overflow-auto rounded-md border bg-background p-3 text-xs leading-6">{output.summary}</pre>
        </CardContent>
      )}
    </Card>
  );
}

function MetaRows({ rows }: { rows: [string, string][] }) {
  return <div className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">{rows.map(([key, value]) => <React.Fragment key={key}><span>{key}</span><code className="truncate font-mono text-foreground">{value}</code></React.Fragment>)}</div>;
}

function RawDialog({ event, onClose }: { event: TaskEvent; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4" onClick={onClose}>
      <div className="grid max-h-[86vh] w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)] rounded-lg border bg-background shadow-lg" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold">原始事件</h2>
          <Button variant="ghost" size="icon" onClick={onClose}><X /></Button>
        </div>
        <pre className="overflow-auto bg-muted/40 p-4 text-xs leading-6">{JSON.stringify(event.raw || event.data || event, null, 2)}</pre>
      </div>
    </div>
  );
}

function buildTimelineItems(sourceEvents: TaskEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolItems = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  for (const event of sourceEvents) {
    if (!isMainEvent(event)) continue;
    const payload = normalizePayload(event.raw);
    if (event.event_type === "tool.call") {
      const toolUse = extractToolUse(payload);
      const id = toolUse.id || toolUse.tool_use_id || event.event_id || `tool-${items.length}`;
      const item: Extract<TimelineItem, { kind: "tool" }> = { kind: "tool", id, uiKey: toolUIKey(event, id, items.length), event, call: toolUse, result: null };
      toolItems.set(id, item);
      items.push(item);
      continue;
    }
    if (event.event_type === "tool.output" || isToolResultPayload(payload)) {
      const resultID = extractToolResultID(payload);
      const existing = resultID ? toolItems.get(resultID) : undefined;
      if (existing) {
        existing.result = event;
        continue;
      }
      const id = resultID || event.event_id || `tool-result-${items.length}`;
      items.push({ kind: "tool", id, uiKey: toolUIKey(event, id, items.length), event, call: null, result: event });
      continue;
    }
    items.push({ kind: "event", event });
  }
  return items;
}

function attachTimelineTiming(items: TimelineItem[]): TimedTimelineItem[] {
  let previousTime = 0;
  return items.map((item) => {
    const currentTime = eventTimeSeconds(item.kind === "tool" && item.result ? item.result : item.event);
    const elapsedSeconds = previousTime && currentTime ? Math.max(0, currentTime - previousTime) : undefined;
    if (currentTime) previousTime = currentTime;
    return { ...item, elapsedSeconds };
  });
}

function toolUIKey(event: TaskEvent, id: string | undefined, index: number) {
  return `${event.task_id || "task"}:${event.event_id || id || "tool"}:${index}`;
}

function isMainEvent(event: TaskEvent) {
  const type = event.event_type || "";
  if (type === "user.prompt") return true;
  if (type === "assistant.message") return hasVisibleText(event);
  if (type === "assistant.thinking") return hasVisibleText(event);
  if (type === "tool.call" || type === "tool.output") return true;
  if (type === "task.failed" || type === "task.killed" || type === "server.error") return true;
  if (type === "claude.raw") {
    const payload = normalizePayload(event.raw);
    const rawType = String(payload.type || payload.subtype || "");
    if (isToolResultPayload(payload)) return true;
    if (rawType === "system" || rawType === "result" || rawType === "user") return false;
    return hasVisibleText(event);
  }
  if (type === "acpx.raw" || type === "acpx.session" || type === "metric.updated") return false;
  return false;
}

function hasVisibleText(event: TaskEvent) {
  const data = normalizePayload(event.data);
  const raw = normalizePayload(event.raw);
  return Boolean(extractText(data) || extractText(raw) || data.text || data.command || raw.command);
}

function describeEvent(event: TaskEvent) {
  const data = normalizePayload(event.data);
  const raw = normalizePayload(event.raw);
  const payload = Object.keys(raw).length ? raw : data;
  const type = event.event_type || "";
  if (isToolResultPayload(payload)) return describeToolOutput(data, payload);
  if (type === "user.prompt") return { title: "用户指令", summary: String(data.prompt || ""), meta: [] as [string, string][] };
  if (type === "assistant.message") return { title: "Agent 回复", summary: extractText(data) || extractText(raw) || "Agent 返回了一条消息。", meta: [] as [string, string][] };
  if (type === "assistant.thinking") return { title: "Agent 思考", summary: extractText(data) || extractText(raw) || "Agent 正在思考。", meta: [] as [string, string][] };
  if (type === "acpx.session") return { title: "会话", summary: "已确保当前工作区会话可复用。", meta: sessionMeta(payload) };
  if (type === "acpx.raw") return { title: "系统事件", summary: describeACPXRaw(payload), meta: [] as [string, string][] };
  if (type === "metric.updated") return { title: "运行指标", summary: describeMetric(payload), meta: [] as [string, string][] };
  if (type === "claude.raw" && payload.type === "user") return { title: "上下文注入", summary: "Agent 向模型注入了上下文内容。", meta: [] as [string, string][] };
  if (type === "claude.raw" && payload.type === "system") return { title: "系统事件", summary: "Agent 会话元数据更新。", meta: [] as [string, string][] };
  if (type === "claude.raw" && payload.type === "result") return { title: "执行结果", summary: "Agent 返回最终执行结果。", meta: [] as [string, string][] };
  if (type === "task.failed") return { title: "任务失败", summary: String(data.message || data.error || "任务执行失败。"), meta: [] as [string, string][] };
  if (type === "server.error") return { title: "服务端错误", summary: String(data.message || "服务端返回错误。"), meta: [] as [string, string][] };
  return { title: type || "事件", summary: extractText(payload) || "收到一条事件。", meta: [] as [string, string][] };
}

function describeToolOutput(data: Record<string, unknown>, payload: Record<string, unknown>) {
  const result = (payload.tool_use_result || {}) as Record<string, unknown>;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const text = String(data.text || stdout || stderr || extractToolResultContent(payload) || extractText(payload) || "");
  return { title: result.is_error ? "工具错误输出" : "工具返回", summary: text || "工具返回了输出。", meta: [] as [string, string][] };
}

function extractToolUse(payload: Record<string, unknown>): ToolUse {
  if ((payload.name || payload.title || payload.kind) && (payload.input || payload.rawInput)) return payload as ToolUse;
  const content = (payload.content || (payload.message as Record<string, unknown> | undefined)?.content) as unknown;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && (((item as Record<string, unknown>).type === "tool_use") || (item as Record<string, unknown>).name || (item as Record<string, unknown>).title)) return item as ToolUse;
    }
  }
  return {};
}

function isToolResultPayload(payload: Record<string, unknown>) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.tool_use_result) return true;
  const content = (payload.message as Record<string, unknown> | undefined)?.content;
  return Array.isArray(content) && content.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result");
}

function extractToolResultID(payload: Record<string, unknown>) {
  const content = (payload.message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(content)) {
    const result = content.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result" && (item as Record<string, unknown>).tool_use_id) as Record<string, unknown> | undefined;
    if (result) return String(result.tool_use_id);
  }
  return String(payload.tool_use_id || payload.parent_tool_use_id || payload.toolCallId || payload.tool_call_id || "");
}

function extractToolResultContent(payload: Record<string, unknown>) {
  const content = (payload.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result")
    .map((item) => String((item as Record<string, unknown>).content || ""))
    .filter(Boolean)
    .join("\n");
}

function sessionMeta(payload: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  for (const key of ["agent", "session_name", "acpxRecordId", "acpxSessionId", "agentSessionId", "name"]) {
    if (typeof payload[key] === "string" && payload[key]) rows.push([key, String(payload[key])]);
  }
  return rows;
}

function describeACPXRaw(payload: Record<string, unknown>) {
  const params = payload.params as Record<string, unknown> | undefined;
  const update = params?.update as Record<string, unknown> | undefined;
  const updateType = String(update?.sessionUpdate || "");
  if (updateType === "agent_thought_chunk") return "Agent 正在思考。";
  if (updateType === "available_commands_update") return "Agent 可用命令列表已更新。";
  if (updateType) return `收到 ${updateType}。`;
  return "收到一条协议事件。";
}

function describeMetric(payload: Record<string, unknown>) {
  const params = payload.params as Record<string, unknown> | undefined;
  const update = params?.update as Record<string, unknown> | undefined;
  if (update?.cost && typeof update.cost === "object") {
    const cost = update.cost as Record<string, unknown>;
    return `Token ${String(update.used || "-")} / ${String(update.size || "-")}，费用 ${String(cost.amount || "-")} ${String(cost.currency || "")}`;
  }
  if (update?.used || update?.size) return `Token ${String(update.used || "-")} / ${String(update.size || "-")}`;
  const result = payload.result as Record<string, unknown> | undefined;
  if (result?.stopReason) return `停止原因：${String(result.stopReason)}`;
  return "运行指标已更新。";
}

function toolTitle(name: string, input: Record<string, unknown>) {
  const lower = String(name || "").toLowerCase();
  if (isSkillRead(name, input)) return `阅读 Skill：${skillNameFromInput(input)}`;
  if (isSkillTool(name, input)) return `调用 Skill：${skillNameFromInput(input)}`;
  if (lower.includes("bash")) return "执行命令";
  if (lower.includes("read")) return "读取文件";
  if (lower.includes("edit") || lower.includes("write")) return "修改文件";
  if (lower.includes("grep")) return "搜索文本";
  if (lower.includes("glob")) return "查找文件";
  if (lower.includes("todo")) return "更新任务清单";
  return `调用工具：${name}`;
}

function toolTarget(name: string, input: Record<string, unknown>) {
  return String(input.file_path || input.path || input.pattern || input.query || input.command || input.cmd || "");
}

function toolUseSummary(name: string, input: Record<string, unknown>) {
  return String(input.command || input.cmd || input.query || input.pattern || input.file_path || input.path || JSON.stringify(input, null, 2));
}

function isSkillRead(name: string, input: Record<string, unknown>) {
  const target = toolTarget(name, input).toLowerCase();
  return name.toLowerCase().includes("read") && target.endsWith("skill.md");
}

function isSkillTool(name: string, input: Record<string, unknown>) {
  const target = toolTarget(name, input).toLowerCase();
  return name.toLowerCase().includes("skill") || target.includes("/skills/") || target.includes(".agents/skills") || target.includes(".codex/skills");
}

function skillNameFromInput(input: Record<string, unknown>) {
  const target = toolTarget("", input);
  const parts = target.split("/").filter(Boolean);
  const idx = parts.findIndex((part) => part === "skills");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  if (target.endsWith("SKILL.md") && parts.length >= 2) return parts[parts.length - 2];
  return "Skill";
}

function extractText(value: Record<string, unknown> | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.text === "string") return value.text;
  if (typeof value.message === "string") return value.message;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const part = item as Record<string, unknown>;
      if (part.type === "tool_result" || part.type === "tool_use") return "";
      return String(part.text || part.content || "");
    }).filter(Boolean).join("\n");
  }
  if (value.message && typeof value.message === "object") return extractText(value.message as Record<string, unknown>);
  if (typeof value.result === "string") return value.result;
  return "";
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return { text: value }; }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return { text: String(value) };
}

function withEventTimestamp(event: TaskEvent, envelopeTimestamp?: number): TaskEvent {
  return {
    ...event,
    timestamp: event.timestamp || envelopeTimestamp || Math.floor(Date.now() / 1000),
    received_at: Math.floor(Date.now() / 1000)
  };
}

function eventTimeSeconds(event: TaskEvent | undefined) {
  return Number(event?.timestamp || event?.received_at || 0);
}

function formatEventTime(event: TaskEvent) {
  const value = eventTimeSeconds(event);
  if (!value) return "--:--:--";
  return new Date(value * 1000).toLocaleTimeString("zh-CN", { hour12: false });
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

function formatElapsed(seconds: number | undefined) {
  if (seconds === undefined) return "耗时 --";
  if (seconds < 1) return "耗时 <1s";
  if (seconds < 60) return `耗时 ${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `耗时 ${minutes}m ${rest}s`;
}

function extractSessionIDFromEvent(event: TaskEvent) {
  for (const value of [normalizePayload(event.raw), normalizePayload(event.data)]) {
    if (typeof value.session_id === "string" && value.session_id) return value.session_id;
    for (const key of ["sessionId", "acpxRecordId", "acpxSessionId", "agentSessionId"]) {
      if (typeof value[key] === "string" && value[key]) return String(value[key]);
    }
    const message = value.message as Record<string, unknown> | undefined;
    if (message && typeof message.session_id === "string") return message.session_id;
  }
  return "";
}

function statusFromEvent(type: string) {
  if (type === "session.created" || type === "acpx.session") return "created";
  if (type === "task.completed") return "completed";
  if (type === "task.failed") return "failed";
  if (type === "task.killed") return "killed";
  if (type === "task.stopping") return "stopping";
  return "running";
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
  return workspaceNameFromPath(record?.workspace_path || "") || record?.session_name || fallback || "未命名会话";
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

function workspaceForPath(path: string, selected?: Workspace): Workspace {
  const cleanPath = path.trim();
  if (selected?.path === cleanPath) return selected;
  return {
    id: workspaceIDFromPath(cleanPath),
    name: workspaceNameFromPath(cleanPath),
    path: cleanPath
  };
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
