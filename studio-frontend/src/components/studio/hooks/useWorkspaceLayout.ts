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
  PANEL_DIRECTIONS,
  loadShortcutConfig,
  normalizeShortcut,
  shortcutFromEvent,
  type PanelDirection,
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
  const terminalTitlesRef = useRef<Record<string, TerminalTitleState>>({});
  const [stateLoaded, setStateLoaded] = useState(false);
  const [loadedProjectId, setLoadedProjectId] = useState("");

  const skipSaveRef = useRef(true);
  const prevDeviceRef = useRef<string | null>(null);

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

    if (prevDeviceRef.current === project.device_id && layoutTree) {
      setLoadedProjectId(projectId);
      setStateLoaded(true);
      return;
    }

    prevDeviceRef.current = project.device_id;
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
        },
      }).catch((err) => {
        console.error("failed to save studio state:", err);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [layoutTree, focusedId, newTerminalType, projectId, stateLoaded]);

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
        : matched in PANEL_DIRECTIONS && focusPanelByDirection(PANEL_DIRECTIONS[matched as keyof typeof PANEL_DIRECTIONS]);
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

  function handleClosePanel(panelId: string) {
    if (!layoutTree) return;
    const panel = findPanel(layoutTree, panelId);
    if (panel) {
      closeBackendResourcesForTabs(panel.tabs);
    }
    const isFocused = focusedId === panelId;
    const nextFocused = isFocused ? findNextPanelId(layoutTree, panelId) : focusedId;
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

  function handleAddTab(panelId: string, kind: TerminalKind, tabProjectId?: string) {
    const tab = createTerminalTab(kind, tabProjectId);
    setLayoutTree((prev) => (prev ? addTabToPanel(prev, panelId, tab) : createTerminalPanel(kind, panelId, tabProjectId)));
    setFocusedId(panelId);
    setNewTerminalType(kind);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function handleAddFileExplorer(panelId: string, tabProjectId?: string) {
    const tab = createFileExplorerTab(tabProjectId);
    setLayoutTree((prev) => (prev ? addTabToPanel(prev, panelId, tab) : null));
    setFocusedId(panelId);
    setAddMenuPanelId(null);
    setLayoutVersion((value) => value + 1);
  }

  function handleAddAgentChat(panelId: string, agentKind: string, agentRuntime: StudioTab["agentRuntime"] = "acpx", tabProjectId?: string) {
    const tab = createAgentChatTab(agentKind, undefined, undefined, agentRuntime, tabProjectId);
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
        if (!cleaned) return null;
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
      return { panelId, index: -1 };
    }
    return { panelId: fallbackPanelId, index: fallbackIndex };
  }

  function handleTabDragMove(clientX: number, clientY: number, fallbackPanelId: string, fallbackIndex: number) {
    const target = resolveTabDrop(clientX, clientY, fallbackPanelId, fallbackIndex);
    if (!tabDragTarget || tabDragTarget.panelId !== target.panelId || tabDragTarget.insertIndex !== target.index) {
      setTabDragTarget({ panelId: target.panelId, insertIndex: target.index });
    }
  }

  function handleTabDragEnd(fromPanelId: string, tabId: string, clientX: number, clientY: number, fallbackIndex: number) {
    const target = resolveTabDrop(clientX, clientY, fromPanelId, fallbackIndex);
    setTabDragTarget(null);
    setIsDraggingTab(false);
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

  function findDirectionalPanelId(direction: PanelDirection): string {
    if (!layoutTree || !focusedId) return "";
    const current = document.querySelector<HTMLElement>(`[data-studio-panel="true"][data-panel-id="${CSS.escape(focusedId)}"]`);
    if (!current) return "";
    const currentRect = current.getBoundingClientRect();
    const currentCenterX = currentRect.left + currentRect.width / 2;
    const currentCenterY = currentRect.top + currentRect.height / 2;
    const allPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-studio-panel='true']"))
      .map((panel) => {
        const rect = panel.getBoundingClientRect();
        return {
          id: panel.dataset.panelId || "",
          rect,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
        };
      })
      .filter((panel) => panel.id);
    const candidates = allPanels
      .filter((panel) => panel.id !== focusedId)
      .map((panel) => {
        const horizontalOverlap = Math.max(0, Math.min(currentRect.right, panel.rect.right) - Math.max(currentRect.left, panel.rect.left));
        const verticalOverlap = Math.max(0, Math.min(currentRect.bottom, panel.rect.bottom) - Math.max(currentRect.top, panel.rect.top));
        const primaryDistance = direction === "left"
          ? currentRect.left - panel.rect.right
          : direction === "right"
            ? panel.rect.left - currentRect.right
            : direction === "up"
              ? currentRect.top - panel.rect.bottom
              : panel.rect.top - currentRect.bottom;
        const centerDistance = direction === "left" || direction === "right"
          ? Math.abs(panel.centerY - currentCenterY)
          : Math.abs(panel.centerX - currentCenterX);
        const overlap = direction === "left" || direction === "right" ? verticalOverlap : horizontalOverlap;
        return {
          id: panel.id,
          primaryDistance,
          centerDistance,
          overlap,
        };
      })
      .filter((panel) => panel.primaryDistance >= -1);

    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        if (a.primaryDistance !== b.primaryDistance) return a.primaryDistance - b.primaryDistance;
        if (a.overlap !== b.overlap) return b.overlap - a.overlap;
        return a.centerDistance - b.centerDistance;
      });
      return candidates[0].id;
    }

    return findWrappedPanelId(allPanels, focusedId, direction);
  }

  function findWrappedPanelId(
    panels: Array<{ id: string; rect: DOMRect; centerX: number; centerY: number }>,
    currentPanelId: string,
    direction: PanelDirection
  ) {
    const ordered = [...panels].sort((a, b) => {
      if (Math.abs(a.rect.top - b.rect.top) > 8) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });
    const currentIndex = ordered.findIndex((panel) => panel.id === currentPanelId);
    if (currentIndex < 0 || ordered.length <= 1) return "";
    if (direction === "right" || direction === "down") {
      return ordered[(currentIndex + 1) % ordered.length].id;
    }
    return ordered[(currentIndex - 1 + ordered.length) % ordered.length].id;
  }

  function focusPanelByDirection(direction: PanelDirection) {
    const nextPanelId = findDirectionalPanelId(direction);
    if (!nextPanelId) return false;
    handleFocus(nextPanelId);
    return true;
  }

  function createPanelRightOfFocused() {
    if (!focusedId) return false;
    handleSplit(focusedId, "right", newTerminalType);
    return true;
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
  };
}
