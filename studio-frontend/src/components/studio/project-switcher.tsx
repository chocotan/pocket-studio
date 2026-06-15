import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, FolderGit2, Search, Server } from "lucide-react";
import type { Device } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Project } from "./studio-dashboard";

interface ProjectSwitcherProps {
  projects: Project[];
  devices: Device[];
  currentProjectId?: string;
  onSelectProject: (projectId: string) => void;
  onMoveProject: (projectId: string, direction: "up" | "down") => void;
  triggerClassName?: string;
  triggerLabel?: string;
}

interface ProjectNavMenuProps {
  projects: Project[];
  devices: Device[];
  currentProjectId?: string;
  alertProjectIds?: Set<string>;
  onSelectProject: (projectId: string) => void;
  className?: string;
}

export function ProjectSwitcher({
  projects,
  devices,
  currentProjectId = "",
  onSelectProject,
  onMoveProject,
  triggerClassName,
  triggerLabel = "切换项目",
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const currentProject = projects.find((project) => project.id === currentProjectId);
  const currentDevice = currentProject ? deviceForProject(devices, currentProject) : undefined;
  const currentDeviceName = currentDevice ? deviceDisplayName(currentDevice, currentProject?.device_id) : "";
  const visibleProjects = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return projects;
    return projects.filter((project) => {
      const device = deviceForProject(devices, project);
      return [
        project.name,
        project.workspace_path,
        project.device_id,
        device?.name || "",
      ].some((value) => value.toLowerCase().includes(term));
    });
  }, [devices, projects, query]);

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

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-full border border-slate-200/60 bg-slate-100/80 px-2.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:border-indigo-200 hover:bg-indigo-50/70 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 dark:border-slate-700/60 dark:bg-slate-800/50 dark:text-slate-400 dark:hover:border-indigo-800 dark:hover:bg-slate-800",
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
            <FolderGit2 className="h-3.5 w-3.5 text-indigo-500" />
            <span className="font-semibold text-slate-600 dark:text-slate-300">项目切换</span>
          </>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(42rem,calc(100dvw-2rem))] max-w-none overflow-hidden p-0 border-slate-200/80 shadow-2xl rounded-2xl animate-scale-in">
          <DialogHeader className="px-5 py-4 bg-slate-50 border-b border-slate-100">
            <DialogTitle className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <span className="h-6.5 w-6.5 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center">
                <FolderGit2 className="h-3.5 w-3.5 text-indigo-600" />
              </span>
              项目切换
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3 p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索项目、路径或设备"
                className="h-9 rounded-xl border-slate-200 bg-slate-50/60 pl-8 pr-3 text-xs"
              />
            </div>

            <div className="max-h-[min(26rem,60dvh)] overflow-y-auto rounded-xl border border-slate-200 bg-white">
              {visibleProjects.length === 0 ? (
                <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-slate-400">
                  <Search className="h-5 w-5" />
                  <span className="text-xs font-semibold">没有匹配的项目</span>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {visibleProjects.map((project) => {
                    const fullIndex = projects.findIndex((item) => item.id === project.id);
                    const device = deviceForProject(devices, project);
                    const deviceName = deviceDisplayName(device, project.device_id);
                    const selected = project.id === currentProjectId;
                    const online = Boolean(device?.workspaces);
                    return (
                      <li key={project.id}>
                        <div
                          className={cn(
                            "grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5 transition-colors",
                            selected ? "bg-indigo-50/70" : "bg-white hover:bg-slate-50"
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => selectProject(project.id)}
                            className="min-w-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", selected ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500")}>
                                <FolderGit2 className="h-3.5 w-3.5" />
                              </span>
                              <span className="min-w-0">
                                <span className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-xs font-bold text-slate-800">{project.name}</span>
                                  {selected && <Check className="h-3.5 w-3.5 shrink-0 text-indigo-600" />}
                                </span>
                                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-slate-500">
                                  <Server className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{deviceName}</span>
                                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-slate-300")} />
                                </span>
                              </span>
                            </span>
                            <span className="mt-1 block truncate pl-9 font-mono text-[10px] text-slate-400" title={project.workspace_path}>
                              {project.workspace_path}
                            </span>
                          </button>

                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={fullIndex <= 0}
                              onClick={() => onMoveProject(project.id, "up")}
                              title="上移"
                              aria-label={`${project.name} 上移`}
                              className="text-slate-500 hover:text-slate-800"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={fullIndex === -1 || fullIndex >= projects.length - 1}
                              onClick={() => onMoveProject(project.id, "down")}
                              title="下移"
                              aria-label={`${project.name} 下移`}
                              className="text-slate-500 hover:text-slate-800"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
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
  className,
}: ProjectNavMenuProps) {
  return (
    <nav
      className={cn("min-w-0", className)}
      aria-label="项目列表"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain">
        {projects.length === 0 ? (
          <div className="flex h-7 items-center gap-1.5 rounded-md border border-dashed border-slate-200 px-2 text-[11px] font-semibold text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <FolderGit2 className="h-3.5 w-3.5" />
            暂无项目
          </div>
        ) : (
          projects.map((project, index) => {
            const device = deviceForProject(devices, project);
            const deviceName = deviceDisplayName(device, project.device_id);
            const selected = project.id === currentProjectId;
            const alerting = alertProjectIds.has(project.id);
            const online = Boolean(device?.workspaces);
            return (
              <div key={project.id} className="flex shrink-0 items-center gap-1">
                {index > 0 && <span className="h-3 w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />}
                <button
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                  data-alert={alerting ? "true" : "false"}
                  className={cn(
                    "studio-project-nav-item relative flex h-7 min-w-0 items-center gap-1.5 overflow-hidden rounded-md border px-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400",
                    selected
                      ? "border-indigo-200 bg-indigo-50 text-indigo-700 shadow-sm shadow-indigo-500/5 dark:border-indigo-900/70 dark:bg-indigo-950/35 dark:text-indigo-300"
                      : "border-transparent bg-slate-50/70 text-slate-600 hover:border-slate-200 hover:bg-white dark:bg-slate-900/45 dark:text-slate-400 dark:hover:border-slate-800 dark:hover:bg-slate-800/70"
                  )}
                  title={`${deviceName} / ${project.name}`}
                  aria-current={selected ? "page" : undefined}
                >
                  <span className={cn("relative z-10 h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600")} />
                  <span className="relative z-10 flex min-w-0 max-w-[240px] items-center gap-1 text-[11px] leading-none">
                    <span className="truncate font-semibold text-slate-500 dark:text-slate-400">
                      {deviceName}
                    </span>
                    <span className="text-slate-300 dark:text-slate-600">/</span>
                    <span className={cn("truncate font-bold", selected ? "text-indigo-700 dark:text-indigo-200" : "text-slate-700 dark:text-slate-300")}>
                      {project.name}
                    </span>
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </nav>
  );
}

function deviceForProject(devices: Device[], project: Project) {
  return devices.find((device) => device.id === project.device_id);
}

function deviceDisplayName(device: Device | undefined, fallback = "") {
  const raw = (device?.name || fallback).trim();
  if (!raw) return fallback;
  const withoutProtocol = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = withoutProtocol.split(/[/:?#]/, 1)[0] || withoutProtocol;
  return host.split(".")[0] || host || raw;
}
