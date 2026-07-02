import React, { useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ArrowLeft, ChevronDown, ChevronUp, LayoutGrid, Palette, Check, Cable, Layers, FolderTree, FileText, Plus } from "lucide-react";
import type { Device } from "@/lib/types";
import { type StudioTheme, terminalType, terminalTypeFromCommand, cleanTerminalTitle, type TerminalKind } from "./terminal-types";
import type { Project } from "./studio-dashboard";
import { EmptyWorkspace } from "./empty-workspace";
import { ProjectNavMenu, ProjectSwitcher } from "./project-switcher";
import {
  normalizeSizes,
  sizesFromLayoutMap,
  splitLayoutMap,
  type LayoutNode,
  type SplitGroup,
} from "./studio-layout";
import { TerminalPanelView, TerminalTypeMenu } from "./terminal-panel-view";
import { FloatingWindow } from "./floating-window";
import { ZoomSelect } from "./zoom-select";
import { NotificationCenter } from "./notification-center";
import type { PageZoom } from "@/lib/zoom";
import { postJSON } from "@/lib/api";
import type { NotificationJumpTarget, TerminalNotification } from "./terminal-notifications";
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
  devices: Device[];
  pageZoom: PageZoom;
  onPageZoomChange: (zoom: PageZoom) => void;
  onSelectProject: (projectId: string) => void;
  onTerminalFocused?: (projectId: string, tabId: string) => void;
  notificationJumpTarget?: NotificationJumpTarget | null;
  onNotificationJumpHandled?: (nonce: number) => void;
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

export function StudioWorkspace({
  projectId,
  project,
  projects,
  favoriteProjects,
  favoriteIds,
  onToggleFavorite,
  onMoveFavorite,
  devices,
  pageZoom,
  onPageZoomChange,
  onSelectProject,
  onTerminalFocused = () => {},
  notificationJumpTarget = null,
  onNotificationJumpHandled = () => {},
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
  const [directModeSaving, setDirectModeSaving] = useState(false);
  const [directModeError, setDirectModeError] = useState("");
  const [navHidden, setNavHidden] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STUDIO_NAV_HIDDEN_KEY) === "true";
  });
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
    alertTerminalIds,
    onTerminalFocused,
    notificationJumpTarget,
    onNotificationJumpHandled,
  });

  useEffect(() => {
    localStorage.setItem("pocket-studio-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STUDIO_NAV_HIDDEN_KEY, String(navHidden));
    if (navHidden) setThemeMenuOpen(false);
  }, [navHidden]);


  useEffect(() => {
    setDirectModeError("");
  }, [projectId, project.direct_mode]);

  async function toggleDirectMode() {
    if (directModeSaving) return;
    const desiredDirectMode = !project.direct_mode;
    const previousProject = project;
    setDirectModeError("");
    setDirectModeSaving(true);
    onProjectUpdated({ ...project, direct_mode: desiredDirectMode });
    try {
      const updated = await postJSON<Project>("/api/project/direct-mode", {
        project_id: projectId,
        direct_mode: desiredDirectMode,
      });
      onProjectUpdated(updated);
    } catch (err) {
      console.error("failed to toggle direct mode:", err);
      onProjectUpdated(previousProject);
      setDirectModeError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectModeSaving(false);
    }
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

  return (
    <div
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
        <header className="studio-header shrink-0 h-11 flex items-center gap-2 px-3 z-50 shadow-sm transition-colors duration-150">
          <div className="flex shrink-0 items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-500/25 flex-shrink-0">
              <span className="text-white font-black text-[10px] leading-none">P</span>
            </div>
            <span className="hidden font-bold text-foreground text-xs tracking-tight sm:inline">Pocket Studio</span>
            <span className="hidden px-1.5 py-0.5 text-[9px] uppercase font-bold tracking-widest bg-indigo-50 text-indigo-600 rounded border border-indigo-100 dark:bg-indigo-950/40 dark:text-indigo-400 dark:border-indigo-900/60 md:inline">
              PRO
            </span>
          </div>

          <ProjectNavMenu
            projects={favoriteProjects}
            devices={devices}
            currentProjectId={projectId}
            alertProjectIds={new Set([...alertProjectIds].filter((id) => id !== projectId))}
            onSelectProject={onSelectProject}
            className="flex-1"
          />

          <div className="flex shrink-0 items-center gap-1.5">
            <ProjectSwitcher
              projects={projects}
              favoriteProjects={favoriteProjects}
              favoriteIds={favoriteIds}
              devices={devices}
              currentProjectId={projectId}
              onSelectProject={onSelectProject}
              onToggleFavorite={onToggleFavorite}
              onMoveFavorite={onMoveFavorite}
              triggerClassName="hidden md:flex"
            />

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void toggleDirectMode();
              }}
              disabled={directModeSaving}
              className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[10px] font-bold transition-colors ${project.direct_mode ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground"} disabled:opacity-60`}
              title={project.direct_mode ? `直连终端已开启：${project.direct_endpoint?.terminal_ws_url || "等待 daemon 上报端点"}` : "开启后终端 WebSocket 将直连 daemon，文件/Agent 仍走服务器"}
            >
              <Cable className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{directModeSaving ? "保存中" : project.direct_mode ? "直连" : "中转"}</span>
            </button>
            {directModeError ? (
              <span className="hidden max-w-[260px] truncate rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] font-semibold text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300" title={directModeError}>
                直连切换失败：{directModeError}
              </span>
            ) : null}
            <NotificationCenter
              notifications={notifications}
              open={notificationCenterOpen}
              onOpenChange={onNotificationCenterOpenChange}
              onSelect={onSelectNotification}
              onMarkAllRead={onMarkAllNotificationsRead}
            />
            <ZoomSelect value={pageZoom} onChange={onPageZoomChange} compact />

            {/* Display Mode Toggle */}
            <div className="flex items-center bg-muted/40 p-0.5 rounded-lg border border-border/60">
              <button
                type="button"
                onClick={() => setLayoutMode("grid")}
                className={`p-1.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-all cursor-pointer ${
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
                className={`p-1.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-all cursor-pointer ${
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
              className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors cursor-pointer"
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
                className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors cursor-pointer flex items-center gap-1"
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
              className="flex h-7 w-7 items-center justify-center rounded-md bg-card hover:bg-muted text-foreground border border-border shadow-sm transition-all active:scale-95 duration-150 cursor-pointer hover:text-accent-foreground"
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

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-1 bg-slate-50 dark:bg-[#0f131c] transition-colors duration-150 relative">
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
                        onFocus={() => focusFloatingPanel(p.id)}
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
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-1.5 backdrop-blur-md bg-white/70 dark:bg-slate-900/70 border border-border/80 shadow-lg rounded-xl px-3 py-1.5 animate-in fade-in slide-in-from-bottom-4 duration-300">
            {panels.flatMap((p) => p.tabs.map((t) => ({ tab: t, panel: p }))).map(({ tab, panel }) => {
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
                  ? (tab.agentKind as TerminalKind || "opencode")
                  : terminalTypeFromCommand(activeCommand, tab.termType)
              );
              
              const isCrossProject = (tab.projectId || projectId) !== projectId;
              const tabProject = projects.find((proj) => proj.id === (tab.projectId || projectId));
              
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
                      focusFloatingPanel(panel.id);
                    } else if (isActive) {
                      setFloatingPanels((prev) => ({
                        ...prev,
                        [panel.id]: { ...prev[panel.id], isMinimized: true }
                      }));
                    } else {
                      handleActiveTab(panel.id, tab.id);
                      focusFloatingPanel(panel.id);
                    }
                  }}
                  className={`relative flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold border rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 ${
                    isActive
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-sm shadow-indigo-500/25"
                      : (panel.activeTabId === tab.id && isMinimized)
                        ? "bg-muted/40 border-border/40 text-muted-foreground opacity-60 hover:opacity-100"
                        : "bg-card border-border text-foreground hover:bg-accent"
                  }`}
                  title={tab.title}
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded">
                    {isFileExplorer ? (
                      <FolderTree className="h-3.5 w-3.5 text-sky-500" />
                    ) : isFileViewer ? (
                      <FileText className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      displayType.logo
                    )}
                  </span>
                  <span className="max-w-[100px] truncate text-[10px] pr-1.5">
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
                    <span className="absolute -top-1.5 -right-1.5 text-[7px] bg-amber-500 text-white rounded px-0.5 border border-amber-600 font-bold scale-90">
                      P
                    </span>
                  )}
                  
                  {/* Status dot: only show for active tab of the panel */}
                  {panel.activeTabId === tab.id && (
                    <span className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-0.5 rounded-full ${
                      isActive ? "bg-white" : isMinimized ? "bg-amber-500" : "bg-indigo-500"
                    }`} />
                  )}
                </button>
              );
            })}

            {/* Separator between items and New Window button */}
            {panels.length > 0 && (
              <div className="h-5 w-px bg-border/80 mx-1.5" />
            )}

            {/* New Window Button with Dropdown Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setDockMenuOpen((prev) => !prev)}
                className="flex items-center justify-center h-7 w-7 rounded-lg border border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground transition-all duration-250 hover:scale-105 active:scale-95 shadow-sm cursor-pointer"
                title="新建终端、文件浏览器或 AI 助手窗口"
              >
                <Plus className="h-4 w-4 text-indigo-500 shrink-0" />
              </button>

              {dockMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40 cursor-default" onClick={() => setDockMenuOpen(false)} />
                  <TerminalTypeMenu
                    align="right"
                    style={{ bottom: "34px", top: "auto", position: "absolute" }}
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
        )}
      </main>
    </div>
  );
}
