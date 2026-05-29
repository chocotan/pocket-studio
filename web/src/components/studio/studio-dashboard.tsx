import React, { useState, useEffect } from "react";
import {
  Cpu,
  Plus,
  FolderGit2,
  FolderPlus,
  Server,
  Folder,
  ArrowRight,
  HelpCircle,
  Zap,
  Terminal,
  Monitor,
  Globe,
} from "lucide-react";
import type { Device } from "../../lib/types";
import { postJSON } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

export interface Project {
  id: string;
  name: string;
  device_id: string;
  workspace_path: string;
  agent_ids: string[];
  tmux_ids: string[];
  studio_state?: unknown;
}

interface StudioDashboardProps {
  devices: Device[];
  projects: Project[];
  onSelectProject: (projectId: string) => void;
  onRefreshProjects: () => void;
}

const FEATURE_PILLS = [
  { icon: Terminal, label: "分裂终端" },
  { icon: Zap, label: "实时 WebSocket" },
  { icon: Monitor, label: "多设备管理" },
  { icon: Globe, label: "本地 + 远程" },
];

export function StudioDashboard({
  devices,
  projects,
  onSelectProject,
  onRefreshProjects,
}: StudioDashboardProps) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [newProjPath, setNewProjPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (devices.length > 0 && !selectedDeviceId) {
      setSelectedDeviceId(devices[0].id);
    }
  }, [devices, selectedDeviceId]);

  const activeDevice = devices.find((d) => d.id === selectedDeviceId) || devices[0];
  const deviceProjects = projects.filter(
    (proj) => activeDevice && proj.device_id === activeDevice.id
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjName.trim() || !selectedDeviceId || !newProjPath.trim()) {
      setError("所有字段均为必填项");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await postJSON<Project>("/api/project/create", {
        name: newProjName.trim(),
        device_id: selectedDeviceId,
        workspace_path: newProjPath.trim(),
      });
      setNewProjName("");
      setNewProjPath("");
      setCreateOpen(false);
      onRefreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function openCreateModal() {
    setNewProjPath(activeDevice?.workspaces?.[0]?.path || "/home/user/project");
    setError("");
    setCreateOpen(true);
  }

  return (
    <div className="studio-square min-h-screen bg-[#f8fafc] select-none font-sans overflow-y-auto">
      <div className="relative z-10 max-w-7xl mx-auto px-6 py-12">
        {/* ── Hero Header ── */}
        <header className="text-center mb-16 animate-fade-in">
          {/* Logo badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-50 border border-indigo-200/80 text-indigo-600 text-xs font-bold tracking-wider uppercase mb-6 shadow-sm">
            <div className="h-4 w-4 rounded-md bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center">
              <span className="text-white text-[8px] font-black leading-none">P</span>
            </div>
            Pocket Studio
          </div>

          <h1 className="text-5xl sm:text-6xl font-extrabold tracking-tight leading-[1.12] mb-5">
            <span className="text-slate-900">
              轻量开发控制台
            </span>
          </h1>
          <p className="text-slate-500 text-base font-light max-w-xl mx-auto leading-relaxed">
            选择开发机，绑定项目路径，即刻进入高度可配置的
            <strong className="font-semibold text-slate-700"> 分裂终端工作区</strong>。
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap items-center justify-center gap-2 mt-8">
            {FEATURE_PILLS.map(({ icon: Icon, label }, i) => (
              <span
                key={label}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold bg-white border border-slate-200/80 text-slate-600 shadow-sm animate-fade-in delay-${(i + 1) * 75}`}
              >
                <Icon className="h-3 w-3 text-indigo-500" />
                {label}
              </span>
            ))}
          </div>
        </header>

        {/* ── Two-column layout ── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

          {/* ── Left: Machine Selector (4 cols) ── */}
          <aside className="lg:col-span-4 animate-fade-in delay-75">
            <div className="bg-white/80 backdrop-blur-xl border border-slate-200/70 rounded-2xl p-6 shadow-[0_4px_24px_rgba(0,0,0,0.05)]">
              <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
                <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <div className="h-6 w-6 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center">
                    <Cpu className="h-3.5 w-3.5 text-indigo-600" />
                  </div>
                  机器大厅
                </h2>
                <Badge variant="secondary" className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-full">
                  {devices.length} 台
                </Badge>
              </div>

              <div className="space-y-2.5">
                {devices.length === 0 ? (
                  <div className="text-center py-10 text-xs text-slate-400">
                    <Server className="h-8 w-8 mx-auto mb-2 text-slate-200" />
                    暂无在线守护进程设备
                  </div>
                ) : (
                  devices.map((device) => {
                    const isSelected = selectedDeviceId === device.id;
                    const online = device.workspaces !== undefined;
                    return (
                      <button
                        key={device.id}
                        type="button"
                        onClick={() => setSelectedDeviceId(device.id)}
                        className={`w-full p-3.5 rounded-xl border flex items-center gap-3 text-left cursor-pointer transition-all duration-200 ${
                          isSelected
                            ? "bg-indigo-50/80 border-indigo-300/60 shadow-[0_0_0_1px_rgba(99,102,241,0.15)]"
                            : "border-slate-100 bg-white/50 hover:bg-slate-50 hover:border-slate-200"
                        }`}
                      >
                        <div
                          className={`h-9 w-9 rounded-lg flex-shrink-0 flex items-center justify-center border transition-all ${
                            isSelected
                              ? "bg-gradient-to-tr from-indigo-600 to-indigo-500 border-indigo-700 text-white shadow-lg shadow-indigo-500/30"
                              : "bg-white border-slate-200 text-slate-400"
                          }`}
                        >
                          <Server className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-bold truncate ${isSelected ? "text-indigo-700" : "text-slate-700"}`}>
                            {device.name || device.id}
                          </p>
                          <p className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                            {device.id === "dev_local" ? "本地主机" : "远程云主机"}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              online ? "bg-emerald-500 animate-pulse-dot" : "bg-slate-300"
                            }`}
                          />
                          <span className={`text-[10px] font-semibold ${online ? "text-emerald-600" : "text-slate-400"}`}>
                            {online ? "在线" : "离线"}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </aside>

          {/* ── Right: Projects Grid (8 cols) ── */}
          <section className="lg:col-span-8 animate-fade-in delay-150">
            {activeDevice ? (
              <div className="space-y-5">
                {/* Section header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <FolderGit2 className="h-5 w-5 text-indigo-500" />
                    <h2 className="text-sm font-bold text-slate-800">
                      {activeDevice.name || activeDevice.id}
                      <span className="text-slate-400 font-normal ml-1.5">的项目</span>
                    </h2>
                    <Badge className="text-[10px] font-bold text-slate-500 bg-slate-100 border border-slate-200 rounded-full">
                      {deviceProjects.length} 个
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    onClick={openCreateModal}
                    className="h-8 px-3.5 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-500/25 rounded-xl transition-all active:scale-95"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    创建项目
                  </Button>
                </div>

                {/* Projects grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {deviceProjects.map((proj, i) => (
                    <ProjectCard
                      key={proj.id}
                      proj={proj}
                      deviceLabel={activeDevice.id === "dev_local" ? "Local" : "Remote"}
                      index={i}
                      onClick={() => onSelectProject(proj.id)}
                    />
                  ))}

                  {/* Create card */}
                  <button
                    type="button"
                    onClick={openCreateModal}
                    className="group border-2 border-dashed border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 cursor-pointer rounded-2xl p-6 flex flex-col items-center justify-center h-44 text-slate-400 hover:text-indigo-600 transition-all duration-300 shadow-sm animate-fade-in"
                    style={{ animationDelay: `${(deviceProjects.length + 1) * 75}ms` }}
                  >
                    <div className="h-11 w-11 rounded-full bg-slate-100 group-hover:bg-indigo-100 transition-colors flex items-center justify-center mb-3 border border-slate-200 group-hover:border-indigo-200 shadow-inner">
                      <FolderPlus className="h-5 w-5 transform group-hover:scale-110 transition-transform" />
                    </div>
                    <span className="text-xs font-bold text-slate-600 group-hover:text-indigo-600 transition-colors">
                      创建新项目
                    </span>
                    <span className="text-[10px] text-slate-400 mt-1">绑定任意绝对路径</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-white/80 border border-slate-200 rounded-2xl p-12 text-center text-slate-400 shadow-sm flex flex-col items-center justify-center min-h-64">
                <HelpCircle className="h-10 w-10 text-slate-200 mb-3 animate-bounce" />
                <span className="text-sm font-medium">请在左侧选择一台开发机</span>
                <span className="text-xs text-slate-300 mt-1">以展示该机器下的项目列表</span>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ── Create Project Dialog ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm p-0 overflow-hidden border-slate-200/80 shadow-2xl rounded-2xl">
          <DialogHeader className="px-6 py-4 bg-slate-50 border-b border-slate-100">
            <DialogTitle className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <div className="h-6 w-6 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center">
                <FolderPlus className="h-3.5 w-3.5 text-indigo-600" />
              </div>
              创建项目
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleCreate} className="p-6 space-y-4">
            {error && (
              <div className="bg-rose-50 text-rose-600 rounded-xl p-3 border border-rose-100 text-xs">
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                显示名称
              </Label>
              <Input
                required
                value={newProjName}
                onChange={(e) => setNewProjName(e.target.value)}
                placeholder="例如 remote-agent"
                className="text-xs rounded-xl border-slate-200 focus:border-indigo-400 focus:ring-indigo-500/20 bg-slate-50/50"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 font-mono">
                项目目录
              </Label>
              <Input
                required
                value={newProjPath}
                onChange={(e) => setNewProjPath(e.target.value)}
                placeholder="/home/choco/Downloads/remote-agent"
                className="text-xs rounded-xl border-slate-200 focus:border-indigo-400 focus:ring-indigo-500/20 bg-slate-50/50 font-mono"
              />
            </div>

            <DialogFooter className="pt-2 flex justify-end gap-2">
              <DialogClose
                className="inline-flex items-center justify-center text-xs rounded-xl border border-slate-200 text-slate-600 hover:text-slate-800 hover:bg-slate-50 px-3 py-1.5 font-semibold transition-colors"
              >
                取消
              </DialogClose>
              <Button
                type="submit"
                size="sm"
                disabled={submitting}
                className="text-xs rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow shadow-indigo-500/20"
              >
                {submitting ? "正在创建..." : "确认创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── Project Card Sub-Component ── */
function ProjectCard({
  proj,
  deviceLabel,
  index,
  onClick,
}: {
  proj: Project;
  deviceLabel: string;
  index: number;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className="group relative bg-white/80 backdrop-blur-xl border border-slate-200/70 rounded-2xl p-6 shadow-[0_2px_16px_rgba(0,0,0,0.04)] hover:border-indigo-300/60 hover:shadow-[0_8px_32px_rgba(99,102,241,0.10)] transition-all duration-300 transform hover:-translate-y-0.5 cursor-pointer flex flex-col justify-between h-44 overflow-hidden animate-fade-in"
      style={{ animationDelay: `${(index + 2) * 75}ms` }}
    >
      {/* Colored left border accent */}
      <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-indigo-500 to-violet-500 rounded-l-2xl" />

      {/* Top: Badge & terminal count */}
      <div className="flex items-center justify-between pl-2">
        <Badge className="text-[9px] uppercase font-bold tracking-widest bg-indigo-50 text-indigo-600 border border-indigo-100 rounded-md px-2 py-0.5">
          {deviceLabel}
        </Badge>
        <Badge variant="secondary" className="text-[10px] bg-slate-50 text-slate-500 border border-slate-200 rounded-md font-mono font-bold">
          {proj.tmux_ids?.length || 1} 终端
        </Badge>
      </div>

      {/* Middle: Title & path */}
      <div className="pl-2 flex-1 flex flex-col justify-center mt-2">
        <h3 className="text-sm font-bold text-slate-800 group-hover:text-indigo-700 transition-colors duration-200 truncate">
          {proj.name}
        </h3>
        <div className="flex items-center gap-1.5 mt-1.5 text-[10.5px] text-slate-400 font-mono">
          <Folder className="h-3 w-3 text-slate-300 flex-shrink-0" />
          <span className="truncate" title={proj.workspace_path}>
            {proj.workspace_path}
          </span>
        </div>
      </div>

      {/* Bottom: Enter workspace link */}
      <div className="flex items-center justify-between text-xs text-indigo-600 font-bold pt-3 border-t border-slate-100 pl-2">
        <span className="group-hover:text-indigo-700 transition-colors">进入工作区</span>
        <ArrowRight className="h-3.5 w-3.5 transform group-hover:translate-x-1.5 transition-transform duration-200 text-indigo-500" />
      </div>
    </div>
  );
}
