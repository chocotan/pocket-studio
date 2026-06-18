import React, { useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ArrowLeft, ChevronDown, ChevronUp, LayoutGrid, Columns, Maximize, Palette, Check } from "lucide-react";
import type { Device } from "@/lib/types";
import { type StudioTheme } from "./terminal-types";
import type { Project } from "./studio-dashboard";
import { EmptyWorkspace } from "./empty-workspace";
import { ProjectNavMenu } from "./project-switcher";
import {
  normalizeSizes,
  sizesFromLayoutMap,
  splitLayoutMap,
  type LayoutNode,
  type SplitGroup,
} from "./studio-layout";
import { TerminalPanelView } from "./terminal-panel-view";
import { ZoomSelect } from "./zoom-select";
import { NotificationCenter } from "./notification-center";
import type { PageZoom } from "@/lib/zoom";
import type { NotificationJumpTarget, TerminalNotification } from "./terminal-notifications";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import { updateSplitSizes } from "./studio-layout-ops";

interface StudioWorkspaceProps {
  projectId: string;
  project: Project;
  projects: Project[];
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
}

const Columns3Icon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
    <path d="M15 3v18" />
  </svg>
);

const STUDIO_NAV_HIDDEN_KEY = "pocket-studio-nav-hidden";

export function StudioWorkspace({
  projectId,
  project,
  projects,
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
    applyPresetLayout,
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
            projects={projects}
            devices={devices}
            currentProjectId={projectId}
            alertProjectIds={new Set([...alertProjectIds].filter((id) => id !== projectId))}
            onSelectProject={onSelectProject}
            className="flex-1"
          />

          <div className="flex shrink-0 items-center gap-1.5">
            <NotificationCenter
              notifications={notifications}
              open={notificationCenterOpen}
              onOpenChange={onNotificationCenterOpenChange}
              onSelect={onSelectNotification}
              onMarkAllRead={onMarkAllNotificationsRead}
            />
            <ZoomSelect value={pageZoom} onChange={onPageZoomChange} compact />
            {/* Preset Layout Buttons */}
            <div className="flex items-center bg-muted/40 p-0.5 rounded-lg border border-border/60">
              {/* Preset 1: Full workspace */}
              <button
                type="button"
                onClick={() => applyPresetLayout(1)}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-all cursor-pointer"
                title="应用布局：全功能工作区 (文件管理器+编辑器区+终端)"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              {/* Preset 2: Single terminal */}
              <button
                type="button"
                onClick={() => applyPresetLayout(2)}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-all cursor-pointer"
                title="应用布局：单终端面板"
              >
                <Maximize className="h-3.5 w-3.5" />
              </button>
              {/* Preset 3: Side by side terminals */}
              <button
                type="button"
                onClick={() => applyPresetLayout(3)}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-all cursor-pointer"
                title="应用布局：左右双终端"
              >
                <Columns className="h-3.5 w-3.5" />
              </button>
              {/* Preset 4: Three-column layout */}
              <button
                type="button"
                onClick={() => applyPresetLayout(4)}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-all cursor-pointer"
                title="应用布局：左侧文件+中间编辑+右侧终端"
              >
                <Columns3Icon className="h-3.5 w-3.5" />
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

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-1 bg-slate-50 dark:bg-[#0f131c] transition-colors duration-150">
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
            {layoutTree ? (
              renderNode(layoutTree)
            ) : (
              <EmptyWorkspace
                onCreate={handleCreateInitialPanel}
                onCreateFileExplorer={handleCreateInitialFileExplorer}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
