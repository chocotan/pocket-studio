import React, { useEffect, useRef, useState, useMemo } from "react";
import { ChevronLeft, ChevronRight, FileText, FolderTree, Image as ImageIcon, Plus, X, Cpu, Terminal } from "lucide-react";
import { OpenCode, Codex, ClaudeCode, KiloCode } from "@lobehub/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { XtermInstance } from "./xterm-instance";
import { FileExplorerTab } from "./file-explorer-tab";
import { FileViewerTab } from "./file-viewer-tab";
import { SplitBottomIcon, SplitLeftIcon, SplitRightIcon, SplitTopIcon } from "./split-icons";
import type { TerminalPanel, StudioTab } from "./studio-layout";
import { AgentChatTab } from "./agent-chat/agent-chat-tab";
import type { Project } from "./studio-dashboard";
import type { Device } from "@/lib/types";
import { deviceDisplayName } from "./project-switcher";
import {
  cleanTerminalTitle,
  terminalType,
  terminalTypeFromCommand,
  type SplitDirection,
  type TerminalKind,
  type TerminalTitleState,
  type StudioTheme,
  TERMINAL_TYPES,
} from "./terminal-types";


interface TerminalPanelViewProps {
  panel: TerminalPanel;
  focused: boolean;
  addMenuPanelId: string | null;
  dragTarget: { panelId: string; insertIndex: number } | null;
  isDraggingTab: boolean;
  projectId: string;
  project: Project;
  projects: Project[];
  devices: Device[];
  workspacePath: string;
  onFocus: (id: string) => void;
  onAddMenu: (id: string) => void;
  onSplitSelect: (id: string, dir: SplitDirection, kind: TerminalKind) => void;
  onAddTab: (id: string, kind: TerminalKind, tabProjectId?: string) => void;
  onAddFileExplorer: (id: string, tabProjectId?: string) => void;
  onAddAgentChat: (panelId: string, agentKind: string, agentRuntime?: StudioTab["agentRuntime"], tabProjectId?: string) => void;
  onUpdateTabProperties: (tabId: string, props: Partial<StudioTab>) => void;
  onOpenFile: (panelId: string, path: string, tabProjectId?: string) => void;
  onActiveTab: (panelId: string, tabId: string) => void;
  onCloseTab: (panelId: string, tabId: string) => void;
  onTabDragStart: () => void;
  onTabDragMove: (clientX: number, clientY: number, fallbackPanelId: string, fallbackIndex: number) => void;
  onTabDragEnd: (fromPanelId: string, tabId: string, clientX: number, clientY: number, fallbackIndex: number) => void;
  onTabDragCancel: () => void;
  onClosePanel: (id: string) => void;
  onTitleChange: (id: string, title: string, command?: string, fullTitle?: string) => void;
  onTerminalFocus: (panelId: string, tabId: string) => void;
  terminalTitles: Record<string, TerminalTitleState>;
  alertTerminalIds?: Set<string>;
  layoutVersion: number;
  theme?: StudioTheme;
  scale?: number;
}

function TerminalPanelViewComponent({
  panel,
  focused,
  addMenuPanelId,
  dragTarget,
  isDraggingTab,
  projectId,
  project,
  projects,
  devices,
  workspacePath,
  onFocus,
  onAddMenu,
  onSplitSelect,
  onAddTab,
  onAddFileExplorer,
  onAddAgentChat,
  onUpdateTabProperties,
  onOpenFile,
  onActiveTab,
  onCloseTab,
  onTabDragStart,
  onTabDragMove,
  onTabDragEnd,
  onTabDragCancel,
  onClosePanel,
  onTitleChange,
  onTerminalFocus,
  terminalTitles,
  alertTerminalIds = new Set<string>(),
  layoutVersion,
  theme = "light",
  scale = 1,
}: TerminalPanelViewProps) {
  const tabbarRef = useRef<HTMLDivElement | null>(null);
  const tabScrollerRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const tabButtonRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pointerDragRef = useRef<{ panelId: string; tabId: string; pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null);
  const [scrollState, setScrollState] = useState({ canLeft: false, canRight: false });
  const [addMenuPosition, setAddMenuPosition] = useState({ left: 4, top: 26 });
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const isFocused = focused;
  const splitActions = [
    { dir: "left" as const, Icon: SplitLeftIcon, label: "向左分割" },
    { dir: "right" as const, Icon: SplitRightIcon, label: "向右分割" },
    { dir: "top" as const, Icon: SplitTopIcon, label: "向上分割" },
    { dir: "bottom" as const, Icon: SplitBottomIcon, label: "向下分割" },
  ];
  const focusClasses = isFocused
    ? "border-2 [--studio-panel-shadow:none]"
    : "border-2 shadow-sm";
  const panelStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    zIndex: isFocused ? 2 : 1,
  };
  const accentClasses = {
    indigo: "bg-indigo-100 text-indigo-600 ring-1 ring-indigo-200/70 dark:bg-indigo-400/18 dark:text-indigo-200 dark:ring-indigo-300/20",
    violet: "bg-violet-100 text-violet-600 ring-1 ring-violet-200/70 dark:bg-violet-400/18 dark:text-violet-200 dark:ring-violet-300/20",
    emerald: "bg-emerald-100 text-emerald-600 ring-1 ring-emerald-200/70 dark:bg-emerald-400/16 dark:text-emerald-200 dark:ring-emerald-300/20",
    amber: "bg-amber-100 text-amber-700 ring-1 ring-amber-200/70 dark:bg-amber-400/16 dark:text-amber-200 dark:ring-amber-300/20",
    cyan: "bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200/70 dark:bg-cyan-400/16 dark:text-cyan-200 dark:ring-cyan-300/20",
    rose: "bg-rose-100 text-rose-600 ring-1 ring-rose-200/70 dark:bg-rose-400/16 dark:text-rose-200 dark:ring-rose-300/20",
    lime: "bg-lime-100 text-lime-700 ring-1 ring-lime-200/70 dark:bg-lime-400/16 dark:text-lime-200 dark:ring-lime-300/20",
  };
  const panelAlert = panel.tabs.some((tab) => alertTerminalIds.has(tab.id));
  function updateScrollState() {
    const scroller = tabScrollerRef.current;
    if (!scroller) return;
    const maxLeft = scroller.scrollWidth - scroller.clientWidth;
    setScrollState({
      canLeft: scroller.scrollLeft > 1,
      canRight: scroller.scrollLeft < maxLeft - 1,
    });
  }

  function updateAddMenuPosition() {
    const tabbar = tabbarRef.current;
    const button = addButtonRef.current;
    if (!tabbar || !button) return;
    const tabbarRect = tabbar.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const menuWidth = 160;
    // getBoundingClientRect returns screen px (scaled by the page-zoom CSS
    // transform on an ancestor), but this menu is absolutely positioned inside
    // that scaled subtree, where top/left are interpreted in unscaled layout px.
    // Divide the rect-derived distances by the zoom factor so it lands right.
    const s = scale || 1;
    const tabbarWidth = tabbarRect.width / s;
    const left = Math.max(4, Math.min((buttonRect.left - tabbarRect.left) / s, tabbarWidth - menuWidth - 4));
    setAddMenuPosition({
      left,
      top: (buttonRect.bottom - tabbarRect.top) / s + 2,
    });
  }

  function scrollTabs(direction: "left" | "right") {
    const scroller = tabScrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({
      left: direction === "left" ? -Math.max(160, scroller.clientWidth * 0.7) : Math.max(160, scroller.clientWidth * 0.7),
      behavior: "smooth",
    });
  }

  function displayTitleForTab(tab: TerminalPanel["tabs"][number]) {
    if (tab.kind === "file_explorer") return "文件";
    if (tab.kind === "file_viewer") return tab.title;
    if (tab.kind === "agent_chat") return tab.title;
    const liveTitle = terminalTitles[tab.id];
    return cleanTerminalTitle(liveTitle?.title || tab.title, terminalType(tab.termType).title, tab.termType);
  }

  function fullTitleForTab(tab: TerminalPanel["tabs"][number]) {
    if (tab.kind === "file_explorer") return "文件";
    if (tab.kind === "file_viewer") return tab.title;
    if (tab.kind === "agent_chat") return tab.title;
    const liveTitle = terminalTitles[tab.id];
    const rawTitle = (liveTitle?.fullTitle || liveTitle?.title || tab.title || "").trim();
    return rawTitle || terminalType(tab.termType).title;
  }

  function getDropIndex(clientX: number) {
    const buttons = panel.tabs
      .map((tab, index) => ({ element: tabButtonRefs.current[tab.id], index }))
      .filter((item): item is { element: HTMLDivElement; index: number } => Boolean(item.element));
    for (const { element, index } of buttons) {
      const rect = element.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return index;
    }
    return panel.tabs.length;
  }

  function handleTabPointerDown(event: React.PointerEvent<HTMLDivElement>, tabId: string) {
    if (event.button !== 0) return;
    pointerDragRef.current = {
      panelId: panel.id,
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleTabPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance < 5) return;
    if (!drag.dragging) onTabDragStart();
    drag.dragging = true;
    const scroller = tabScrollerRef.current;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (event.clientX < rect.left + 28) scroller.scrollBy({ left: -18 });
      if (event.clientX > rect.right - 28) scroller.scrollBy({ left: 18 });
    }
    const nextDropIndex = getDropIndex(event.clientX);
    setDropIndex(nextDropIndex);
    onTabDragMove(event.clientX, event.clientY, panel.id, nextDropIndex);
  }

  function handleTabPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
    if (drag.dragging) {
      event.preventDefault();
      event.stopPropagation();
      onTabDragEnd(drag.panelId, drag.tabId, event.clientX, event.clientY, dropIndex ?? getDropIndex(event.clientX));
      setDropIndex(null);
    }
  }

  function handleTabPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      pointerDragRef.current = null;
      setDropIndex(null);
      onTabDragCancel();
    }
  }

  useEffect(() => {
    updateScrollState();
    const scroller = tabScrollerRef.current;
    if (!scroller) return;
    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(scroller);
    window.addEventListener("resize", updateScrollState);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateScrollState);
    };
  }, [panel.tabs.length, layoutVersion]);

  useEffect(() => {
    if (addMenuPanelId !== panel.id) return;
    updateAddMenuPosition();
    const scroller = tabScrollerRef.current;
    const tabbar = tabbarRef.current;
    const resizeObserver = new ResizeObserver(updateAddMenuPosition);
    if (tabbar) resizeObserver.observe(tabbar);
    window.addEventListener("resize", updateAddMenuPosition);
    scroller?.addEventListener("scroll", updateAddMenuPosition);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateAddMenuPosition);
      scroller?.removeEventListener("scroll", updateAddMenuPosition);
    };
  }, [addMenuPanelId, panel.id, panel.tabs.length, layoutVersion, scale]);

  useEffect(() => {
    const activeTab = tabButtonRefs.current[panel.activeTabId];
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateScrollState();
  }, [panel.activeTabId, panel.tabs.length]);

  const visibleDropIndex = dragTarget
    ? dragTarget.panelId === panel.id ? dragTarget.insertIndex : null
    : dropIndex;

  return (
    <div
      data-studio-panel="true"
      data-panel-id={panel.id}
      data-focused={isFocused ? "true" : "false"}
      data-alert={panelAlert ? "true" : "false"}
      onClick={() => onFocus(panel.id)}
      onPointerEnter={() => {
        if (!isFocused) onFocus(panel.id);
      }}
      style={panelStyle}
      className={`studio-panel box-border bg-card text-card-foreground transition-[border-color,box-shadow] duration-150 ${focusClasses}`}
    >
      <div
        ref={tabbarRef}
        data-studio-tabbar="true"
        data-panel-id={panel.id}
        data-tab-count={panel.tabs.length}
        className="studio-tabbar relative flex h-6 shrink-0 items-end gap-0.5 overflow-visible border-b-0 bg-muted px-1"
      >
        {scrollState.canLeft && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              scrollTabs("left");
            }}
            className="relative z-20 mb-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-white hover:text-indigo-600"
            aria-label="向左滚动标签"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}

        <div
          ref={tabScrollerRef}
          onScroll={updateScrollState}
          className="relative z-10 flex min-w-0 flex-1 items-end gap-1 overflow-x-auto overflow-y-visible pl-1 pr-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {panel.tabs.map((tab) => {
            const isFileExplorer = tab.kind === "file_explorer";
            const isFileViewer = tab.kind === "file_viewer";
            const liveTitle = tab.kind === "terminal" ? terminalTitles[tab.id] : undefined;
            const activeCommand = liveTitle?.command || tab.activeCommand || "";
            const displayType = terminalType(
              tab.kind === "agent_chat"
                ? (tab.agentKind as TerminalKind || "opencode")
                : terminalTypeFromCommand(activeCommand, tab.termType)
            );
            const displayTitle = displayTitleForTab(tab);
            const fullTitle = fullTitleForTab(tab);
            const active = tab.id === panel.activeTabId;
            const alerting = alertTerminalIds.has(tab.id) && !(isFocused && active);
            const tabIndex = panel.tabs.indexOf(tab);

            const tabProjectId = tab.projectId || projectId;
            const tabProject = projects.find((p) => p.id === tabProjectId);
            const isCrossProject = tabProjectId !== projectId;

            return (
              <React.Fragment key={tab.id}>
                {visibleDropIndex === tabIndex && <TabDropMarker panelId={panel.id} index={tabIndex} />}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div
                        role="tab"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          onActiveTab(panel.id, tab.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            onActiveTab(panel.id, tab.id);
                          }
                        }}
                        data-studio-tab="true"
                        data-panel-id={panel.id}
                        data-tab-index={tabIndex}
                        data-alert={alerting ? "true" : "false"}
                        ref={(element) => {
                          tabButtonRefs.current[tab.id] = element;
                        }}
                        onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
                        onPointerMove={handleTabPointerMove}
                        onPointerUp={handleTabPointerUp}
                        onPointerCancel={handleTabPointerCancel}
                        className={`studio-tab group flex h-6 min-w-11 max-w-[420px] flex-[0_1_auto] items-center gap-1 rounded-t-md border px-1.5 text-left transition-colors ${
                          active
                            ? "studio-tab-active relative z-20 border-border bg-card text-foreground shadow-sm"
                            : "studio-tab-inactive relative border-border/50 bg-muted/40 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                        }`}
                      >
                        <span className={`relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded-md ${
                          isFileExplorer
                            ? active ? "bg-sky-100 text-sky-700 ring-1 ring-sky-200/70 dark:bg-sky-400/16 dark:text-sky-200 dark:ring-sky-300/20" : "text-slate-400 dark:text-slate-600"
                            : isFileViewer
                              ? active ? "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/70 dark:bg-emerald-400/16 dark:text-emerald-200 dark:ring-emerald-300/20" : "text-slate-400 dark:text-slate-600"
                              : active ? accentClasses[displayType.accent] : "text-slate-400 dark:text-slate-600"
                        }`}>
                          {isFileExplorer
                            ? <FolderTree className="h-3.5 w-3.5" />
                            : isFileViewer
                              ? tab.fileKind === "image" ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />
                              : displayType.logo}
                        </span>
                        <span className="relative z-10 min-w-0 flex-1 truncate text-[11px] font-semibold leading-none">
                          {displayTitle}
                        </span>
                        {isCrossProject && tabProject && (
                          <span
                            className="relative z-10 shrink-0 bg-indigo-50/80 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 px-1 py-0.5 rounded text-[8px] font-bold max-w-[80px] truncate border border-indigo-100/50 dark:border-indigo-900/50"
                            title={`项目: ${tabProject.name}`}
                          >
                            {tabProject.name}
                          </span>
                        )}
                        <button
                          type="button"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            onCloseTab(panel.id, tab.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              onCloseTab(panel.id, tab.id);
                            }
                          }}
                          onPointerUp={(event) => {
                            event.stopPropagation();
                          }}
                          className="relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-rose-400/10 dark:hover:text-rose-300"
                          aria-label="关闭标签"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipContent side="bottom" className="max-w-[420px] whitespace-normal break-words text-[10px] font-medium leading-relaxed">
                    <div className="flex flex-col gap-0.5">
                      <div>{fullTitle}</div>
                      {tabProject && (
                        <div className="text-[9px] text-slate-400 dark:text-slate-500">
                          项目: {tabProject.name}
                        </div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </React.Fragment>
            );
          })}
          {visibleDropIndex === panel.tabs.length && <TabDropMarker panelId={panel.id} index={panel.tabs.length} />}
          <div className="relative flex h-6 shrink-0 items-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={addButtonRef}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      updateAddMenuPosition();
                      onAddMenu(panel.id);
                    }}
                    className="flex h-6 w-5 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-indigo-600"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                }
              />
              <TooltipContent side="bottom" className="text-[10px] font-medium">
                新建终端标签
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {scrollState.canRight && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              scrollTabs("right");
            }}
            className="relative z-20 mb-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-white hover:text-indigo-600"
            aria-label="向右滚动标签"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}

        {addMenuPanelId === panel.id && (
          <TerminalTypeMenu
            align="left"
            style={addMenuPosition}
            projects={projects}
            devices={devices}
            projectId={projectId}
            onSelect={(kind, tabProjectId) => onAddTab(panel.id, kind, tabProjectId)}
            onFileExplorer={(tabProjectId) => onAddFileExplorer(panel.id, tabProjectId)}
            onAddAgentChat={(agentKind, agentRuntime, tabProjectId) => onAddAgentChat(panel.id, agentKind, agentRuntime, tabProjectId)}
          />
        )}

        <div className="relative z-10 flex shrink-0 items-center gap-px pb-0.5">
          {splitActions.map(({ dir, Icon, label }) => (
            <Tooltip key={dir}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSplitSelect(panel.id, dir, "bash");
                    }}
                    className="flex h-6 w-5 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
                  >
                    <Icon />
                  </button>
                }
              />
              <TooltipContent side="bottom" className="text-[10px] font-medium">
                {label}
              </TooltipContent>
            </Tooltip>
          ))}

          <div className="mx-0.5 h-3.5 w-px bg-slate-200" />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClosePanel(panel.id);
                  }}
                  className="flex h-6 w-5 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                >
                  <X className="h-3 w-3" />
                </button>
              }
            />
            <TooltipContent side="bottom" className="text-[10px] font-medium">
              关闭面板
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="studio-terminal-surface relative min-h-0 flex-1 bg-card text-card-foreground border-t border-border">
        {panel.tabs.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-slate-400 bg-slate-50/50 dark:bg-slate-900/10">
            <div className="h-10 w-10 rounded-full bg-slate-100/80 border border-slate-200/50 flex items-center justify-center mb-3 dark:bg-slate-800 dark:border-slate-700">
              <Plus className="h-5 w-5 text-slate-400 dark:text-slate-500" />
            </div>
            <h3 className="text-xs font-bold text-slate-700 dark:text-slate-350">此面板为空</h3>
            <p className="text-[10px] text-slate-400 mt-1 max-w-[220px] leading-relaxed dark:text-slate-500">
              您可以点击上方标签栏的 “+” 按钮，或者使用下方快捷方式创建终端或资源管理器。
            </p>
            <div className="mt-4 flex flex-col gap-1.5 w-full max-w-[180px]">
              <button
                type="button"
                onClick={() => onAddTab(panel.id, "bash")}
                className="w-full h-8 px-3 text-[10px] font-bold bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 hover:text-indigo-600 transition-all flex items-center gap-2 justify-center cursor-pointer shadow-sm dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-indigo-400"
              >
                <Terminal className="h-3.5 w-3.5 text-slate-500 shrink-0 dark:text-slate-400" />
                打开 Bash 终端
              </button>
              <button
                type="button"
                onClick={() => onAddTab(panel.id, "claude")}
                className="w-full h-8 px-3 text-[10px] font-bold bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 hover:text-indigo-600 transition-all flex items-center gap-2 justify-center cursor-pointer shadow-sm dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-indigo-400"
              >
                <Cpu className="h-3 w-3 text-indigo-500 shrink-0" />
                打开 Claude Code
              </button>
              <button
                type="button"
                onClick={() => onAddFileExplorer(panel.id)}
                className="w-full h-8 px-3 text-[10px] font-bold bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 hover:text-indigo-600 transition-all flex items-center gap-2 justify-center cursor-pointer shadow-sm dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-indigo-400"
              >
                <FolderTree className="h-3 w-3 text-sky-500 shrink-0" />
                打开文件管理器
              </button>
            </div>
          </div>
        ) : (
          panel.tabs.map((tab) => {
            const type = terminalType(tab.termType);
            const active = tab.id === panel.activeTabId;
            const tabProjectId = tab.projectId || projectId;
            const tabProject = projects.find((p) => p.id === tabProjectId) || project;
            const tabWorkspacePath = tabProject.workspace_path || workspacePath;
            return (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{
                  visibility: active ? "visible" : "hidden",
                  pointerEvents: active ? "auto" : "none",
                }}
              >
                {tab.kind === "file_explorer" ? (
                  <FileExplorerTab
                    projectId={tabProjectId}
                    workspacePath={tabWorkspacePath}
                    active={active}
                    layoutVersion={layoutVersion}
                    onOpenFile={(path) => onOpenFile(panel.id, path, tabProjectId)}
                    theme={theme}
                  />
                ) : tab.kind === "file_viewer" ? (
                  <FileViewerTab
                    projectId={tabProjectId}
                    path={tab.filePath || ""}
                    active={active}
                    dragSuspended={isDraggingTab}
                    theme={theme}
                  />
                ) : tab.kind === "agent_chat" ? (
                  <AgentChatTab
                    project={tabProject}
                    tab={tab}
                    active={active}
                    workspacePath={tabWorkspacePath}
                    onUpdateTabProperties={onUpdateTabProperties}
                  />
                ) : (
                  <XtermInstance
                    projectId={tabProjectId}
                    terminalId={tab.id}
                    command={type.command}
                    isActive={isFocused && active}
                    layoutVersion={layoutVersion}
                    theme={theme}
                    scale={scale}
                    directMode={Boolean(tabProject.direct_mode)}
                    directEndpoint={tabProject.direct_mode ? tabProject.direct_endpoint : undefined}
                    onTitleChange={(title, command, fullTitle) => onTitleChange(tab.id, title, command, fullTitle)}
                    onActiveFocus={() => onTerminalFocus(panel.id, tab.id)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export const TerminalPanelView = React.memo(TerminalPanelViewComponent);

function TerminalTypeMenu({
  align,
  style,
  projects,
  devices,
  projectId,
  onSelect,
  onFileExplorer,
  onAddAgentChat,
}: {
  align: "left" | "right";
  style?: React.CSSProperties;
  projects: Project[];
  devices: Device[];
  projectId: string;
  onSelect: (kind: TerminalKind, tabProjectId?: string) => void;
  onFileExplorer: (tabProjectId?: string) => void;
  onAddAgentChat: (agentKind: string, agentRuntime?: StudioTab["agentRuntime"], tabProjectId?: string) => void;
}) {
  const [submenu, setSubmenu] = useState<"terminal" | "acpx" | "acp" | null>(null);

  const groupedProjects = useMemo(() => {
    const groups: Array<{ deviceName: string; list: Project[] }> = [];
    const deviceMap = new Map<string, Project[]>();
    for (const p of projects) {
      const devId = p.device_id || "unknown";
      let list = deviceMap.get(devId);
      if (!list) {
        list = [];
        deviceMap.set(devId, list);
      }
      list.push(p);
    }
    deviceMap.forEach((list, devId) => {
      const dev = devices.find((d) => d.id === devId);
      const deviceName = deviceDisplayName(dev, devId);
      groups.push({ deviceName, list });
    });
    return groups;
  }, [projects, devices]);

  const [selectedProjId, setSelectedProjId] = useState(projectId);

  const terminalMenuItems = TERMINAL_TYPES
    .map((item) => ({
      ...item,
      menuLabel: terminalMenuLabel(item.value),
    }))
    .sort((left, right) => terminalMenuOrder(left.value) - terminalMenuOrder(right.value));

  return (
    <div
      className={`absolute top-6 z-50 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}
      style={style}
      onClick={(event) => event.stopPropagation()}
    >
      {projects.length > 1 && (
        <div className="px-2.5 py-1.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between gap-1 text-[10px] text-slate-500">
          <span className="font-semibold shrink-0">运行项目:</span>
          <select
            value={selectedProjId}
            onChange={(e) => setSelectedProjId(e.target.value)}
            className="flex-1 bg-white border border-slate-200 rounded px-1 py-0.5 text-[10px] text-slate-700 outline-none cursor-pointer hover:border-indigo-300"
          >
            {groupedProjects.map((group) => (
              <optgroup key={group.deviceName} label={group.deviceName}>
                {group.list.map((p: Project) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      {!submenu ? (
        <>
          <MenuBranch label="终端类型" icon={<Terminal className="h-3.5 w-3.5" />} tone="slate" onClick={() => setSubmenu("terminal")} />
          <MenuBranch label="ACPX会话" icon={<Cpu className="h-3.5 w-3.5" />} tone="amber" onClick={() => setSubmenu("acpx")} />
          <MenuBranch label="ACP会话" icon={<Cpu className="h-3.5 w-3.5" />} tone="emerald" onClick={() => setSubmenu("acp")} />
          <div className="border-t border-slate-100 my-1" />
          <button
            type="button"
            onClick={() => onFileExplorer(selectedProjId)}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-sky-100 text-sky-750">
              <FolderTree className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">文件管理器</span>
          </button>
        </>
      ) : submenu === "terminal" ? (
        <>
          <MenuHeader label="终端类型" onBack={() => setSubmenu(null)} />
          {terminalMenuItems.map((item) => (
            <MenuItem
              key={item.value}
              label={item.menuLabel}
              icon={item.logo}
              tone={item.accent}
              onClick={() => onSelect(item.value, selectedProjId)}
            />
          ))}
        </>
      ) : submenu === "acpx" ? (
        <>
          <MenuHeader label="ACPX会话" onBack={() => setSubmenu(null)} />
          <MenuItem label="opencode" icon={<OpenCode width={14} height={14} />} tone="amber" onClick={() => onAddAgentChat("opencode", "acpx", selectedProjId)} />
          <MenuItem label="claude code" icon={<ClaudeCode width={14} height={14} />} tone="violet" onClick={() => onAddAgentChat("claude", "acpx", selectedProjId)} />
          <MenuItem label="pi" icon={<span className="text-[10px] font-black leading-none">π</span>} tone="cyan" onClick={() => onAddAgentChat("pi", "acpx", selectedProjId)} />
        </>
      ) : (
        <>
          <MenuHeader label="ACP会话" onBack={() => setSubmenu(null)} />
          <MenuItem label="opencode" icon={<OpenCode width={14} height={14} />} tone="amber" onClick={() => onAddAgentChat("opencode", "direct_acp", selectedProjId)} />
          <MenuItem label="kilo code" icon={<KiloCode width={14} height={14} />} tone="lime" onClick={() => onAddAgentChat("kilo", "direct_acp", selectedProjId)} />
          <MenuItem label="codex" icon={<Codex width={14} height={14} />} tone="emerald" onClick={() => onAddAgentChat("codex", "direct_acp", selectedProjId)} />
        </>
      )}
    </div>
  );
}

function terminalMenuOrder(kind: TerminalKind) {
  const order: TerminalKind[] = ["bash", "opencode", "codex", "claude", "kilo", "pi", "agy"];
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
}

function terminalMenuLabel(kind: TerminalKind) {
  switch (kind) {
    case "bash":
      return "普通终端";
    case "claude":
      return "claude code";
    default:
      return kind;
  }
}

function MenuHeader({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1 px-1.5 py-1 border-b border-slate-100 bg-slate-50/50">
      <button
        type="button"
        onClick={onBack}
        className="p-1 rounded hover:bg-slate-200/50 text-slate-500 cursor-pointer"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="text-[9px] font-bold text-slate-400 uppercase select-none">{label}</span>
    </div>
  );
}

function MenuBranch({
  label,
  icon,
  tone,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <span className={`flex h-5 w-5 items-center justify-center rounded-md ${menuToneClass(tone)}`}>
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
    </button>
  );
}

function MenuItem({
  label,
  icon,
  tone,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
    >
      <span className={`flex h-5 w-5 items-center justify-center rounded-md ${menuToneClass(tone)}`}>
        {icon}
      </span>
      <span className="truncate font-semibold text-slate-750">{label}</span>
    </button>
  );
}

function menuToneClass(tone: string) {
  switch (tone) {
    case "amber":
      return "bg-amber-100 text-amber-750";
    case "emerald":
      return "bg-emerald-100 text-emerald-700";
    case "violet":
      return "bg-violet-100 text-violet-750";
    case "lime":
      return "bg-lime-100 text-lime-750";
    case "cyan":
      return "bg-cyan-100 text-cyan-750";
    case "rose":
      return "bg-rose-100 text-rose-750";
    case "sky":
      return "bg-sky-100 text-sky-750";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

function TabDropMarker({ panelId, index }: { panelId: string; index: number }) {
  return (
    <span
      data-studio-drop-marker="true"
      data-panel-id={panelId}
      data-drop-index={index}
      className="h-5 w-0.5 shrink-0 rounded-full bg-indigo-500 shadow-[0_0_0_2px_rgba(99,102,241,0.16)]"
      aria-hidden="true"
    />
  );
}
