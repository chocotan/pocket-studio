import React, { useState, useEffect } from "react";
import {
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
  RefreshCw,
  Settings,
  TerminalSquare,
} from "lucide-react";
import type { Device } from "../../lib/types";
import { clearClientConfig, loadClientConfig, postJSON, saveClientConfig, type ClientConfig } from "../../lib/api";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverURL, setServerURL] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [settingsValidation, setSettingsValidation] = useState("");
  const [settingsValidationOK, setSettingsValidationOK] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [validatingSettings, setValidatingSettings] = useState(false);
  const [switchingLocalMode, setSwitchingLocalMode] = useState(false);

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

  useEffect(() => {
    loadClientConfig().then((cfg) => {
      setServerURL(cfg.server_url);
      setAccessToken(cfg.access_token || "");
    }).catch(() => {});
  }, []);

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

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsError("");
    try {
      const cfg: ClientConfig = {
        server_url: serverURL.trim(),
        local_mode: false,
        access_token: accessToken.trim(),
      };
      const saved = await saveClientConfig(cfg);
      setServerURL(saved.server_url);
      setAccessToken(saved.access_token || "");
      await syncAppImageDaemon(saved);
      navigateWithConfig(saved);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleValidateSettings() {
    setValidatingSettings(true);
    setSettingsError("");
    setSettingsValidation("");
    setSettingsValidationOK(false);
    try {
      await validateServerSettings(serverURL.trim(), accessToken.trim());
      setSettingsValidation("校验通过，token 可用");
      setSettingsValidationOK(true);
    } catch (err) {
      setSettingsValidation(err instanceof Error ? err.message : String(err));
      setSettingsValidationOK(false);
    } finally {
      setValidatingSettings(false);
    }
  }

  async function handleLocalMode() {
    setSwitchingLocalMode(true);
    setSettingsError("");
    setSettingsValidation("");
    setSettingsValidationOK(false);
    try {
      clearClientConfig();
      const result = await switchAppImageToLocalMode();
      const localURL = result.server_url;
      setServerURL(localURL);
      setAccessToken("");
      setSettingsOpen(false);
      window.location.assign(`/studio/?server_url=${encodeURIComponent(localURL)}&server_url_source=runtime`);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitchingLocalMode(false);
    }
  }

  return (
    <div
      className="studio-square theme-light flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground font-sans"
      style={{ fontFamily: "var(--font-sans)" }}
    >
      <header className="shrink-0 h-11 bg-white/95 border-b border-slate-200/70 flex items-center justify-between px-4 z-50 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-6 w-6 rounded-md bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-500/25 flex-shrink-0">
            <span className="text-white font-black text-[10px] leading-none">P</span>
          </div>
          <span className="font-bold text-slate-800 text-xs tracking-tight">Pocket Studio</span>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onRefreshProjects}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
            title="刷新设备和项目"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
            title="配置服务端地址"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden bg-slate-50 p-2.5">
        <div className="grid h-full min-h-0 grid-cols-[minmax(220px,260px)_1fr] gap-2.5 max-lg:grid-cols-1">
          <aside className="studio-panel min-h-0 overflow-hidden border border-slate-200/80 bg-white shadow-sm max-lg:h-64">
            <div className="flex h-9 items-center justify-between border-b border-slate-200/70 bg-slate-100/70 px-3">
              <div className="flex items-center gap-2">
                <Server className="h-3.5 w-3.5 text-slate-500" />
                <span className="text-[11px] font-bold text-slate-700">开发设备</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onRefreshProjects}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white hover:text-slate-800 cursor-pointer"
                  title="刷新设备列表"
                  aria-label="刷新设备列表"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <Badge className="rounded bg-white px-1.5 py-0 text-[9px] font-bold text-slate-500 border border-slate-200">
                  {devices.length}
                </Badge>
              </div>
            </div>

            <div className="h-[calc(100%-2.25rem)] overflow-y-auto p-2">
              {devices.length === 0 ? (
                <div className="flex h-full min-h-36 flex-col items-center justify-center border border-dashed border-slate-200 bg-slate-50 text-center text-xs text-slate-500">
                  <Server className="mb-2 h-6 w-6 text-slate-300" />
                  无在线设备
                </div>
              ) : (
                <div className="space-y-1">
                  {devices.map((device) => {
                    const isSelected = selectedDeviceId === device.id;
                    const online = device.workspaces !== undefined;
                    const projectCount = projects.filter((project) => project.device_id === device.id).length;
                    return (
                      <button
                        key={device.id}
                        type="button"
                        onClick={() => setSelectedDeviceId(device.id)}
                        className={`group grid w-full grid-cols-[1.75rem_1fr_auto] items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors cursor-pointer ${
                          isSelected
                            ? "border-indigo-200 bg-indigo-50 text-slate-900"
                            : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        <span className={`flex h-7 w-7 items-center justify-center rounded-md ${
                          isSelected ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500 group-hover:bg-white"
                        }`}>
                          <Server className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold">{device.name || device.id}</span>
                          <span className="mt-0.5 block truncate text-[9px] text-slate-400">
                            {device.workspaces?.length || 0} 个工作区
                          </span>
                        </span>
                        <span className="flex flex-col items-end gap-1">
                          <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-slate-300"}`} />
                          <span className="font-mono text-[9px] font-bold text-slate-400">{projectCount}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <section className="studio-panel min-h-0 overflow-hidden border border-slate-200/80 bg-white shadow-sm">
            <div className="flex h-9 items-center justify-between border-b border-slate-200/70 bg-slate-100/70 px-3">
              <div className="flex min-w-0 items-center gap-2">
                <FolderGit2 className="h-3.5 w-3.5 text-indigo-600" />
                <span className="truncate text-[11px] font-bold text-slate-700">
                  {activeDevice ? `${activeDevice.name || activeDevice.id} 的项目` : "项目工作区"}
                </span>
                {activeDevice && (
                  <Badge className="rounded bg-white px-1.5 py-0 text-[9px] font-bold text-slate-500 border border-slate-200">
                    {deviceProjects.length}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3">
                <div className="hidden items-center gap-2 text-[10px] font-mono text-slate-400 sm:flex">
                  <span>name</span>
                  <span className="text-slate-300">/</span>
                  <span>workspace</span>
                  <span className="text-slate-300">/</span>
                  <span>term</span>
                </div>
                <button
                  type="button"
                  onClick={onRefreshProjects}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white hover:text-slate-800 cursor-pointer"
                  title="刷新项目列表"
                  aria-label="刷新项目列表"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <Button
                  size="sm"
                  onClick={openCreateModal}
                  disabled={!activeDevice}
                  className="h-6 rounded-md bg-indigo-600 px-2 text-[10px] font-semibold text-white hover:bg-indigo-500 shadow-sm shadow-indigo-500/15 flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  创建
                </Button>
              </div>
            </div>

            <div className="h-[calc(100%-2.25rem)] overflow-y-auto p-2">
              {activeDevice ? (
                deviceProjects.length === 0 ? (
                  <div className="flex h-full min-h-80 flex-col items-center justify-center border border-dashed border-slate-200 bg-slate-50 text-center text-slate-500">
                    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white">
                      <FolderGit2 className="h-5 w-5 text-slate-400" />
                    </div>
                    <h3 className="text-sm font-bold text-slate-800">暂无项目</h3>
                    <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
                      该设备还没有关联项目目录。创建一个项目后可直接进入工作区。
                    </p>
                    <Button
                      size="sm"
                      onClick={openCreateModal}
                      className="mt-4 h-8 rounded-md bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-500 cursor-pointer"
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      创建项目
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-1.5 animate-fade-in">
                    {deviceProjects.map((proj, i) => (
                      <ProjectCard
                        key={proj.id}
                        proj={proj}
                        deviceLabel={activeDevice.name || activeDevice.id}
                        index={i}
                        onClick={() => onSelectProject(proj.id)}
                      />
                    ))}
                  </div>
                )
              ) : (
                <div className="flex h-full min-h-80 flex-col items-center justify-center border border-dashed border-slate-200 bg-slate-50 text-center text-slate-500">
                  <HelpCircle className="mb-3 h-8 w-8 text-slate-300" />
                  <span className="text-sm font-bold text-slate-800">请选择一台开发机</span>
                  <span className="mt-1 text-xs text-slate-500">在左侧设备面板中选择在线守护进程。</span>
                </div>
              )}
            </div>
          </section>
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

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md p-0 overflow-hidden border-slate-200/80 shadow-2xl rounded-2xl animate-scale-in">
          <DialogHeader className="px-6 py-4 bg-slate-50 border-b border-slate-100">
            <DialogTitle className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <div className="h-6.5 w-6.5 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center">
                <Settings className="h-3.5 w-3.5 text-indigo-600" />
              </div>
              服务端地址
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveSettings} className="p-6 space-y-4">
            {settingsError && (
              <div className="bg-rose-50 text-rose-600 rounded-xl p-3.5 border border-rose-100 text-xs font-semibold">
                {settingsError}
              </div>
            )}
            {settingsValidation && (
              <div
                aria-live="polite"
                className={`rounded-xl p-3.5 border text-xs font-semibold ${
                  settingsValidationOK
                    ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                    : "bg-rose-50 text-rose-600 border-rose-100"
                }`}
              >
                {settingsValidation}
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Server URL
              </Label>
              <Input
                required
                value={serverURL}
                onChange={(e) => setServerURL(e.target.value)}
                placeholder="http://127.0.0.1:18080"
                className="text-xs rounded-xl border-slate-200 focus:border-indigo-400 focus:ring-indigo-500/20 bg-slate-50/50 font-mono h-9"
              />
              <p className="text-[11px] text-slate-500 leading-relaxed">
                使用本地模式时填本机地址；使用云端时填云端 server 地址。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Access Token
              </Label>
              <Input
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="ps_xxxxx 或 server admin token"
                className="text-xs rounded-xl border-slate-200 focus:border-indigo-400 focus:ring-indigo-500/20 bg-slate-50/50 font-mono h-9"
              />
              <p className="text-[11px] text-slate-500 leading-relaxed">
                auth 开启后使用 user-frontend 创建的 token；admin-token 模式下填 server 启动时指定的 token。
              </p>
            </div>
            {isAppImagePage() && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-700">本机模式</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                      清除已保存的 Server URL 和 token，并切回 AppImage 启动的本机 server。
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={switchingLocalMode || savingSettings || validatingSettings}
                    onClick={handleLocalMode}
                    className="h-8 shrink-0 rounded-lg border-slate-250 px-3 text-xs font-semibold text-slate-600 hover:bg-white hover:text-slate-800 cursor-pointer"
                  >
                    {switchingLocalMode ? "切换中..." : "切回本机"}
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter className="pt-3 flex justify-end gap-2 border-t border-slate-100">
              <DialogClose
                type="button"
                className="inline-flex items-center justify-center text-xs rounded-xl border border-slate-250 text-slate-600 hover:text-slate-800 hover:bg-slate-50 px-4 h-9 font-semibold transition-colors cursor-pointer"
              >
                取消
              </DialogClose>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={validatingSettings || savingSettings}
                onClick={handleValidateSettings}
                className="text-xs h-9 px-4 rounded-xl border-slate-250 text-slate-600 hover:text-slate-800 hover:bg-slate-50 font-semibold cursor-pointer"
              >
                {validatingSettings ? "校验中..." : "校验"}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingSettings || validatingSettings}
                className="text-xs h-9 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow shadow-indigo-500/20 font-semibold cursor-pointer"
              >
                {savingSettings ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function navigateWithConfig(cfg: ClientConfig) {
  const params = new URLSearchParams();
  params.set("server_url", cfg.server_url);
  if (cfg.access_token) {
    params.set("token", cfg.access_token);
  }
  const path = window.location.protocol === "pocket-studio:" ? "/" : "/studio/";
  window.location.assign(`${path}?${params.toString()}`);
}

async function syncAppImageDaemon(cfg: ClientConfig) {
  if (!isAppImagePage()) {
    return;
  }
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.syncDaemonConfig) {
    return;
  }
  await electronAPI.syncDaemonConfig({
    server_url: cfg.server_url,
    token: cfg.access_token || "",
  });
}

async function switchAppImageToLocalMode(): Promise<{ server_url: string }> {
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.switchToLocalMode) {
    throw new Error("当前环境不支持本机模式切换");
  }
  const result = await electronAPI.switchToLocalMode();
  if (!result?.ok || !result.server_url) {
    throw new Error(result?.error || "本机 server 未启动");
  }
  return { server_url: result.server_url };
}

function isAppImagePage() {
  return window.location.protocol === "pocket-studio:";
}

async function validateServerSettings(serverURL: string, token: string) {
  const base = normalizeServerURL(serverURL);
  const res = await fetch(`${base}/api/state`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (res.ok) {
    return;
  }
  if (res.status === 401) {
    throw new Error("校验失败：token 无效或缺失");
  }
  const text = await res.text().catch(() => "");
  throw new Error(text || `校验失败：server 返回 ${res.status}`);
}

function normalizeServerURL(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("请填写 Server URL");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

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
    <button
      type="button"
      role="button"
      onClick={onClick}
      className="group grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-slate-200/75 bg-white px-3 py-2.5 text-left shadow-sm transition-colors hover:border-indigo-200 hover:bg-indigo-50/35 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-indigo-400 cursor-pointer sm:grid-cols-[minmax(160px,0.75fr)_minmax(220px,1.35fr)_auto_auto]"
      style={{ animationDelay: `${(index + 1) * 60}ms` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 group-hover:bg-white group-hover:text-indigo-600">
          <FolderGit2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-xs font-bold text-slate-800 group-hover:text-indigo-600">
            {proj.name}
          </h3>
          <div className="mt-1 flex items-center gap-1.5">
            <Badge className="max-w-48 truncate rounded border border-indigo-100 bg-indigo-50 px-1.5 py-0 text-[9px] font-bold text-indigo-600">
              {deviceLabel}
            </Badge>
            <span className="hidden truncate font-mono text-[9px] text-slate-400 sm:block">{proj.id}</span>
          </div>
        </div>
      </div>

      <div className="hidden min-w-0 items-center gap-1.5 font-mono text-[10px] text-slate-500 sm:flex">
        <Folder className="h-3.5 w-3.5 shrink-0 text-slate-300" />
        <span className="truncate" title={proj.workspace_path}>{proj.workspace_path}</span>
      </div>

      <div className="hidden items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-bold text-slate-500 sm:flex">
        <TerminalSquare className="h-3.5 w-3.5 text-slate-400" />
        <span>{proj.tmux_ids?.length || 0}</span>
      </div>

      <span className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600">
        <span className="hidden sm:inline">打开</span>
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}
