import type { Project } from "./studio-dashboard";
import {
  cleanTerminalTitle,
  isTerminalKind,
  makeId,
  type TerminalTitleSource,
  type TerminalKind,
  terminalType,
} from "./terminal-types";

export type StudioTabKind = "terminal" | "file_explorer" | "file_viewer";

export interface StudioTab {
  id: string;
  kind: StudioTabKind;
  title: string;
  termType: TerminalKind;
  activeCommand?: string;
  titleSource?: TerminalTitleSource;
  filePath?: string;
  fileKind?: "text" | "image" | "unknown";
}

export interface TerminalPanel {
  type: "panel";
  id: string;
  tabs: StudioTab[];
  activeTabId: string;
  focus: boolean;
}

export interface SplitGroup {
  type: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  children: LayoutNode[];
  sizes?: number[];
}

export type LayoutNode = TerminalPanel | SplitGroup;

export interface StudioState {
  layoutTree: LayoutNode | null;
  focusedId: string;
  newTerminalType: TerminalKind;
}

export function createTerminalTab(kind: TerminalKind): TerminalTab {
  const type = terminalType(kind);
  return {
    id: makeId("term"),
    kind: "terminal",
    title: type.title,
    termType: type.value,
    activeCommand: type.command,
    titleSource: "initial",
  };
}

export type TerminalTab = StudioTab;

export function createFileExplorerTab(): StudioTab {
  return {
    id: makeId("file"),
    kind: "file_explorer",
    title: "文件",
    termType: "bash",
    activeCommand: "",
    titleSource: "initial",
  };
}

export function createFileViewerTab(path: string, kind: "text" | "image" | "unknown" = "unknown"): StudioTab {
  return {
    id: makeId("view"),
    kind: "file_viewer",
    title: basename(path) || "文件",
    termType: "bash",
    activeCommand: "",
    titleSource: "initial",
    filePath: path,
    fileKind: kind,
  };
}

export function createTerminalPanel(kind: TerminalKind, id = makeId("panel")): TerminalPanel {
  const tab = createTerminalTab(kind);
  return {
    type: "panel",
    id,
    tabs: [tab],
    activeTabId: tab.id,
    focus: true,
  };
}

export function normalizeSizes(value: unknown[], count: number): number[] {
  const sizes = value
    .map((item) => (typeof item === "number" && Number.isFinite(item) && item > 0 ? item : 0))
    .slice(0, count);
  while (sizes.length < count) sizes.push(0);
  const total = sizes.reduce((sum, item) => sum + item, 0);
  if (total <= 0) return Array.from({ length: count }, () => 100 / count);
  return sizes.map((item) => (item / total) * 100);
}

export function initialStudioState(project: Project): StudioState {
  const raw = project.studio_state as Partial<StudioState> | undefined;
  if (raw && "layoutTree" in raw && raw.layoutTree === null) {
    return {
      layoutTree: null,
      focusedId: "",
      newTerminalType: isTerminalKind(raw?.newTerminalType) ? raw.newTerminalType : "bash",
    };
  }
  const layoutTree = sanitizeLayoutNode(raw?.layoutTree, createLayoutIDTracker()) || createTerminalPanel("bash");
  const firstFocused = findFocusedPanel(layoutTree) || firstPanelInTree(layoutTree).id;
  const focusedId = typeof raw?.focusedId === "string" && raw.focusedId ? raw.focusedId : firstFocused;
  return {
    layoutTree: setFocusInLayout(layoutTree, focusedId),
    focusedId,
    newTerminalType: isTerminalKind(raw?.newTerminalType) ? raw.newTerminalType : "bash",
  };
}

interface LayoutIDTracker {
  panels: Set<string>;
  splits: Set<string>;
  tabs: Set<string>;
}

function createLayoutIDTracker(): LayoutIDTracker {
  return {
    panels: new Set(),
    splits: new Set(),
    tabs: new Set(),
  };
}

function uniqueLayoutID(value: unknown, prefix: "panel" | "split" | "term" | "file" | "view", used: Set<string>): string {
  const id = typeof value === "string" && value ? value : makeId(prefix);
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let next = makeId(prefix);
  while (used.has(next)) {
    next = makeId(prefix);
  }
  used.add(next);
  return next;
}

export function sanitizeLayoutNode(value: unknown, tracker = createLayoutIDTracker()): LayoutNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;

  if (node.type === "panel") {
    const tabs = Array.isArray(node.tabs)
      ? node.tabs.map((tab) => sanitizeTab(tab, tracker)).filter((tab): tab is TerminalTab => tab !== null)
      : [];
    const activeTabId = typeof node.activeTabId === "string" && tabs.some((tab) => tab.id === node.activeTabId)
      ? node.activeTabId
      : (tabs.length > 0 ? tabs[0].id : "");
    return {
      type: "panel",
      id: uniqueLayoutID(node.id, "panel", tracker.panels),
      tabs,
      activeTabId,
      focus: Boolean(node.focus),
    };
  }

  if (node.type === "pane") {
    const kind = isTerminalKind(node.termType) ? node.termType : "bash";
    const type = terminalType(kind);
    const tab: TerminalTab = {
      id: uniqueLayoutID(node.id, "term", tracker.tabs),
      kind: "terminal",
      title: cleanTerminalTitle(typeof node.title === "string" ? node.title : "", type.title, kind),
      termType: kind,
      activeCommand: typeof node.activeCommand === "string" ? node.activeCommand : "",
      titleSource: "initial",
    };
    return {
      type: "panel",
      id: uniqueLayoutID(undefined, "panel", tracker.panels),
      tabs: [tab],
      activeTabId: tab.id,
      focus: Boolean(node.focus),
    };
  }

  if (node.type === "split") {
    const children = Array.isArray(node.children)
      ? node.children.map((child) => sanitizeLayoutNode(child, tracker)).filter((child): child is LayoutNode => child !== null)
      : [];
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return {
      type: "split",
      id: uniqueLayoutID(node.id, "split", tracker.splits),
      orientation: node.orientation === "vertical" ? "vertical" : "horizontal",
      children,
      sizes: normalizeSizes(Array.isArray(node.sizes) ? node.sizes : [], children.length),
    };
  }
  return null;
}

export function firstPanelInTree(node: LayoutNode): TerminalPanel {
  if (node.type === "panel") return node;
  return firstPanelInTree(node.children[0]);
}

export function findFocusedPanel(node: LayoutNode): string {
  if (node.type === "panel") return node.focus ? node.id : "";
  for (const child of node.children) {
    const id = findFocusedPanel(child);
    if (id) return id;
  }
  return "";
}

export function setFocusInLayout(node: LayoutNode, id: string | null): LayoutNode {
  if (node.type === "panel") return { ...node, focus: node.id === id };
  return { ...node, children: node.children.map((child) => setFocusInLayout(child, id)) };
}

export function cleanLayoutTitles(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "panel") {
    return {
      ...node,
      tabs: node.tabs.map((tab) => ({
        ...tab,
        title: tab.kind === "file_explorer" || tab.kind === "file_viewer"
          ? tab.kind === "file_explorer" ? "文件" : tab.title
          : cleanTerminalTitle(tab.title, terminalType(tab.termType).title, tab.termType),
        titleSource: tab.titleSource || "initial",
      })),
    };
  }
  return {
    ...node,
    children: node.children.map((child) => cleanLayoutTitles(child)).filter((child): child is LayoutNode => child !== null),
  };
}

export function splitLayoutMap(node: SplitGroup): Record<string, number> {
  const sizes = normalizeSizes(node.sizes || [], node.children.length);
  return Object.fromEntries(node.children.map((child, index) => [child.id, sizes[index]]));
}

export function sizesFromLayoutMap(node: SplitGroup, layout: Record<string, number>): number[] {
  return node.children.map((child) => layout[child.id] || 0);
}

function sanitizeTab(value: unknown, tracker?: LayoutIDTracker): TerminalTab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Record<string, unknown>;
  const tabKind: StudioTabKind = tab.kind === "file_explorer"
    ? "file_explorer"
    : tab.kind === "file_viewer"
      ? "file_viewer"
      : "terminal";
  const kind = isTerminalKind(tab.termType) ? tab.termType : "bash";
  const type = terminalType(kind);
  const idPrefix = tabKind === "file_explorer" ? "file" : tabKind === "file_viewer" ? "view" : "term";
  const filePath = typeof tab.filePath === "string" ? tab.filePath : "";
  return {
    id: tracker ? uniqueLayoutID(tab.id, idPrefix, tracker.tabs) : (typeof tab.id === "string" && tab.id ? tab.id : makeId(idPrefix)),
    kind: tabKind,
    title: tabKind === "file_explorer"
      ? "文件"
      : tabKind === "file_viewer"
        ? (typeof tab.title === "string" && tab.title ? tab.title : basename(filePath) || "文件")
      : cleanTerminalTitle(typeof tab.title === "string" ? tab.title : "", type.title, kind),
    termType: kind,
    activeCommand: typeof tab.activeCommand === "string" ? tab.activeCommand : "",
    titleSource: tab.titleSource === "tmux" ? tab.titleSource : "initial",
    filePath,
    fileKind: tab.fileKind === "text" || tab.fileKind === "image" ? tab.fileKind : "unknown",
  };
}

function basename(path: string) {
  const normalized = path.replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}
