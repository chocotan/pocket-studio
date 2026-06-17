import { makeId, type TerminalTitleSource, type SplitDirection } from "./terminal-types";
import { normalizeSizes, type LayoutNode, type TerminalPanel, type TerminalTab, type StudioTab } from "./studio-layout";

export function editableTargetShouldKeepKeyboard(event: KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

export function performSplit(
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

export function removePanel(node: LayoutNode, targetId: string): LayoutNode | null {
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

export function updateSplitSizes(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (node.type === "panel") return node;
  if (node.id === splitId) return { ...node, sizes: normalizeSizes(sizes, node.children.length) };
  return { ...node, children: node.children.map((child) => updateSplitSizes(child, splitId, sizes)) };
}

export function addTabToPanel(node: LayoutNode, panelId: string, tab: StudioTab, insertIndex?: number): LayoutNode {
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

export function replaceOrAddFileViewer(node: LayoutNode, panelId: string, tab: StudioTab): LayoutNode {
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

export function setActiveTabInTree(node: LayoutNode, panelId: string, tabId: string): LayoutNode {
  if (node.type === "panel") {
    if (node.id !== panelId) return node;
    return { ...node, activeTabId: tabId, focus: true };
  }
  return { ...node, children: node.children.map((child) => setActiveTabInTree(child, panelId, tabId)) };
}

export function updateTabTitleInTree(node: LayoutNode, tabId: string, title: string, command: string, source: TerminalTitleSource): LayoutNode {
  if (node.type === "panel") {
    let changed = false;
    const tabs = node.tabs.map((tab) => {
      if (tab.id !== tabId || tab.kind !== "terminal") return tab;
      if (tab.title === title && tab.activeCommand === command && tab.titleSource === source) return tab;
      changed = true;
      return {
        ...tab,
        title,
        activeCommand: command,
        titleSource: source,
      };
    });
    return changed ? { ...node, tabs } : node;
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateTabTitleInTree(child, tabId, title, command, source);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export function closeTabInTree(node: LayoutNode, panelId: string, tabId: string): LayoutNode {
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

export function findPanel(node: LayoutNode, panelId: string): TerminalPanel | null {
  if (node.type === "panel") return node.id === panelId ? node : null;
  for (const child of node.children) {
    const panel = findPanel(child, panelId);
    if (panel) return panel;
  }
  return null;
}

export function findPanelForTab(node: LayoutNode, tabId: string, preferredPanelId = ""): TerminalPanel | null {
  if (preferredPanelId) {
    const preferred = findPanel(node, preferredPanelId);
    if (preferred?.tabs.some((tab) => tab.id === tabId)) return preferred;
  }
  if (node.type === "panel") {
    return node.tabs.some((tab) => tab.id === tabId) ? node : null;
  }
  for (const child of node.children) {
    const panel = findPanelForTab(child, tabId);
    if (panel) return panel;
  }
  return null;
}

export function findNextPanelId(node: LayoutNode, panelId: string): string {
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

export function findTab(node: LayoutNode, panelId: string, tabId: string): TerminalTab | null {
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

export function removeTabForMove(node: LayoutNode, panelId: string, tabId: string): LayoutNode | null {
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

export function collectAllTabs(node: LayoutNode | null): StudioTab[] {
  if (!node) return [];
  if (node.type === "panel") {
    return [...node.tabs];
  }
  return node.children.flatMap(collectAllTabs);
}

export function updateTabPropertiesInTree(node: LayoutNode, tabId: string, props: Partial<StudioTab>): LayoutNode {
  if (node.type === "panel") {
    let changed = false;
    const tabs = node.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      changed = true;
      return {
        ...tab,
        ...props,
      };
    });
    return changed ? { ...node, tabs } : node;
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateTabPropertiesInTree(child, tabId, props);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

