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
  FolderUp,
  ChevronRight,
  Loader2,
  Home,
  Check,
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

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  modified?: number;
}

interface WorkspaceListResult {
  workspace_path?: string;
  path?: string;
  entries?: FileEntry[];
  error?: string;
}

// Utility path helpers
function getParentPath(p: string): string {
  const clean = p.replace(/\\/g, '/').replace(/\/$/, '');
  const lastSlash = clean.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return clean.substring(0, lastSlash) || '/';
}

function getBasename(p: string): string {
  const clean = p.replace(/\\/g, '/').replace(/\/$/, '');
  const base = clean.substring(clean.lastIndexOf('/') + 1);
  return base || clean;
}

function joinPath(base: string, part: string): string {
  const cleanBase = base.replace(/\/$/, "");
  return `${cleanBase}/${part}`;
}

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

  // Directory browser states
  const [showBrowser, setShowBrowser] = useState(false);
  const [browsingPath, setBrowsingPath] = useState("");
  const [dirEntries, setDirEntries] = useState<FileEntry[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);

  useEffect(() => {
    if (devices.length > 0 && !selectedDeviceId) {
      setSelectedDeviceId(devices[0].id);
    }
  }, [devices, selectedDeviceId]);

  const activeDevice = devices.find((d) => d.id === selectedDeviceId) || devices[0];
  const deviceProjects = projects.filter(
    (proj) => activeDevice && proj.device_id === activeDevice.id
  );

  // Initialize directory browsing path when dialog opens
  useEffect(() => {
    if (createOpen && activeDevice) {
      const initialPath = activeDevice?.workspaces?.[0]?.path
        ? getParentPath(activeDevice.workspaces[0].path)
        : "~";
      setBrowsingPath(initialPath);
      setNewProjPath(activeDevice?.workspaces?.[0]?.path || initialPath);
      setShowBrowser(false);
      setDirError("");
      setNewFolderName("");
      setShowNewFolderInput(false);
    }
  }, [createOpen, activeDevice]);

  // Load directory items
  async function loadDirectory(path: string) {
    if (!selectedDeviceId) return;
    setDirLoading(true);
    setDirError("");
    try {
      const res = await postJSON<WorkspaceListResult>(
        `/api/workspace/list?device_id=${encodeURIComponent(selectedDeviceId)}`,
        {
          request_id: `req-${Math.random().toString(36).slice(2)}`,
          workspace_path: path,
          path: ""
        }
      );
      if (res.error) {
        setDirError(res.error);
      } else {
        // Only keep directories and hide hidden ones
        const directories = (res.entries || []).filter(e => e.is_dir && !e.name.startsWith("."));
        setDirEntries(directories);
        if (res.workspace_path) {
          setBrowsingPath(res.workspace_path);
        }
      }
    } catch (err) {
      setDirError(err instanceof Error ? err.message : "无法读取目录");
    } finally {
      setDirLoading(false);
    }
  }

  // Reload when browsing path changes or browser toggled open
  useEffect(() => {
    if (showBrowser && browsingPath) {
      loadDirectory(browsingPath);
    }
  }, [showBrowser, browsingPath]);

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

  async function handleCreateFolder() {
    if (!newFolderName.trim() || !browsingPath) return;
    setCreatingFolder(true);
    try {
      const targetPath = joinPath(browsingPath, newFolderName.trim());
      // Create folder by writing .keep file
      await postJSON<WorkspaceListResult>(
        `/api/workspace/write?device_id=${encodeURIComponent(selectedDeviceId)}`,
        {
          request_id: `req-${Math.random().toString(36).slice(2)}`,
          workspace_path: targetPath,
          path: ".keep",
          content: ""
        }
      );
      setNewFolderName("");
      setShowNewFolderInput(false);
      // Reload directory
      await loadDirectory(browsingPath);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : "无法创建目录");
    } finally {
      setCreatingFolder(false);
    }
  }

  function handleSelectFolder(path: string) {
    setNewProjPath(path);
    const base = getBasename(path);
    if (base) {
      setNewProjName(base);
    }
    setShowBrowser(false);
  }

  function openCreateModal() {
    setError("");
    setCreateOpen(true);
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#f8fafc] font-sans">
      {/* ── Left Sidebar (Dark Console Style) ── */}
      <aside className="w-64 bg-[#0b0f19] text-slate-200 flex flex-col justify-between border-r border-slate-800 flex-shrink-0">
        <div className="p-6">
          {/* Brand Logo & Header */}
          <div className="flex items-center gap-3 mb-8">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <span className="text-white text-sm font-black">P</span>
            </div>
            <div>
              <h1 className="font-extrabold text-sm tracking-tight text-white">Pocket Studio</h1>
              <p className="text-[10px] text-slate-500 font-medium">轻量开发控制台</p>
            </div>
          </div>

          {/* Machine List Label */}
          <div className="space-y-4">
            <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-slate-500 font-bold font-mono">
              <span>机器列表</span>
              <span className="bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded text-[9px]">{devices.length}</span>
            </div>

            {/* Machines Stack */}
            <div className="space-y-1.5 overflow-y-auto max-h-[calc(100vh-200px)] pr-1">
              {devices.length === 0 ? (
                <div className="text-center py-10 text-xs text-slate-500 border border-dashed border-slate-800 rounded-lg">
                  <Server className="h-6 w-6 mx-auto mb-2 text-slate-700" />
                  无在线设备
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
                      className={`w-full p-3 rounded-xl border text-left cursor-pointer transition-all duration-150 flex items-center gap-3 ${
                        isSelected
                          ? "bg-indigo-600/10 border-indigo-500/50 text-white shadow-sm"
                          : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                      }`}
                    >
                      <div className={`h-8 w-8 rounded-lg flex-shrink-0 flex items-center justify-center transition-all ${
                        isSelected ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400"
                      }`}>
                        <Server className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold truncate">{device.name || device.id}</p>
                        <p className="text-[9px] text-slate-500 font-mono truncate mt-0.5">
                          {device.id === "dev_local" ? "本地主机" : "远程云主机"}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500 animate-pulse-dot" : "bg-slate-600"}`} />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Sidebar Footer */}
        <div className="p-6 border-t border-slate-800 bg-[#070b13]/80 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Cpu className="h-3.5 w-3.5 text-indigo-500" />
            <span>Daemon {devices.length > 0 ? "已在线" : "离线"}</span>
          </div>
          <span className="text-[9px] text-slate-600 font-mono">v0.1.0</span>
        </div>
      </aside>

      {/* ── Right Content Area (Beautiful Premium Dashboard) ── */}
      <main className="flex-1 overflow-y-auto flex flex-col">
        {/* Sticky Header */}
        <header className="h-16 border-b border-slate-200 bg-white/80 backdrop-blur px-8 flex items-center justify-between sticky top-0 z-30 flex-shrink-0">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-5 w-5 text-indigo-600" />
            <h2 className="text-sm font-bold text-slate-800">
              {activeDevice ? `${activeDevice.name || activeDevice.id} 的项目列表` : "选择设备查看项目"}
            </h2>
            {activeDevice && (
              <Badge className="text-[10px] font-bold text-slate-500 bg-slate-100 border border-slate-200 rounded-full ml-2">
                {deviceProjects.length} 个项目
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-3">
            {activeDevice && (
              <Button
                size="sm"
                onClick={openCreateModal}
                className="h-9 px-4 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-500/20 rounded-xl transition-all active:scale-95 flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                创建项目
              </Button>
            )}
          </div>
        </header>

        {/* Content Body */}
        <div className="flex-1 p-8 max-w-6xl w-full mx-auto">
          {activeDevice ? (
            <div className="space-y-6">
              {deviceProjects.length === 0 ? (
                <div className="border border-dashed border-slate-200 bg-white rounded-2xl p-16 text-center text-slate-400 shadow-sm flex flex-col items-center justify-center min-h-[300px]">
                  <div className="h-12 w-12 rounded-full bg-slate-50 flex items-center justify-center mb-4 border border-slate-100">
                    <FolderGit2 className="h-6 w-6 text-slate-400" />
                  </div>
                  <h3 className="text-sm font-bold text-slate-800">暂无项目</h3>
                  <p className="text-xs text-slate-500 max-w-sm mt-2 leading-relaxed">
                    该设备上还没有关联任何项目工作区。点击右上角的“创建项目”按钮，关联一个本地目录。
                  </p>
                  <Button
                    size="sm"
                    onClick={openCreateModal}
                    className="mt-4 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl px-4 h-9 shadow-md shadow-indigo-500/10 cursor-pointer"
                  >
                    关联新项目
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-fade-in">
                  {deviceProjects.map((proj, i) => (
                    <ProjectCard
                      key={proj.id}
                      proj={proj}
                      deviceLabel={activeDevice.id === "dev_local" ? "Local" : "Remote"}
                      index={i}
                      onClick={() => onSelectProject(proj.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="border border-slate-200 bg-white rounded-2xl p-16 text-center text-slate-400 shadow-sm flex flex-col items-center justify-center min-h-[400px]">
              <HelpCircle className="h-10 w-10 text-slate-300 mb-3 animate-bounce" />
              <span className="text-sm font-bold text-slate-800">请选择一台开发机</span>
              <span className="text-xs text-slate-500 mt-1">在左侧机器列表中选择一个在线的守护进程设备。</span>
            </div>
          )}
        </div>
      </main>

      {/* ── Create Project Dialog (Directory Selector Built-in) ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md p-0 overflow-hidden border-slate-200/80 shadow-2xl rounded-2xl animate-scale-in">
          <DialogHeader className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex-shrink-0">
            <DialogTitle className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <div className="h-6.5 w-6.5 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center">
                <FolderPlus className="h-3.5 w-3.5 text-indigo-600" />
              </div>
              创建项目
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleCreate} className="p-6 space-y-4 max-h-[85vh] overflow-y-auto">
            {error && (
              <div className="bg-rose-50 text-rose-600 rounded-xl p-3.5 border border-rose-100 text-xs font-semibold">
                {error}
              </div>
            )}

            {/* Field: Name */}
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                显示名称
              </Label>
              <Input
                required
                value={newProjName}
                onChange={(e) => setNewProjName(e.target.value)}
                placeholder="例如 my-pocket-studio"
                className="text-xs rounded-xl border-slate-200 focus:border-indigo-400 focus:ring-indigo-500/20 bg-slate-50/50 h-9"
              />
            </div>

            {/* Field: Path */}
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                项目目录
              </Label>
              <div className="flex gap-2">
                <Input
                  required
                  value={newProjPath}
                  onChange={(e) => {
                    setNewProjPath(e.target.value);
                    const base = getBasename(e.target.value);
                    if (base && (!newProjName || newProjName === getBasename(newProjPath))) {
                      setNewProjName(base);
                    }
                  }}
                  placeholder="/home/choco/Downloads/project-name"
                  className="text-xs rounded-xl border-slate-200 focus:border-indigo-400 focus:ring-indigo-500/20 bg-slate-50/50 font-mono h-9 flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowBrowser(!showBrowser)}
                  className="text-xs h-9 px-3 rounded-xl border-slate-250 hover:bg-slate-50 flex items-center gap-1 cursor-pointer"
                >
                  <Folder className="h-3.5 w-3.5 text-slate-500" />
                  {showBrowser ? "关闭浏览" : "浏览目录"}
                </Button>
              </div>
            </div>

            {/* ── Built-in Directory Picker ── */}
            {showBrowser && (
              <div className="border border-slate-200 rounded-xl p-3.5 bg-slate-50/80 backdrop-blur-sm space-y-3 animate-scale-in">
                {/* Picker Header Navigation */}
                <div className="flex items-center justify-between text-[11px] text-slate-500 font-bold border-b border-slate-200 pb-2">
                  <div className="flex items-center gap-1.5 max-w-[240px] truncate">
                    <Home className="h-3 w-3 text-slate-400" />
                    <span className="font-mono text-slate-600" title={browsingPath}>
                      {browsingPath}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {/* Back Button */}
                    <button
                      type="button"
                      disabled={browsingPath === "/" || browsingPath === "" || browsingPath === "~"}
                      onClick={() => setBrowsingPath(getParentPath(browsingPath))}
                      className="p-1 rounded hover:bg-slate-200/80 disabled:opacity-30 disabled:pointer-events-none cursor-pointer flex items-center gap-0.5 text-indigo-600 font-bold"
                      title="返回上级"
                    >
                      <FolderUp className="h-3.5 w-3.5" />
                    </button>
                    {/* New Folder Button */}
                    <button
                      type="button"
                      onClick={() => setShowNewFolderInput(!showNewFolderInput)}
                      className="p-1 rounded hover:bg-slate-200/80 text-indigo-600 font-bold cursor-pointer"
                      title="新建文件夹"
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Inline New Folder Input */}
                {showNewFolderInput && (
                  <div className="flex gap-1.5 bg-white p-2 rounded-lg border border-slate-200 shadow-inner">
                    <Input
                      placeholder="文件夹名称"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      className="h-7 text-xs rounded-md border-slate-200 font-sans flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={creatingFolder || !newFolderName.trim()}
                      onClick={handleCreateFolder}
                      className="h-7 px-2.5 bg-indigo-600 text-white rounded-md text-xs cursor-pointer"
                    >
                      {creatingFolder ? "创建中..." : "创建"}
                    </Button>
                  </div>
                )}

                {/* Directory Entries List */}
                <div className="max-h-40 overflow-y-auto pr-1 space-y-1 min-h-[100px] flex flex-col justify-start">
                  {dirLoading ? (
                    <div className="flex-1 flex flex-col items-center justify-center py-8 text-slate-400 text-xs gap-1.5">
                      <Loader2 className="h-4.5 w-4.5 animate-spin text-indigo-500" />
                      <span>正在加载目录列表...</span>
                    </div>
                  ) : dirError ? (
                    <div className="flex-1 text-center py-6 text-xs text-rose-500 bg-rose-50/50 rounded-lg p-3 border border-rose-100 font-medium">
                      {dirError}
                    </div>
                  ) : dirEntries.length === 0 ? (
                    <div className="flex-1 text-center py-8 text-xs text-slate-400">
                      此目录下无其他文件夹
                    </div>
                  ) : (
                    dirEntries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        onClick={() => setBrowsingPath(joinPath(browsingPath, entry.name))}
                        className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-white border border-transparent hover:border-slate-200 text-slate-700 text-xs font-medium flex items-center justify-between group transition-all duration-150 cursor-pointer"
                      >
                        <span className="flex items-center gap-2 truncate">
                          <Folder className="h-3.5 w-3.5 text-indigo-400 flex-shrink-0 group-hover:text-indigo-500" />
                          <span className="truncate">{entry.name}</span>
                        </span>
                        <ChevronRight className="h-3 w-3 text-slate-350 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                    ))
                  )}
                </div>

                {/* Confirm Selector Button */}
                <div className="pt-2 border-t border-slate-200/60 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleSelectFolder(browsingPath)}
                    className="h-8 px-3 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1 cursor-pointer"
                  >
                    <Check className="h-3 w-3" />
                    选择当前目录
                  </Button>
                </div>
              </div>
            )}

            {/* Footer Buttons */}
            <DialogFooter className="pt-3 flex justify-end gap-2 border-t border-slate-100 flex-shrink-0">
              <DialogClose
                type="button"
                className="inline-flex items-center justify-center text-xs rounded-xl border border-slate-250 text-slate-600 hover:text-slate-800 hover:bg-slate-50 px-4 h-9 font-semibold transition-colors cursor-pointer"
              >
                取消
              </DialogClose>
              <Button
                type="submit"
                size="sm"
                disabled={submitting}
                className="text-xs h-9 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow shadow-indigo-500/20 font-semibold cursor-pointer"
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

/* ── Project Card Sub-Component (Spectacular Glassmorphic Glow) ── */
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
      className="group relative bg-white/90 backdrop-blur-xl border border-slate-200/80 rounded-2xl p-6 shadow-sm hover:border-indigo-300/80 hover:shadow-lg hover:shadow-indigo-500/[0.04] transition-all duration-300 transform hover:-translate-y-0.5 cursor-pointer flex flex-col justify-between h-44 overflow-hidden animate-fade-in"
      style={{ animationDelay: `${(index + 1) * 60}ms` }}
    >
      {/* Premium indigo left border accent */}
      <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-indigo-500 to-violet-500 rounded-l-2xl" />

      {/* Top: Labels & stats */}
      <div className="flex items-center justify-between pl-1">
        <Badge className="text-[9px] uppercase font-bold tracking-widest bg-indigo-50 text-indigo-600 border border-indigo-100 rounded-md px-2 py-0.5">
          {deviceLabel}
        </Badge>
        <Badge variant="secondary" className="text-[10px] bg-slate-50 text-slate-500 border border-slate-200 rounded-md font-mono font-bold">
          {proj.tmux_ids?.length || 0} tmux 终端
        </Badge>
      </div>

      {/* Middle: Title & workspace absolute path */}
      <div className="pl-1 flex-1 flex flex-col justify-center mt-2">
        <h3 className="text-sm font-bold text-slate-800 group-hover:text-indigo-600 transition-colors duration-200 truncate">
          {proj.name}
        </h3>
        <div className="flex items-center gap-1.5 mt-1.5 text-[10.5px] text-slate-400 font-mono">
          <Folder className="h-3 w-3 text-slate-300 flex-shrink-0" />
          <span className="truncate" title={proj.workspace_path}>
            {proj.workspace_path}
          </span>
        </div>
      </div>

      {/* Bottom: Direct link trigger */}
      <div className="flex items-center justify-between text-xs text-indigo-600 font-bold pt-3 border-t border-slate-100 pl-1">
        <span className="group-hover:text-indigo-500 transition-colors">进入工作区</span>
        <ArrowRight className="h-3.5 w-3.5 transform group-hover:translate-x-1 transition-transform duration-200 text-indigo-500" />
      </div>
    </div>
  );
}
