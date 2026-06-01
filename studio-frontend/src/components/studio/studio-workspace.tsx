import React, { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ArrowLeft, CircleDot, LayoutGrid, Columns, Maximize, Palette, Check } from "lucide-react";
import { type StudioTheme } from "./terminal-types";
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
import { getJSON, postJSON } from "@/lib/api";
import { ZoomSelect } from "./zoom-select";
import type { PageZoom } from "@/lib/zoom";

interface StudioWorkspaceProps {
  projectId: string;
  project: Project;
  pageZoom: PageZoom;
  onPageZoomChange: (zoom: PageZoom) => void;
  onBackToDashboard: () => void;
}

const Columns3Icon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2500/svg"
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

export function StudioWorkspace({
  projectId,
  project,
  pageZoom,
  onPageZoomChange,
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
  const [theme, setTheme] = useState<StudioTheme>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const urlTheme = params.get("theme");
      if (urlTheme === "light" || urlTheme === "claude" || urlTheme === "dark" || urlTheme === "synthwave" || urlTheme === "onedark") {
        return urlTheme as StudioTheme;
      }
      const saved = localStorage.getItem("pocket-studio-theme");
      if (saved === "light" || saved === "claude" || saved === "dark" || saved === "synthwave" || saved === "onedark") {
        return saved as StudioTheme;
      }
    }
    return "light";
  });
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [stateLoaded, setStateLoaded] = useState(false);

  useEffect(() => {
    localStorage.setItem("pocket-studio-theme", theme);
  }, [theme]);

  const skipSaveRef = useRef(true);

  function collectAllTabs(node: LayoutNode | null): StudioTab[] {
    if (!node) return [];
    if (node.type === "panel") {
      return [...node.tabs];
    }
    return node.children.flatMap(collectAllTabs);
  }

  function applyPresetLayout(type: 1 | 2 | 3 | 4) {
    const existingTabs = collectAllTabs(layoutTree);

    if (type === 1) {
      // Preset 1: Full IDE layout
      // Left Explorer, Right-Top Editor, Right-Bottom Terminal
      const explorerTabs = existingTabs.filter((t) => t.kind === "file_explorer");
      const editorTabs = existingTabs.filter((t) => t.kind === "file_viewer");
      const terminalTabs = existingTabs.filter((t) => t.kind === "terminal");

      // Fallbacks if empty
      if (explorerTabs.length === 0) {
        explorerTabs.push(createFileExplorerTab());
      }
      if (terminalTabs.length === 0) {
        terminalTabs.push(createTerminalTab("bash"));
      }

      const explorerPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: explorerTabs,
        activeTabId: explorerTabs[0].id,
        focus: false,
      };

      const editorPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: editorTabs,
        activeTabId: editorTabs.length > 0 ? editorTabs[0].id : "",
        focus: false,
      };

      const termPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: terminalTabs,
        activeTabId: terminalTabs[0].id,
        focus: true,
      };

      const rightSplit: SplitGroup = {
        type: "split",
        id: makeId("split"),
        orientation: "vertical",
        children: [editorPanel, termPanel],
        sizes: [60, 40],
      };

      const mainSplit: SplitGroup = {
        type: "split",
        id: makeId("split"),
        orientation: "horizontal",
        children: [explorerPanel, rightSplit],
        sizes: [22, 78],
      };

      setLayoutTree(mainSplit);
      setFocusedId(termPanel.id);
    } else if (type === 2) {
      // Preset 2: Single panel containing all tabs merged
      const allTabs = [...existingTabs];
      if (allTabs.length === 0) {
        allTabs.push(createTerminalTab("bash"));
      }

      const panel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: allTabs,
        activeTabId: allTabs[0].id,
        focus: true,
      };

      setLayoutTree(panel);
      setFocusedId(panel.id);
    } else if (type === 3) {
      // Preset 3: Side-by-side terminal splits
      const leftTabs: StudioTab[] = [];
      const rightTabs: StudioTab[] = [];

      // Split layout - explorers left, editors right
      existingTabs.forEach((tab) => {
        if (tab.kind === "file_explorer") {
          leftTabs.push(tab);
        } else if (tab.kind === "file_viewer") {
          rightTabs.push(tab);
        }
      });

      // Split terminal tabs between left and right evenly
      const terminalTabs = existingTabs.filter((t) => t.kind === "terminal");
      terminalTabs.forEach((tab, index) => {
        if (index % 2 === 0) {
          leftTabs.push(tab);
        } else {
          rightTabs.push(tab);
        }
      });

      // Fallbacks if empty
      if (leftTabs.length === 0) {
        leftTabs.push(createTerminalTab("bash"));
      }
      if (rightTabs.length === 0) {
        rightTabs.push(createTerminalTab("bash"));
      }

      const panel1: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: leftTabs,
        activeTabId: leftTabs[0].id,
        focus: true,
      };

      const panel2: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: rightTabs,
        activeTabId: rightTabs[0].id,
        focus: false,
      };

      const split: SplitGroup = {
        type: "split",
        id: makeId("split"),
        orientation: "horizontal",
        children: [panel1, panel2],
        sizes: [50, 50],
      };

      setLayoutTree(split);
      setFocusedId(panel1.id);
    } else if (type === 4) {
      // Preset 4: Three-column layout (Left: Explorer, Middle: Editor, Right: Terminal)
      const explorerTabs = existingTabs.filter((t) => t.kind === "file_explorer");
      const editorTabs = existingTabs.filter((t) => t.kind === "file_viewer");
      const terminalTabs = existingTabs.filter((t) => t.kind === "terminal");

      // Fallbacks if empty
      if (explorerTabs.length === 0) {
        explorerTabs.push(createFileExplorerTab());
      }
      if (terminalTabs.length === 0) {
        terminalTabs.push(createTerminalTab("bash"));
      }

      const explorerPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: explorerTabs,
        activeTabId: explorerTabs[0].id,
        focus: false,
      };

      const editorPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: editorTabs,
        activeTabId: editorTabs.length > 0 ? editorTabs[0].id : "",
        focus: false,
      };

      const termPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: terminalTabs,
        activeTabId: terminalTabs[0].id,
        focus: true,
      };

      const split: SplitGroup = {
        type: "split",
        id: makeId("split"),
        orientation: "horizontal",
        children: [explorerPanel, editorPanel, termPanel],
        sizes: [20, 48, 32],
      };

      setLayoutTree(split);
      setFocusedId(termPanel.id);
    }
    setLayoutVersion((v) => v + 1);
  }

  useEffect(() => {
    let cancelled = false;
    skipSaveRef.current = true;
    setStateLoaded(false);
    setTabDragTarget(null);
    setIsDraggingTab(false);

    const applyState = (stateProject: Project) => {
      const next = initialStudioState(stateProject);
      setLayoutTree(next.layoutTree);
      setFocusedId(next.focusedId);
      setNewTerminalType(next.newTerminalType);
      setLayoutVersion((value) => value + 1);
    };

    getJSON<unknown>(`/api/project/state?project_id=${encodeURIComponent(projectId)}`)
      .then((state) => {
        if (cancelled) return;
        applyState({ ...project, studio_state: state });
      })
      .catch((err) => {
        console.error("failed to load studio state:", err);
        if (!cancelled) applyState(project);
      })
      .finally(() => {
        if (!cancelled) setStateLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [project.id, projectId]);

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
    if (!stateLoaded) return;
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
  }, [layoutTree, focusedId, newTerminalType, projectId, stateLoaded]);

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
        if (source === "terminal" && tab.titleSource === "tmux") return tab;
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
      if (node.id !== panelId) return node;
      const nextTabs = node.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId = node.activeTabId === tabId
        ? (nextTabs.length > 0 ? nextTabs[Math.max(0, nextTabs.length - 1)].id : "")
        : node.activeTabId;
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
    const newPanel: TerminalPanel = {
      type: "panel",
      id: makeId("panel"),
      tabs: [],
      activeTabId: "",
      focus: true,
    };
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
      return closeTabInTree(prev, panelId, tabId);
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
        setThemeMenuOpen(false);
      }}
      className={`studio-square bg-background text-foreground select-none flex flex-col overflow-hidden theme-${theme} ${theme === "dark" || theme === "synthwave" || theme === "onedark" ? "dark" : ""}`}
      style={{
        width: "100dvw",
        height: "100dvh",
        fontFamily: "var(--font-sans)",
      }}
    >
      <header className="shrink-0 h-11 bg-white/95 border-b border-slate-200/70 flex items-center justify-between px-4 z-50 shadow-sm dark:bg-[#161d28]/95 dark:border-slate-800/80 transition-colors duration-150">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-6 w-6 rounded-md bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-500/25 flex-shrink-0">
            <span className="text-white font-black text-[10px] leading-none">P</span>
          </div>
          <span className="font-bold text-slate-800 text-xs tracking-tight dark:text-white">Pocket Studio</span>
          <span className="px-2 py-0.5 text-[9px] uppercase font-bold tracking-widest bg-indigo-50 text-indigo-600 rounded border border-indigo-100 dark:bg-indigo-950/40 dark:text-indigo-400 dark:border-indigo-900/60">
            PRO
          </span>
          <div className="ml-2 h-4 w-px bg-slate-200 dark:bg-slate-800" />
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500 bg-slate-100/80 px-2.5 py-0.5 rounded-full border border-slate-200/60 dark:bg-slate-800/50 dark:border-slate-700/60 dark:text-slate-400">
            <span className="text-indigo-600 font-semibold truncate max-w-[220px] dark:text-indigo-400">{project.name}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <ZoomSelect value={pageZoom} onChange={onPageZoomChange} />
          {/* Preset Layout Buttons */}
          <div className="flex items-center bg-slate-150/40 p-0.5 rounded-lg border border-slate-200/55 dark:bg-slate-800/40 dark:border-slate-700/60 mr-2">
            {/* Preset 1: Full workspace */}
            <button
              type="button"
              onClick={() => applyPresetLayout(1)}
              className="p-1.5 rounded-md hover:bg-white text-slate-500 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400 transition-all cursor-pointer"
              title="应用布局：全功能工作区 (文件管理器+编辑器区+终端)"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            {/* Preset 2: Single terminal */}
            <button
              type="button"
              onClick={() => applyPresetLayout(2)}
              className="p-1.5 rounded-md hover:bg-white text-slate-500 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400 transition-all cursor-pointer"
              title="应用布局：单终端面板"
            >
              <Maximize className="h-3.5 w-3.5" />
            </button>
            {/* Preset 3: Side by side terminals */}
            <button
              type="button"
              onClick={() => applyPresetLayout(3)}
              className="p-1.5 rounded-md hover:bg-white text-slate-500 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400 transition-all cursor-pointer"
              title="应用布局：左右双终端"
            >
              <Columns className="h-3.5 w-3.5" />
            </button>
            {/* Preset 4: Three-column layout */}
            <button
              type="button"
              onClick={() => applyPresetLayout(4)}
              className="p-1.5 rounded-md hover:bg-white text-slate-500 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400 transition-all cursor-pointer"
              title="应用布局：左侧文件+中间编辑+右侧终端"
            >
              <Columns3Icon className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="h-4 w-px bg-slate-200 dark:bg-slate-800 mr-1" />

          {/* Theme Dropdown Selector */}
          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setThemeMenuOpen(!themeMenuOpen);
              }}
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-800 dark:hover:bg-slate-800 dark:text-slate-400 dark:hover:text-slate-100 transition-colors cursor-pointer flex items-center gap-1"
              title="切换主题 / Switch Theme"
            >
              <Palette className="h-4 w-4" />
            </button>

            {themeMenuOpen && (
              <>
                <div className="fixed inset-0 z-40 cursor-default" onClick={() => setThemeMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-48 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-800/80 dark:bg-[#161d28] z-50 animate-scale-in">
                  <div className="px-2.5 py-1.5 text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest border-b border-slate-100 dark:border-slate-800 mb-1">
                    选择主题 / Themes
                  </div>
                  {[
                    { id: "light" as const, name: "极光白 (Light)", preview: "bg-[#fafafa] border-slate-350" },
                    { id: "claude" as const, name: "Claude 暖白", preview: "bg-[#f7f1e8] border-[#b66a2c]" },
                    { id: "dark" as const, name: "暗夜黑 (Dark)", preview: "bg-[#121824] border-slate-700" },
                    { id: "synthwave" as const, name: "霓虹幻境 (Synthwave)", preview: "bg-[#1c0d2e] border-fuchsia-900" },
                    { id: "onedark" as const, name: "黑客帝国 (One Dark)", preview: "bg-[#1e222a] border-slate-800" },
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
                          ? "bg-indigo-50 text-indigo-650 dark:bg-slate-800/80 dark:text-indigo-400"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/40 dark:hover:text-slate-100"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full border ${t.preview}`} />
                        <span>{t.name}</span>
                      </div>
                      {theme === t.id && <Check className="h-3.5 w-3.5 text-indigo-650 dark:text-indigo-400" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Connection Status indicator */}
          <div className="flex items-center gap-1.5 bg-slate-100/50 dark:bg-slate-800/40 px-2 py-0.5 rounded-full border border-slate-200/50 dark:border-slate-700/60">
            <CircleDot className="h-2.5 w-2.5 text-emerald-500 animate-pulse" />
            <span className="text-[9px] text-slate-500 font-mono font-bold uppercase tracking-wider dark:text-slate-400">
              Connected
            </span>
          </div>

          {/* Back button */}
          <button
            type="button"
            onClick={onBackToDashboard}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 border border-slate-205 hover:border-slate-300 shadow-sm font-semibold text-[11px] transition-all active:scale-95 duration-150 cursor-pointer dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            返回项目大厅
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5 bg-slate-50 dark:bg-[#0f131c] transition-colors duration-150">
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
