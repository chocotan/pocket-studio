import { useEffect, useMemo, useRef, useState } from "react";
import { Cable, Check, FolderGit2, Plus, Search, Star, X } from "lucide-react";
import type { Device } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Project } from "./studio-dashboard";

interface ProjectSwitcherProps {
  projects: Project[];
  favoriteProjects: Project[];
  favoriteIds: Set<string>;
  devices: Device[];
  currentProjectId?: string;
  onSelectProject: (projectId: string) => void;
  onToggleFavorite: (projectId: string) => void;
  onDirectModeChange: (projectId: string, directMode: boolean) => void;
  triggerClassName?: string;
  triggerLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface ProjectNavMenuProps {
  projects: Project[];
  devices: Device[];
  currentProjectId?: string;
  alertProjectIds?: Set<string>;
  onSelectProject: (projectId: string) => void;
  onAddFavorite: () => void;
  onRemoveFavorite: (projectId: string) => void;
  onMoveFavorite: (projectId: string, direction: "up" | "down") => void;
  className?: string;
}

export function ProjectSwitcher({
  projects,
  favoriteProjects,
  favoriteIds,
  devices,
  currentProjectId = "",
  onSelectProject,
  onToggleFavorite,
  onDirectModeChange,
  triggerClassName,
  triggerLabel = "项目列表",
  open: controlledOpen,
  onOpenChange,
}: ProjectSwitcherProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const open = controlledOpen ?? uncontrolledOpen;
  const currentProject = projects.find((project) => project.id === currentProjectId);
  const currentDevice = currentProject ? deviceForProject(devices, currentProject) : undefined;
  const currentDeviceName = currentDevice ? deviceDisplayName(currentDevice, currentProject?.device_id) : "";

  const filteredProjects = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return projects;
    return projects.filter((project) => {
      const device = deviceForProject(devices, project);
      return [project.name, project.workspace_path, project.device_id, device?.name || ""].some((value) =>
        value.toLowerCase().includes(term)
      );
    });
  }, [devices, projects, query]);
  const favoriteOrder = useMemo(
    () => new Map(favoriteProjects.map((project, index) => [project.id, index])),
    [favoriteProjects]
  );
  const groupedProjects = useMemo(
    () => groupProjectsByDevice(filteredProjects, devices, favoriteIds, favoriteOrder),
    [devices, favoriteIds, favoriteOrder, filteredProjects]
  );

  function setOpen(nextOpen: boolean) {
    setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [open]);

  function selectProject(projectId: string) {
    setOpen(false);
    setQuery("");
    onSelectProject(projectId);
  }

  function renderRow(project: Project, options: { favorite: boolean }) {
    const selected = project.id === currentProjectId;
    return (
      <li key={project.id}>
        <div
          onClick={() => selectProject(project.id)}
          className={cn(
            "grid min-h-[3.25rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-2.5 transition-all duration-150 cursor-pointer border-l-2 select-none",
            selected
              ? "bg-indigo-50/50 dark:bg-indigo-950/25 border-indigo-600 dark:border-indigo-500"
              : "bg-white hover:bg-slate-50 dark:bg-transparent dark:hover:bg-slate-800/20 border-transparent"
          )}
        >
          {/* Left side: Project Info */}
          <div className="flex flex-col min-w-0 pr-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <FolderGit2 className={cn("h-4 w-4 shrink-0 transition-colors", selected ? "text-indigo-600 dark:text-indigo-400" : "text-slate-400")} />
              <span className={cn("truncate text-xs font-medium tracking-tight", selected ? "text-indigo-750 dark:text-indigo-350" : "text-slate-700 dark:text-slate-200")}>
                {project.name}
              </span>
              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />}
            </div>
            <div
              className="mt-1 block truncate font-mono text-[9px] text-slate-450 dark:text-slate-500 pl-[22px]"
              title={project.workspace_path}
            >
            {project.workspace_path}
            </div>
          </div>

          {/* Right side: Action Buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDirectModeChange(project.id, !project.direct_mode);
              }}
              title={project.direct_mode ? "当前为直连模式（点击切换为中转）" : "当前为中转模式（点击切换为直连）"}
              className={cn(
                "h-6 w-6 rounded-md flex items-center justify-center transition-all duration-150 cursor-pointer shadow-sm border shrink-0",
                project.direct_mode
                  ? "border-emerald-250 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-450"
                  : "border-slate-200 bg-white text-slate-450 hover:bg-slate-50 dark:border-slate-800/80 dark:bg-slate-900 dark:text-slate-500 dark:hover:bg-slate-800"
              )}
            >
              <Cable className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(project.id);
              }}
              title={options.favorite ? "取消收藏" : "加入收藏"}
              aria-label={options.favorite ? `取消收藏 ${project.name}` : `收藏 ${project.name}`}
              className={cn(
                "h-6 w-6 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-all flex items-center justify-center cursor-pointer border border-transparent hover:border-slate-200/80 dark:hover:border-slate-700/60 shrink-0",
                options.favorite ? "text-amber-500 hover:text-amber-600" : "text-slate-400 hover:text-amber-500"
              )}
            >
              <Star className={cn("h-3.5 w-3.5", options.favorite && "fill-current")} />
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          "flex h-6 min-w-0 items-center gap-1.5 rounded-full border border-slate-200/60 bg-slate-100/80 px-2 text-[10px] text-slate-500 transition-colors hover:border-indigo-200 hover:bg-indigo-50/70 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 dark:border-slate-700/60 dark:bg-slate-800/50 dark:text-slate-400 dark:hover:border-indigo-800 dark:hover:bg-slate-800",
          triggerClassName
        )}
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        {currentProject ? (
          <>
            {currentDeviceName && (
              <>
                <span className="truncate max-w-[120px] font-semibold text-slate-500 dark:text-slate-400" title={currentDeviceName}>
                  {currentDeviceName}
                </span>
                <span className="text-slate-300 dark:text-slate-600">/</span>
              </>
            )}
            <span className="truncate max-w-[220px] font-semibold text-indigo-600 dark:text-indigo-400" title={currentProject.name}>
              {currentProject.name}
            </span>
          </>
        ) : (
          <>
            <Star className="h-3.5 w-3.5 text-amber-500" />
            <span className="font-semibold text-slate-600 dark:text-slate-300">项目列表</span>
          </>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100dvw-4rem)] sm:max-w-4xl overflow-hidden p-0 border-slate-200/80 dark:border-slate-800/80 shadow-2xl rounded-2xl animate-scale-in">
          <DialogHeader className="px-5 py-4 bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-150 dark:border-slate-800/80 backdrop-blur-md">
            <DialogTitle className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <span className="h-7 w-7 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center dark:bg-indigo-950/40 dark:border-indigo-900/60">
                <FolderGit2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              </span>
              <span>切换项目工作区</span>
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 p-5 bg-slate-50/20 dark:bg-slate-950/10">
            {/* Search Input */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-450 dark:text-slate-500" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="键入以搜索项目名称、路径或关联设备..."
                className="h-10 rounded-xl border-slate-200/80 bg-white pl-10 pr-12 text-xs focus-visible:ring-2 focus-visible:ring-indigo-500/20 focus-visible:border-indigo-500 transition-all dark:border-slate-800/80 dark:bg-slate-900"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 select-none">
                <kbd className="hidden sm:inline-flex h-5 items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1.5 font-mono text-[9px] font-medium text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500">
                  ESC
                </kbd>
              </div>
            </div>

            {/* Project List Scroll Area */}
            <div className="max-h-[min(36rem,65dvh)] overflow-y-auto pr-1">
              {groupedProjects.length === 0 ? (
                <div className="flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white px-4 text-center text-slate-400 dark:border-slate-800 dark:bg-slate-900 gap-2">
                  <FolderGit2 className="h-8 w-8 text-slate-350 dark:text-slate-650" />
                  <span className="text-xs font-semibold">{projects.length === 0 ? "还没有项目" : "没有找到匹配的项目"}</span>
                </div>
              ) : (
                <div className={cn(
                  "grid gap-4",
                  groupedProjects.length === 1 && "grid-cols-1 max-w-xl mx-auto w-full",
                  groupedProjects.length === 2 && "grid-cols-1 md:grid-cols-2",
                  groupedProjects.length >= 3 && "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
                )}>
                  {groupedProjects.map((group) => (
                    <section
                      key={group.deviceId}
                      className="min-w-0 overflow-hidden rounded-xl border border-slate-200/80 bg-white dark:border-slate-800/80 dark:bg-slate-900 shadow-sm flex flex-col transition-all hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700/60 duration-200"
                    >
                      <div className="flex h-10 items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/50 px-3.5 dark:border-slate-800/80 dark:bg-slate-900/50 shrink-0 select-none">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            group.online ? "bg-emerald-500 shadow-sm shadow-emerald-500/30 animate-pulse" : "bg-slate-300 dark:bg-slate-600"
                          )} />
                          <span className="truncate text-xs font-bold text-slate-700 dark:text-slate-200" title={group.deviceName}>
                            {group.deviceName}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 text-[10px] font-bold text-slate-400">
                          {group.favoriteCount > 0 && (
                            <span className="flex items-center gap-1 text-amber-500">
                              <Star className="h-3 w-3 fill-current" />
                              {group.favoriteCount}
                            </span>
                          )}
                          <span className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded-full text-[9px] text-slate-500 dark:text-slate-400">{group.projects.length}</span>
                        </div>
                      </div>
                      <ul className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-slate-900">
                        {group.projects.map((project) =>
                          renderRow(project, { favorite: favoriteIds.has(project.id) })
                        )}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ProjectNavMenu({
  projects,
  devices,
  currentProjectId = "",
  alertProjectIds = new Set<string>(),
  onSelectProject,
  onAddFavorite,
  onRemoveFavorite,
  onMoveFavorite,
  className,
}: ProjectNavMenuProps) {
  const [draggedProjectId, setDraggedProjectId] = useState("");

  function moveFavoriteToIndex(projectId: string, targetIndex: number) {
    const currentIndex = projects.findIndex((project) => project.id === projectId);
    if (currentIndex === -1 || currentIndex === targetIndex) return;
    const direction = targetIndex < currentIndex ? "up" : "down";
    const steps = Math.abs(targetIndex - currentIndex);
    for (let i = 0; i < steps; i += 1) {
      onMoveFavorite(projectId, direction);
    }
  }

  return (
    <nav
      className={cn("min-w-0", className)}
      aria-label="项目列表"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain">
        {projects.length === 0 ? (
          <button
            type="button"
            onClick={onAddFavorite}
            className="flex h-6 items-center gap-1.5 rounded-md border border-dashed border-slate-200 px-2 text-[11px] font-semibold text-slate-500 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 dark:border-slate-800 dark:text-slate-500 dark:hover:border-indigo-800 dark:hover:bg-slate-800 dark:hover:text-indigo-300"
            title="添加收藏"
            aria-label="添加收藏"
          >
            <Plus className="h-3.5 w-3.5" />
            添加收藏
          </button>
        ) : (
          projects.map((project, index) => {
            const device = deviceForProject(devices, project);
            const deviceName = deviceDisplayName(device, project.device_id);
            const selected = project.id === currentProjectId;
            const alerting = alertProjectIds.has(project.id);
            const online = Boolean(device?.workspaces);
            const dragging = draggedProjectId === project.id;
            return (
              <div
                key={project.id}
                className="flex shrink-0 items-center gap-1"
                draggable
                onDragStart={(event) => {
                  setDraggedProjectId(project.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", project.id);
                }}
                onDragEnd={() => {
                  setDraggedProjectId("");
                }}
                onDragOver={(event) => {
                  if (!draggedProjectId || draggedProjectId === project.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedId = event.dataTransfer.getData("text/plain") || draggedProjectId;
                  if (!draggedId || draggedId === project.id) return;
                  moveFavoriteToIndex(draggedId, index);
                  setDraggedProjectId("");
                }}
              >
                {index > 0 && <span className="h-3 w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />}
                <div
                  data-alert={alerting ? "true" : "false"}
                  className={cn(
                    "studio-project-nav-item group relative flex h-6 min-w-0 items-center overflow-hidden rounded-md border pr-0.5 transition-colors",
                    dragging && "opacity-50",
                    selected
                      ? "border-indigo-200 bg-indigo-50 text-indigo-700 shadow-sm shadow-indigo-500/5 dark:border-indigo-900/70 dark:bg-indigo-950/35 dark:text-indigo-300"
                      : "border-transparent bg-slate-50/70 text-slate-600 hover:border-slate-200 hover:bg-white dark:bg-slate-900/45 dark:text-slate-400 dark:hover:border-slate-800 dark:hover:bg-slate-800/70"
                  )}
                  title={`${deviceName} / ${project.name}`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectProject(project.id)}
                    className="flex h-full min-w-0 cursor-grab items-center gap-1.5 px-1.5 text-left active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                    aria-current={selected ? "page" : undefined}
                    title={`${deviceName} / ${project.name}`}
                  >
                    <span className={cn("relative z-10 h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600")} />
                    <span className="relative z-10 flex min-w-0 max-w-[220px] items-center gap-1 text-[11px] leading-none">
                      <span className="truncate font-normal text-slate-500 dark:text-slate-400">
                        {deviceName}
                      </span>
                      <span className="text-slate-300 dark:text-slate-600">/</span>
                      <span className={cn("truncate font-normal", selected ? "text-indigo-700 dark:text-indigo-200" : "text-slate-700 dark:text-slate-300")}>
                        {project.name}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveFavorite(project.id);
                    }}
                    onDragStart={(event) => event.preventDefault()}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-slate-300 opacity-60 transition-colors hover:bg-red-50 hover:text-red-500 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                    title={`移除收藏 ${project.name}`}
                    aria-label={`移除收藏 ${project.name}`}
                    draggable={false}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {index === projects.length - 1 && (
                  <button
                    type="button"
                    onClick={onAddFavorite}
                    className="flex h-6 w-6 items-center justify-center rounded-md border border-dashed border-slate-200 text-slate-400 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 dark:border-slate-800 dark:text-slate-500 dark:hover:border-indigo-800 dark:hover:bg-slate-800 dark:hover:text-indigo-300"
                    title="添加收藏"
                    aria-label="添加收藏"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </nav>
  );
}

export function deviceForProject(devices: Device[], project: Project) {
  return devices.find((device) => device.id === project.device_id);
}

export function deviceDisplayName(device: Device | undefined, fallback = "") {
  const raw = (device?.name || fallback).trim();
  if (!raw) return fallback;
  const withoutAddress = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (withoutAddress) return withoutAddress;
  const withoutProtocol = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = withoutProtocol.split(/[/:?#]/, 1)[0] || withoutProtocol;
  return host.split(".")[0] || host || raw;
}

interface ProjectDeviceGroup {
  deviceId: string;
  deviceName: string;
  online: boolean;
  favoriteCount: number;
  projects: Project[];
}

function groupProjectsByDevice(
  projects: Project[],
  devices: Device[],
  favoriteIds: Set<string>,
  favoriteOrder: Map<string, number>
) {
  const deviceOrder = new Map(devices.map((device, index) => [device.id, index]));
  const byDevice = new Map<string, ProjectDeviceGroup>();

  for (const project of projects) {
    const device = deviceForProject(devices, project);
    const deviceId = project.device_id || "__unknown__";
    const group = byDevice.get(deviceId) || {
      deviceId,
      deviceName: deviceDisplayName(device, project.device_id || "未分配设备"),
      online: Boolean(device?.workspaces),
      favoriteCount: 0,
      projects: [],
    };
    group.projects.push(project);
    if (favoriteIds.has(project.id)) group.favoriteCount += 1;
    byDevice.set(deviceId, group);
  }

  return Array.from(byDevice.values())
    .sort((a, b) => {
      const aIndex = deviceOrder.get(a.deviceId) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = deviceOrder.get(b.deviceId) ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return a.deviceName.localeCompare(b.deviceName);
    })
    .map((group) => ({
      ...group,
      projects: [...group.projects].sort((a, b) => {
        const aFavorite = favoriteIds.has(a.id);
        const bFavorite = favoriteIds.has(b.id);
        if (aFavorite !== bFavorite) return aFavorite ? -1 : 1;
        if (aFavorite && bFavorite) {
          return (favoriteOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (favoriteOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER);
        }
        return 0;
      }),
    }));
}
