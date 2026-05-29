import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, FolderTree, Image as ImageIcon, Plus, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { XtermInstance } from "./xterm-instance";
import { FileExplorerTab } from "./file-explorer-tab";
import { FileViewerTab } from "./file-viewer-tab";
import { SplitBottomIcon, SplitLeftIcon, SplitRightIcon, SplitTopIcon } from "./split-icons";
import type { TerminalPanel } from "./studio-layout";
import {
  TERMINAL_TYPES,
  cleanTerminalTitle,
  terminalType,
  terminalTypeFromCommand,
  type SplitDirection,
  type TerminalKind,
  type TerminalTitleSource,
} from "./terminal-types";

interface TerminalPanelViewProps {
  panel: TerminalPanel;
  addMenuPanelId: string | null;
  dragTarget: { panelId: string; insertIndex: number } | null;
  isDraggingTab: boolean;
  projectId: string;
  workspacePath: string;
  onFocus: (id: string) => void;
  onAddMenu: (id: string) => void;
  onSplitSelect: (id: string, dir: SplitDirection, kind: TerminalKind) => void;
  onAddTab: (id: string, kind: TerminalKind) => void;
  onAddFileExplorer: (id: string) => void;
  onOpenFile: (panelId: string, path: string) => void;
  onActiveTab: (panelId: string, tabId: string) => void;
  onCloseTab: (panelId: string, tabId: string) => void;
  onTabDragStart: () => void;
  onTabDragMove: (clientX: number, clientY: number, fallbackPanelId: string, fallbackIndex: number) => void;
  onTabDragEnd: (fromPanelId: string, tabId: string, clientX: number, clientY: number, fallbackIndex: number) => void;
  onTabDragCancel: () => void;
  onClosePanel: (id: string) => void;
  onTitleChange: (id: string, title: string, command?: string, source?: TerminalTitleSource) => void;
  layoutVersion: number;
}

export function TerminalPanelView({
  panel,
  addMenuPanelId,
  dragTarget,
  isDraggingTab,
  projectId,
  workspacePath,
  onFocus,
  onAddMenu,
  onSplitSelect,
  onAddTab,
  onAddFileExplorer,
  onOpenFile,
  onActiveTab,
  onCloseTab,
  onTabDragStart,
  onTabDragMove,
  onTabDragEnd,
  onTabDragCancel,
  onClosePanel,
  onTitleChange,
  layoutVersion,
}: TerminalPanelViewProps) {
  const tabScrollerRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pointerDragRef = useRef<{ panelId: string; tabId: string; pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null);
  const [scrollState, setScrollState] = useState({ canLeft: false, canRight: false });
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const isFocused = panel.focus;
  const splitActions = [
    { dir: "left" as const, Icon: SplitLeftIcon, label: "向左分割" },
    { dir: "right" as const, Icon: SplitRightIcon, label: "向右分割" },
    { dir: "top" as const, Icon: SplitTopIcon, label: "向上分割" },
    { dir: "bottom" as const, Icon: SplitBottomIcon, label: "向下分割" },
  ];
  const focusClasses = isFocused
    ? "border-indigo-300/80 shadow-[inset_0_0_0_1px_rgba(99,102,241,0.18)]"
    : "border-slate-200/80 hover:border-slate-300/80 shadow-sm";
  const accentClasses = {
    indigo: "bg-indigo-100 text-indigo-600 ring-1 ring-indigo-200/70",
    violet: "bg-violet-100 text-violet-600 ring-1 ring-violet-200/70",
    emerald: "bg-emerald-100 text-emerald-600 ring-1 ring-emerald-200/70",
    amber: "bg-amber-100 text-amber-700 ring-1 ring-amber-200/70",
    cyan: "bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200/70",
    rose: "bg-rose-100 text-rose-600 ring-1 ring-rose-200/70",
  };
  const addMenuLeft = Math.min(panel.tabs.length * 112 + 28, 520);

  function updateScrollState() {
    const scroller = tabScrollerRef.current;
    if (!scroller) return;
    const maxLeft = scroller.scrollWidth - scroller.clientWidth;
    setScrollState({
      canLeft: scroller.scrollLeft > 1,
      canRight: scroller.scrollLeft < maxLeft - 1,
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
    const activeTab = tabButtonRefs.current[panel.activeTabId];
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateScrollState();
  }, [panel.activeTabId, panel.tabs.length]);

  const visibleDropIndex = dragTarget
    ? dragTarget.panelId === panel.id ? dragTarget.insertIndex : null
    : dropIndex;

  return (
    <div
      onClick={() => onFocus(panel.id)}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      className={`studio-panel border bg-white transition-all duration-200 ${focusClasses}`}
    >
      <div
        data-studio-tabbar="true"
        data-panel-id={panel.id}
        data-tab-count={panel.tabs.length}
        className={`studio-tabbar relative flex h-8 shrink-0 items-end gap-0.5 overflow-visible border-b-0 px-1 pt-0.5 ${
          isFocused ? "bg-slate-100" : "bg-[#edf2f7]"
        }`}
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
            const displayType = terminalType(terminalTypeFromCommand(tab.activeCommand || "", tab.termType));
            const displayTitle = isFileExplorer || isFileViewer
              ? tab.title
              : cleanTerminalTitle(tab.title, terminalType(tab.termType).title, tab.termType);
            const active = tab.id === panel.activeTabId;
            const tabIndex = panel.tabs.indexOf(tab);
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
                        title={displayTitle}
                        data-studio-tab="true"
                        data-panel-id={panel.id}
                        data-tab-index={tabIndex}
                        ref={(element) => {
                          tabButtonRefs.current[tab.id] = element;
                        }}
                        onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
                        onPointerMove={handleTabPointerMove}
                        onPointerUp={handleTabPointerUp}
                        onPointerCancel={handleTabPointerCancel}
                        className={`studio-tab group flex h-7 min-w-[72px] max-w-[220px] flex-[0_1_auto] items-center gap-1 rounded-t-md border px-1.5 text-left transition-colors ${
                          active
                            ? "studio-tab-active relative z-20 border-slate-200 bg-[#fbfbfb] text-slate-900 shadow-sm"
                            : "studio-tab-inactive relative border-slate-200/70 bg-slate-50/70 text-slate-500 hover:bg-white/80 hover:text-slate-800"
                        }`}
                      >
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md ${
                          isFileExplorer
                            ? active ? "bg-sky-100 text-sky-700 ring-1 ring-sky-200/70" : "text-slate-400"
                            : isFileViewer
                              ? active ? "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/70" : "text-slate-400"
                            : active ? accentClasses[displayType.accent] : "text-slate-400"
                        }`}>
                          {isFileExplorer
                            ? <FolderTree className="h-3.5 w-3.5" />
                            : isFileViewer
                              ? tab.fileKind === "image" ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />
                              : displayType.logo}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold leading-none">
                          {displayTitle}
                        </span>
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
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"
                          aria-label="关闭标签"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipContent side="bottom" className="max-w-[360px] text-[10px] font-medium">
                    {displayTitle}
                  </TooltipContent>
                </Tooltip>
              </React.Fragment>
            );
          })}
          {visibleDropIndex === panel.tabs.length && <TabDropMarker panelId={panel.id} index={panel.tabs.length} />}
          <div className="relative flex h-7 shrink-0 items-center pb-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
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
            style={{ left: addMenuLeft, top: 34 }}
            onSelect={(kind) => onAddTab(panel.id, kind)}
            onFileExplorer={() => onAddFileExplorer(panel.id)}
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

      <div className="studio-terminal-surface relative min-h-0 flex-1 bg-[#fbfbfb]">
        {panel.tabs.map((tab) => {
          const type = terminalType(tab.termType);
          const active = tab.id === panel.activeTabId;
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
                  projectId={projectId}
                  workspacePath={workspacePath}
                  active={active}
                  layoutVersion={layoutVersion}
                  onOpenFile={(path) => onOpenFile(panel.id, path)}
                />
              ) : tab.kind === "file_viewer" ? (
                <FileViewerTab
                  projectId={projectId}
                  path={tab.filePath || ""}
                  active={active}
                  dragSuspended={isDraggingTab}
                />
              ) : (
                <XtermInstance
                  projectId={projectId}
                  terminalId={tab.id}
                  command={type.command}
                  isActive={isFocused && active}
                  layoutVersion={layoutVersion}
                  onTitleChange={(title, command, source) => onTitleChange(tab.id, title, command, source)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TerminalTypeMenu({
  align,
  style,
  onSelect,
  onFileExplorer,
}: {
  align: "left" | "right";
  style?: React.CSSProperties;
  onSelect: (kind: TerminalKind) => void;
  onFileExplorer: () => void;
}) {
  return (
    <div
      className={`absolute top-7 z-50 w-40 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}
      style={style}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onFileExplorer}
        className="flex w-full items-center gap-2 border-b border-slate-100 px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-sky-100 text-sky-700">
          <FolderTree className="h-3.5 w-3.5" />
        </span>
        <span className="truncate">文件资源管理器</span>
      </button>
      {TERMINAL_TYPES.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onSelect(item.value)}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 text-slate-600">
            {item.logo}
          </span>
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function TabDropMarker({ panelId, index }: { panelId: string; index: number }) {
  return (
    <span
      data-studio-drop-marker="true"
      data-panel-id={panelId}
      data-drop-index={index}
      className="mb-0.5 h-6 w-0.5 shrink-0 rounded-full bg-indigo-500 shadow-[0_0_0_2px_rgba(99,102,241,0.16)]"
      aria-hidden="true"
    />
  );
}
