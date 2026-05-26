import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  Code2,
  Cpu,
  Folder,
  Menu,
  Monitor,
  Send,
  Square,
  Terminal,
  X
} from "lucide-react";
import "./styles.css";

type Workspace = {
  id: string;
  name: string;
  path: string;
};

type Device = {
  id: string;
  name: string;
  status: string;
  agent?: string;
  agent_label?: string;
  workspaces: Workspace[];
};

type TaskEvent = {
  task_id: string;
  event_id?: string;
  event_type: string;
  source?: string;
  sequence?: number;
  data?: unknown;
  raw?: unknown;
};

type TaskRecord = {
  task_id: string;
  workspace_id?: string;
  workspace_path?: string;
  prompt?: string;
  status?: string;
  session_id?: string;
  updated_at?: number;
  events?: TaskEvent[];
};

type TimelineItem =
  | { kind: "event"; event: TaskEvent }
  | { kind: "tool"; id?: string; uiKey: string; event: TaskEvent; call: ToolUse | null; result: TaskEvent | null };

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

function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [tasks, setTasks] = useState<string[]>([]);
  const [taskRecords, setTaskRecords] = useState<Map<string, TaskRecord>>(new Map());
  const [currentTaskId, setCurrentTaskId] = useState("");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [status, setStatus] = useState("idle");
  const [prompt, setPrompt] = useState("");
  const [autoShell, setAutoShell] = useState(true);
  const [conn, setConn] = useState("Connecting...");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [rawEvent, setRawEvent] = useState<TaskEvent | null>(null);
  const [expandedToolResults, setExpandedToolResults] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const eventsRef = useRef<HTMLDivElement | null>(null);

  const selectedDevice = devices.find((device) => device.id === selectedDeviceId);
  const selectedWorkspace = selectedDevice?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const agentLabel = selectedDevice?.agent_label || agentDisplayName(selectedDevice?.agent || "claude");
  const currentRecord = currentTaskId ? taskRecords.get(currentTaskId) : undefined;
  const timelineItems = useMemo(() => buildTimelineItems(events), [events]);

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
          return;
        }
        if (env.type === "task.event") {
          const payload = env.payload as TaskEvent;
          if (!payload?.task_id) return;
          setCurrentTaskId((current) => current || payload.task_id);
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
    setEvents(record.events ? [...record.events] : []);
    setStatus(record.status || "running");
    setExpandedToolResults(new Set());
  }, [currentTaskId, taskRecords]);

  useEffect(() => {
    const node = eventsRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [timelineItems.length]);

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
    if (!text || !selectedDevice || !selectedWorkspace || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const resumeSessionId = currentRecord?.session_id || "";
    const taskId = resumeSessionId && currentTaskId ? currentTaskId : `tsk_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const userEvent: TaskEvent = { task_id: taskId, event_type: "user.prompt", source: "web", data: { prompt: text } };

    setCurrentTaskId(taskId);
    setStatus("running");
    setPrompt("");
    setTasks((current) => current.includes(taskId) ? current : [taskId, ...current]);
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(taskId) || { task_id: taskId, events: [] };
      record.workspace_id = selectedWorkspace.id;
      record.workspace_path = selectedWorkspace.path;
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
        workspace_id: selectedWorkspace.id,
        workspace_path: selectedWorkspace.path,
        agent: selectedDevice.agent || "claude_code",
        prompt: text,
        parent_task_id: resumeSessionId ? currentTaskId : "",
        resume_session_id: resumeSessionId,
        options: {
          auto_shell: autoShell,
          allowed_tools: ["file", "bash"],
          timeout_seconds: 3600
        }
      }
    }));
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

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brandMark">AB</div>
          <div>
            <div className="brandTitle">AgentBridge</div>
            <div className="brandSubtitle">{conn}</div>
          </div>
        </div>
        <div className="navScroll">
          <NavSection title="概览">
            <button className="navItem"><Monitor size={16} /> 工作台</button>
            <button className="navItem"><Activity size={16} /> 会话</button>
          </NavSection>
          <NavSection title="设备">
            {devices.map((device) => (
              <button
                key={device.id}
                className={`resourceItem ${device.id === selectedDeviceId ? "active" : ""}`}
                onClick={() => {
                  setSelectedDeviceId(device.id);
                  setSelectedWorkspaceId(device.workspaces[0]?.id || "");
                  setSidebarOpen(false);
                }}
              >
                <Monitor size={16} />
                <span><strong>{device.name || device.id}</strong><small>{device.id}</small></span>
              </button>
            ))}
          </NavSection>
          <NavSection title="工作区">
            {(selectedDevice?.workspaces || []).map((workspace) => (
              <button
                key={workspace.id}
                className={`resourceItem ${workspace.id === selectedWorkspaceId ? "active" : ""}`}
                onClick={() => {
                  setSelectedWorkspaceId(workspace.id);
                  setSidebarOpen(false);
                }}
              >
                <Folder size={16} />
                <span><strong>{workspace.name}</strong><small>{workspace.path}</small></span>
              </button>
            ))}
          </NavSection>
          <NavSection title="当前会话任务">
            {tasks.length === 0 && <p className="muted">暂无任务</p>}
            {tasks.map((taskId) => {
              const record = taskRecords.get(taskId);
              return (
                <button
                  key={taskId}
                  className={`resourceItem ${taskId === currentTaskId ? "active" : ""}`}
                  onClick={() => {
                    setCurrentTaskId(taskId);
                    setSidebarOpen(false);
                  }}
                >
                  <Cpu size={16} />
                  <span><strong>{record?.prompt || taskId}</strong><small>{record?.status || "running"} · {taskId}</small></span>
                </button>
              );
            })}
          </NavSection>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="mobileActions">
              <button className="ghost" onClick={() => setSidebarOpen(true)}><Menu size={16} />菜单</button>
              <button className="ghost" onClick={() => setInspectorOpen(true)}>详情</button>
            </div>
            <h1>{selectedDevice?.name || "选择设备和工作区"}</h1>
            <p>{selectedWorkspace?.path || agentLabel}</p>
          </div>
          <div className="topActions">
            <span className="pill">Session <strong>{currentRecord?.session_id ? shortID(currentRecord.session_id) : "new"}</strong></span>
            <button className="ghost" disabled={!currentTaskId} onClick={stopTask}><Square size={15} />停止</button>
          </div>
        </header>

        <section className="taskStrip">
          <span>Engine <strong>{agentLabel}</strong></span>
          <span>Mode <strong>Remote session</strong></span>
          <span>Shell <strong>{autoShell ? "auto" : "manual"}</strong></span>
        </section>

        <section className="events" ref={eventsRef}>
          {timelineItems.length === 0 ? (
            <div className="emptyState">
              <Bot size={32} />
              <h2>等待任务</h2>
              <p>选择设备和工作区后发送指令</p>
            </div>
          ) : timelineItems.map((item, index) => (
            item.kind === "tool"
              ? (
                <ToolBlock
                  key={item.uiKey}
                  item={item}
                  resultExpanded={expandedToolResults.has(item.uiKey)}
                  onToggleResult={() => {
                    const id = item.uiKey;
                    setExpandedToolResults((current) => {
                      const next = new Set(current);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  }}
                  onRaw={setRawEvent}
                />
              )
              : <MessageBlock key={`${item.event.event_id || index}`} event={item.event} onRaw={setRawEvent} />
          ))}
        </section>

        <section className="composer">
          <div className="composerShell">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") dispatchTask();
              }}
              placeholder="Ctrl+Enter 发送任务给 Agent"
            />
            <div className="controls">
              <label><input type="checkbox" checked={autoShell} onChange={(event) => setAutoShell(event.target.checked)} /> 允许自动 Shell</label>
              <button className="primary" onClick={dispatchTask}><Send size={16} />{currentRecord?.session_id ? "继续对话" : "发送"}</button>
            </div>
          </div>
        </section>
      </main>

      <aside className={`inspector ${inspectorOpen ? "open" : ""}`}>
        <div className="section">
          <div className="inspectorHeader">
            <h2>当前任务</h2>
            <button className="iconButton" onClick={() => setInspectorOpen(false)}><X size={16} /></button>
          </div>
          <Metric label="Task" value={currentTaskId || "-"} />
          <Metric label="Status" value={status} />
          <Metric label="Events" value={String(events.length)} />
        </div>
        <div className="section">
          <button className="danger" disabled={!currentTaskId} onClick={stopTask}>Stop Task</button>
        </div>
        <div className="activityList">
          <h2>执行流</h2>
          {events.slice().reverse().map((event, index) => (
            <button
              key={`${event.event_id || index}`}
              className={!isMainEvent(event) ? "hiddenEvent" : ""}
              title="查看原始事件"
              onClick={() => setRawEvent(event)}
            >
              <span>{describeEvent(event).title} {event.sequence ? `#${event.sequence}` : ""}</span>
              <code>Raw</code>
            </button>
          ))}
        </div>
      </aside>

      {rawEvent && <RawDialog event={rawEvent} onClose={() => setRawEvent(null)} />}
    </div>
  );
}

function NavSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="navSection"><h2>{title}</h2>{children}</section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><code>{value}</code></div>;
}

function MessageBlock({ event, onRaw }: { event: TaskEvent; onRaw: (event: TaskEvent) => void }) {
  const view = describeEvent(event);
  return (
    <article className={`message ${messageTone(event.event_type)}`}>
      <header className="messageHeader">
        <strong>{view.title}</strong>
        <button className="rawButton" onClick={() => onRaw(event)}>Raw</button>
      </header>
      <div className="messageBody">
        <p>{view.summary}</p>
        {view.meta && view.meta.length > 0 && <MetaRows rows={view.meta} />}
      </div>
    </article>
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
    <article className="toolBlock">
      <header>
        <div><Terminal size={16} /><strong>{toolTitle(name, input)}</strong></div>
        <div className="toolActions">
          <span className={`toolStatus ${item.result ? (hasError ? "error" : "done") : ""}`}>{item.result ? (hasError ? "执行失败" : "执行完成") : "执行中"}</span>
          {output && <button className="rawButton" onClick={onToggleResult}>{resultExpanded ? "隐藏结果" : "展开结果"}</button>}
          <button className="rawButton" onClick={() => onRaw(item.result || item.event)}>Raw</button>
        </div>
      </header>
      <section>
        <h3>执行工具内容</h3>
        <p>{toolUseSummary(name, input)}</p>
        <MetaRows rows={[["工具", name], toolTarget(name, input) ? ["目标", toolTarget(name, input)] : null].filter(Boolean) as [string, string][]} />
      </section>
      {output && resultExpanded && (
        <section className={`toolResult ${hasError ? "error" : ""}`}>
          <h3>执行工具结果</h3>
          <pre>{output.summary}</pre>
        </section>
      )}
    </article>
  );
}

function MetaRows({ rows }: { rows: [string, string][] }) {
  return <div className="metaRows">{rows.map(([key, value]) => <React.Fragment key={key}><span>{key}</span><code>{value}</code></React.Fragment>)}</div>;
}

function RawDialog({ event, onClose }: { event: TaskEvent; onClose: () => void }) {
  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header><h2>原始事件</h2><button className="iconButton" onClick={onClose}><X size={16} /></button></header>
        <pre>{JSON.stringify(event.raw || event.data || event, null, 2)}</pre>
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
  if (type === "task.completed") return "completed";
  if (type === "task.failed") return "failed";
  if (type === "task.killed") return "killed";
  if (type === "task.stopping") return "stopping";
  return "running";
}

function isDuplicateEvent(items: TaskEvent[], event: TaskEvent) {
  if (event.event_id && items.some((item) => item.event_id === event.event_id)) return true;
  if (event.event_type !== "user.prompt") return false;
  const prompt = String(normalizePayload(event.data).prompt || "");
  return items.some((item) => item.event_type === "user.prompt" && String(normalizePayload(item.data).prompt || "") === prompt);
}

function shortID(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
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

createRoot(document.getElementById("root")!).render(<App />);
