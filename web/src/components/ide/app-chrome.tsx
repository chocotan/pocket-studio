import React, { useState } from "react";
import { Code2, Monitor, Plus, Search, Trash2, X, Settings, Home, LayoutPanelLeft, Terminal, Bot, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatEventTime } from "@/lib/agent-events";
import type { Device, SearchResult, TaskRecord } from "@/lib/types";
import {
  agentDisplayName,
  defaultWorkspacePath,
  formatRecordTime,
  sessionDisplayTitle,
  statusBadgeVariant,
  statusLabel,
  workspaceNameFromPath
} from "@/lib/session-utils";
import { cn } from "@/lib/utils";

export function ActivityBar({
  currentTaskId,
  tasks,
  taskRecords,
  view,
  onCreateSession,
  onOpenDashboard,
  onOpenSearch,
  onOpenTask
}: {
  currentTaskId: string;
  tasks: string[];
  taskRecords: Map<string, TaskRecord>;
  view: "dashboard" | "task";
  onCreateSession: () => void;
  onOpenDashboard: () => void;
  onOpenSearch: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <aside className="activity-bar">
      <div className="activity-bar-top">
        <button 
          className={cn("activity-bar-item", view === "dashboard" && "activity-bar-item-active")} 
          onClick={onOpenDashboard}
          title="工作台"
        >
          <Home className="size-5" />
        </button>
        <button 
          className="activity-bar-item" 
          onClick={onOpenSearch}
          title="搜索"
        >
          <Search className="size-5" />
        </button>
        
        <div className="activity-bar-separator" />
        
        {tasks.map((taskId) => (
          <button 
            key={taskId} 
            className={cn("activity-bar-item", currentTaskId === taskId && view === "task" && "activity-bar-item-active")} 
            onClick={() => onOpenTask(taskId)}
            title={sessionDisplayTitle(taskRecords.get(taskId), taskId)}
          >
            <LayoutPanelLeft className="size-5" />
          </button>
        ))}
        
        <button 
          className="activity-bar-item mt-2 text-primary" 
          onClick={onCreateSession}
          title="创建会话"
        >
          <Plus className="size-5" />
        </button>
      </div>

      <div className="activity-bar-bottom">
        <button className="activity-bar-item" title="设置">
          <Settings className="size-5" />
        </button>
      </div>
    </aside>
  );
}

export function StatusBar({
  agentLabel,
  conn,
  deviceName,
  eventCount,
  status,
  workspacePath
}: {
  agentLabel: string;
  conn: string;
  deviceName: string;
  eventCount: number;
  status: string;
  workspacePath: string;
}) {
  return (
    <footer className="status-bar">
      <div className="flex items-center gap-2 pr-4 border-r border-border">
        <div className={cn("size-2 rounded-full", conn === "Connected" ? "bg-green-500" : "bg-muted-foreground")} />
        <span>{conn === "Connected" ? "在线" : conn}</span>
      </div>
      <span className="font-medium text-foreground">{status || "idle"}</span>
      <span className="min-w-0 truncate ml-auto">{workspacePath || "未设置目录"}</span>
    </footer>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <code className="truncate font-mono text-xs text-foreground">{value}</code>
    </div>
  );
}

export function SearchDialog({
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
  onQueryChange: (query: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-start bg-background/70 px-4 pt-[10vh]" onClick={onClose}>
      <div className="search-panel mx-auto grid max-h-[74vh] w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)] rounded-lg border shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-3 border-b p-3">
          <Search className="size-4 text-muted-foreground" />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            placeholder="搜索会话、目录、Prompt 或执行事件"
          />
          <Button variant="ghost" size="icon" onClick={onClose}><X /></Button>
        </div>
        <div className="min-h-0 overflow-auto p-2">
          {results.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">{query.trim() ? "没有找到匹配内容" : "输入关键词开始搜索"}</div>
          ) : results.map((result) => (
            <button
              key={result.taskId}
              className="search-result grid w-full gap-1 rounded-md px-3 py-2 text-left"
              onClick={() => onOpenTask(result.taskId)}
            >
              <span className="truncate text-sm font-medium"><HighlightedText text={result.title} query={query} /></span>
              <span className="truncate text-xs text-muted-foreground">
                <HighlightedText text={result.subtitle || taskRecords.get(result.taskId)?.workspace_path || "未设置目录"} query={query} />
              </span>
              {result.preview ? <span className="line-clamp-2 text-xs text-muted-foreground"><HighlightedText text={result.preview} query={query} /></span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function HighlightedText({ text, query }: { text: string; query: string }) {
  const terms = searchHighlightTerms(query);
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "ig");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) => (
        terms.some((term) => term.toLowerCase() === part.toLowerCase())
          ? <mark className="search-highlight" key={`${part}-${index}`}>{part}</mark>
          : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
      ))}
    </>
  );
}

function searchHighlightTerms(query: string) {
  return query.trim().split(/\s+/).filter((term) => term.length >= 2).slice(0, 5);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function NavButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: React.ElementType; label: string; onClick: () => void }) {
  return (
    <Button
      className={cn("sidebar-nav-button justify-start gap-3 px-3", active && "sidebar-nav-button-active")}
      variant="ghost"
      onClick={onClick}
    >
      <Icon className="size-4" />
      <span>{label}</span>
    </Button>
  );
}

export function ConnectionBadge({ conn }: { conn: string }) {
  const connected = conn === "Connected";
  return (
    <div className="connection-card flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs">
      <span className="text-muted-foreground">连接</span>
      <span className={cn("font-medium", connected ? "text-green-600" : "text-muted-foreground")}>{connected ? "在线" : conn}</span>
    </div>
  );
}

export function SidebarSessions({
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
    <div className="min-h-0 overflow-auto px-3 py-4">
      <div className="mb-2 px-2 text-xs font-medium uppercase text-muted-foreground">最近会话</div>
      <div className="grid gap-1">
        {tasks.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">暂无会话</div>
        ) : tasks.map((taskId) => (
          <SidebarSessionItem
            active={taskId === currentTaskId}
            key={taskId}
            record={taskRecords.get(taskId)}
            taskId={taskId}
            onDelete={() => onDeleteTask(taskId)}
            onOpen={() => onOpenTask(taskId)}
          />
        ))}
      </div>
    </div>
  );
}

function SidebarSessionItem({
  active,
  taskId,
  record,
  onDelete,
  onOpen
}: {
  active: boolean;
  taskId: string;
  record: TaskRecord | undefined;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const title = sessionDisplayTitle(record, taskId);
  const subtitle = [agentDisplayName(record?.agent || ""), workspaceNameFromPath(record?.workspace_path || "")].filter(Boolean).join(" / ");
  return (
    <div className={cn("sidebar-session group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-lg", active && "sidebar-session-active")}>
      <button className="min-w-0 px-2 py-2 text-left" onClick={onOpen}>
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle || "未设置目录"}</span>
      </button>
      <Button
        className="session-delete-button mr-1 h-7 w-7 px-0"
        variant="ghost"
        size="sm"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        aria-label="删除会话"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

export function Dashboard({
  devices,
  tasks,
  taskRecords,
  selectedDeviceId,
  onSelectDevice,
  onCreateFromDevice,
  onDeleteTask,
  onOpenTask
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
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId) || devices[0];
  const deviceTasks = tasks.filter((taskId) => !selectedDevice || taskRecords.get(taskId)?.device_id === selectedDevice.id);
  return (
    <div className="dashboard-canvas min-h-0 h-full overflow-auto p-8 max-sm:p-4">
      <div className="mx-auto grid max-w-[1200px] gap-8">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">欢迎回到工作台</h2>
          <p className="text-sm text-muted-foreground">管理远程设备上的开发环境，启动由 AI 驱动的编程会话。</p>
        </div>
        
        {/* Metric Cards Row */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="dashboard-panel">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">在线设备</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{devices.length}</div>
            </CardContent>
          </Card>
          <Card className="dashboard-panel">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">进行中会话</CardTitle>
              <Terminal className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{tasks.length}</div>
            </CardContent>
          </Card>
          <Card className="dashboard-panel">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">可用 Agent 引擎</CardTitle>
              <Bot className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {devices.reduce((acc, dev) => acc + (dev.agents?.length || (dev.agent ? 1 : 0)), 0)}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid min-h-[500px] gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          <Card className="dashboard-panel flex flex-col overflow-hidden border-0 shadow-sm ring-1 ring-border/50">
            <CardHeader className="border-b bg-card px-6 py-5">
              <CardTitle className="text-lg">已连接的设备</CardTitle>
              <CardDescription>选择一台设备以查看其运行状态和会话列表</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto p-0 bg-muted/20">
              {devices.length === 0 ? (
                <div className="flex h-full items-center justify-center p-8">
                  <EmptyState title="无在线设备" description="请确保远程机器上的 Agent Daemon 正在运行并连接至平台。" />
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {devices.map((device) => (
                    <DeviceTreeRow
                      device={device}
                      key={device.id}
                      selected={device.id === selectedDevice?.id}
                      onCreate={() => onCreateFromDevice(device)}
                      onSelect={() => onSelectDevice(device)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          
          <Card className="dashboard-panel flex flex-col min-h-0 border-0 shadow-sm ring-1 ring-border/50">
            <CardHeader className="border-b bg-card px-6 py-5 flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-lg">近期会话</CardTitle>
                <CardDescription className="mt-1.5">{selectedDevice ? selectedDevice.name || selectedDevice.id : "未选择设备"}</CardDescription>
              </div>
              {selectedDevice && (
                <Button onClick={() => onCreateFromDevice(selectedDevice)} size="sm" className="shadow-sm">
                  <Plus className="mr-1 size-3.5" />
                  新建
                </Button>
              )}
            </CardHeader>
            <CardContent className="flex-1 overflow-auto p-0 bg-muted/10">
              <div className="p-4">
                {deviceTasks.length === 0 ? (
                  <EmptyState title="暂无会话" description="点击右上角新建按钮，或者在左侧设备列表中快速创建。" />
                ) : (
                  <div className="grid gap-3">
                    {deviceTasks.map((taskId) => (
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
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DeviceTreeRow({
  device,
  selected,
  onCreate,
  onSelect
}: {
  device: Device;
  selected: boolean;
  onCreate: () => void;
  onSelect: () => void;
}) {
  const agents = device.agents?.length ? device.agents.map((agent) => agent.label || agentDisplayName(agent.name)) : [agentDisplayName(device.agent || "")];
  return (
    <div className={cn("device-row group flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 transition-colors", selected ? "bg-muted/50" : "hover:bg-muted/30")}>
      <button className="grid min-w-0 flex-1 gap-3 text-left w-full" onClick={onSelect}>
        <div className="flex min-w-0 items-center gap-4">
          <div className={cn("device-icon grid size-12 place-items-center rounded-xl shadow-sm border", selected ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border")}>
            <Monitor className="size-6" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate font-semibold text-base text-foreground">{device.name || device.id}</div>
              <div className="size-2 rounded-full bg-green-500" title="Online"></div>
            </div>
            <div className="truncate text-xs text-muted-foreground mt-0.5 font-mono">{device.id}</div>
          </div>
        </div>
        
        {/* Detail Row (Agents & Workspaces) */}
        <div className="grid gap-2.5 pl-[64px]">
          <div className="flex flex-wrap gap-1.5">
            {agents.length === 0 ? <Badge variant="secondary" className="font-normal text-xs">未检测到 Agent</Badge> : agents.map((agent) => <Badge key={agent} variant="outline" className="font-normal text-xs bg-card">{agent}</Badge>)}
          </div>
          <div className="grid gap-1">
            {(device.workspaces || []).map((workspace) => (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground" key={workspace.id}>
                <Code2 className="size-3.5" />
                <span className="font-medium text-foreground">{workspace.name || workspace.id}</span>
                <span className="opacity-50">·</span>
                <span className="truncate font-mono opacity-80">{workspace.path}</span>
              </div>
            ))}
          </div>
        </div>
      </button>
      <div className="flex items-center justify-end sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <Button variant="secondary" size="sm" onClick={onCreate} className="shadow-sm">
          <Plus className="mr-1 size-3.5" />
          新建会话
        </Button>
      </div>
    </div>
  );
}

function SessionDeviceItem({ taskId, record, onDelete, onOpen }: { taskId: string; record: TaskRecord | undefined; onDelete: () => void; onOpen: () => void }) {
  return (
    <div className="session-device-item group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-sm transition-all hover:shadow-md hover:border-border/80">
      <button className="min-w-0 text-left flex flex-col gap-1.5" onClick={onOpen}>
        <div className="flex items-center gap-2">
          <span className="block truncate text-sm font-semibold text-foreground">{sessionDisplayTitle(record, taskId)}</span>
          <Badge variant={statusBadgeVariant(record?.status)} className="h-5 text-[10px] uppercase font-bold tracking-wider">{statusLabel(record?.status)}</Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Bot className="size-3" /> {agentDisplayName(record?.agent || "")}</span>
          <span className="opacity-40">•</span>
          <span className="truncate flex-1 font-mono">{record?.workspace_path || taskId}</span>
        </div>
        <span className="block text-[11px] text-muted-foreground/70">{formatRecordTime(record?.updated_at || record?.started_at)}</span>
      </button>
      <div className="flex flex-col items-end gap-2">
        <Button
          className="session-delete-button size-8 rounded-full opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          variant="ghost"
          size="icon"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          aria-label="删除会话"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 p-10 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground mb-4">
        <Monitor className="size-6 opacity-50" />
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground max-w-[200px] leading-relaxed">{description}</p>
    </div>
  );
}

export function NewSessionDialog({
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

export function RawDialog({ event, onClose }: { event: import("@/lib/agent-events").TaskEvent; onClose: () => void }) {
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
