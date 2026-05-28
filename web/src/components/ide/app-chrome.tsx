import React, { useState } from "react";
import { Code2, Monitor, Plus, Search, Trash2, X, Settings, Home, LayoutPanelLeft, Terminal, Bot, Server, Folder, ArrowRight, Sparkles, HardDrive } from "lucide-react";
import { ProviderIcon } from "@lobehub/icons";

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

// --- Map agent name to provider key for Lobe Icons ---
export function getProviderKey(agentName: string): string {
  const name = (agentName || "").toLowerCase().trim();
  if (name.includes("claude") || name === "claude_code" || name === "claude-code") return "anthropic";
  if (name.includes("gemini")) return "google";
  if (name.includes("copilot") || name === "github-copilot") return "github";
  if (name.includes("deepseek")) return "deepseek";
  if (name.includes("openai") || name.includes("gpt")) return "openai";
  if (name.includes("qwen")) return "qwen";
  return "openai";
}

// --- Beautiful custom AgentIcon with Lobe Icons ---
export function AgentIcon({
  agentName,
  className = "size-5",
  active = false
}: {
  agentName: string;
  className?: string;
  active?: boolean;
}) {
  const provider = getProviderKey(agentName);
  return (
    <div 
      className={cn(
        "relative flex items-center justify-center rounded-lg border border-slate-100 bg-white p-1 shadow-sm transition-all duration-300", 
        active && "border-blue-200 bg-blue-50/50 shadow-md ring-2 ring-blue-500/20 scale-105", 
        className
      )}
    >
      <ProviderIcon provider={provider} size={18} type="color" />
    </div>
  );
}

// --- Deterministic hash-based gradient for project initials ---
export function getProjectGradient(name: string) {
  let hash = 0;
  const projectName = name || "Project";
  for (let i = 0; i < projectName.length; i++) {
    hash = projectName.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // Choose beautiful low-saturation hues (slate, violet, steel blue, sage, charcoal, teal)
  const hues = [200, 215, 230, 260, 280, 160, 185];
  const hue = hues[Math.abs(hash) % hues.length];
  
  const colorA = `hsl(${hue}, 38%, 42%)`;
  const colorB = `hsl(${hue}, 48%, 28%)`;
  
  return {
    background: `linear-gradient(135deg, ${colorA} 0%, ${colorB} 100%)`
  };
}

export function ActivityBar({
  currentProjectKey,
  projects,
  view,
  onSelectProject,
  onOpenDashboard,
  onOpenSearch
}: {
  currentProjectKey: string;
  projects: Array<{
    key: string;
    deviceId: string;
    workspacePath: string;
    workspaceName: string;
    activeAgent?: string;
  }>;
  view: "dashboard" | "task";
  onSelectProject: (deviceId: string, path: string) => void;
  onOpenDashboard: () => void;
  onOpenSearch: () => void;
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
          title="全局搜索"
        >
          <Search className="size-5" />
        </button>
        
        <div className="activity-bar-separator" />
        
        {projects.map((project) => {
          const isActive = view === "task" && currentProjectKey === project.key;
          const letter = project.workspaceName.trim().charAt(0).toUpperCase() || "P";
          const gradientStyle = getProjectGradient(project.workspaceName);
          
          return (
            <button 
              key={project.key} 
              className={cn(
                "activity-bar-item activity-bar-project-item flex items-center justify-center", 
                isActive && "activity-bar-item-active"
              )} 
              onClick={() => onSelectProject(project.deviceId, project.workspacePath)}
              title={`项目: ${project.workspaceName}\n设备: ${project.deviceId}\n物理路径: ${project.workspacePath}`}
            >
              <div 
                className="project-letter-badge" 
                style={gradientStyle}
              >
                {letter}
              </div>
            </button>
          );
        })}
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
      {agentLabel ? (
        <div className="flex items-center gap-1.5 border-r border-border pr-4">
          <Bot className="size-3.5" />
          <span>{agentLabel}</span>
        </div>
      ) : null}
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

// --- Redesigned Project-Centric Dashboard ---
export function Dashboard({
  devices,
  tasks,
  taskRecords,
  projects,
  onSelectProject,
  onAddProject
}: {
  devices: Device[];
  tasks: string[];
  taskRecords: Map<string, TaskRecord>;
  projects: Array<{
    key: string;
    deviceId: string;
    deviceName: string;
    workspacePath: string;
    workspaceName: string;
    activeAgent?: string;
    sessionCount: number;
  }>;
  onSelectProject: (deviceId: string, path: string) => void;
  onAddProject: (deviceId: string, path: string) => void;
}) {
  const [targetDeviceId, setTargetDeviceId] = useState(devices[0]?.id || "");
  const [customPath, setCustomPath] = useState("");
  
  React.useEffect(() => {
    if (devices.length > 0 && !targetDeviceId) {
      setTargetDeviceId(devices[0].id);
    }
  }, [devices]);

  const activeDevice = devices.find(d => d.id === targetDeviceId) || devices[0];

  const handleCreateProject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetDeviceId || !customPath.trim()) return;
    onAddProject(targetDeviceId, customPath.trim());
    setCustomPath("");
  };

  return (
    <div className="dashboard-canvas min-h-0 h-full overflow-auto p-8 max-sm:p-4 bg-slate-50/50">
      <div className="mx-auto grid max-w-[1200px] gap-8">
        
        {/* Welcome Section */}
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">欢迎来到 PocketStudio</h2>
          <p className="text-sm text-slate-500 max-w-[600px] leading-relaxed">
            管理您远程机器上的代码项目，在此直接加载工作区的文件与终端，并自由拉起多个 AI Agent 实例进行高效协作。
          </p>
        </div>
        
        {/* Stats Row */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="dashboard-panel border shadow-sm rounded-xl">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-semibold text-slate-400 uppercase tracking-wider">活跃项目</CardTitle>
              <Folder className="h-4 w-4 text-slate-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-extrabold text-slate-800">{projects.length}</div>
            </CardContent>
          </Card>
          <Card className="dashboard-panel border shadow-sm rounded-xl">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-semibold text-slate-400 uppercase tracking-wider">在线设备</CardTitle>
              <Monitor className="h-4 w-4 text-slate-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-extrabold text-slate-800">{devices.length}</div>
            </CardContent>
          </Card>
          <Card className="dashboard-panel border shadow-sm rounded-xl">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-semibold text-slate-400 uppercase tracking-wider">运行中会话</CardTitle>
              <Bot className="h-4 w-4 text-slate-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-extrabold text-slate-800">{tasks.length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Two Columns Layout */}
        <div className="grid gap-6 lg:grid-cols-[1fr_380px] items-start">
          
          {/* Projects Column */}
          <div className="grid gap-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <Folder className="size-5 text-slate-500" />
                我的项目列表
              </h3>
            </div>

            {projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-white/50 p-12 text-center shadow-sm">
                <Folder className="size-12 text-slate-300 stroke-[1.5] mb-4" />
                <h4 className="font-bold text-slate-700 text-sm">暂无活跃项目</h4>
                <p className="text-xs text-slate-400 max-w-[240px] mt-1 leading-relaxed">请在右侧选择机器与路径，创建一个新项目以开始开发。</p>
              </div>
            ) : (
              <div className="project-grid">
                {projects.map((project) => (
                  <div 
                    key={project.key} 
                    className="project-card shadow-sm cursor-pointer group"
                    onClick={() => onSelectProject(project.deviceId, project.workspacePath)}
                  >
                    <div className="project-card-header">
                      <div 
                        className="project-letter-badge project-letter-badge-lg" 
                        style={getProjectGradient(project.workspaceName)}
                      >
                        {project.workspaceName.trim().charAt(0).toUpperCase() || "P"}
                      </div>
                      <div className="min-w-0">
                        <div className="project-card-title truncate">{project.workspaceName}</div>
                        <div className="project-card-device">
                          <div className="size-1.5 rounded-full bg-green-500" />
                          <span className="truncate">{project.deviceName}</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="project-card-path truncate" title={project.workspacePath}>
                      {project.workspacePath}
                    </div>

                    <div className="project-card-meta">
                      <div className="flex items-center gap-1.5 text-xs text-slate-400">
                        <Bot className="size-3.5" />
                        <span>{project.sessionCount} 个 AI 实例</span>
                      </div>
                      
                      <div className="flex items-center gap-1 text-xs font-semibold text-primary group-hover:translate-x-0.5 transition-transform">
                        <span>打开项目</span>
                        <ArrowRight className="size-3.5" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick Start Sidebar Column */}
          <div className="grid gap-6">
            
            {/* Create Project Card */}
            <Card className="border shadow-sm rounded-xl overflow-hidden bg-white">
              <CardHeader className="bg-slate-50/50 border-b p-5">
                <CardTitle className="text-base font-bold text-slate-800">新建/注册项目</CardTitle>
                <CardDescription className="text-xs text-slate-400">指定机器上的某个目录作为一个独立项目。</CardDescription>
              </CardHeader>
              <CardContent className="p-5">
                <form onSubmit={handleCreateProject} className="grid gap-4">
                  <label className="grid gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    目标机器
                    <Select value={targetDeviceId} onValueChange={setTargetDeviceId}>
                      <SelectTrigger className="w-full h-9 rounded-lg"><SelectValue placeholder="选择机器" /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {devices.length === 0 && <SelectItem value="none" disabled>无可用机器</SelectItem>}
                          {devices.map((d) => <SelectItem key={d.id} value={d.id}>{d.name || d.id}</SelectItem>)}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </label>

                  <label className="grid gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    物理目录路径
                    <Input
                      className="h-9 rounded-lg"
                      value={customPath}
                      onChange={(e) => setCustomPath(e.target.value)}
                      placeholder={activeDevice ? defaultWorkspacePath(activeDevice) : "/home/user/my-project"}
                    />
                  </label>

                  <Button 
                    type="submit" 
                    disabled={!targetDeviceId || !customPath.trim()} 
                    className="w-full h-9 rounded-lg shadow-sm"
                  >
                    <Plus className="mr-1.5 size-4" />
                    创建并进入项目
                  </Button>
                </form>
              </CardContent>
            </Card>

            {/* Online Devices Panel */}
            <Card className="border shadow-sm rounded-xl overflow-hidden bg-white">
              <CardHeader className="bg-slate-50/50 border-b p-5">
                <CardTitle className="text-base font-bold text-slate-800">在线设备列表</CardTitle>
                <CardDescription className="text-xs text-slate-400">目前注册的远程 daemon 节点信息。</CardDescription>
              </CardHeader>
              <CardContent className="p-0 divide-y divide-slate-100">
                {devices.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-400">暂无在线设备</div>
                ) : devices.map((d) => (
                  <div key={d.id} className="p-4 flex items-start gap-3">
                    <div className="size-9 rounded-lg bg-slate-50 border flex items-center justify-center text-slate-500 shrink-0">
                      <Monitor className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-slate-700 text-sm truncate">{d.name || d.id}</span>
                        <div className="size-1.5 rounded-full bg-green-500 shrink-0" />
                      </div>
                      <span className="block font-mono text-[10px] text-slate-400 truncate mt-0.5">{d.id}</span>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {(d.agents?.length ? d.agents : [{ name: d.agent || "claude", label: d.agent_label }]).map(a => (
                          <Badge key={a.name} variant="outline" className="font-normal text-[10px] bg-slate-50 text-slate-500 py-0 px-1.5 h-5">
                            {a.label || agentDisplayName(a.name)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
            
          </div>
          
        </div>
      </div>
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
        <div className="grid gap-2 text-sm font-medium text-slate-700">
          <span>选择 AI 开发引擎</span>
          <div className="agent-selection-grid">
            {agents.length === 0 ? (
              <div className="text-xs text-slate-400 p-2">暂无可用 Agent</div>
            ) : (
              agents.map((agent) => {
                const isActive = selectedAgent === agent.name;
                const provider = getProviderKey(agent.name);
                
                let desc = "远程开发引擎";
                if (agent.name.includes("claude")) desc = "最强工程代码与指令执行";
                else if (agent.name.includes("gemini")) desc = "双子座多模态长文本引擎";
                else if (agent.name.includes("copilot")) desc = "微软全能代码快捷助手";
                else if (agent.name.includes("deepseek")) desc = "高性价比深度推理";
                else if (agent.name.includes("qwen")) desc = "先进中文推理";
                
                return (
                  <div
                    key={agent.name}
                    className={cn(
                      "agent-selector-card flex items-center gap-3 cursor-pointer p-2.5 rounded-xl border border-slate-100 transition-all duration-200",
                      isActive && "agent-selector-card-active border-blue-500 bg-blue-50/5 shadow-sm"
                    )}
                    onClick={() => onAgentChange && onAgentChange(agent.name)}
                  >
                    <div className="shrink-0 rounded-lg p-1 bg-white border border-slate-100/50 shadow-sm flex items-center justify-center">
                      <ProviderIcon provider={provider} size={18} type="color" />
                    </div>
                    <div className="min-w-0 text-left">
                      <div className="agent-selector-title text-xs font-bold text-slate-800 truncate">{agent.label || agentDisplayName(agent.name)}</div>
                      <div className="agent-selector-desc text-[9px] text-slate-400 truncate mt-0.5">{desc}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
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
