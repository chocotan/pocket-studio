import { useState, useEffect, useRef } from "react";
import type { Project } from "../studio-dashboard";
import {
  initialStudioState,
  createFileExplorerTab,
  createTerminalTab,
  createTerminalPanel,
  createFileViewerTab,
  createAgentChatTab,
  cleanLayoutTitles,
  type LayoutNode,
  type TerminalPanel,
  type StudioTab,
} from "../studio-layout";
import {
  agentNameForRuntime,
  makeId,
  isPlaceholderTerminalTitle,
  type TerminalKind,
  type SplitDirection,
  type TerminalTitleState,
} from "../terminal-types";
import {
  loadShortcutConfig,
  normalizeShortcut,
  shortcutFromEvent,
  type ShortcutAction,
} from "../shortcut-settings";
import {
  collectAllTabs,
  performSplit,
  removePanel,
  addTabToPanel,
  replaceOrAddFileViewer,
  setActiveTabInTree,
  updateTabTitleInTree,
  updateTabPropertiesInTree,
  closeTabInTree,
  findPanel,
  findPanelForTabOrAgentSession,
  findNextPanelId,
  findTab,
  removeTabForMove,
  editableTargetShouldKeepKeyboard,
} from "../studio-layout-ops";
import { directWebsocketURL, getJSON, postJSON, websocketURL } from "@/lib/api";
import type { NotificationJumpTarget } from "../terminal-notifications";

function collectAllPanels(node: LayoutNode | null): TerminalPanel[] {
  if (!node) return [];
  if (node.type === "panel") return [node];
  return node.children.flatMap(collectAllPanels);
}

interface UseWorkspaceLayoutProps {
  projectId: string;
  project: Project;
  alertTerminalIds: Set<string>;
  onTerminalFocused: (projectId: string, tabId: string) => void;
  notificationJumpTarget: NotificationJumpTarget | null;
  onNotificationJumpHandled: (nonce: number) => void;
}

export function useWorkspaceLayout({
  projectId,
  project,
  alertTerminalIds,
  onTerminalFocused,
  notificationJumpTarget,
  onNotificationJumpHandled,
}: UseWorkspaceLayoutProps) {
  const initialState = initialStudioState(project);
  const [layoutTree, setLayoutTree] = useState<LayoutNode | null>(initialState.layoutTree);
  const [focusedId, setFocusedId] = useState<string>(initialState.focusedId);
  const [newTerminalType, setNewTerminalType] = useState<TerminalKind>(initialState.newTerminalType);
  const [addMenuPanelId, setAddMenuPanelId] = useState<string | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [tabDragTarget, setTabDragTarget] = useState<{ panelId: string; insertIndex: number } | null>(null);
  const [isDraggingTab, setIsDraggingTab] = useState(false);
  const [terminalTitles, setTerminalTitles] = useState<Record<string, TerminalTitleState>>({});
  const [workspaceSwitchToken, setWorkspaceSwitchToken] = useState(0);
  const terminalTitlesRef = useRef<Record<string, TerminalTitleState>>({});
  const [stateLoaded, setStateLoaded] = useState(false);
  const [loadedProjectId, setLoadedProjectId] = useState("");

  const [layoutMode, setLayoutMode] = useState<"grid" | "floating">("grid");
  interface FloatingPanelState {
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    isMaximized: boolean;
    isMinimized: boolean;
  }
  const [floatingPanels, setFloatingPanels] = useState<Record<string, FloatingPanelState>>({});

  const skipSaveRef = useRef(true);

  function raiseFloatingPanel(
    panels: Record<string, FloatingPanelState>,
    panelId: string
  ): Record<string, FloatingPanelState> {
    const current = panels[panelId];
    if (!current) return panels;
    const maxZ = Object.values(panels).reduce((max, panel) => Math.max(max, panel.zIndex), 1);
    const alreadyTop = Object.entries(panels).every(([id, panel]) => {
      return id === panelId || panel.zIndex < current.zIndex;
    });
    if (alreadyTop && !current.isMinimized) return panels;
    return {
      ...panels,
      [panelId]: {
        ...current,
        zIndex: maxZ + 1,
        isMinimized: false,
      },
    };
  }

  function deleteAgentSession(tab: StudioTab) {
    if (tab.kind !== "agent_chat" || !tab.agentSessionId) return;
    const socket = new WebSocket(websocketURL("/ws/acpx", new URLSearchParams({ task_id: tab.agentSessionId })));
    const message = JSON.stringify({
      id: makeId("msg"),
      type: "session.delete",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: project.device_id },
      payload: {
        task_id: tab.agentSessionId,
        workspace_path: project.workspace_path,
        agent: agentNameForRuntime(tab.agentKind, tab.agentRuntime),
        agent_runtime: tab.agentRuntime,
        session_name: tab.agentSessionId,
      },
    });
    socket.onopen = () => {
      socket.send(message);
      socket.close();
    };
    socket.onerror = (error) => {
      console.error("Failed to delete agent session", error);
    };
  }

  function closeTerminalSession(tab: StudioTab) {
    if (tab.kind !== "terminal") return;
    const params = new URLSearchParams({
      project_id: projectId,
      terminal_id: tab.id,
      command: tab.activeCommand || "",
    });
    const endpoint = project.direct_mode ? project.direct_endpoint : undefined;
    if (project.direct_mode && !endpoint?.terminal_ws_url) {
      console.warn("Direct mode is enabled, but the daemon has not reported a direct terminal endpoint; closing via server relay.");
    }
    const relayURL = websocketURL("/ws/terminal", params);
    const directURL = endpoint?.terminal_ws_url ? directWebsocketURL(endpoint.terminal_ws_url, params, endpoint.token) : "";
    const message = JSON.stringify({ type: "exit", close_session: true });
    const sendClose = (url: string, fallbackURL = "") => {
      const socket = new WebSocket(url);
      let sent = false;
      let fallbackStarted = false;
      const fallback = () => {
        if (!fallbackURL || sent || fallbackStarted) return;
        fallbackStarted = true;
        sendClose(fallbackURL);
      };
      socket.onopen = () => {
        sent = true;
        socket.send(message);
        socket.close();
      };
      socket.onerror = (error) => {
        console.error("Failed to close terminal session", error);
        fallback();
      };
      socket.onclose = () => {
        fallback();
      };
    };
    sendClose(directURL || relayURL, directURL ? relayURL : "");
  }

  function closeBackendResources(tab: StudioTab) {
    deleteAgentSession(tab);
    closeTerminalSession(tab);
  }

  function closeBackendResourcesForTabs(tabs: StudioTab[]) {
    for (const tab of tabs) {
      closeBackendResources(tab);
    }
  }

  useEffect(() => {
    terminalTitlesRef.current = terminalTitles;
  }, [terminalTitles]);

  useEffect(() => {
    let cancelled = false;

    skipSaveRef.current = true;
    setStateLoaded(false);
    setLoadedProjectId("");
    setTabDragTarget(null);
    setIsDraggingTab(false);
    setTerminalTitles({});

    const applyState = (stateProject: Project) => {
      const next = initialStudioState(stateProject);
      setLayoutTree(next.layoutTree);
      setFocusedId(next.focusedId);
      setNewTerminalType(next.newTerminalType);

      const raw = stateProject.studio_state as any;
      if (raw) {
        if (raw.layoutMode === "grid" || raw.layoutMode === "floating") {
          setLayoutMode(raw.layoutMode);
        } else {
          const saved = typeof window !== "undefined" ? localStorage.getItem("pocket-studio-layout-mode") : null;
          setLayoutMode(saved === "floating" ? "floating" : "grid");
        }
        if (raw.floatingPanels && typeof raw.floatingPanels === "object") {
          setFloatingPanels(raw.floatingPanels);
        } else {
          setFloatingPanels({});
        }
      } else {
        const saved = typeof window !== "undefined" ? localStorage.getItem("pocket-studio-layout-mode") : null;
        setLayoutMode(saved === "floating" ? "floating" : "grid");
        setFloatingPanels({});
      }

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
        if (!cancelled) {
          setLoadedProjectId(projectId);
          setStateLoaded(true);
        }
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
          layoutMode,
          floatingPanels,
        },
      }).catch((err) => {
        console.error("failed to save studio state:", err);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [layoutTree, focusedId, newTerminalType, layoutMode, floatingPanels, projectId, stateLoaded]);

  const panels = collectAllPanels(layoutTree);

  useEffect(() => {
    if (!layoutTree) return;
    const currentPanels = collectAllPanels(layoutTree);
    
    setFloatingPanels((prev) => {
      let changed = false;
      const next = { ...prev };
      
      currentPanels.forEach((panel, index) => {
        if (!next[panel.id]) {
          changed = true;
          const cascadeIndex = index % 8;
          next[panel.id] = {
            x: 60 + cascadeIndex * 35,
            y: 40 + cascadeIndex * 30,
            width: 700,
            height: 480,
            zIndex: index + 1,
            isMaximized: false,
            isMinimized: false,
          };
        }
      });
      
      // Clean up deleted panels
      const activeIds = new Set(currentPanels.map((p) => p.id));
      Object.keys(next).forEach((id) => {
        if (!activeIds.has(id)) {
          delete next[id];
          changed = true;
        }
      });
      
      return changed ? next : prev;
    });
  }, [layoutTree]);

  // Sync focused panel to top of floating z-index stack
  useEffect(() => {
    if (layoutMode === "floating" && focusedId) {
      setFloatingPanels((prev) => raiseFloatingPanel(prev, focusedId));
    }
  }, [focusedId, layoutMode]);

  const focusFloatingPanel = (panelId: string) => {
    setFloatingPanels((prev) => raiseFloatingPanel(prev, panelId));
    handleFocus(panelId);
  };

  useEffect(() => {
    if (!stateLoaded || loadedProjectId !== projectId || !layoutTree || !notificationJumpTarget) return;
    if (notificationJumpTarget.projectId !== projectId) return;
    const target = findPanelForTabOrAgentSession(layoutTree, notificationJumpTarget.tabId, notificationJumpTarget.panelId);
    if (target) {
      activateTerminalTab(target.panel.id, target.tabId);
      onNotificationJumpHandled(notificationJumpTarget.nonce);
      return;
    }
    console.warn("notification target terminal not found in loaded layout:", notificationJumpTarget);
    onNotificationJumpHandled(notificationJumpTarget.nonce);
  }, [layoutTree, loadedProjectId, notificationJumpTarget?.nonce, projectId, stateLoaded]);

  useEffect(() => {
    if (!stateLoaded || !layoutTree || alertTerminalIds.size === 0) return;
    const focusedPanel = focusedId ? findPanel(layoutTree, focusedId) : null;
    const activeTab = focusedPanel?.tabs.find((tab) => tab.id === focusedPanel.activeTabId);
    if (activeTab?.id && alertTerminalIds.has(activeTab.id)) {
      onTerminalFocused(projectId, activeTab.id);
      return;
    }
    if (activeTab?.kind === "agent_chat" && activeTab.agentSessionId && alertTerminalIds.has(activeTab.agentSessionId)) {
      onTerminalFocused(projectId, activeTab.agentSessionId);
    }
  }, [alertTerminalIds, focusedId, layoutTree, projectId, stateLoaded]);

  useEffect(() => {
    const tabIds = new Set(collectAllTabs(layoutTree).map((tab) => tab.id));
    setTerminalTitles((prev) => {
      let changed = false;
      const next: Record<string, TerminalTitleState> = {};
      Object.entries(prev).forEach(([id, value]) => {
        if (tabIds.has(id)) {
          next[id] = value;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [layoutTree]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || editableTargetShouldKeepKeyboard(event)) return;
      const pressed = shortcutFromEvent(event);
      const shortcuts = loadShortcutConfig();
      const matched = (Object.keys(shortcuts) as ShortcutAction[]).find((action) => {
        return normalizeShortcut(shortcuts[action]) === pressed;
      });
      if (!matched) return;
      const handled = matched === "panel.newRight"
        ? createPanelRightOfFocused()
        : (matched === "panel.left" || matched === "panel.up")
          ? switchGlobalTab("left")
          : (matched === "panel.right" || matched === "panel.down")
            ? switchGlobalTab("right")
            : false;
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [layoutTree, focusedId]);

  function applyPresetLayout(type: 1 | 2 | 3 | 4) {
    const existingTabs = collectAllTabs(layoutTree);

    if (type === 1) {
      const explorerTabs = existingTabs.filter((t) => t.kind === "file_explorer");
      const editorTabs = existingTabs.filter((t) => t.kind === "file_viewer");
      const terminalTabs = existingTabs.filter((t) => t.kind === "terminal");

      if (explorerTabs.length === 0) {
        explorerTabs.push(createFileExplorerTab(projectId));
      }
      if (editorTabs.length === 0) {
        editorTabs.push(createTerminalTab("bash", projectId));
      }
      if (terminalTabs.length === 0) {
        terminalTabs.push(createTerminalTab("bash", projectId));
      }

      const explorerPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: explorerTabs,
        activeTabId: explorerTabs[0].id,
        focus: false,
      };

      const rightTopPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: editorTabs,
        activeTabId: editorTabs[0].id,
        focus: false,
      };

      const rightBottomPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: terminalTabs,
        activeTabId: terminalTabs[0].id,
        focus: true,
      };

      const rightSplit: LayoutNode = {
        type: "split",
        id: makeId("split"),
        orientation: "vertical",
        children: [rightTopPanel, rightBottomPanel],
        sizes: [60, 40],
      };

      const rootSplit: LayoutNode = {
        type: "split",
        id: makeId("split"),
        orientation: "horizontal",
        children: [explorerPanel, rightSplit],
        sizes: [20, 80],
      };

      setLayoutTree(rootSplit);
      setFocusedId(rightBottomPanel.id);
    } else if (type === 2) {
      const terminalTabs = existingTabs.filter((t) => t.kind === "terminal");
      if (terminalTabs.length === 0) {
        terminalTabs.push(createTerminalTab("bash", projectId));
      }
      const panel = createTerminalPanel("bash", undefined, projectId);
      panel.tabs = terminalTabs;
      panel.activeTabId = terminalTabs[0].id;
      setLayoutTree(panel);
      setFocusedId(panel.id);
    } else if (type === 3) {
      const terminalTabs = existingTabs.filter((t) => t.kind === "terminal");
      if (terminalTabs.length < 2) {
        while (terminalTabs.length < 2) {
          terminalTabs.push(createTerminalTab("bash", projectId));
        }
      }
      const mid = Math.ceil(terminalTabs.length / 2);
      const leftTabs = terminalTabs.slice(0, mid);
      const rightTabs = terminalTabs.slice(mid);

      const leftPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: leftTabs,
        activeTabId: leftTabs[0].id,
        focus: false,
      };
      const rightPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: rightTabs,
        activeTabId: rightTabs[0].id,
        focus: true,
      };
      const split: LayoutNode = {
        type: "split",
        id: makeId("split"),
        orientation: "horizontal",
        children: [leftPanel, rightPanel],
        sizes: [50, 50],
      };
      setLayoutTree(split);
      setFocusedId(rightPanel.id);
    } else if (type === 4) {
      const explorerTabs = existingTabs.filter((t) => t.kind === "file_explorer");
      const editorTabs = existingTabs.filter((t) => t.kind === "file_viewer");
      const terminalTabs = existingTabs.filter((t) => t.kind === "terminal");

      if (explorerTabs.length === 0) {
        explorerTabs.push(createFileExplorerTab(projectId));
      }
      if (editorTabs.length === 0) {
        editorTabs.push(createTerminalTab("bash", projectId));
      }
      if (terminalTabs.length === 0) {
        terminalTabs.push(createTerminalTab("bash", projectId));
      }

      const leftPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: explorerTabs,
        activeTabId: explorerTabs[0].id,
        focus: false,
      };
      const middlePanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: editorTabs,
        activeTabId: editorTabs[0].id,
        focus: false,
      };
      const rightPanel: TerminalPanel = {
        type: "panel",
        id: makeId("panel"),
        tabs: terminalTabs,
        activeTabId: terminalTabs[0].id,
        focus: true,
      };

      const split: LayoutNode = {
        type: "split",
        id: makeId("split"),
        orientation: "horizontal",
        children: [leftPanel, middlePanel, rightPanel],
        sizes: [20, 50, 30],
      };
      setLayoutTree(split);
      setFocusedId(rightPanel.id);
    }
    setLayoutVersion((v) => v + 1);
  }

  function handleFocus(panelId: string) {
    setFocusedId(panelId);
    if (layoutMode === "floating" && panelId) {
      setFloatingPanels((prev) => raiseFloatingPanel(prev, panelId));
    }
  }

  function handleSplit(panelId: string, dir: SplitDirection, kind: TerminalKind) {
    const newPanel = createTerminalPanel(kind);
    setLayoutTree((prev) => {
      if (!prev) return newPanel;
      return performSplit(prev, panelId, dir, newPanel);
    });
    setFocusedId(newPanel.id);
    setNewTerminalType(kind);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function findNextFloatingPanelId(tree: LayoutNode, closedPanelId: string): string {
    const allPanels: TerminalPanel[] = [];
    const collectPanels = (n: LayoutNode) => {
      if (n.type === "panel") {
        if (n.id !== closedPanelId) {
          allPanels.push(n);
        }
      } else if (n.type === "split") {
        n.children.forEach(collectPanels);
      }
    };
    collectPanels(tree);

    if (allPanels.length === 0) return "";

    const sorted = allPanels.map((p) => {
      const conf = floatingPanels[p.id] || { zIndex: 1, isMinimized: false };
      return { id: p.id, zIndex: conf.zIndex || 1, isMinimized: !!conf.isMinimized };
    });

    const nonMinimized = sorted.filter((s) => !s.isMinimized);
    if (nonMinimized.length > 0) {
      nonMinimized.sort((a, b) => b.zIndex - a.zIndex);
      return nonMinimized[0].id;
    }

    sorted.sort((a, b) => b.zIndex - a.zIndex);
    return sorted[0].id;
  }

  function handleClosePanel(panelId: string) {
    if (!layoutTree) return;
    const panel = findPanel(layoutTree, panelId);
    if (panel) {
      closeBackendResourcesForTabs(panel.tabs);
    }
    const isFocused = focusedId === panelId;
    let nextFocused = focusedId;
    if (isFocused) {
      if (layoutMode === "floating") {
        nextFocused = findNextFloatingPanelId(layoutTree, panelId);
      } else {
        nextFocused = findNextPanelId(layoutTree, panelId);
      }
    }
    const nextTree = removePanel(layoutTree, panelId);
    setLayoutTree(nextTree);
    if (nextTree) {
      handleFocus(nextFocused === panelId ? "" : nextFocused);
    } else {
      setFocusedId("");
    }
    setAddMenuPanelId((prev) => (prev === panelId ? null : prev));
    setLayoutVersion((value) => value + 1);
  }

  function handleAddTab(panelId: string, kind: TerminalKind, tabProjectId?: string, filePath?: string) {
    const tab = createTerminalTab(kind, tabProjectId, filePath);
    setLayoutTree((prev) => (prev ? addTabToPanel(prev, panelId, tab) : createTerminalPanel(kind, panelId, tabProjectId, filePath)));
    setFocusedId(panelId);
    setNewTerminalType(kind);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function handleAddFileExplorer(panelId: string, tabProjectId?: string, filePath?: string) {
    const tab = createFileExplorerTab(tabProjectId, filePath);
    setLayoutTree((prev) => (prev ? addTabToPanel(prev, panelId, tab) : null));
    setFocusedId(panelId);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function handleAddAgentChat(panelId: string, agentKind: string, agentRuntime: StudioTab["agentRuntime"] = "acpx", tabProjectId?: string, filePath?: string) {
    const tab = createAgentChatTab(agentKind, undefined, undefined, agentRuntime, tabProjectId, filePath);
    setLayoutTree((prev) => (prev ? addTabToPanel(prev, panelId, tab) : null));
    setFocusedId(panelId);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function handleUpdateTabProperties(tabId: string, props: Partial<StudioTab>) {
    setLayoutTree((prev) => (prev ? updateTabPropertiesInTree(prev, tabId, props) : null));
    setLayoutVersion((value) => value + 1);
  }

  function handleOpenFile(fromPanelId: string, path: string, tabProjectId?: string) {
    const tab = createFileViewerTab(path, "unknown", tabProjectId);
    setLayoutTree((prev) => (prev ? replaceOrAddFileViewer(prev, fromPanelId, tab) : null));
    setFocusedId(fromPanelId);
    setLayoutVersion((value) => value + 1);
  }

  function handleCloseTab(panelId: string, tabId: string) {
    if (layoutTree) {
      const tab = findTab(layoutTree, panelId, tabId);
      if (tab) {
        closeBackendResources(tab);
      }
    }
    setLayoutTree((prev) => {
      if (!prev) return null;
      const nextTree = closeTabInTree(prev, panelId, tabId);
      if (nextTree && nextTree.type === "panel" && nextTree.tabs.length === 0) {
        return null;
      }
      return nextTree;
    });
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function activateTerminalTab(panelId: string, tabId: string) {
    setLayoutTree((prev) => (prev ? setActiveTabInTree(prev, panelId, tabId) : null));
    setFocusedId(panelId);
    setLayoutVersion((value) => value + 1);
  }

  function handleActiveTab(panelId: string, tabId: string) {
    activateTerminalTab(panelId, tabId);
  }

  function handleTerminalFocus(panelId: string, tabId: string) {
    handleFocus(panelId);
    onTerminalFocused(projectId, tabId);
  }

  function handleMoveTab(fromPanelId: string, toPanelId: string, tabId: string, insertIndex: number) {
    if (!layoutTree) return;
    const tab = findTab(layoutTree, fromPanelId, tabId);
    if (!tab) return;
    if (fromPanelId === toPanelId) {
      setLayoutTree((prev) => {
        if (!prev) return null;
        const cleaned = removeTabForMove(prev, fromPanelId, tabId);
        if (!cleaned) return prev;
        return addTabToPanel(cleaned, toPanelId, tab, insertIndex);
      });
      setLayoutVersion((value) => value + 1);
      return;
    }
    setLayoutTree((prev) => {
      if (!prev) return null;
      const cleaned = removeTabForMove(prev, fromPanelId, tabId);
      if (!cleaned) {
        return addTabToPanel(prev, toPanelId, tab, insertIndex);
      }
      return addTabToPanel(cleaned, toPanelId, tab, insertIndex);
    });
    setFocusedId(toPanelId);
    setLayoutVersion((value) => value + 1);
  }

  function resolveTabDrop(clientX: number, clientY: number, fallbackPanelId: string, fallbackIndex: number) {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const element of elements) {
      const panelEl = element.closest("[data-studio-panel='true']");
      if (!(panelEl instanceof HTMLElement)) continue;
      const panelId = panelEl.dataset.panelId || "";
      if (!panelId) continue;
      const tabsEl = element.closest("[data-panel-tabs-container='true']");
      if (tabsEl) {
        const children = Array.from(tabsEl.querySelectorAll("[data-tab-button='true']"));
        for (let i = 0; i < children.length; i++) {
          const rect = children[i].getBoundingClientRect();
          if (clientX < rect.left + rect.width / 2) {
            return { panelId, index: i };
          }
        }
        return { panelId, index: children.length };
      }
      return layoutMode === "floating" ? null : { panelId, index: -1 };
    }
    return { panelId: fallbackPanelId, index: fallbackIndex };
  }

  function handleTabDragMove(clientX: number, clientY: number, fallbackPanelId: string, fallbackIndex: number) {
    const target = resolveTabDrop(clientX, clientY, fallbackPanelId, fallbackIndex);
    if (!target) {
      if (tabDragTarget) setTabDragTarget(null);
      return;
    }
    if (!tabDragTarget || tabDragTarget.panelId !== target.panelId || tabDragTarget.insertIndex !== target.index) {
      setTabDragTarget({ panelId: target.panelId, insertIndex: target.index });
    }
  }

  function handleTabDragEnd(fromPanelId: string, tabId: string, clientX: number, clientY: number, fallbackIndex: number) {
    const target = resolveTabDrop(clientX, clientY, fromPanelId, fallbackIndex);
    setTabDragTarget(null);
    setIsDraggingTab(false);
    if (!target) return;
    const dropIndex = target.index === -1 ? 9999 : target.index;
    handleMoveTab(fromPanelId, target.panelId, tabId, dropIndex);
  }

  function handleTerminalTitle(tabId: string, title: string, command?: string, fullTitle?: string) {
    const nextTitle = (title || "").trim();
    const nextFullTitle = (fullTitle || "").trim();
    const nextCommand = (command || "").trim();
    const previous = terminalTitlesRef.current[tabId];
    if (isPlaceholderTerminalTitle(nextTitle, nextCommand)) {
      const nextTitles = {
        ...terminalTitlesRef.current,
        [tabId]: {
          title: previous?.title || "",
          fullTitle: previous?.fullTitle || "",
          command: nextCommand,
          source: previous?.source || "initial" as const,
        },
      };
      terminalTitlesRef.current = nextTitles;
      setTerminalTitles(nextTitles);
      return;
    }
    const nextSource = nextTitle ? "tmux" as const : "initial" as const;
    const nextTitles = {
      ...terminalTitlesRef.current,
      [tabId]: {
        title: nextTitle,
        fullTitle: nextFullTitle,
        command: nextCommand,
        source: nextSource,
      },
    };
    terminalTitlesRef.current = nextTitles;
    setTerminalTitles(nextTitles);
    setLayoutTree((tree) => (tree ? updateTabTitleInTree(tree, tabId, nextTitle, nextCommand, nextSource) : tree));
  }

  function handleCreateInitialPanel(kind: TerminalKind) {
    const panel = createTerminalPanel(kind, undefined, projectId);
    setLayoutTree(panel);
    setFocusedId(panel.id);
    setNewTerminalType(kind);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function handleCreateInitialFileExplorer() {
    const tab = createFileExplorerTab(projectId);
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



  function createPanelRightOfFocused() {
    if (!focusedId) return false;
    handleSplit(focusedId, "right", newTerminalType);
    return true;
  }

  function switchGlobalTab(direction: "left" | "right") {
    const currentPanels = collectAllPanels(layoutTree);
    const allTabsWithPanel = currentPanels.flatMap((p) =>
      p.tabs.map((t) => ({ tab: t, panel: p }))
    );
    if (allTabsWithPanel.length <= 1) return false;

    const activeIndex = allTabsWithPanel.findIndex(({ tab, panel }) => {
      return panel.id === focusedId && panel.activeTabId === tab.id;
    });

    let nextIndex = 0;
    if (activeIndex >= 0) {
      nextIndex = direction === "left"
        ? (activeIndex - 1 + allTabsWithPanel.length) % allTabsWithPanel.length
        : (activeIndex + 1) % allTabsWithPanel.length;
    }

    const target = allTabsWithPanel[nextIndex];
    setFloatingPanels((prev) => {
      const cur = prev[target.panel.id];
      if (cur && cur.isMinimized) {
        return {
          ...prev,
          [target.panel.id]: { ...cur, isMinimized: false }
        };
      }
      return prev;
    });
    handleActiveTab(target.panel.id, target.tab.id);
    focusFloatingPanel(target.panel.id);
    setWorkspaceSwitchToken((value) => value + 1);
    return true;
  }

  function insertNewPanel(newPanel: TerminalPanel) {
    setLayoutTree((prev) => {
      if (!prev) return newPanel;
      const currentPanels = collectAllPanels(prev);
      const targetId = focusedId || currentPanels[0]?.id || "";
      if (!targetId) return newPanel;
      return performSplit(prev, targetId, "right", newPanel);
    });
    setFocusedId(newPanel.id);
    setLayoutVersion((value) => value + 1);
  }

  function handleCreateNewPanel(kind: TerminalKind, tabProjectId?: string, filePath?: string) {
    const newTab = createTerminalTab(kind, tabProjectId, filePath);
    const panelId = makeId("panel");
    insertNewPanel({
      type: "panel",
      id: panelId,
      tabs: [newTab],
      activeTabId: newTab.id,
      focus: true,
    });
    setNewTerminalType(kind);
  }

  function handleCreateNewFileExplorer(tabProjectId?: string, filePath?: string) {
    const newTab = createFileExplorerTab(tabProjectId, filePath);
    const panelId = makeId("panel");
    insertNewPanel({
      type: "panel",
      id: panelId,
      tabs: [newTab],
      activeTabId: newTab.id,
      focus: true,
    });
  }

  function handleCreateNewAgentChat(agentKind: string, agentRuntime: StudioTab["agentRuntime"] = "acpx", tabProjectId?: string, filePath?: string) {
    const newTab = createAgentChatTab(agentKind, undefined, undefined, agentRuntime, tabProjectId, filePath);
    const panelId = makeId("panel");
    insertNewPanel({
      type: "panel",
      id: panelId,
      tabs: [newTab],
      activeTabId: newTab.id,
      focus: true,
    });
  }

  return {
    layoutTree,
    setLayoutTree,
    focusedId,
    setFocusedId,
    newTerminalType,
    setNewTerminalType,
    addMenuPanelId,
    setAddMenuPanelId,
    layoutVersion,
    setLayoutVersion,
    tabDragTarget,
    setTabDragTarget,
    isDraggingTab,
    setIsDraggingTab,
    terminalTitles,
    setTerminalTitles,
    workspaceSwitchToken,
    stateLoaded,
    loadedProjectId,
    applyPresetLayout,
    handleFocus,
    handleSplit,
    handleClosePanel,
    handleAddTab,
    handleAddFileExplorer,
    handleAddAgentChat,
    handleUpdateTabProperties,
    handleOpenFile,
    handleCloseTab,
    activateTerminalTab,
    handleActiveTab,
    handleTerminalFocus,
    handleMoveTab,
    resolveTabDrop,
    handleTabDragMove,
    handleTabDragEnd,
    handleTerminalTitle,
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
  };
}
