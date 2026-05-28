import React, { useState, useEffect } from "react";
import { Cpu, Plus, FolderGit2, ArrowRight, FolderPlus, Server, X, Activity } from "lucide-react";
import type { Device } from "@/lib/types";
import { postJSON } from "@/lib/api";

export interface Project {
  id: string;
  name: string;
  device_id: string;
  workspace_path: string;
  agent_ids: string[];
  tmux_ids: string[];
}

interface StudioDashboardProps {
  devices: Device[];
  projects: Project[];
  onSelectProject: (projectId: string) => void;
  onRefreshProjects: () => void;
}

export function StudioDashboard({
  devices,
  projects,
  onSelectProject,
  onRefreshProjects,
}: StudioDashboardProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [newProjDevice, setNewProjDevice] = useState("");
  const [newProjPath, setNewProjPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (devices.length > 0 && !newProjDevice) {
      setNewProjDevice(devices[0].id);
    }
  }, [devices]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjName.trim() || !newProjDevice || !newProjPath.trim()) {
      setError("所有字段均为必填项");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await postJSON<Project>("/api/project/create", {
        name: newProjName.trim(),
        device_id: newProjDevice,
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

  return (
    <div className="grow overflow-y-auto bg-gradient-to-b from-indigo-50/30 via-slate-50 to-slate-100 p-8 select-none">
      {/* Welcome Header */}
      <div className="mb-10 text-center max-w-4xl mx-auto">
        <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
          轻量化跨机开发协同工作流
        </h1>
        <p className="mt-3 text-lg text-slate-500 font-light">
          管理任意物理机上的开发目录，拉起高能 AI Agent 会话，挂载持久化 tmux 终端。
        </p>
      </div>

      {/* Main Layout Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 max-w-7xl mx-auto w-full">
        {/* Left: Machines list (4 cols) */}
        <div className="lg:col-span-4 flex flex-col space-y-6">
          <div className="bg-white/80 backdrop-blur border border-slate-200/80 rounded-2xl p-6 shadow-sm flex flex-col space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h2 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
                <Cpu className="h-4.5 w-4.5 text-indigo-500" />
                <span>机器列表</span>
              </h2>
              <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-mono">
                {devices.length} 台在线
              </span>
            </div>

            <div className="space-y-3">
              {devices.length === 0 ? (
                <div className="text-center py-6 text-xs text-slate-400">
                  暂无在线守护进程设备
                </div>
              ) : (
                devices.map((device) => {
                  const online = device.workspaces !== undefined;
                  return (
                    <div
                      key={device.id}
                      className="p-4 rounded-xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 hover:border-slate-200 flex items-center justify-between transition group"
                    >
                      <div className="flex items-center space-x-3">
                        <div className="h-9 w-9 rounded-lg bg-indigo-50 flex items-center justify-center border border-indigo-100 group-hover:border-indigo-200 transition">
                          <Server className="h-4.5 w-4.5 text-indigo-600" />
                        </div>
                        <div>
                          <h4 className="text-xs font-bold text-slate-700 group-hover:text-indigo-600 transition">
                            {device.name || device.id}
                          </h4>
                          <p className="text-[9px] text-slate-400 font-mono mt-0.5">
                            {device.agent || "claude"} ({device.workspaces?.length || 0} 工作区)
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-1.5">
                        <span className={`h-2.5 w-2.5 rounded-full ${online ? "bg-emerald-500 animate-pulse" : "bg-slate-300"}`}></span>
                        <span className="text-[10px] font-semibold text-slate-500">
                          {online ? "在线" : "离线"}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Right: Projects explorer (8 cols) */}
        <div className="lg:col-span-8 flex flex-col space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-800 flex items-center space-x-2">
              <FolderGit2 className="h-5 w-5 text-indigo-500" />
              <span>开发项目列表</span>
            </h2>
            <button
              onClick={() => setCreateOpen(true)}
              className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 hover:shadow-md hover:shadow-indigo-500/10 rounded-xl text-xs font-semibold text-white flex items-center space-x-1.5 transition select-none"
            >
              <Plus className="h-4 w-4" />
              <span>新建项目挂载</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.map((proj) => {
              const deviceName = devices.find((d) => d.id === proj.device_id)?.name || proj.device_id;
              return (
                <div
                  key={proj.id}
                  onClick={() => onSelectProject(proj.id)}
                  className="bg-white/90 hover:bg-white border border-slate-200/60 hover:border-indigo-400/80 rounded-2xl p-5 shadow-sm hover:shadow-md hover:shadow-indigo-500/5 cursor-pointer transition flex flex-col justify-between h-44 group"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="px-2.5 py-0.5 text-[9px] uppercase font-bold tracking-wider bg-indigo-50 text-indigo-600 rounded border border-indigo-100 flex items-center space-x-1">
                        <Server className="h-2.5 w-2.5" />
                        <span>{deviceName.split(" ")[0]}</span>
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">
                        {proj.agent_ids?.length || 0} 会话 / {proj.tmux_ids?.length || 0} 终端
                      </span>
                    </div>
                    <h3 className="text-base font-bold text-slate-800 mt-3 group-hover:text-indigo-600 transition">
                      {proj.name}
                    </h3>
                    <p className="text-[10px] text-slate-500 font-mono mt-1 break-all bg-slate-50 p-2 rounded-lg border border-slate-100">
                      {proj.workspace_path}
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-xs text-indigo-600 group-hover:text-indigo-500 pt-3 border-t border-slate-50 font-semibold">
                    <span>进入工作空间</span>
                    <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-1 transition-transform" />
                  </div>
                </div>
              );
            })}

            {/* Custom Add project card option */}
            <div
              onClick={() => setCreateOpen(true)}
              className="border-2 border-dashed border-slate-200 hover:border-indigo-400/60 hover:bg-indigo-50/10 cursor-pointer rounded-2xl p-5 flex flex-col items-center justify-center h-44 text-slate-400 hover:text-indigo-600 transition group"
            >
              <FolderPlus className="h-8 w-8 mb-2 group-hover:scale-110 transition-transform text-slate-300 group-hover:text-indigo-400" />
              <span className="text-xs font-bold text-slate-600 group-hover:text-indigo-600">创建新项目挂载</span>
              <span className="text-[10px] text-slate-400 mt-1">绑定目标物理机的绝对工作目录进行协同</span>
            </div>
          </div>
        </div>
      </div>

      {/* Create Project Modal Dialog */}
      {createOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-slate-200/80 animate-in fade-in-50 zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="font-bold text-slate-800 flex items-center space-x-2">
                <FolderPlus className="h-4.5 w-4.5 text-indigo-500" />
                <span>创建新项目挂载</span>
              </h3>
              <button
                onClick={() => setCreateOpen(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1 hover:bg-slate-100 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              {error && (
                <div className="bg-rose-50 text-rose-600 text-xs rounded-lg p-3 border border-rose-100">
                  {error}
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">项目名称</label>
                <input
                  type="text"
                  required
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  placeholder="例如 my-workspace-app"
                  className="w-full bg-white border border-slate-200 hover:border-slate-300 focus:border-indigo-500 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition font-sans"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">绑定宿主物理机</label>
                <select
                  value={newProjDevice}
                  onChange={(e) => setNewProjDevice(e.target.value)}
                  className="w-full bg-white border border-slate-200 hover:border-slate-300 focus:border-indigo-500 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition font-sans"
                >
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name || d.id}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">机器中工作目录的绝对路径</label>
                <input
                  type="text"
                  required
                  value={newProjPath}
                  onChange={(e) => setNewProjPath(e.target.value)}
                  placeholder="例如 /home/choco/projects/my-app"
                  className="w-full bg-white border border-slate-200 hover:border-slate-300 focus:border-indigo-500 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition font-mono"
                />
              </div>
              <div className="pt-2 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 rounded-xl text-xs font-semibold text-white shadow-sm hover:shadow transition"
                >
                  {submitting ? "正在创建..." : "确认创建"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
