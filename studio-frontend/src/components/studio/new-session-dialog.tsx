import React, { useState, useEffect, useMemo } from "react";
import {
  Server,
  FolderGit2,
  Folder,
  FolderTree,
  Terminal as TerminalIcon,
  Sparkles,
  Check,
  ChevronRight,
  Loader2,
  Cpu,
  Bot,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Device } from "@/lib/types";
import type { Project } from "./studio-dashboard";
import {
  availableTerminalTypes,
  directACPMenuItems,
  type TerminalKind,
  type TerminalAccent,
} from "./terminal-types";
import { deviceDisplayName } from "./project-switcher";
import { fetchCustomAgents, customAgentBaseLabel } from "@/lib/skill-api";
import type { CustomAgent } from "@/lib/types";

export type SessionLaunchKind = "agent_chat" | "terminal" | "file_explorer";

export interface CreateSessionSpec {
  deviceId: string;
  workspacePath: string;
  projectName?: string;
  kind: SessionLaunchKind;
  agentKind?: string;
  agentRuntime?: "direct_acp";
  termType?: TerminalKind;
  useTmux?: boolean;
  customAgent?: { id: string; name: string };
}

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: Device[];
  projects: Project[];
  initialDeviceId?: string;
  initialWorkspacePath?: string;
  onSubmit: (spec: CreateSessionSpec) => Promise<void> | void;
}

export function NewSessionDialog({
  open,
  onOpenChange,
  devices,
  projects,
  initialDeviceId,
  initialWorkspacePath,
  onSubmit,
}: NewSessionDialogProps) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [workspacePath, setWorkspacePath] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");
  const [sessionCategory, setSessionCategory] = useState<"acp" | "terminal" | "tool" | "custom">("acp");
  const [selectedAgentKind, setSelectedAgentKind] = useState<string>("");
  const [selectedTermType, setSelectedTermType] = useState<TerminalKind>("bash");
  const [useTmux, setUseTmux] = useState<boolean>(true);
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const [customAgentsError, setCustomAgentsError] = useState<string>("");
  const [selectedCustomAgentId, setSelectedCustomAgentId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");

  const orderedDevices = useMemo(() => {
    return [...devices].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }, [devices]);

  const activeDevice = useMemo(() => {
    return devices.find((d) => d.id === selectedDeviceId) || orderedDevices[0];
  }, [devices, orderedDevices, selectedDeviceId]);

  const activeACPItems = useMemo(() => directACPMenuItems(activeDevice), [activeDevice]);
  const activeTerminalItems = useMemo(() => availableTerminalTypes(activeDevice), [activeDevice]);

  // Load daemon-managed custom agents for the active device (feature-gated by
  // the daemon's custom.agents.v1 capability via /api/agent/list).
  useEffect(() => {
    if (!open || !activeDevice?.id || sessionCategory !== "custom") return;
    let cancelled = false;
    setCustomAgentsError("");
    fetchCustomAgents(activeDevice.id)
      .then((res) => {
        if (cancelled) return;
        const agents = res.agents || [];
        setCustomAgents(agents);
        if (agents.length > 0 && !agents.some((a) => a.id === selectedCustomAgentId)) {
          setSelectedCustomAgentId(agents[0].id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setCustomAgents([]);
        setCustomAgentsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeDevice?.id, sessionCategory]);

  // Existing projects and configured workspaces on the active device
  const deviceProjects = useMemo(() => {
    if (!activeDevice) return [];
    return projects.filter((p) => p.device_id === activeDevice.id);
  }, [activeDevice, projects]);

  const deviceWorkspaces = useMemo(() => {
    if (!activeDevice || !Array.isArray(activeDevice.workspaces)) return [];
    return activeDevice.workspaces;
  }, [activeDevice]);

  // Sync initial selections on open
  useEffect(() => {
    if (open) {
      setError("");
      setSubmitting(false);
      const devId = initialDeviceId || activeDevice?.id || orderedDevices[0]?.id || "";
      setSelectedDeviceId(devId);

      const dev = devices.find((d) => d.id === devId);
      const defaultPath = initialWorkspacePath || dev?.workspaces?.[0]?.path || (deviceProjects[0]?.workspace_path) || "~";
      setWorkspacePath(defaultPath);
      setProjectName(deriveProjectName(defaultPath));

      const acpList = directACPMenuItems(dev);
      if (acpList.length > 0) {
        setSessionCategory("acp");
        setSelectedAgentKind(acpList[0].agent);
      } else {
        setSessionCategory("terminal");
        setSelectedTermType("bash");
      }
    }
  }, [open, initialDeviceId, initialWorkspacePath]);

  // When device changes in the dialog, auto-update default workspace & agent options
  function handleDeviceChange(devId: string) {
    setSelectedDeviceId(devId);
    setError("");
    const dev = devices.find((d) => d.id === devId);
    const existing = projects.find((p) => p.device_id === devId);
    const defaultPath = dev?.workspaces?.[0]?.path || existing?.workspace_path || "~";
    setWorkspacePath(defaultPath);
    setProjectName(deriveProjectName(defaultPath));

    const acpList = directACPMenuItems(dev);
    if (acpList.length > 0) {
      if (!acpList.some((item) => item.agent === selectedAgentKind)) {
        setSelectedAgentKind(acpList[0].agent);
      }
    } else {
      setSessionCategory("terminal");
      setSelectedTermType("bash");
    }
  }

  function handleSelectPathPreset(path: string, name?: string) {
    setWorkspacePath(path);
    setProjectName(name || deriveProjectName(path));
  }

  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!activeDevice) {
      setError("请选择一台在线设备");
      return;
    }
    const trimmedPath = workspacePath.trim();
    if (!trimmedPath) {
      setError("请指定工作区目录路径");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      let spec: CreateSessionSpec;
      if (sessionCategory === "acp") {
        spec = {
          deviceId: activeDevice.id,
          workspacePath: trimmedPath,
          projectName: projectName.trim() || deriveProjectName(trimmedPath),
          kind: "agent_chat",
          agentKind: selectedAgentKind || "opencode",
          agentRuntime: "direct_acp",
        };
      } else if (sessionCategory === "custom") {
        const agent = customAgents.find((a) => a.id === selectedCustomAgentId);
        if (!agent) {
          setError("请选择一个自定义 Agent（或先在设置中创建）");
          setSubmitting(false);
          return;
        }
        spec = {
          deviceId: activeDevice.id,
          workspacePath: trimmedPath,
          projectName: projectName.trim() || deriveProjectName(trimmedPath),
          kind: "terminal",
          termType: agent.base_agent as TerminalKind,
          customAgent: { id: agent.id, name: agent.name },
        };
      } else if (sessionCategory === "tool") {
        spec = {
          deviceId: activeDevice.id,
          workspacePath: trimmedPath,
          projectName: projectName.trim() || deriveProjectName(trimmedPath),
          kind: "file_explorer",
        };
      } else {
        spec = {
          deviceId: activeDevice.id,
          workspacePath: trimmedPath,
          projectName: projectName.trim() || deriveProjectName(trimmedPath),
          kind: "terminal",
          termType: selectedTermType,
          useTmux,
        };
      }

      await onSubmit(spec);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100dvw-2rem)] sm:max-w-3xl md:max-w-4xl p-0 overflow-hidden border-border/80 shadow-2xl rounded-2xl animate-scale-in">
        <DialogHeader className="px-6 py-4 bg-muted/40 border-b border-border/70 flex-shrink-0">
          <DialogTitle className="text-sm font-bold text-foreground flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-bold text-foreground tracking-tight">新建会话</div>
                <div className="text-[11px] font-normal text-muted-foreground">
                  选择机器、工作区目录与 Agent 类型，一键创建并立即进入
                </div>
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col max-h-[calc(85dvh-7rem)] overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="bg-destructive/10 text-destructive rounded-xl p-3 border border-destructive/20 text-xs font-semibold">
              {error}
            </div>
          )}

          {/* ── STEP 1: 选择开发机 ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-black">
                  1
                </span>
                选择机器 (开发设备)
              </Label>
              <span className="text-[10px] text-muted-foreground">
                共 {devices.length} 台设备可用
              </span>
            </div>

            {orderedDevices.length === 0 ? (
              <div className="p-4 rounded-xl border border-dashed border-border bg-muted/30 text-center text-xs text-muted-foreground">
                当前暂无在线开发机，请先在目标机器上运行 daemon 客户端。
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {orderedDevices.map((device) => {
                  const isSelected = activeDevice?.id === device.id;
                  const displayName = deviceDisplayName(device, device.id);
                  const workspacesCount = device.workspaces?.length || 0;
                  const agentCount = device.agents?.length || 0;

                  return (
                    <button
                      key={device.id}
                      type="button"
                      onClick={() => handleDeviceChange(device.id)}
                      className={`relative flex flex-col p-3 rounded-xl border text-left transition-all cursor-pointer ${
                        isSelected
                          ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                          : "border-border/80 bg-card hover:border-border hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                            isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                          }`}>
                            <Server className="h-3.5 w-3.5" />
                          </span>
                          <span className="truncate text-xs font-bold text-foreground">
                            {displayName}
                          </span>
                        </div>
                        <span className="flex h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                      </div>

                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-auto pl-8">
                        <span>{workspacesCount} 个工作区</span>
                        <span>·</span>
                        <span>{agentCount} 个 Agent</span>
                      </div>

                      {isSelected && (
                        <div className="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="h-2.5 w-2.5" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── STEP 2: 选择工作区 ── */}
          <div className="space-y-2">
            <Label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-black">
                2
              </span>
              选择工作区 (目录路径)
            </Label>

            {/* Quick-select chips */}
            {(deviceWorkspaces.length > 0 || deviceProjects.length > 0) && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-medium text-muted-foreground">常用与已有项目:</div>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-1">
                  {deviceWorkspaces.map((ws) => (
                    <button
                      key={`ws-${ws.id || ws.path}`}
                      type="button"
                      onClick={() => handleSelectPathPreset(ws.path, ws.name)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                        workspacePath === ws.path
                          ? "border-primary bg-primary/10 text-primary font-semibold"
                          : "border-border/70 bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      }`}
                    >
                      <Folder className="h-3 w-3 text-muted-foreground" />
                      <span className="truncate max-w-[200px]">{ws.name || ws.path}</span>
                    </button>
                  ))}
                  {deviceProjects.map((p) => {
                    if (deviceWorkspaces.some((ws) => ws.path === p.workspace_path)) return null;
                    return (
                      <button
                        key={`proj-${p.id}`}
                        type="button"
                        onClick={() => handleSelectPathPreset(p.workspace_path, p.name)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                          workspacePath === p.workspace_path
                            ? "border-primary bg-primary/10 text-primary font-semibold"
                            : "border-border/70 bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        }`}
                      >
                        <FolderGit2 className="h-3 w-3 text-muted-foreground" />
                        <span className="truncate max-w-[200px]">{p.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Input fields */}
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_minmax(140px,200px)] gap-2">
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground font-medium">路径 (绝对路径或 ~)</div>
                <Input
                  required
                  value={workspacePath}
                  onChange={(e) => {
                    setWorkspacePath(e.target.value);
                    setProjectName(deriveProjectName(e.target.value));
                  }}
                  placeholder="例如 /home/user/project 或 ~/workspace"
                  className="text-xs font-mono h-9 rounded-xl border-border focus:border-primary/50 focus:ring-primary/20 bg-muted/30"
                />
              </div>

              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground font-medium">项目显示名</div>
                <Input
                  required
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="显示名称"
                  className="text-xs h-9 rounded-xl border-border focus:border-primary/50 focus:ring-primary/20 bg-muted/30"
                />
              </div>
            </div>
          </div>

          {/* ── STEP 3: 选择 Agent 类型 ── */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-black">
                  3
                </span>
                选择 Agent / 会话类型
              </Label>

              {/* Category tabs */}
              <div className="flex items-center rounded-lg bg-muted/50 p-0.5 border border-border/70 text-[11px]">
                <button
                  type="button"
                  onClick={() => setSessionCategory("acp")}
                  className={`px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer ${
                    sessionCategory === "acp"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Cpu className="h-3 w-3 text-emerald-500" />
                    智能 Agent
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSessionCategory("terminal")}
                  className={`px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer ${
                    sessionCategory === "terminal"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <TerminalIcon className="h-3 w-3 text-indigo-500" />
                    命令行终端
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSessionCategory("custom")}
                  className={`px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer ${
                    sessionCategory === "custom"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Bot className="h-3 w-3 text-fuchsia-500" />
                    自定义 Agent
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSessionCategory("tool")}
                  className={`px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer ${
                    sessionCategory === "tool"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <FolderTree className="h-3 w-3 text-sky-500" />
                    文件浏览
                  </span>
                </button>
              </div>
            </div>

            {/* Direct ACP Agent Cards */}
            {sessionCategory === "acp" && (
              activeACPItems.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-border bg-muted/30 text-center text-xs text-muted-foreground">
                  所选设备当前未配置 Direct ACP Agent，可切换到“命令行终端”模式。
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {activeACPItems.map((item) => {
                    const isSelected = selectedAgentKind === item.agent;
                    return (
                      <button
                        key={item.agent}
                        type="button"
                        onClick={() => setSelectedAgentKind(item.agent)}
                        className={`relative flex items-center gap-2.5 p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                          isSelected
                            ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                            : "border-border/80 bg-card hover:border-border hover:bg-muted/40"
                        }`}
                      >
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${toneClass(item.tone)}`}>
                          {item.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-bold text-foreground">
                            {item.label}
                          </div>
                          <div className="text-[9px] text-muted-foreground">
                            ACP 对话
                          </div>
                        </div>
                        {isSelected && (
                          <div className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground shrink-0">
                            <Check className="h-2 w-2" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )
            )}

            {/* Terminal Cards */}
            {sessionCategory === "terminal" && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {activeTerminalItems.map((item) => {
                    const isSelected = selectedTermType === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setSelectedTermType(item.value)}
                        className={`relative flex items-center gap-2.5 p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                          isSelected
                            ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                            : "border-border/80 bg-card hover:border-border hover:bg-muted/40"
                        }`}
                      >
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${toneClass(item.accent)}`}>
                          {item.logo}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-bold text-foreground">
                            {item.label}
                          </div>
                          <div className="text-[9px] text-muted-foreground">
                            {item.value === "bash" ? "系统 Shell" : "CLI 终端"}
                          </div>
                        </div>
                        {isSelected && (
                          <div className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground shrink-0">
                            <Check className="h-2 w-2" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Tmux toggle */}
                <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-muted/40 border border-border/70 text-xs">
                  <div className="flex flex-col">
                    <span className="font-semibold text-foreground">使用 tmux</span>
                    <span className="text-[10px] text-muted-foreground">
                      {useTmux ? "断线后自动恢复终端状态" : "直连 PTY 模式（支持内联图片）"}
                    </span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useTmux}
                      onChange={(e) => setUseTmux(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-muted-foreground/30 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                  </label>
                </div>
              </div>
            )}

            {/* Custom Agent Cards */}
            {sessionCategory === "custom" && (
              customAgentsError ? (
                <div className="p-4 rounded-xl border border-dashed border-border bg-muted/30 text-center text-xs text-muted-foreground">
                  无法加载自定义 Agent：{customAgentsError}
                  <div className="mt-1 text-[10px]">请确认目标设备 daemon 已更新到支持自定义 Agent 的版本。</div>
                </div>
              ) : customAgents.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-border bg-muted/30 text-center text-xs text-muted-foreground">
                  尚未创建自定义 Agent。可在 设置 → 技能与 Agent 中创建（选择底层 CLI、绑定技能与系统提示词）。
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {customAgents.map((agent) => {
                    const isSelected = selectedCustomAgentId === agent.id;
                    const skillCount = agent.skills?.length || 0;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => setSelectedCustomAgentId(agent.id)}
                        className={`relative flex flex-col gap-1.5 p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                          isSelected
                            ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                            : "border-border/80 bg-card hover:border-border hover:bg-muted/40"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/60 dark:text-fuchsia-300">
                            <Bot className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-bold text-foreground">{agent.name}</div>
                            <div className="text-[9px] text-muted-foreground truncate">
                              {customAgentBaseLabel(agent.base_agent)} · {skillCount} 技能
                              {agent.system_prompt ? " · 提示词" : ""}
                            </div>
                          </div>
                          {isSelected && (
                            <div className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground shrink-0">
                              <Check className="h-2 w-2" />
                            </div>
                          )}
                        </div>
                        {agent.description && (
                          <div className="text-[10px] text-muted-foreground line-clamp-2 pl-9">{agent.description}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )
            )}

            {/* Tool / File Explorer */}
            {sessionCategory === "tool" && (
              <div className="p-4 rounded-xl border border-border bg-card flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                  <FolderTree className="h-5 w-5" />
                </span>
                <div>
                  <div className="text-xs font-bold text-foreground">文件资源管理器</div>
                  <div className="text-[11px] text-muted-foreground">
                    在当前工作区目录中浏览、查看和编辑文件
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <DialogFooter className="pt-3 flex items-center justify-end gap-2 border-t border-border/70 flex-shrink-0">
            <DialogClose
              type="button"
              className="inline-flex items-center justify-center text-xs rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 px-4 h-9 font-semibold transition-colors cursor-pointer"
            >
              取消
            </DialogClose>
            <Button
              type="submit"
              disabled={submitting || !activeDevice || !workspacePath.trim()}
              className="text-xs h-9 px-5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm shadow-primary/25 font-semibold cursor-pointer flex items-center gap-1.5"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在创建并启动...
                </>
              ) : (
                <>
                  <span>创建并进入会话</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function deriveProjectName(path: string) {
  const normalized = (path || "").trim().replace(/[/\\]+$/, "");
  if (!normalized || normalized === "~") return "workspace";
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || "workspace";
}

function toneClass(tone: TerminalAccent | string) {
  switch (tone) {
    case "amber":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300";
    case "emerald":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "violet":
      return "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300";
    case "lime":
      return "bg-lime-100 text-lime-800 dark:bg-lime-950/60 dark:text-lime-300";
    case "cyan":
      return "bg-cyan-100 text-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-300";
    case "rose":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300";
    case "sky":
    case "blue":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}
