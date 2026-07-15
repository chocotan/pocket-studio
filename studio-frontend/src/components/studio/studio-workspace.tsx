import React, { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ArrowLeft, ChevronDown, ChevronUp, LayoutGrid, Palette, Check, Cable, Layers, FolderTree, FileText, Plus, Lock, Unlock, Monitor, Folder } from "lucide-react";
import type { Device } from "@/lib/types";
import { type StudioTheme, terminalType, terminalTypeFromCommand, terminalKindFromAgentKind, cleanTerminalTitle, type TerminalTitleState } from "./terminal-types";
import type { Project } from "./studio-dashboard";
import { EmptyWorkspace } from "./empty-workspace";
import { ProjectNavMenu, ProjectSwitcher, deviceDisplayName } from "./project-switcher";
import {
  normalizeSizes,
  sizesFromLayoutMap,
  splitLayoutMap,
  type LayoutNode,
  type SplitGroup,
  type StudioTab,
  type TerminalPanel,
} from "./studio-layout";
import { TerminalPanelView, TerminalTypeMenu } from "./terminal-panel-view";
import { FloatingWindow } from "./floating-window";
import { ZoomSelect } from "./zoom-select";
import { NotificationCenter } from "./notification-center";
import type { PageZoom } from "@/lib/zoom";
import type { NotificationHostTarget, NotificationJumpTarget, TerminalNotification } from "./terminal-notifications";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import { updateSplitSizes } from "./studio-layout-ops";

interface StudioWorkspaceProps {
  projectId: string;
  project: Project;
  projects: Project[];
  favoriteProjects: Project[];
  favoriteIds: Set<string>;
  onToggleFavorite: (projectId: string) => void;
  onMoveFavorite: (projectId: string, direction: "up" | "down") => void;
  onDirectModeChange: (projectId: string, directMode: boolean) => void;
  devices: Device[];
  pageZoom: PageZoom;
  onPageZoomChange: (zoom: PageZoom) => void;
  onSelectProject: (projectId: string) => void;
  onTerminalFocused?: (projectId: string, tabId: string) => void;
  notificationJumpTarget?: NotificationJumpTarget | null;
  onNotificationJumpHandled?: (nonce: number) => void;
  onNotificationTargetsChange?: (hostProjectId: string, targets: NotificationHostTarget[]) => void;
  alertProjectIds?: Set<string>;
  alertTerminalIds?: Set<string>;
  notifications?: TerminalNotification[];
  notificationCenterOpen?: boolean;
  onNotificationCenterOpenChange?: (open: boolean) => void;
  onSelectNotification?: (notification: TerminalNotification) => void;
  onMarkAllNotificationsRead?: () => void;
  onBackToDashboard: () => void;
  onProjectUpdated?: (project: Project) => void;
}

const STUDIO_NAV_HIDDEN_KEY = "pocket-studio-nav-hidden";
const FLOATING_DOCK_AUTO_HIDE_KEY = "pocket-studio-floating-dock-auto-hide";

export function StudioWorkspace({
  projectId,
  project,
  projects,
  favoriteProjects,
  favoriteIds,
  onToggleFavorite,
  onMoveFavorite,
  onDirectModeChange,
  devices,
  pageZoom,
  onPageZoomChange,
  onSelectProject,
  onTerminalFocused = () => {},
  notificationJumpTarget = null,
  onNotificationJumpHandled = () => {},
  onNotificationTargetsChange = () => {},
  alertProjectIds = new Set<string>(),
  alertTerminalIds = new Set<string>(),
  notifications = [],
  notificationCenterOpen = false,
  onNotificationCenterOpenChange = () => {},
  onSelectNotification = () => {},
  onMarkAllNotificationsRead = () => {},
  onBackToDashboard,
  onProjectUpdated = () => {},
}: StudioWorkspaceProps) {
  const [theme, setTheme] = useState<StudioTheme>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const urlTheme = params.get("theme");
      if (urlTheme === "light" || urlTheme === "claude" || urlTheme === "sandalwood" || urlTheme === "dark" || urlTheme === "synthwave" || urlTheme === "onedark" || urlTheme === "charcoal") {
        return urlTheme as StudioTheme;
      }
      const saved = localStorage.getItem("pocket-studio-theme");
      if (saved === "light" || saved === "claude" || saved === "sandalwood" || saved === "dark" || saved === "synthwave" || saved === "onedark" || saved === "charcoal") {
        return saved as StudioTheme;
      }
    }
    return "light";
  });
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [dockMenuOpen, setDockMenuOpen] = useState(false);
  const [dockAutoHide, setDockAutoHide] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(FLOATING_DOCK_AUTO_HIDE_KEY) === "true";
  });
  const [dockGrouping, setDockGrouping] = useState<"none" | "project" | "machine">((() => {
    if (typeof window === "undefined") return "project";
    const saved = localStorage.getItem("pocket-studio-dock-grouping");
    if (saved === "false" || saved === "none") return "none";
    if (saved === "machine") return "machine";
    return "project";
  }));
  const [dockHovering, setDockHovering] = useState(false);
  const [dockRevealed, setDockRevealed] = useState(false);
  const dockRevealTimerRef = useRef<number | null>(null);
  const previousFocusedIdRef = useRef("");
  const previousTopFloatingPanelIdRef = useRef("");
  const [navHidden, setNavHidden] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STUDIO_NAV_HIDDEN_KEY) === "true";
  });
  const [projectListOpen, setProjectListOpen] = useState(false);
  const panelScale = pageZoom / 100;

  const {
    layoutTree,
    setLayoutTree,
    focusedId,
    tabDragTarget,
    setTabDragTarget,
    isDraggingTab,
    setIsDraggingTab,
    terminalTitles,
    workspaceSwitchToken,
    stateLoaded,
    loadedProjectId,
    layoutVersion,
    setLayoutVersion,
    addMenuPanelId,
    setAddMenuPanelId,
    handleFocus,
    handleSplit,
    handleClosePanel,
    handleAddTab,
    handleAddFileExplorer,
    handleAddAgentChat,
    handleUpdateTabProperties,
    handleOpenFile,
    handleActiveTab,
    handleCloseTab,
    handleTabDragMove,
    handleTabDragEnd,
    handleTerminalTitle,
    handleTerminalFocus,
    handleCreateInitialPanel,
    handleCreateInitialFileExplorer,
    handleCreateNewPanel,
    handleCreateNewFileExplorer,
    handleCreateNewAgentChat,
    layoutMode,
    setLayoutMode,
    floatingPanels,
    setFloatingPanels,
    focusFloatingPanel,
    panels,
  } = useWorkspaceLayout({
    projectId,
    project,
    projects,
    alertTerminalIds,
    onTerminalFocused,
    notificationJumpTarget,
    onNotificationJumpHandled,
    onNotificationTargetsChange,
  });
  const currentDevice = devices.find((device) => device.id === project.device_id);

  useEffect(() => {
    localStorage.setItem("pocket-studio-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STUDIO_NAV_HIDDEN_KEY, String(navHidden));
    if (navHidden) setThemeMenuOpen(false);
  }, [navHidden]);

  useEffect(() => {
    localStorage.setItem(FLOATING_DOCK_AUTO_HIDE_KEY, String(dockAutoHide));
    if (!dockAutoHide) {
      setDockHovering(false);
      setDockRevealed(false);
    }
  }, [dockAutoHide]);

  useEffect(() => {
    localStorage.setItem("pocket-studio-dock-grouping", dockGrouping);
  }, [dockGrouping]);

  useEffect(() => {
    return () => {
      if (dockRevealTimerRef.current !== null) {
        window.clearTimeout(dockRevealTimerRef.current);
      }
    };
  }, []);

  function revealDockBriefly() {
    if (!dockAutoHide) return;
    setDockRevealed(true);
    if (dockRevealTimerRef.current !== null) {
      window.clearTimeout(dockRevealTimerRef.current);
    }
    dockRevealTimerRef.current = window.setTimeout(() => {
      dockRevealTimerRef.current = null;
      setDockRevealed(false);
    }, 1400);
  }

  function focusFloatingPanelAndRevealDock(panelId: string) {
    focusFloatingPanel(panelId);
    revealDockBriefly();
  }

  useEffect(() => {
    const previousFocusedId = previousFocusedIdRef.current;
    previousFocusedIdRef.current = focusedId;
    if (!previousFocusedId || previousFocusedId === focusedId) return;
    if (layoutMode === "floating") revealDockBriefly();
  }, [focusedId, layoutMode, dockAutoHide]);

  useEffect(() => {
    if (layoutMode === "floating" && workspaceSwitchToken > 0) revealDockBriefly();
  }, [workspaceSwitchToken, layoutMode, dockAutoHide]);

  useEffect(() => {
    if (layoutMode !== "floating") {
      previousTopFloatingPanelIdRef.current = "";
      return;
    }
    const topPanelId = Object.entries(floatingPanels)
      .filter(([, panel]) => !panel.isMinimized)
      .sort(([, a], [, b]) => b.zIndex - a.zIndex)[0]?.[0] || "";
    const previousTopPanelId = previousTopFloatingPanelIdRef.current;
    previousTopFloatingPanelIdRef.current = topPanelId;
    if (!previousTopPanelId || previousTopPanelId === topPanelId) return;
    revealDockBriefly();
  }, [floatingPanels, layoutMode, dockAutoHide]);

  function toggleDirectMode() {
    const desiredDirectMode = !project.direct_mode;
    onDirectModeChange(projectId, desiredDirectMode);
    onProjectUpdated({ ...project, direct_mode: desiredDirectMode });
  }

  function renderNode(node: LayoutNode): React.ReactNode {
    if (node.type === "panel") {
      return (
        <TerminalPanelView
          key={node.id}
          panel={node}
          focused={focusedId === node.id}
          addMenuPanelId={addMenuPanelId}
          dragTarget={tabDragTarget}
          isDraggingTab={isDraggingTab}
          projectId={projectId}
          project={project}
          projects={projects}
          devices={devices}
          workspacePath={project.workspace_path}
          onFocus={handleFocus}
          onAddMenu={(panelId) => setAddMenuPanelId((prev) => prev === panelId ? null : panelId)}
          onSplitSelect={handleSplit}
          onAddTab={handleAddTab}
          onAddFileExplorer={handleAddFileExplorer}
          onAddAgentChat={handleAddAgentChat}
          onUpdateTabProperties={handleUpdateTabProperties}
          onOpenFile={handleOpenFile}
          onActiveTab={handleActiveTab}
          onCloseTab={handleCloseTab}
          layoutMode={layoutMode}
          onCreateNewPanel={handleCreateNewPanel}
          onCreateNewFileExplorer={handleCreateNewFileExplorer}
          onCreateNewAgentChat={handleCreateNewAgentChat}
          onTabDragStart={() => setIsDraggingTab(true)}
          onTabDragMove={handleTabDragMove}
          onTabDragEnd={handleTabDragEnd}
          onTabDragCancel={() => {
            setTabDragTarget(null);
            setIsDraggingTab(false);
          }}
          onClosePanel={handleClosePanel}
          onTitleChange={handleTerminalTitle}
          onTerminalFocus={handleTerminalFocus}
          terminalTitles={terminalTitles}
          alertTerminalIds={alertTerminalIds}
          layoutVersion={layoutVersion}
          theme={theme}
          scale={panelScale}
        />
      );
    }

    return renderSplitGroup(node);
  }

  function renderSplitGroup(node: SplitGroup): React.ReactNode {
    const isH = node.orientation === "horizontal";
    return (
      <Group
        key={node.id}
        id={node.id}
        orientation={isH ? "horizontal" : "vertical"}
        defaultLayout={splitLayoutMap(node)}
        onLayoutChanged={(layout) => {
          setLayoutTree((prev) => prev ? updateSplitSizes(prev, node.id, sizesFromLayoutMap(node, layout)) : prev);
          setLayoutVersion((value) => value + 1);
        }}
        style={{
          display: "flex",
          flexDirection: isH ? "row" : "column",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {node.children.map((child, i) => (
          <React.Fragment key={child.id || i}>
            {i > 0 && (
              <Separator
                className={isH ? "resize-handle-horizontal" : "resize-handle-vertical"}
              />
            )}
            <Panel
              id={child.id}
              minSize={10}
              defaultSize={normalizeSizes(node.sizes || [], node.children.length)[i]}
              style={{ position: "relative", overflow: "visible", minWidth: 0, minHeight: 0, zIndex: child.type === "panel" && child.focus ? 2 : 1 }}
            >
              {renderNode(child)}
            </Panel>
          </React.Fragment>
        ))}
      </Group>
    );
  }

  const renderTabButton = (tab: StudioTab, panel: TerminalPanel) => {
    const float = floatingPanels[panel.id];
    const isMinimized = float?.isMinimized;
    const isPanelFocused = focusedId === panel.id && !isMinimized;
    const isActive = isPanelFocused && panel.activeTabId === tab.id;

    const isFileExplorer = tab.kind === "file_explorer";
    const isFileViewer = tab.kind === "file_viewer";
    const liveTitle = tab.kind === "terminal" ? terminalTitles[tab.id] : undefined;
    const activeCommand = liveTitle?.command || tab.activeCommand || "";
    const displayType = terminalType(
      tab.kind === "agent_chat"
        ? terminalKindFromAgentKind(tab.agentKind)
        : terminalTypeFromCommand(activeCommand, tab.termType)
    );

    const isCrossProject = (tab.projectId || projectId) !== projectId;
    const tabProject = projects.find((proj) => proj.id === (tab.projectId || projectId));
    const tabDevice = tabProject ? devices.find((device) => device.id === tabProject.device_id) : undefined;
    const tabDeviceName = tabProject ? deviceDisplayName(tabDevice, tabProject.device_id) : "";
    const crossProjectLabel = tabProject ? `${tabDeviceName}/${tabProject.name}` : "";

    return (
      <button
        key={tab.id}
        type="button"
        onClick={() => {
          if (isMinimized) {
            setFloatingPanels((prev) => ({
              ...prev,
              [panel.id]: { ...prev[panel.id], isMinimized: false }
            }));
            handleActiveTab(panel.id, tab.id);
            focusFloatingPanelAndRevealDock(panel.id);
          } else if (isActive) {
            setFloatingPanels((prev) => ({
              ...prev,
              [panel.id]: { ...prev[panel.id], isMinimized: true }
            }));
            revealDockBriefly();
          } else {
            handleActiveTab(panel.id, tab.id);
            focusFloatingPanelAndRevealDock(panel.id);
          }
        }}
        className={`relative flex h-5 items-center gap-1.5 px-2 text-[10px] font-semibold border rounded-md transition-all duration-200 active:scale-95 ${
          isActive
            ? "bg-indigo-600 border-indigo-600 text-white shadow-sm shadow-indigo-500/25"
            : (panel.activeTabId === tab.id && isMinimized)
              ? "bg-muted/40 border-border/40 text-muted-foreground opacity-60 hover:opacity-100"
              : "bg-card border-border text-foreground hover:bg-accent"
        }`}
        title={tabProject && isCrossProject ? `${tabDeviceName} / ${tabProject.name}` : tab.title}
      >
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded">
          {isFileExplorer ? (
            <FolderTree className="h-3 w-3 text-sky-500" />
          ) : isFileViewer ? (
            <FileText className="h-3 w-3 text-emerald-500" />
          ) : (
            displayType.logo
          )}
        </span>
        <span className="w-[120px] truncate text-[10px] pr-1.5 flex-shrink-0">
          {tab.kind === "file_explorer"
            ? "文件"
            : tab.kind === "file_viewer"
              ? tab.title
              : tab.kind === "agent_chat"
                ? tab.title
                : cleanTerminalTitle(liveTitle?.title || tab.title, terminalType(tab.termType).title, tab.termType)
          }
        </span>
        
        {isCrossProject && tabProject && (
          <span className="absolute -top-1.5 -right-1.5 max-w-[96px] truncate rounded border border-amber-600 bg-amber-500 px-1 text-[7px] font-bold text-white shadow-sm">
            {crossProjectLabel}
          </span>
        )}
      </button>
    );
  };

  const handleCycleGrouping = () => {
    setDockGrouping((prev) => {
      if (prev === "none") return "project";
      if (prev === "project") return "machine";
      return "none";
    });
  };

  // Grouping logic for the dock
  const allTabs = panels.flatMap((p) => p.tabs.map((t) => ({ tab: t, panel: p })));
  const groupsMap = new Map<string, {
    machineName: string;
    directory: string;
    tabs: Array<{ tab: StudioTab; panel: TerminalPanel }>;
  }>();

  allTabs.forEach(({ tab, panel }) => {
    const tabProjectId = tab.projectId || projectId;
    const tabProject = projects.find((p) => p.id === tabProjectId) || project;
    const tabDevice = devices.find((d) => d.id === tabProject?.device_id);
    const machineName = deviceDisplayName(tabDevice, tabProject?.device_id || "未知机器");
    const directory = getTabDirectory(tab, tab.kind === "terminal" ? terminalTitles[tab.id] : undefined, tabProject?.workspace_path);
    
    const groupKey = dockGrouping === "machine" ? machineName : `${machineName}::${directory}`;
    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, {
        machineName,
        directory,
        tabs: []
      });
    }
    groupsMap.get(groupKey)!.tabs.push({ tab, panel });
  });

  const groupedList = Array.from(groupsMap.values());
  groupedList.sort((a, b) => {
    if (a.machineName !== b.machineName) {
      return a.machineName.localeCompare(b.machineName);
    }
    return a.directory.localeCompare(b.directory);
  });

  const uniqueMachines = Array.from(new Set(groupedList.map((g) => g.machineName)));
  const hasMultipleMachines = uniqueMachines.length > 1;

  return (
    <div
      data-testid="studio-workspace"
      data-project-id={projectId}
      data-state-loaded={stateLoaded && loadedProjectId === projectId ? "true" : "false"}
      onClick={() => {
        setAddMenuPanelId(null);
        setThemeMenuOpen(false);
      }}
      className={`studio-square bg-background text-foreground select-none flex flex-col overflow-hidden theme-${theme} ${theme === "dark" || theme === "synthwave" || theme === "onedark" || theme === "charcoal" ? "dark" : ""}`}
      style={{
        width: "100dvw",
        height: "100dvh",
        fontFamily: "var(--font-sans)",
      }}
    >
      {!navHidden && (
        <header className="studio-header shrink-0 h-7 flex items-center gap-1.5 px-2 z-50 shadow-sm transition-colors duration-150">
          <div
            onClick={onBackToDashboard}
            className="flex h-6 shrink-0 items-center gap-1.5 cursor-pointer hover:opacity-80 active:scale-95 transition-all select-none"
            title="返回"
          >
            <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-indigo-600 shadow-sm shadow-indigo-500/25">
              <span className="text-white font-black text-[8px] leading-none">P</span>
            </div>
            <span className="hidden font-bold text-foreground text-xs tracking-tight sm:inline">Pocket Studio</span>
            <span className="hidden h-6 items-center px-1 text-[8px] uppercase font-bold tracking-widest bg-indigo-50 text-indigo-600 rounded border border-indigo-100 dark:bg-indigo-950/40 dark:text-indigo-400 dark:border-indigo-900/60 md:flex">
              PRO
            </span>
          </div>

          <ProjectNavMenu
            projects={favoriteProjects}
            devices={devices}
            currentProjectId={projectId}
            alertProjectIds={new Set([...alertProjectIds].filter((id) => id !== projectId))}
            onSelectProject={onSelectProject}
            onAddFavorite={() => setProjectListOpen(true)}
            onRemoveFavorite={onToggleFavorite}
            onMoveFavorite={onMoveFavorite}
            className="flex-1"
          />

          <div className="flex shrink-0 items-center gap-1">
            <ProjectSwitcher
              projects={projects}
              favoriteProjects={favoriteProjects}
              favoriteIds={favoriteIds}
              devices={devices}
              currentProjectId={projectId}
              onSelectProject={onSelectProject}
              onToggleFavorite={onToggleFavorite}
              onDirectModeChange={onDirectModeChange}
              open={projectListOpen}
              onOpenChange={setProjectListOpen}
              triggerClassName="hidden md:flex"
            />

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                toggleDirectMode();
              }}
              className={`flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10px] font-bold transition-colors ${project.direct_mode ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}
              title={project.direct_mode ? `直连已开启：${project.direct_endpoint?.terminal_ws_url || "等待 daemon 上报端点"}` : "开启后 Terminal 与 Agent Chat WebSocket 将直连 daemon"}
            >
              <Cable className="h-3 w-3" />
              <span className="hidden lg:inline">{project.direct_mode ? "直连" : "中转"}</span>
            </button>
            <NotificationCenter
              notifications={notifications}
              open={notificationCenterOpen}
              onOpenChange={onNotificationCenterOpenChange}
              onSelect={onSelectNotification}
              onMarkAllRead={onMarkAllNotificationsRead}
            />
            <ZoomSelect value={pageZoom} onChange={onPageZoomChange} compact />

            {/* Display Mode Toggle */}
            <div className="flex h-6 items-center rounded-md bg-muted/30">
              <button
                type="button"
                onClick={() => setLayoutMode("grid")}
                className={`flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground transition-all cursor-pointer ${
                  layoutMode === "grid"
                    ? "bg-accent text-accent-foreground shadow-sm font-bold"
                    : "text-muted-foreground"
                }`}
                title="平铺网格模式 / Grid Mode"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode("floating")}
                className={`flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground transition-all cursor-pointer ${
                  layoutMode === "floating"
                    ? "bg-accent text-accent-foreground shadow-sm font-bold"
                    : "text-muted-foreground"
                }`}
                title="悬浮窗口模式 / Floating Windows Mode"
              >
                <Layers className="h-3.5 w-3.5" />
              </button>
            </div>


            <div className="h-4 w-px bg-border" />

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setNavHidden(true);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors cursor-pointer"
              title="隐藏顶部栏"
            >
              <ChevronUp className="h-4 w-4" />
            </button>

            {/* Theme Dropdown Selector */}
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setThemeMenuOpen(!themeMenuOpen);
                }}
                className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors cursor-pointer"
                title="切换主题 / Switch Theme"
              >
                <Palette className="h-4 w-4" />
              </button>

              {themeMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40 cursor-default" onClick={() => setThemeMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border bg-card text-card-foreground p-1.5 shadow-lg z-50 animate-scale-in">
                    <div className="px-2.5 py-1.5 text-[9px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border mb-1">
                      选择主题 / Themes
                    </div>
                    {[
                      { id: "light" as const, name: "极光白 (Light)", preview: "bg-[#fafafa] border-slate-350" },
                      { id: "claude" as const, name: "Claude 暖白", preview: "bg-[#f7f1e8] border-[#b66a2c]" },
                      { id: "sandalwood" as const, name: "古雅檀香 (Sandalwood)", preview: "bg-[#f9f6f0] border-[#c86446]" },
                      { id: "dark" as const, name: "暗夜黑 (Dark)", preview: "bg-[#121824] border-slate-700" },
                      { id: "synthwave" as const, name: "霓虹幻境 (Synthwave)", preview: "bg-[#1c0d2e] border-fuchsia-900" },
                      { id: "onedark" as const, name: "黑客帝国 (One Dark)", preview: "bg-[#1e222a] border-slate-800" },
                      { id: "charcoal" as const, name: "柔和深灰 (Charcoal)", preview: "bg-[#383d47] border-[#6ca7c3]" },
                    ].map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setTheme(t.id);
                          setThemeMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                          theme === t.id
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`w-2.5 h-2.5 rounded-full border ${t.preview}`} />
                          <span>{t.name}</span>
                        </div>
                        {theme === t.id && <Check className="h-3.5 w-3.5 text-accent-foreground" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Back button */}
            <button
              type="button"
              onClick={onBackToDashboard}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-card hover:bg-muted text-foreground border border-border shadow-sm transition-all active:scale-95 duration-150 cursor-pointer hover:text-accent-foreground"
              title="返回"
              aria-label="返回"
            >
              <ArrowLeft className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            </button>
          </div>
        </header>
      )}

      {navHidden && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setNavHidden(false);
          }}
          className="fixed left-1/2 top-0 z-50 flex h-3.5 w-7 -translate-x-1/2 items-center justify-center rounded-b border-x border-b border-border/60 bg-card/80 text-muted-foreground opacity-70 shadow-sm transition-[height,opacity,color,background-color] hover:h-5 hover:bg-card hover:text-foreground hover:opacity-100"
          title="显示顶部栏"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-[#0f131c] transition-colors duration-150 relative">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            className="absolute left-0 top-0"
            style={{
              width: `${100 / panelScale}%`,
              height: `${100 / panelScale}%`,
              transform: `scale(${panelScale})`,
              transformOrigin: "top left",
            }}
          >
            {layoutMode === "grid" ? (
              layoutTree ? (
                renderNode(layoutTree)
              ) : (
                <EmptyWorkspace
                  device={currentDevice}
                  onCreate={handleCreateInitialPanel}
                  onCreateFileExplorer={handleCreateInitialFileExplorer}
                />
              )
            ) : (
              /* Floating Mode Desktop */
              <div 
                className="relative w-full h-full overflow-hidden"
                style={{
                  backgroundImage: theme === "dark" || theme === "synthwave" || theme === "onedark" || theme === "charcoal"
                    ? "radial-gradient(rgba(255,255,255,0.06) 1px, transparent 0)"
                    : "radial-gradient(rgba(0,0,0,0.06) 1px, transparent 0)",
                  backgroundSize: "24px 24px"
                }}
              >
                {panels.length === 0 ? (
                  <EmptyWorkspace
                    device={currentDevice}
                    onCreate={handleCreateInitialPanel}
                    onCreateFileExplorer={handleCreateInitialFileExplorer}
                  />
                ) : (
                  panels.map((p) => {
                    const floatState = floatingPanels[p.id];
                    if (!floatState) return null;

                    return (
                      <FloatingWindow
                        key={p.id}
                        id={p.id}
                        x={floatState.x}
                        y={floatState.y}
                        width={floatState.width}
                        height={floatState.height}
                        zIndex={floatState.zIndex}
                        isMaximized={floatState.isMaximized}
                        isMinimized={floatState.isMinimized}
                        focused={focusedId === p.id && !floatState.isMinimized}
                        scale={panelScale}
                        onFocus={() => focusFloatingPanelAndRevealDock(p.id)}
                        onUpdatePosition={(newX, newY) => {
                          setFloatingPanels((prev) => ({
                            ...prev,
                            [p.id]: { ...prev[p.id], x: newX, y: newY },
                          }));
                        }}
                        onUpdateSize={(newX, newY, newW, newH) => {
                          setFloatingPanels((prev) => ({
                            ...prev,
                            [p.id]: {
                              ...prev[p.id],
                              x: newX,
                              y: newY,
                              width: newW,
                              height: newH,
                            },
                          }));
                        }}
                        onToggleMaximize={() => {
                          setFloatingPanels((prev) => ({
                            ...prev,
                            [p.id]: {
                              ...prev[p.id],
                              isMaximized: !prev[p.id].isMaximized,
                            },
                          }));
                        }}
                        onMinimize={() => {
                          setFloatingPanels((prev) => ({
                            ...prev,
                            [p.id]: { ...prev[p.id], isMinimized: true },
                          }));
                        }}
                      >
                        {(floatProps) => (
                          <TerminalPanelView
                            key={p.id}
                            panel={p}
                            focused={focusedId === p.id}
                            addMenuPanelId={addMenuPanelId}
                            dragTarget={tabDragTarget}
                            isDraggingTab={isDraggingTab}
                            projectId={projectId}
                            project={project}
                            projects={projects}
                            devices={devices}
                            workspacePath={project.workspace_path}
                            onFocus={(panelId) => {
                              handleFocus(panelId);
                              revealDockBriefly();
                            }}
                            onAddMenu={(panelId) => setAddMenuPanelId((prev) => prev === panelId ? null : panelId)}
                            onSplitSelect={handleSplit}
                            onAddTab={handleAddTab}
                            onAddFileExplorer={handleAddFileExplorer}
                            onAddAgentChat={handleAddAgentChat}
                            onUpdateTabProperties={handleUpdateTabProperties}
                            onOpenFile={handleOpenFile}
                            onActiveTab={handleActiveTab}
                            onCloseTab={handleCloseTab}
                            layoutMode={layoutMode}
                            onCreateNewPanel={handleCreateNewPanel}
                            onCreateNewFileExplorer={handleCreateNewFileExplorer}
                            onCreateNewAgentChat={handleCreateNewAgentChat}
                            onTabDragStart={() => setIsDraggingTab(true)}
                            onTabDragMove={handleTabDragMove}
                            onTabDragEnd={handleTabDragEnd}
                            onTabDragCancel={() => {
                              setTabDragTarget(null);
                              setIsDraggingTab(false);
                            }}
                            onClosePanel={handleClosePanel}
                            onTitleChange={handleTerminalTitle}
                            onTerminalFocus={handleTerminalFocus}
                            terminalTitles={terminalTitles}
                            alertTerminalIds={alertTerminalIds}
                            layoutVersion={layoutVersion}
                            theme={theme}
                            scale={panelScale}
                            {...floatProps}
                          />
                        )}
                      </FloatingWindow>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {/* Dock Taskbar for Floating Mode */}
        {layoutMode === "floating" && (
          <>
            {dockAutoHide && (
              <div
                className="absolute bottom-0 left-0 right-0 z-[99] h-3"
                onPointerEnter={() => setDockHovering(true)}
              />
            )}
            <div
              className={`absolute left-1/2 z-[100] flex items-center gap-1.5 backdrop-blur-md bg-white/70 dark:bg-slate-900/70 border border-border/80 shadow-lg rounded-xl px-3 py-0.5 transition-[transform,opacity] duration-200 ease-out ${
                dockAutoHide && !dockHovering && !dockMenuOpen && !dockRevealed
                  ? "bottom-0 translate-y-[calc(100%-4px)] -translate-x-1/2 opacity-35"
                  : "bottom-0.5 -translate-x-1/2 translate-y-0 opacity-100"
              }`}
              onPointerEnter={() => setDockHovering(true)}
              onPointerLeave={() => setDockHovering(false)}
            >
              <button
                type="button"
                onClick={() => setDockAutoHide((prev) => !prev)}
                className={`flex h-5 w-5 items-center justify-center rounded-md border transition-all duration-200 hover:scale-105 active:scale-95 shadow-sm cursor-pointer ${
                  dockAutoHide
                    ? "bg-muted/40 border-border/40 text-muted-foreground hover:bg-accent hover:text-foreground"
                    : "bg-indigo-600 border-indigo-600 text-white"
                }`}
                title={dockAutoHide ? "Dock 自动隐藏已开启" : "Dock 固定显示"}
              >
                {dockAutoHide ? <Unlock className="h-3 w-3 shrink-0" /> : <Lock className="h-3 w-3 shrink-0" />}
              </button>

              <button
                type="button"
                onClick={handleCycleGrouping}
                className={`flex h-5 w-5 items-center justify-center rounded-md border transition-all duration-200 hover:scale-105 active:scale-95 shadow-sm cursor-pointer ${
                  dockGrouping !== "none"
                    ? "bg-indigo-600 border-indigo-600 text-white"
                    : "bg-muted/40 border-border/40 text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                title={
                  dockGrouping === "none"
                    ? "Dock 自动分组：已关闭 (点击切换为按项目分组)"
                    : dockGrouping === "project"
                      ? "Dock 自动分组：按项目分组 (点击切换为按机器分组)"
                      : "Dock 自动分组：按机器分组 (点击切换为关闭分组)"
                }
              >
                {dockGrouping === "machine" ? (
                  <Monitor className="h-3 w-3 shrink-0" />
                ) : (
                  <FolderTree className="h-3 w-3 shrink-0" />
                )}
              </button>

              <div className="h-4 w-px bg-border/80 mx-1.5" />

              {dockGrouping !== "none" ? (
                groupedList.map((group, groupIdx) => {
                  const shortDir = getShortDirectoryName(group.directory, project.workspace_path);
                  return (
                    <div
                      key={groupIdx}
                      className="flex h-6 items-center gap-1 bg-black/5 dark:bg-white/5 border border-border/40 rounded-lg px-1 transition-all duration-200 hover:border-indigo-500/30 flex-shrink-0"
                    >
                      {/* Group Header Badge */}
                      <div
                        className="flex h-5 items-center gap-1 text-[9px] font-semibold text-muted-foreground bg-muted/50 dark:bg-slate-800/60 hover:bg-muted/80 dark:hover:bg-slate-800/80 px-1.5 rounded border border-border/30 select-none cursor-help flex-shrink-0 transition-colors"
                        title={`机器: ${group.machineName}\n目录: ${group.directory}`}
                      >
                        {dockGrouping === "machine" ? (
                          <Monitor className={`h-3 w-3 shrink-0 ${getMachineColorClass(group.machineName)}`} />
                        ) : hasMultipleMachines ? (
                          <Monitor className={`h-3 w-3 shrink-0 ${getMachineColorClass(group.machineName)}`} />
                        ) : (
                          <Folder className="h-3 w-3 text-amber-500/80 shrink-0" />
                        )}
                        <span className="truncate w-[60px] text-[10px] flex-shrink-0">
                          {dockGrouping === "machine" ? group.machineName : shortDir}
                        </span>
                      </div>
                      
                      {/* Tabs in this group */}
                      <div className="flex items-center gap-1">
                        {group.tabs.map(({ tab, panel }) => renderTabButton(tab, panel))}
                      </div>
                    </div>
                  );
                })
              ) : (
                panels.flatMap((p) => p.tabs.map((t) => ({ tab: t, panel: p }))).map(({ tab, panel }) => renderTabButton(tab, panel))
              )}

              {panels.length > 0 && (
                <div className="h-4 w-px bg-border/80 mx-1.5" />
              )}

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setDockMenuOpen((prev) => !prev)}
                  className="flex h-5 w-5 items-center justify-center rounded-md border border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground transition-all duration-250 hover:scale-105 active:scale-95 shadow-sm cursor-pointer"
                  title="新建终端、文件浏览器或 AI 助手窗口"
                >
                  <Plus className="h-3 w-3 text-indigo-500 shrink-0" />
                </button>

                {dockMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40 cursor-default" onClick={() => setDockMenuOpen(false)} />
                    <TerminalTypeMenu
                      align="right"
                      style={{ bottom: "32px", top: "auto", position: "absolute" }}
                      projects={projects}
                      devices={devices}
                      projectId={projectId}
                      onSelect={(kind, tabProjectId) => {
                        handleCreateNewPanel(kind, tabProjectId);
                        setDockMenuOpen(false);
                      }}
                      onFileExplorer={(tabProjectId) => {
                        handleCreateNewFileExplorer(tabProjectId);
                        setDockMenuOpen(false);
                      }}
                      onAddAgentChat={(agentKind, agentRuntime, tabProjectId) => {
                        handleCreateNewAgentChat(agentKind, agentRuntime, tabProjectId);
                        setDockMenuOpen(false);
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function getTabDirectory(
  tab: StudioTab,
  liveTitle?: TerminalTitleState,
  projectWorkspacePath?: string
): string {
  if (tab.kind === "file_explorer") {
    return tab.filePath || projectWorkspacePath || "未知目录";
  }
  if (tab.kind === "file_viewer") {
    if (tab.filePath) {
      const lastSlash = tab.filePath.lastIndexOf("/");
      if (lastSlash !== -1) {
        return tab.filePath.substring(0, lastSlash) || "/";
      }
      return tab.filePath;
    }
    return projectWorkspacePath || "未知目录";
  }
  if (tab.kind === "agent_chat") {
    return projectWorkspacePath || "未知目录";
  }
  // For terminal
  const fullTitle = liveTitle?.fullTitle || "";
  if (fullTitle.startsWith("/") || fullTitle.startsWith("~")) {
    return fullTitle;
  }
  return projectWorkspacePath || "未知目录";
}

function getShortDirectoryName(path: string, projectWorkspacePath?: string): string {
  if (!path || path === "未知目录") return "未知目录";
  if (path === projectWorkspacePath) {
    const lastSlash = path.lastIndexOf("/");
    const name = lastSlash !== -1 ? path.substring(lastSlash + 1) : path;
    return name || "/";
  }
  const lastSlash = path.lastIndexOf("/");
  const name = lastSlash !== -1 ? path.substring(lastSlash + 1) : path;
  return name || "/";
}

const MACHINE_COLORS = [
  "text-indigo-500 dark:text-indigo-400",
  "text-emerald-500 dark:text-emerald-400",
  "text-sky-500 dark:text-sky-400",
  "text-rose-500 dark:text-rose-400",
  "text-amber-500 dark:text-amber-400",
  "text-violet-500 dark:text-violet-400",
];

function getMachineColorClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % MACHINE_COLORS.length;
  return MACHINE_COLORS[index];
}
