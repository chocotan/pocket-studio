import React, { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ArrowLeft, CircleDot } from "lucide-react";
import type { Project } from "./studio-dashboard";
import { EmptyWorkspace } from "./empty-workspace";
import {
  cleanLayoutTitles,
  createFileExplorerTab,
  createFileViewerTab,
  createTerminalPanel,
  createTerminalTab,
  firstPanelInTree,
  initialStudioState,
  normalizeSizes,
  setFocusInLayout,
  sizesFromLayoutMap,
  splitLayoutMap,
  type LayoutNode,
  type SplitGroup,
  type TerminalPanel,
  type TerminalTab,
  type StudioTab,
} from "./studio-layout";
import { TerminalPanelView } from "./terminal-panel-view";
import {
  cleanTerminalTitle,
  isPlaceholderTerminalTitle,
  makeId,
  terminalType,
  type SplitDirection,
  type TerminalKind,
  type TerminalTitleSource,
} from "./terminal-types";
import { postJSON } from "@/lib/api";

interface StudioWorkspaceProps {
  projectId: string;
  project: Project;
  onBackToDashboard: () => void;
}

export function StudioWorkspace({
  projectId,
  project,
  onBackToDashboard,
}: StudioWorkspaceProps) {
  const initialState = initialStudioState(project);
  const [layoutTree, setLayoutTree] = useState<LayoutNode | null>(initialState.layoutTree);
  const [focusedId, setFocusedId] = useState<string>(initialState.focusedId);
  const [newTerminalType, setNewTerminalType] = useState<TerminalKind>(initialState.newTerminalType);
  const [addMenuPanelId, setAddMenuPanelId] = useState<string | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [tabDragTarget, setTabDragTarget] = useState<{ panelId: string; insertIndex: number } | null>(null);
  const [isDraggingTab, setIsDraggingTab] = useState(false);
  const skipSaveRef = useRef(true);

  useEffect(() => {
    const next = initialStudioState(project);
    setLayoutTree(next.layoutTree);
    setFocusedId(next.focusedId);
    setNewTerminalType(next.newTerminalType);
    setLayoutVersion((value) => value + 1);
    setTabDragTarget(null);
    setIsDraggingTab(false);
    skipSaveRef.current = true;
  }, [project.id]);

  useEffect(() => {
    const frames: number[] = [];
    const timers: number[] = [];
    const bump = () => setLayoutVersion((value) => value + 1);
    frames.push(window.requestAnimationFrame(() => {
      bump();
      frames.push(window.requestAnimationFrame(bump));
    }));
    [100, 350, 900].forEach((delay) => {
      timers.push(window.setTimeout(bump, delay));
    });
    return () => {
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [project.id]);

  useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      postJSON("/api/project/state", {
        project_id: projectId,
        state: {
          layoutTree: cleanLayoutTitles(layoutTree),
          focusedId,
          newTerminalType,
        },
      }).catch((err) => {
        console.error("failed to save studio state:", err);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [layoutTree, focusedId, newTerminalType, projectId]);

  function performSplit(
    node: LayoutNode,
    targetId: string,
    direction: SplitDirection,
    newPanel: TerminalPanel
  ): LayoutNode {
    if (node.type === "panel") {
      if (node.id !== targetId) return node;
      const isH = direction === "left" || direction === "right";
      const newFirst = direction === "left" || direction === "top";
      return {
        type: "split",
        id: makeId("split"),
        orientation: isH ? "horizontal" : "vertical",
        children: newFirst ? [newPanel, node] : [node, newPanel],
        sizes: [50, 50],
      };
    }
    return { ...node, children: node.children.map((child) => performSplit(child, targetId, direction, newPanel)) };
  }

  function removePanel(node: LayoutNode, targetId: string): LayoutNode | null {
    if (node.type === "panel") return node.id === targetId ? null : node;
    const nextChildren: LayoutNode[] = [];
    const nextSizes: number[] = [];
    node.children.forEach((child, index) => {
      const nextChild = removePanel(child, targetId);
      if (nextChild) {
        nextChildren.push(nextChild);
        nextSizes.push(node.sizes?.[index] || 0);
      }
    });
    if (nextChildren.length === 0) return null;
    if (nextChildren.length === 1) return nextChildren[0];
    return { ...node, children: nextChildren, sizes: normalizeSizes(nextSizes, nextChildren.length) };
  }

  function updateSplitSizes(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
    if (node.type === "panel") return node;
    if (node.id === splitId) return { ...node, sizes: normalizeSizes(sizes, node.children.length) };
    return { ...node, children: node.children.map((child) => updateSplitSizes(child, splitId, sizes)) };
  }

  function updateTabTitle(node: LayoutNode, tabId: string, title: string, command?: string, source: TerminalTitleSource = "tmux"): LayoutNode {
    if (node.type === "panel") {
      let changed = false;
      const tabs = node.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        if (tab.kind !== "terminal") return tab;
        const nextCommand = command || tab.activeCommand || "";
        const cleanedTitle = cleanTerminalTitle(title, terminalType(tab.termType).title, tab.termType);
        const placeholderTitle = isPlaceholderTerminalTitle(cleanedTitle, nextCommand);
        const shouldKeepTitle = source === "tmux" && (
          placeholderTitle ||
          (tab.titleSource === "terminal" && cleanedTitle === tab.title)
        );
        const nextTitle = shouldKeepTitle
          ? tab.title
          : cleanedTitle;
        const nextTitleSource = shouldKeepTitle ? tab.titleSource : source;
        if (tab.title === nextTitle && tab.activeCommand === nextCommand) return tab;
        changed = true;
        return { ...tab, title: nextTitle, activeCommand: nextCommand, titleSource: nextTitleSource };
      });
      return changed ? { ...node, tabs } : node;
    }
    return { ...node, children: node.children.map((child) => updateTabTitle(child, tabId, title, command, source)) };
  }

  function addTabToPanel(node: LayoutNode, panelId: string, tab: StudioTab, insertIndex?: number): LayoutNode {
    if (node.type === "panel") {
      if (node.id !== panelId) return node;
      const index = Math.max(0, Math.min(insertIndex ?? node.tabs.length, node.tabs.length));
      const tabs = [...node.tabs];
      tabs.splice(index, 0, tab);
      return {
        ...node,
        tabs,
        activeTabId: tab.id,
        focus: true,
      };
    }
    return { ...node, children: node.children.map((child) => addTabToPanel(child, panelId, tab, insertIndex)) };
  }

  function replaceOrAddFileViewer(node: LayoutNode, panelId: string, tab: StudioTab): LayoutNode {
    if (node.type === "panel") {
      if (node.id !== panelId) return node;
      const existing = node.tabs.find((item) => item.kind === "file_viewer" && item.filePath === tab.filePath);
      if (existing) {
        return { ...node, activeTabId: existing.id, focus: true };
      }
      return { ...node, tabs: [...node.tabs, tab], activeTabId: tab.id, focus: true };
    }
    return { ...node, children: node.children.map((child) => replaceOrAddFileViewer(child, panelId, tab)) };
  }

  function setActiveTabInTree(node: LayoutNode, panelId: string, tabId: string): LayoutNode {
    if (node.type === "panel") {
      if (node.id !== panelId) return node;
      return { ...node, activeTabId: tabId, focus: true };
    }
    return { ...node, children: node.children.map((child) => setActiveTabInTree(child, panelId, tabId)) };
  }

  function closeTabInTree(node: LayoutNode, panelId: string, tabId: string): LayoutNode {
    if (node.type === "panel") {
      if (node.id !== panelId || node.tabs.length <= 1) return node;
      const nextTabs = node.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId = node.activeTabId === tabId ? nextTabs[Math.max(0, nextTabs.length - 1)].id : node.activeTabId;
      return { ...node, tabs: nextTabs, activeTabId };
    }
    return { ...node, children: node.children.map((child) => closeTabInTree(child, panelId, tabId)) };
  }

  function findPanel(node: LayoutNode, panelId: string): TerminalPanel | null {
    if (node.type === "panel") return node.id === panelId ? node : null;
    for (const child of node.children) {
      const panel = findPanel(child, panelId);
      if (panel) return panel;
    }
    return null;
  }

  function findNextPanelId(node: LayoutNode, panelId: string): string {
    const panels: TerminalPanel[] = [];
    const collect = (item: LayoutNode) => {
      if (item.type === "panel") {
        panels.push(item);
        return;
      }
      item.children.forEach(collect);
    };
    collect(node);
    const index = panels.findIndex((panel) => panel.id === panelId);
    if (index >= 0 && index + 1 < panels.length) return panels[index + 1].id;
    return panelId;
  }

  function findTab(node: LayoutNode, panelId: string, tabId: string): TerminalTab | null {
    if (node.type === "panel") {
      if (node.id !== panelId) return null;
      return node.tabs.find((tab) => tab.id === tabId) || null;
    }
    for (const child of node.children) {
      const tab = findTab(child, panelId, tabId);
      if (tab) return tab;
    }
    return null;
  }

  function removeTabForMove(node: LayoutNode, panelId: string, tabId: string): LayoutNode | null {
    if (node.type === "panel") {
      if (node.id !== panelId) return node;
      const nextTabs = node.tabs.filter((tab) => tab.id !== tabId);
      if (nextTabs.length === 0) return null;
      const activeTabId = node.activeTabId === tabId ? nextTabs[Math.max(0, nextTabs.length - 1)].id : node.activeTabId;
      return { ...node, tabs: nextTabs, activeTabId };
    }
    const nextChildren: LayoutNode[] = [];
    const nextSizes: number[] = [];
    node.children.forEach((child, index) => {
      const nextChild = removeTabForMove(child, panelId, tabId);
      if (nextChild) {
        nextChildren.push(nextChild);
        nextSizes.push(node.sizes?.[index] || 0);
      }
    });
    if (nextChildren.length === 0) return null;
    if (nextChildren.length === 1) return nextChildren[0];
    return { ...node, children: nextChildren, sizes: normalizeSizes(nextSizes, nextChildren.length) };
  }

  function handleFocus(panelId: string) {
    setFocusedId(panelId);
    setLayoutTree((prev) => prev ? setFocusInLayout(prev, panelId) : prev);
  }

  function handleSplit(panelId: string, dir: SplitDirection, kind: TerminalKind) {
    const newPanel = createTerminalPanel(kind);
    setLayoutTree((prev) => {
      if (!prev) return newPanel;
      const unfocused = setFocusInLayout(prev, null);
      return performSplit(unfocused, panelId, dir, newPanel);
    });
    setFocusedId(newPanel.id);
    setNewTerminalType(kind);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function handleClosePanel(panelId: string) {
    setLayoutTree((prev) => {
      if (!prev) return null;
      const panel = findPanel(prev, panelId);
      if (panel) {
        panel.tabs.forEach((tab) => {
          if (tab.kind === "terminal") {
            void postJSON("/api/terminal/close", {
              project_id: projectId,
              terminal_id: tab.id,
            }).catch((err) => {
              console.error("failed to close terminal:", err);
            });
          }
        });
      }
      const simplified = removePanel(prev, panelId);
      if (!simplified) {
        setFocusedId("");
        return null;
      }
      if (focusedId === panelId) {
        const nextPanel = firstPanelInTree(simplified);
        setFocusedId(nextPanel.id);
        return setFocusInLayout(simplified, nextPanel.id);
      }
      return simplified;
    });
    setLayoutVersion((value) => value + 1);
  }

  function handleAddTab(panelId: string, kind: TerminalKind) {
    const tab = createTerminalTab(kind);
    setLayoutTree((prev) => prev ? setFocusInLayout(addTabToPanel(prev, panelId, tab), panelId) : prev);
    setFocusedId(panelId);
    setNewTerminalType(kind);
    setAddMenuPanelId(null);
  }

  function handleAddFileExplorer(panelId: string) {
    const tab = createFileExplorerTab();
    setLayoutTree((prev) => prev ? setFocusInLayout(addTabToPanel(prev, panelId, tab), panelId) : prev);
    setFocusedId(panelId);
    setAddMenuPanelId(null);
  }

  function handleOpenFile(fromPanelId: string, path: string) {
    const tab = createFileViewerTab(path);
    setLayoutTree((prev) => {
      if (!prev) return prev;
      const targetPanelId = findNextPanelId(prev, fromPanelId);
      setFocusedId(targetPanelId);
      return setFocusInLayout(replaceOrAddFileViewer(prev, targetPanelId, tab), targetPanelId);
    });
    setLayoutVersion((value) => value + 1);
  }

  function handleCloseTab(panelId: string, tabId: string) {
    const tab = layoutTree ? findTab(layoutTree, panelId, tabId) : null;
    if (tab?.kind === "terminal") {
      void postJSON("/api/terminal/close", {
        project_id: projectId,
        terminal_id: tabId,
      }).catch((err) => {
        console.error("failed to close terminal:", err);
      });
    }
    setLayoutTree((prev) => {
      if (!prev) return prev;
      const panel = findPanel(prev, panelId);
      if (!panel || panel.tabs.length > 1) return closeTabInTree(prev, panelId, tabId);
      const simplified = removePanel(prev, panelId);
      if (!simplified) {
        setFocusedId("");
        return null;
      }
      const nextPanel = firstPanelInTree(simplified);
      setFocusedId(nextPanel.id);
      return setFocusInLayout(simplified, nextPanel.id);
    });
    setLayoutVersion((value) => value + 1);
  }

  function handleActiveTab(panelId: string, tabId: string) {
    setFocusedId(panelId);
    setLayoutTree((prev) => prev ? setFocusInLayout(setActiveTabInTree(prev, panelId, tabId), panelId) : prev);
  }

  function handleMoveTab(fromPanelId: string, toPanelId: string, tabId: string, insertIndex: number) {
    setLayoutTree((prev) => {
      if (!prev) return prev;
      const tab = findTab(prev, fromPanelId, tabId);
      if (!tab) return prev;
      if (fromPanelId === toPanelId) {
        const panel = findPanel(prev, fromPanelId);
        if (!panel) return prev;
        const fromIndex = panel.tabs.findIndex((item) => item.id === tabId);
        if (fromIndex < 0) return prev;
        const adjustedIndex = insertIndex > fromIndex ? insertIndex - 1 : insertIndex;
        if (fromIndex === adjustedIndex || fromIndex + 1 === insertIndex) return prev;
      } else if (findTab(prev, toPanelId, tabId)) {
        return prev;
      }
      const withoutTab = removeTabForMove(prev, fromPanelId, tabId);
      if (!withoutTab) {
        const panel = createTerminalPanel(tab.termType, toPanelId);
        return { ...panel, tabs: [tab], activeTabId: tab.id };
      }
      const sourcePanel = findPanel(prev, fromPanelId);
      const sourceIndex = sourcePanel?.tabs.findIndex((item) => item.id === tabId) ?? -1;
      const nextInsertIndex = fromPanelId === toPanelId && sourceIndex >= 0 && insertIndex > sourceIndex
        ? insertIndex - 1
        : insertIndex;
      return setFocusInLayout(addTabToPanel(withoutTab, toPanelId, tab, nextInsertIndex), toPanelId);
    });
    setFocusedId(toPanelId);
    setLayoutVersion((value) => value + 1);
    window.setTimeout(() => setLayoutVersion((value) => value + 1), 80);
  }

  function resolveTabDrop(clientX: number, clientY: number, fallbackPanelId: string, fallbackIndex: number) {
    const tabElements = Array.from(document.querySelectorAll<HTMLElement>("[data-studio-tab='true']"));
    for (const tabElement of tabElements) {
      const rect = tabElement.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      const targetPanelId = tabElement.dataset.panelId || fallbackPanelId;
      const tabIndex = Number(tabElement.dataset.tabIndex || "0");
      return {
        panelId: targetPanelId,
        insertIndex: clientX < rect.left + rect.width / 2 ? tabIndex : tabIndex + 1,
      };
    }

    const tabbars = Array.from(document.querySelectorAll<HTMLElement>("[data-studio-tabbar='true']"));
    for (const tabbar of tabbars) {
      const rect = tabbar.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      return {
        panelId: tabbar.dataset.panelId || fallbackPanelId,
        insertIndex: Number(tabbar.dataset.tabCount || "0"),
      };
    }

    return {
      panelId: fallbackPanelId,
      insertIndex: fallbackIndex,
    };
  }

  function handleTabDragMove(clientX: number, clientY: number, fallbackPanelId: string, fallbackIndex: number) {
    setTabDragTarget(resolveTabDrop(clientX, clientY, fallbackPanelId, fallbackIndex));
  }

  function handleTabDragEnd(fromPanelId: string, tabId: string, clientX: number, clientY: number, fallbackIndex: number) {
    const fallbackPanelId = tabDragTarget?.panelId || fromPanelId;
    const drop = resolveTabDrop(clientX, clientY, fallbackPanelId, tabDragTarget?.insertIndex ?? fallbackIndex);
    setTabDragTarget(null);
    setIsDraggingTab(false);
    window.setTimeout(() => {
      handleMoveTab(fromPanelId, drop.panelId, tabId, drop.insertIndex);
    }, 0);
  }

  function handleTerminalTitle(tabId: string, title: string, command?: string, source?: TerminalTitleSource) {
    setLayoutTree((prev) => prev ? updateTabTitle(prev, tabId, title, command, source) : prev);
  }

  function handleCreateInitialPanel(kind: TerminalKind) {
    const panel = createTerminalPanel(kind);
    setLayoutTree(panel);
    setFocusedId(panel.id);
    setNewTerminalType(kind);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function handleCreateInitialFileExplorer() {
    const tab = createFileExplorerTab();
    const panel: TerminalPanel = {
      type: "panel",
      id: makeId("panel"),
      tabs: [tab],
      activeTabId: tab.id,
      focus: true,
    };
    setLayoutTree(panel);
    setFocusedId(panel.id);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function renderNode(node: LayoutNode): React.ReactNode {
    if (node.type === "panel") {
      return (
        <TerminalPanelView
          key={node.id}
          panel={node}
          addMenuPanelId={addMenuPanelId}
          dragTarget={tabDragTarget}
          isDraggingTab={isDraggingTab}
          projectId={projectId}
          workspacePath={project.workspace_path}
          onFocus={handleFocus}
          onAddMenu={(panelId) => {
            setAddMenuPanelId((prev) => prev === panelId ? null : panelId);
          }}
          onSplitSelect={handleSplit}
          onAddTab={handleAddTab}
          onAddFileExplorer={handleAddFileExplorer}
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
          layoutVersion={layoutVersion}
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
              style={{ position: "relative", overflow: "hidden", minWidth: 0, minHeight: 0 }}
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
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100dvw",
        height: "100dvh",
        overflow: "hidden",
        fontFamily: "var(--font-sans)",
      }}
      className="studio-square bg-[#f8fafc] select-none"
    >
      <header className="shrink-0 h-10 bg-white/95 backdrop-blur-md border-b border-slate-200/70 flex items-center justify-between px-4 z-50 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-6 w-6 rounded-md bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-500/25 flex-shrink-0">
            <span className="text-white font-black text-[10px] leading-none">P</span>
          </div>
          <span className="font-bold text-slate-800 text-xs tracking-tight">Pocket Studio</span>
          <span className="px-2 py-0.5 text-[9px] uppercase font-bold tracking-widest bg-indigo-50 text-indigo-600 rounded border border-indigo-100">
            PRO
          </span>
          <div className="ml-2 h-4 w-px bg-slate-200" />
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500 bg-slate-100/80 px-2.5 py-0.5 rounded-full border border-slate-200/60">
            <span className="font-semibold text-slate-700">Local</span>
            <span className="text-slate-300">/</span>
            <span className="text-indigo-600 font-semibold truncate max-w-[220px]">{project.name}</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <CircleDot className="h-3 w-3 text-emerald-500 animate-pulse" />
            <span className="text-[10px] text-slate-500 font-mono font-bold uppercase tracking-wider">
              Connected
            </span>
          </div>
          <button
            type="button"
            onClick={onBackToDashboard}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 border border-slate-200 hover:border-slate-300 shadow-sm font-semibold text-[11px] transition-all active:scale-95 duration-150 cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5 text-slate-400" />
            返回项目大厅
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5">
        <div className="relative min-h-0 flex-1">
          {layoutTree ? (
            renderNode(layoutTree)
          ) : (
            <EmptyWorkspace onCreate={handleCreateInitialPanel} onCreateFileExplorer={handleCreateInitialFileExplorer} />
          )}
        </div>
      </main>
    </div>
  );
}
