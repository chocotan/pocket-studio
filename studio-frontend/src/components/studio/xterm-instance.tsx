import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";
import type { StudioTheme } from "./terminal-types";
import { directWebsocketURL, getJSON, postJSON, websocketURL } from "@/lib/api";
import { pocketElectronAPI } from "@/lib/electron-api";
import { projectDirectMode } from "@/lib/direct-mode";
import { createTerminalImeCompositionGuard } from "./terminal-ime-input";
import { terminalImagePasteText } from "./terminal-image-paste";
import { handleRemoteControlV } from "./terminal-keyboard-input";

export function getXtermTheme(theme: StudioTheme) {
  // Keep terminal surfaces aligned with CSS theme tokens.
  if (theme === "dark") {
    return {
      background:          "#171c28",
      foreground:          "#e8edf7",
      cursor:              "#a5b4fc",
      cursorAccent:        "#171c28",
      selectionBackground: "rgba(129, 140, 248, 0.32)",
      selectionForeground: "#e8edf7",
      black:               "#1f2533",
      red:                 "#f87171",
      green:               "#34d399",
      yellow:              "#fbbf24",
      blue:                "#60a5fa",
      magenta:             "#c4b5fd",
      cyan:                "#22d3ee",
      white:               "#e8edf7",
      brightBlack:         "#94a3b8",
      brightRed:           "#fca5a5",
      brightGreen:         "#6ee7b7",
      brightYellow:        "#fcd34d",
      brightBlue:          "#93c5fd",
      brightMagenta:       "#ddd6fe",
      brightCyan:          "#67e8f9",
      brightWhite:         "#ffffff",
    };
  }

  if (theme === "synthwave") {
    return {
      background:          "#1b1029",
      foreground:          "#f8e8ff",
      cursor:              "#f0abfc",
      cursorAccent:        "#1b1029",
      selectionBackground: "rgba(232, 121, 249, 0.28)",
      selectionForeground: "#f8e8ff",
      black:               "#241338",
      red:                 "#fb7185",
      green:               "#4ade80",
      yellow:              "#fde047",
      blue:                "#38bdf8",
      magenta:             "#e879f9",
      cyan:                "#22d3ee",
      white:               "#f8e8ff",
      brightBlack:         "#c4b5fd",
      brightRed:           "#fda4af",
      brightGreen:         "#86efac",
      brightYellow:        "#fef08a",
      brightBlue:          "#7dd3fc",
      brightMagenta:       "#f0abfc",
      brightCyan:          "#67e8f9",
      brightWhite:         "#ffffff",
    };
  }

  if (theme === "charcoal") {
    return {
      background:          "#3b414c",
      foreground:          "#d5dae2",
      cursor:              "#8bb7cc",
      cursorAccent:        "#3b414c",
      selectionBackground: "rgba(108, 167, 195, 0.28)",
      selectionForeground: "#d5dae2",
      black:               "#2b3038",
      red:                 "#d58a90",
      green:               "#93b899",
      yellow:              "#d0b08a",
      blue:                "#8ab5d4",
      magenta:             "#c4a0c6",
      cyan:                "#8bc0bf",
      white:               "#d5dae2",
      brightBlack:         "#7a8290",
      brightRed:           "#e3a4a9",
      brightGreen:         "#aaccaf",
      brightYellow:        "#e0c4a0",
      brightBlue:          "#a4c8e2",
      brightMagenta:       "#d4b5d6",
      brightCyan:          "#a5d0cf",
      brightWhite:         "#eef1f5",
    };
  }

  if (theme === "onedark") {
    return {
      background:          "#282c34",
      foreground:          "#abb2bf",
      cursor:              "#61afef",
      cursorAccent:        "#282c34",
      selectionBackground: "rgba(97, 175, 239, 0.28)",
      selectionForeground: "#abb2bf",
      black:               "#21252b",
      red:                 "#e06c75",
      green:               "#98c379",
      yellow:              "#e5c07b",
      blue:                "#61afef",
      magenta:             "#c678dd",
      cyan:                "#56b6c2",
      white:               "#abb2bf",
      brightBlack:         "#5c6370",
      brightRed:           "#e06c75",
      brightGreen:         "#98c379",
      brightYellow:        "#e5c07b",
      brightBlue:          "#61afef",
      brightMagenta:       "#c678dd",
      brightCyan:          "#56b6c2",
      brightWhite:         "#ffffff",
    };
  }

  if (theme === "sandalwood") {
    return {
      background:          "#f8f4ec",
      foreground:          "#2a221a",
      cursor:              "#c86446",
      cursorAccent:        "#f8f4ec",
      selectionBackground: "rgba(200, 100, 70, 0.18)",
      selectionForeground: "#2a221a",
      black:               "#2a221a",
      red:                 "#ae4d31",
      green:               "#4d7a5b",
      yellow:              "#b07d30",
      blue:                "#3d6b8a",
      magenta:             "#8b5475",
      cyan:                "#3d8a80",
      white:               "#ebe4d7",
      brightBlack:         "#7a7065",
      brightRed:           "#c86446",
      brightGreen:         "#5fa078",
      brightYellow:        "#cca355",
      brightBlue:          "#5f94b3",
      brightMagenta:       "#a67390",
      brightCyan:          "#5fb3a8",
      brightWhite:         "#fdfbf7",
    };
  }

  if (theme === "claude") {
    return {
      background:          "#f7f0e4",
      foreground:          "#2c2218",
      cursor:              "#b35f2a",
      cursorAccent:        "#f7f0e4",
      selectionBackground: "rgba(179, 95, 42, 0.18)",
      selectionForeground: "#2c2218",
      black:               "#2c2218",
      red:                 "#b42318",
      green:               "#2f7d4f",
      yellow:              "#a15c16",
      blue:                "#2f5f9f",
      magenta:             "#8b4a7a",
      cyan:                "#2f7a7a",
      white:               "#eadcc9",
      brightBlack:         "#7a6b5c",
      brightRed:           "#d0442e",
      brightGreen:         "#3d9b63",
      brightYellow:        "#c27a2c",
      brightBlue:          "#3d74bd",
      brightMagenta:       "#a95d95",
      brightCyan:          "#3d9592",
      brightWhite:         "#fff7ed",
    };
  }

  if (theme === "sky") {
    return {
      background:          "#f4f8ff",
      foreground:          "#16273f",
      cursor:              "#2563eb",
      cursorAccent:        "#f4f8ff",
      selectionBackground: "rgba(37, 99, 235, 0.16)",
      selectionForeground: "#16273f",
      black:               "#16273f",
      red:                 "#dc2626",
      green:               "#15803d",
      yellow:              "#b45309",
      blue:                "#1d4ed8",
      magenta:             "#7c3aed",
      cyan:                "#0e7490",
      white:               "#e6edf7",
      brightBlack:         "#5b6b82",
      brightRed:           "#ef4444",
      brightGreen:         "#16a34a",
      brightYellow:        "#d97706",
      brightBlue:          "#3b82f6",
      brightMagenta:       "#8b5cf6",
      brightCyan:          "#0891b2",
      brightWhite:         "#ffffff",
    };
  }

  if (theme === "jade") {
    return {
      background:          "#f3faf5",
      foreground:          "#182a20",
      cursor:              "#059669",
      cursorAccent:        "#f3faf5",
      selectionBackground: "rgba(5, 150, 105, 0.16)",
      selectionForeground: "#182a20",
      black:               "#182a20",
      red:                 "#b91c1c",
      green:               "#047857",
      yellow:              "#a16207",
      blue:                "#1e40af",
      magenta:             "#86198f",
      cyan:                "#0f766e",
      white:               "#e2efe6",
      brightBlack:         "#587264",
      brightRed:           "#dc2626",
      brightGreen:         "#059669",
      brightYellow:        "#ca8a04",
      brightBlue:          "#2563eb",
      brightMagenta:       "#a21caf",
      brightCyan:          "#0d9488",
      brightWhite:         "#ffffff",
    };
  }

  if (theme === "sakura") {
    return {
      background:          "#fff7f9",
      foreground:          "#33202a",
      cursor:              "#e11d48",
      cursorAccent:        "#fff7f9",
      selectionBackground: "rgba(225, 29, 72, 0.15)",
      selectionForeground: "#33202a",
      black:               "#33202a",
      red:                 "#be123c",
      green:               "#15803d",
      yellow:              "#b45309",
      blue:                "#1d4ed8",
      magenta:             "#a21caf",
      cyan:                "#0e7490",
      white:               "#f7e6ec",
      brightBlack:         "#7d5f6d",
      brightRed:           "#e11d48",
      brightGreen:         "#16a34a",
      brightYellow:        "#d97706",
      brightBlue:          "#3b82f6",
      brightMagenta:       "#c026d3",
      brightCyan:          "#0891b2",
      brightWhite:         "#ffffff",
    };
  }

  if (theme === "xuan") {
    return {
      background:          "#f7f1e3",
      foreground:          "#2b241c",
      cursor:              "#b53a2b",
      cursorAccent:        "#f7f1e3",
      selectionBackground: "rgba(192, 61, 46, 0.16)",
      selectionForeground: "#2b241c",
      black:               "#2b241c",
      red:                 "#b03527",
      green:               "#3f6b4f",
      yellow:              "#9a6a1f",
      blue:                "#2f557f",
      magenta:             "#7d4a68",
      cyan:                "#35736b",
      white:               "#e9dfc9",
      brightBlack:         "#7a6f60",
      brightRed:           "#c03d2e",
      brightGreen:         "#528a68",
      brightYellow:        "#b9852f",
      brightBlue:          "#3f6f9f",
      brightMagenta:       "#96607f",
      brightCyan:          "#4a8f86",
      brightWhite:         "#fdf9ef",
    };
  }

  // light / default — mist porcelain
  return {
    background:          "#fbfcfe",
    foreground:          "#1e293b",
    cursor:              "#4f46e5",
    cursorAccent:        "#fbfcfe",
    selectionBackground: "rgba(79, 70, 229, 0.16)",
    selectionForeground: "#1e293b",
    black:               "#1e293b",
    red:                 "#e11d48",
    green:               "#16a34a",
    yellow:              "#ca8a04",
    blue:                "#2563eb",
    magenta:             "#7c3aed",
    cyan:                "#0891b2",
    white:               "#eef2f7",
    brightBlack:         "#64748b",
    brightRed:           "#f43f5e",
    brightGreen:         "#22c55e",
    brightYellow:        "#eab308",
    brightBlue:          "#3b82f6",
    brightMagenta:       "#8b5cf6",
    brightCyan:          "#06b6d4",
    brightWhite:         "#ffffff",
  };
}

function resolvePanelBackground(element: HTMLElement | null, fallback: string) {
  if (!element) return fallback;
  const styles = getComputedStyle(element);
  const value = styles.getPropertyValue("--studio-panel-background").trim()
    || styles.getPropertyValue("--card").trim();
  return value || fallback;
}

function writeClipboardFallback(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function decodeBase64Utf8(value: string) {
  const binary = window.atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function osc52ClipboardText(data: string) {
  const separator = data.indexOf(";");
  if (separator < 0) return "";
  const selectionTarget = data.slice(0, separator);
  if (!["", "c", "p", "s", "0", "1", "2", "3", "4", "5", "6", "7"].includes(selectionTarget)) {
    return "";
  }
  const payload = data.slice(separator + 1);
  if (!payload || payload === "?") return "";
  try {
    return decodeBase64Utf8(payload);
  } catch {
    return "";
  }
}

function writeClipboardText(text: string) {
  const electronAPI = pocketElectronAPI();
  if (electronAPI?.writeClipboardText) {
    return Promise.resolve(electronAPI.writeClipboardText(text)).then(() => undefined);
  }
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  writeClipboardFallback(text);
  return Promise.resolve();
}

function terminalHomeEndSequence(key: string) {
  if (key === "Home") return "\x1bOH";
  if (key === "End") return "\x1bOF";
  return "";
}

function isAntigravityCommand(command: string) {
  const normalized = command.toLowerCase();
  return normalized.includes("agy") || normalized.includes("antigravity");
}

function normalizePasteLineFeeds(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

function isEditableOutsideTerminal(target: EventTarget | null, terminalContainer: HTMLElement) {
  if (!(target instanceof HTMLElement)) return false;
  if (terminalContainer.contains(target)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}

interface XtermInstanceProps {
  projectId: string;
  terminalId: string;
  command: string;
  isActive: boolean;
  layoutVersion?: number;
  theme?: StudioTheme;
  // Page-zoom factor (1 = 100%). The terminal must NOT be zoomed by an ancestor
  // CSS transform: xterm maps mouse coordinates via getBoundingClientRect (which
  // a transform scales) but measures cell size on a canvas (which a transform
  // does NOT scale), so any CSS scale on the terminal desyncs drag-selection.
  // Instead we cancel the ancestor scale (net identity transform) and zoom via
  // font size, which keeps xterm's coordinate math self-consistent.
  scale?: number;
  directMode?: boolean;
  directEndpoint?: { terminal_ws_url: string; token?: string };
  // Daemon-managed custom agent definition id: when set, the daemon replaces
  // the launch command with the agent's base CLI + skill/prompt injection.
  customAgentId?: string;
  onTitleChange?: (title: string, command?: string, fullTitle?: string) => void;
  onActiveFocus?: () => void;
  filePath?: string;
  // Terminal backend: true (default) keeps the session via tmux; false runs a
  // plain PTY so inline image protocols (OSC 1337 / Kitty) reach the renderer.
  useTmux?: boolean;
}

const BASE_FONT_SIZE = 12;

type TerminalConnectionOwner = {
  id: number;
  close: () => void;
};

let nextTerminalConnectionOwnerId = 1;
const terminalConnectionOwners = new Map<string, TerminalConnectionOwner>();

async function refreshDirectEndpoint(projectId: string): Promise<{ terminal_ws_url: string; token?: string } | undefined> {
  try {
    // Bound the wait: a hung server must not stall the reconnect chain forever.
    const projectData = await Promise.race([
      getJSON<unknown>("/api/project/list"),
      new Promise<undefined>((resolve) => setTimeout(resolve, 8000)),
    ]);
    if (projectData === undefined) return undefined; // refresh request timed out
    const projects = Array.isArray(projectData)
      ? projectData
      : projectData && typeof projectData === "object" && Array.isArray((projectData as { projects?: unknown }).projects)
        ? (projectData as { projects: unknown[] }).projects
        : [];
    const project = projects.find((item): item is { id: string; direct_endpoint?: { terminal_ws_url?: string; token?: string } } => {
      return Boolean(item && typeof item === "object" && (item as { id?: unknown }).id === projectId);
    });
    const endpoint = projectDirectMode(projectId) ? project?.direct_endpoint : undefined;
    return endpoint?.terminal_ws_url ? { terminal_ws_url: endpoint.terminal_ws_url, token: endpoint.token } : undefined;
  } catch (err) {
    console.warn("failed to refresh direct terminal endpoint:", err);
    return undefined;
  }
}

export function XtermInstance({
  projectId,
  terminalId,
  command,
  isActive,
  layoutVersion = 0,
  theme = "light",
  scale = 1,
  directMode = false,
  directEndpoint,
  onTitleChange,
  onActiveFocus,
  filePath,
  useTmux = true,
  customAgentId,
}: XtermInstanceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef    = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef       = useRef<WebSocket | null>(null);
  const connectionGenerationRef = useRef(0);
  const normalExitRef = useRef(false);
  const kickedRef = useRef(false);
  const onTitleChangeRef = useRef(onTitleChange);
  const reconnectTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const receivedFirstFrameRef = useRef(false);
  const resizeDebounceTimerRef = useRef<number | null>(null);
  const terminalReadyRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const currentCommandRef = useRef(command || "");
  const onActiveFocusRef = useRef(onActiveFocus);
  const scaleRef = useRef(scale);
  const directEndpointRef = useRef(directEndpoint);
  const incomingBuf = useRef<Array<string | Uint8Array>>([]);
  // Buffer keystrokes that arrive before WS is OPEN
  const inputBuf    = useRef<string[]>([]);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  useEffect(() => {
    onActiveFocusRef.current = onActiveFocus;
  }, [onActiveFocus]);

  useEffect(() => {
    directEndpointRef.current = directEndpoint;
  }, [directEndpoint]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Zoom the terminal by font size (not by an ancestor CSS scale, which would
  // break xterm's mouse/selection coordinate math — see XtermInstanceProps.scale).
  useEffect(() => {
    scaleRef.current = scale;
    const term = xtermRef.current;
    if (!term) return;
    const nextFontSize = BASE_FONT_SIZE * scale;
    if (term.options.fontSize !== nextFontSize) {
      term.options.fontSize = nextFontSize;
      fitAndResize(true);
    }
  }, [scale]);

  function sendResizeNow(force = false) {
    const ws = wsRef.current;
    const t = xtermRef.current;
    if (!t) return false;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    const nextSize = { cols: t.cols, rows: t.rows };
    if (nextSize.cols <= 0 || nextSize.rows <= 0) return false;
    const lastSize = lastSentSizeRef.current;
    if (!force && lastSize?.cols === nextSize.cols && lastSize.rows === nextSize.rows) return true;
    lastSentSizeRef.current = nextSize;
    ws.send(JSON.stringify({ type: "resize", cols: nextSize.cols, rows: nextSize.rows }));
    return true;
  }

  function fitAndResize(force = false) {
    const fitted = fitAndNotify({ notify: false });
    if (!fitted) return false;
    return sendResizeNow(force);
  }

  function scheduleResizeAfterFit({ force = false, delay = 80 }: { force?: boolean; delay?: number } = {}) {
    if (resizeDebounceTimerRef.current !== null) {
      window.clearTimeout(resizeDebounceTimerRef.current);
    }
    resizeDebounceTimerRef.current = window.setTimeout(() => {
      resizeDebounceTimerRef.current = null;
      fitAndResize(force);
    }, delay);
  }

  function afterFirstTerminalFrame() {
    if (receivedFirstFrameRef.current) return;
    receivedFirstFrameRef.current = true;
    window.requestAnimationFrame(() => scheduleResizeAfterFit({ force: true, delay: 0 }));
  }

  function writeTerminalData(data: string | Uint8Array) {
    const term = xtermRef.current;
    if (!term) return;
    if (!terminalReadyRef.current) {
      incomingBuf.current.push(data);
      return;
    }
    term.write(data);
    afterFirstTerminalFrame();
  }

  function flushTerminalData() {
    const term = xtermRef.current;
    if (!term || !terminalReadyRef.current || incomingBuf.current.length === 0) return;
    const pending = incomingBuf.current;
    incomingBuf.current = [];
    for (const data of pending) {
      term.write(data);
    }
    afterFirstTerminalFrame();
  }

  function fitAndNotify({ notify = true }: { notify?: boolean } = {}) {
    const container = containerRef.current;
    const fit = fitAddonRef.current;
    const t   = xtermRef.current;
    if (!container || !fit || !t) return false;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    try {
      fit.fit();
      t.refresh(0, Math.max(0, t.rows - 1));
      if (notify) fitAndResize();
      return true;
    } catch {
      return false;
    }
  }

  function measureTerminalSize() {
    const fit = fitAddonRef.current;
    const t = xtermRef.current;
    if (!fit || !t) return { cols: 0, rows: 0 };
    try {
      fit.fit();
    } catch {
      return { cols: 0, rows: 0 };
    }
    return { cols: t.cols, rows: t.rows };
  }

  function scheduleFitBurst({ notify = false }: { notify?: boolean } = {}) {
    const frames: number[] = [];
    const timers: number[] = [];
    frames.push(window.requestAnimationFrame(() => {
      fitAndNotify({ notify });
      frames.push(window.requestAnimationFrame(() => fitAndNotify({ notify })));
    }));
    [40, 120, 300, 650, 1200].forEach((delay) => {
      timers.push(window.setTimeout(() => fitAndNotify({ notify }), delay));
    });
    return () => {
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }

  function sendInputData(data: string) {
    const current = wsRef.current;
    if (current?.readyState === WebSocket.OPEN) {
      current.send(data);
    } else {
      inputBuf.current.push(data);
    }
  }

  function sendHomeEndKey(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const sequence = terminalHomeEndSequence(event.key);
    if (!sequence) return false;
    sendInputData(sequence);
    return true;
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const imeCompositionGuard = createTerminalImeCompositionGuard();

    let term: XTerminal | null = null;
    let fitAddon: FitAddon | null = null;
    let connectFrame: number | null = null;
    let cancelInitialFit: (() => void) | null = null;
    let cancelFontFit: (() => void) | null = null;
    let cancelCopyPasteShortcut: (() => void) | null = null;
    let cancelPasteHandler: (() => void) | null = null;
    let cancelFocusHandler: (() => void) | null = null;
    let cancelImeCompositionTracking: (() => void) | null = null;
    let cancelOnlineHandler: (() => void) | null = null;
    let osc52Disposable: { dispose: () => void } | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    const handleTerminalKeyDownCapture = (event: KeyboardEvent) => {
      if (!sendHomeEndKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const postOpenResizeTimers: number[] = [];
    const ownedSockets = new Set<WebSocket>();
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    const connectionKey = `${projectId}::${terminalId}`;
    const ownerId = nextTerminalConnectionOwnerId++;

    let initialized = false;
    let disposed = false;
    disposedRef.current = false;
    const isCurrentEffect = () => !disposed && !disposedRef.current && connectionGenerationRef.current === generation;
    const closeOwnedSockets = () => {
      disposed = true;
      disposedRef.current = true;
      for (const socket of ownedSockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }
      ownedSockets.clear();
    };
    terminalConnectionOwners.get(connectionKey)?.close();
    disposed = false;
    disposedRef.current = false;
    terminalConnectionOwners.set(connectionKey, { id: ownerId, close: closeOwnedSockets });

    const initTerminalAndWS = async () => {
      if (initialized || !isCurrentEffect()) return;
      initialized = true;
      receivedFirstFrameRef.current = false;
      terminalReadyRef.current = false;
      incomingBuf.current = [];

      // Preload Nerd Font symbol glyphs (powerline / devicons) before xterm
      // measures font metrics, otherwise the atlas bakes tofu boxes for the
      // PUA ranges and never re-renders after the webfont arrives.
      try {
        if (document.fonts?.load) {
          await Promise.race([
            document.fonts.load(`12px 'Symbols Nerd Font Mono'`, '\ue0b0\ue725\uf489'),
            new Promise((resolve) => setTimeout(resolve, 1500)),
          ]);
        }
      } catch {
        // Font preload is best-effort; terminal still works without glyphs.
      }

      /* ── 1. Create xterm.js instance ── */
      const terminalTheme = getXtermTheme(theme);
      term = new XTerminal({
        cursorBlink:   true,
        cursorStyle:   "bar",
        fontSize:      BASE_FONT_SIZE * scaleRef.current,
        fontFamily:    "JetBrains Mono, Menlo, Monaco, Consolas, 'Symbols Nerd Font Mono', monospace",
        lineHeight:    1.2,
        scrollback:    5000,
        scrollSensitivity: 1,
        scrollOnUserInput: true,
        allowProposedApi: true,
        theme: {
          ...terminalTheme,
          background: resolvePanelBackground(container, terminalTheme.background),
        }
      });
      term.write('\x1b[?1007l');
      container.addEventListener("keydown", handleTerminalKeyDownCapture, true);

      term.attachCustomKeyEventHandler((event) => {
        // Let compositionend deliver the final Unicode text. Some CJK IMEs expose
        // punctuation as a composing ASCII keydown (for example "." before "。").
        if (imeCompositionGuard.shouldBypassXtermKeyEvent(event)) return false;
        if (event.type === "keydown" && handleRemoteControlV(event, (data) => term?.input(data))) {
          // Ctrl+V is a terminal control key. Prevent the host from also turning it
          // into a clipboard paste; Ctrl+Shift+V owns system clipboard paste.
          return false;
        }
        if (
          event.type === "keydown" &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          (event.key === "Home" || event.key === "End")
        ) {
          event.preventDefault();
          return false;
        }
        return true;
      });

      xtermRef.current = term;
      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);

      // Inline images (iTerm2 OSC 1337 / Sixel / Kitty MVP) from agents like pi.
      // Size reports stay enabled so emitters can query cell pixels for aspect ratio.
      term.loadAddon(new ImageAddon({
        enableSizeReports: true,
        // Generous limits: agents downscale before emitting, but a big paste
        // or screenshot can still be a multi-MB sequence.
        iipSizeLimit: 32 * 1024 * 1024,
        sixelSizeLimit: 32 * 1024 * 1024,
      }));

      osc52Disposable = term.parser.registerOscHandler(52, (data) => {
        const text = osc52ClipboardText(data);
        if (!text) return true;
        return writeClipboardText(text).then(
          () => true,
          () => true,
        );
      });
      const handleTerminalFocus = () => {
        if (!isActiveRef.current) return;
        onActiveFocusRef.current?.();
      };
      container.addEventListener("focusin", handleTerminalFocus);
      cancelFocusHandler = () => {
        container.removeEventListener("focusin", handleTerminalFocus);
      };
      /* Mount terminal into the container div */
      term.open(container);
      const textarea = term.textarea;
      if (textarea) {
        textarea.addEventListener("compositionstart", imeCompositionGuard.start);
        textarea.addEventListener("compositionend", imeCompositionGuard.end);
        textarea.addEventListener("blur", imeCompositionGuard.end);
        cancelImeCompositionTracking = () => {
          textarea.removeEventListener("compositionstart", imeCompositionGuard.start);
          textarea.removeEventListener("compositionend", imeCompositionGuard.end);
          textarea.removeEventListener("blur", imeCompositionGuard.end);
        };
      }

      const getPasteTextForPath = (path: string): string => {
        return terminalImagePasteText(currentCommandRef.current || "", path);
      };

      const pasteIntoTerminal = (text: string) => {
        if (!term) return;
        if (isAntigravityCommand(currentCommandRef.current || "")) {
          const payload = normalizePasteLineFeeds(text);
          const hasLineBreak = payload.includes("\n");
          term.input(term.modes.bracketedPasteMode || hasLineBreak ? `\x1b[200~${payload}\x1b[201~` : payload);
          if (term.textarea) term.textarea.value = "";
          return;
        }
        term.paste(text);
      };

      const pasteFromClipboardFallback = () => {
        if (navigator.clipboard?.read) {
          void navigator.clipboard.read().then((items) => {
            for (const item of items) {
              const imageType = item.types.find((t) => t.startsWith("image/"));
              if (imageType) {
                const cmd = (currentCommandRef.current || "").toLowerCase();
                if (cmd.includes("agy") || cmd.includes("antigravity")) {
                  continue;
                }
                void item.getType(imageType).then((blob) => {
                  const ext = imageType === "image/jpeg" ? "jpg" : "png";
                  const filename = `pasted_image_${Date.now()}.${ext}`;
                  const file = new File([blob], filename, { type: imageType });
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    const dataUrl = e.target?.result as string;
                    if (dataUrl) {
                      postJSON<{ path?: string; error?: string }>("/api/project/file/write", {
                        project_id: projectId,
                        path: filename,
                        content: dataUrl,
                        temporary: true,
                      })
                        .then((result) => {
                          if (result.error) {
                            alert(`Failed to save image to temporary directory: ${result.error}`);
                          } else if (!result.path) {
                            alert("Failed to save image to temporary directory: missing path");
                          } else {
                            term?.paste(getPasteTextForPath(result.path));
                          }
                        })
                        .catch((err) => {
                          alert(`Failed to upload image: ${err instanceof Error ? err.message : String(err)}`);
                        });
                    }
                  };
                  reader.readAsDataURL(file);
                });
                return;
              }
            }
            if (navigator.clipboard.readText) {
              void navigator.clipboard.readText().then((text) => {
                if (text) pasteIntoTerminal(text);
              }).catch(() => {});
            }
          }).catch(() => {
            if (navigator.clipboard.readText) {
              void navigator.clipboard.readText().then((text) => {
                if (text) pasteIntoTerminal(text);
              }).catch(() => {});
            }
          });
        } else if (navigator.clipboard?.readText) {
          void navigator.clipboard.readText().then((text) => {
            if (text) pasteIntoTerminal(text);
          }).catch(() => {});
        }
      };

      const pasteFromSystemClipboard = () => {
        const terminalTextarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
        terminalTextarea?.focus();
        const electronAPI = pocketElectronAPI();
        if (electronAPI?.pasteClipboard) {
          void Promise.resolve(electronAPI.pasteClipboard())
            .then((result) => {
              if (result && typeof result === "object" && "ok" in result && result.ok === false) {
                pasteFromClipboardFallback();
              }
            })
            .catch(() => {
              pasteFromClipboardFallback();
            });
          return;
        }
        pasteFromClipboardFallback();
      };

      const handleCopyPasteShortcut = (event: KeyboardEvent) => {
        if (!isActiveRef.current) return;
        if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
        if (isEditableOutsideTerminal(event.target, container)) return;
        const key = event.key.toLowerCase();
        if (key === "c") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          const selection = term?.getSelection();
          if (!selection) return;
          void writeClipboardText(selection);
        } else if (key === "v") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          pasteFromSystemClipboard();
        }
      };
      const handlePaste = (event: ClipboardEvent) => {
        if (!isActiveRef.current) return;
        const text = event.clipboardData?.getData("text/plain");
        if (text) {
          event.preventDefault();
          event.stopPropagation();
          pasteIntoTerminal(text);
          return;
        }
        const items = event.clipboardData?.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith("image/")) {
              const cmd = (currentCommandRef.current || "").toLowerCase();
              if (cmd.includes("agy") || cmd.includes("antigravity")) {
                continue;
              }
              const file = item.getAsFile();
              if (file) {
                event.preventDefault();
                event.stopPropagation();
                const reader = new FileReader();
                reader.onload = (e) => {
                  const dataUrl = e.target?.result as string;
                  if (dataUrl) {
                    const ext = file.type === "image/jpeg" ? "jpg" : "png";
                    const filename = `pasted_image_${Date.now()}.${ext}`;
                    postJSON<{ path?: string; error?: string }>("/api/project/file/write", {
                      project_id: projectId,
                      path: filename,
                      content: dataUrl,
                      temporary: true,
                    })
                      .then((result) => {
                        if (result.error) {
                          alert(`Failed to save image to temporary directory: ${result.error}`);
                        } else if (!result.path) {
                          alert("Failed to save image to temporary directory: missing path");
                        } else {
                          term?.paste(getPasteTextForPath(result.path));
                        }
                      })
                      .catch((err) => {
                        alert(`Failed to upload image: ${err instanceof Error ? err.message : String(err)}`);
                      });
                  }
                };
                reader.readAsDataURL(file);
                return;
              }
            }
          }
        }
      };
      window.addEventListener("keydown", handleCopyPasteShortcut, { capture: true });
      container.addEventListener("keydown", handleCopyPasteShortcut, { capture: true });
      container.addEventListener("paste", handlePaste, { capture: true });
      cancelCopyPasteShortcut = () => {
        window.removeEventListener("keydown", handleCopyPasteShortcut, { capture: true });
        container.removeEventListener("keydown", handleCopyPasteShortcut, { capture: true });
      };
      cancelPasteHandler = () => {
        container.removeEventListener("paste", handlePaste, { capture: true });
      };

      // Force instant initial fit calculation before websocket runs
      try {
        fitAddon.fit();
      } catch {
        // The resize observer will retry once fonts/layout are ready.
      }
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (!isCurrentEffect()) return;
          if (fitAndNotify({ notify: false })) {
            terminalReadyRef.current = true;
            flushTerminalData();
          }
        });
      });

      cancelInitialFit = scheduleFitBurst();
      cancelFontFit = scheduleFitBurst();
      void document.fonts?.ready.then(() => {
        if (isCurrentEffect() && fitAddon) {
          try {
            fitAddon.fit();
          } catch {
            // Later resize events will retry if font metrics are not ready.
          }
        }
        // If the Nerd Font webfont landed after xterm baked its glyph atlas
        // (measured against fallback metrics), rebuild it so powerline glyphs
        // render correctly without remounting the terminal.
        if (isCurrentEffect() && term) {
          try {
            (term as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
          } catch {
            // Renderer without texture atlas support; ignore.
          }
        }
      });

      /* ── 2. WebSocket connection ── */
      const initialSize = measureTerminalSize();
      const wsParams = new URLSearchParams({
        project_id: projectId,
        terminal_id: terminalId,
        command,
      });
      if (filePath) {
        wsParams.set("path", filePath);
      }
      if (customAgentId) {
        wsParams.set("custom_agent_id", customAgentId);
      }
      if (useTmux === false) {
        wsParams.set("use_tmux", "0");
      }
      if (initialSize.cols > 0 && initialSize.rows > 0) {
        wsParams.set("cols", String(initialSize.cols));
        wsParams.set("rows", String(initialSize.rows));
      }
      // Rebuild the WS URL on every connect attempt: relay URLs embed the
      // current access token, and direct-mode tokens expire ~15 minutes after
      // the project list is served. Reusing a URL captured at mount time meant
      // a long-lived tab could never reconnect after any transient drop.
      let lastResolvedWsUrl = "";
      const resolveWsUrl = async (refreshEndpoint: boolean) => {
        if (!directMode) {
          lastResolvedWsUrl = websocketURL("/ws/terminal", wsParams);
          return lastResolvedWsUrl;
        }
        let endpoint = directEndpointRef.current;
        if (refreshEndpoint || !endpoint?.terminal_ws_url) {
          const refreshed = await refreshDirectEndpoint(projectId);
          if (refreshed) {
            endpoint = refreshed;
            directEndpointRef.current = refreshed;
          }
        }
        lastResolvedWsUrl = endpoint?.terminal_ws_url
          ? directWebsocketURL(endpoint.terminal_ws_url, wsParams, endpoint.token)
          : "";
        return lastResolvedWsUrl;
      };

      let consecutiveFailures = 0;
      let connectedOnce = false;
      let manualRetryArmed = false;
      // Circuit breaker: at this many consecutive failed attempts the failure
      // is very likely permanent (expired auth, unreachable endpoint), so stop
      // auto-reconnecting and wait for explicit user input instead of retrying
      // forever.
      const MAX_CONSECUTIVE_FAILURES = 8;
      const MAX_RECONNECT_DELAY_MS = 30000;

      const scheduleReconnect = (delay: number) => {
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (isCurrentEffect()) void connect();
        }, delay);
      };

      const backoffDelay = () => {
        const backoff = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 6));
        return Math.round(backoff * (0.7 + Math.random() * 0.6));
      };

      const armManualRetry = (reason: string) => {
        const t = term;
        if (!t) return;
        // Keystrokes typed into a dead pane have no local echo and must not be
        // blindly replayed into the shell whenever a later reconnect succeeds.
        inputBuf.current = [];
        if (manualRetryArmed) return;
        manualRetryArmed = true;
        t.write(`\r\n\x1b[31m[${reason}]\x1b[0m`);
        t.write("\r\n\x1b[33m[自动重连已停止，按任意键重试。]\x1b[0m\r\n");
        const retryDisposable = t.onData(() => {
          retryDisposable.dispose();
          // Drop the retry keystroke itself so it is not delivered to the
          // shell once the new connection opens.
          window.setTimeout(() => {
            inputBuf.current = [];
          }, 0);
          if (!isCurrentEffect()) return;
          consecutiveFailures = 0;
          manualRetryArmed = false;
          scheduleReconnect(0);
        });
      };

      // Every failed attempt counts; only the trip reason differs. Transient
      // conditions (daemon still starting, endpoint not yet reported) keep
      // backing off and self-heal; persistent ones trip the breaker.
      const handleFailedAttempt = (tripReason: string) => {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          armManualRetry(tripReason);
          return;
        }
        scheduleReconnect(backoffDelay());
      };

      const connect = async () => {
        if (!isCurrentEffect()) return;
        let wsUrl = "";
        try {
          // Refresh the direct endpoint (and its short-lived token) on retries.
          wsUrl = await resolveWsUrl(consecutiveFailures > 0);
        } catch {
          wsUrl = "";
        }
        if (!isCurrentEffect()) return;
        if (!wsUrl) {
          handleFailedAttempt(directMode
            ? "直连模式已开启，但 daemon 尚未上报可用直连端点；请检查 daemon 内网地址或关闭直连。"
            : "WebSocket connection failed: missing terminal endpoint");
          return;
        }
        let socket: WebSocket;
        try {
          socket = new WebSocket(wsUrl);
        } catch {
          handleFailedAttempt(`WebSocket connection failed: invalid endpoint ${lastResolvedWsUrl}`);
          return;
        }
        const socketGeneration = generation;
        if (wsRef.current && wsRef.current !== socket && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
          wsRef.current.close();
        }
        wsRef.current = socket;
        ownedSockets.add(socket);
        socket.addEventListener("close", () => {
          ownedSockets.delete(socket);
        }, { once: true });
        socket.binaryType = "arraybuffer";

        let pingInterval: number | null = null;

        socket.onopen = () => {
          if (!isCurrentEffect() || socketGeneration !== connectionGenerationRef.current || wsRef.current !== socket) {
            socket.close();
            return;
          }
          connectedOnce = true;
          consecutiveFailures = 0;
          manualRetryArmed = false;
          for (const chunk of inputBuf.current) {
            socket.send(chunk);
          }
          inputBuf.current = [];
          lastSentSizeRef.current = null;
          fitAndResize(true);
          scheduleFitBurst({ notify: true });
          // Non-forced follow-ups: they only transmit when the fitted size
          // actually changed, avoiding a resize -> tmux redraw storm on every
          // reconnect.
          [500, 2000].forEach((delay) => {
            postOpenResizeTimers.push(window.setTimeout(() => {
              fitAndResize();
            }, delay));
          });

          if (pingInterval !== null) window.clearInterval(pingInterval);
          pingInterval = window.setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "ping" }));
            }
          }, 10000);
        };

        socket.onmessage = (event) => {
          if (!isCurrentEffect() || socketGeneration !== connectionGenerationRef.current || wsRef.current !== socket) return;
          if (event.data instanceof ArrayBuffer) {
            writeTerminalData(new Uint8Array(event.data));
          } else if (typeof event.data === "string") {
            try {
              const message = JSON.parse(event.data) as { type?: string; title?: string; full_title?: string; command?: string };
              if (message.type === "title" && typeof message.title === "string") {
                currentCommandRef.current = message.command || "";
                onTitleChangeRef.current?.(message.title, message.command, message.full_title);
                return;
              }
              if (message.type === "exit") {
                const isKick = (message as { reason?: string }).reason === "kick" || (message as { reason?: string }).reason === "replaced";
                if (isKick) {
                  term!.write("\r\n\x1b[31m[该终端已在其他窗口/浏览器打开，本窗口连接已被断开。]\x1b[0m\r\n");
                  kickedRef.current = true;
                }
                normalExitRef.current = true;
                return;
              }
            } catch {
              // Plain terminal text
            }
            writeTerminalData(event.data);
          }
        };

        socket.onerror = () => {
          // Let onclose decide whether to retry or report failure.
        };

        socket.onclose = () => {
          if (pingInterval !== null) {
            window.clearInterval(pingInterval);
            pingInterval = null;
          }
          if (!isCurrentEffect() || socketGeneration !== connectionGenerationRef.current || wsRef.current !== socket) return;
          if (normalExitRef.current || kickedRef.current) {
            return;
          }
          // Skip the notice when this failure is about to trip the breaker
          // (the breaker writes its own message instead).
          if (connectedOnce && consecutiveFailures + 1 < MAX_CONSECUTIVE_FAILURES) {
            term!.write(directMode
              ? "\r\n\x1b[33m[直连 daemon 连接断开，正在重连直连端点...]\x1b[0m\r\n"
              : "\r\n\x1b[33m[Connection closed, reconnecting...]\x1b[0m\r\n");
          }
          // Each attempt re-resolves the URL so expired direct tokens /
          // rotated credentials self-heal.
          handleFailedAttempt(connectedOnce
            ? (directMode
              ? "多次重连失败：直连 daemon 不可达，或直连授权已过期。"
              : "多次重连失败：服务器不可达，或登录态已过期。")
            : `WebSocket connection failed: ${lastResolvedWsUrl}`);
        };

      };

      normalExitRef.current = false;
      kickedRef.current = false;
      connectFrame = window.requestAnimationFrame(() => {
        void connect();
      });

      /* ── 3. User input → WS ── */
      dataDisposable = term.onData((data) => {
        // While the circuit breaker waits for a manual retry, drop input
        // instead of buffering it for a blind replay on the next connection.
        if (!isCurrentEffect() || manualRetryArmed) return;
        sendInputData(data);
      });

      // Sleep/wake and network roaming often leave the socket half-open (no
      // onclose fires and OS TCP keepalive takes ages to notice). When the
      // browser reports connectivity (back), cycle the connection immediately
      // instead of waiting for the OS.
      const handleOnline = () => {
        if (!isCurrentEffect()) return;
        const socket = wsRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          // Its onclose schedules a reconnect with a freshly resolved URL.
          socket.close();
        } else if (!manualRetryArmed && reconnectTimerRef.current === null) {
          scheduleReconnect(0);
        }
      };
      window.addEventListener("online", handleOnline);
      cancelOnlineHandler = () => {
        window.removeEventListener("online", handleOnline);
      };
    };

    // Check size immediately to see if we can initialize right away
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      void initTerminalAndWS();
    }

    /* ── 4. Resize observer — refit when container dimensions change ── */
    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        if (!initialized) {
          void initTerminalAndWS();
        } else {
          scheduleFitBurst();
          scheduleResizeAfterFit();
        }
      }
    });

    // Observe the container itself AND its nearest scrollable ancestor
    ro.observe(container);
    if (container.parentElement) ro.observe(container.parentElement);

    // Listen to window resize events to force PTY resize update
    const handleWinResize = () => {
      lastSentSizeRef.current = null;
      scheduleFitBurst();
      scheduleResizeAfterFit({ delay: 120 });
    };
    window.addEventListener("resize", handleWinResize);

    /* ── 5. Cleanup ── */
    return () => {
      connectionGenerationRef.current += 1;
      const owner = terminalConnectionOwners.get(connectionKey);
      if (owner?.id === ownerId) {
        terminalConnectionOwners.delete(connectionKey);
      }
      closeOwnedSockets();
      if (cancelCopyPasteShortcut) cancelCopyPasteShortcut();
      if (cancelPasteHandler) cancelPasteHandler();
      if (cancelFocusHandler) cancelFocusHandler();
      if (cancelImeCompositionTracking) cancelImeCompositionTracking();
      if (cancelOnlineHandler) cancelOnlineHandler();
      if (cancelInitialFit) cancelInitialFit();
      if (cancelFontFit) cancelFontFit();
      window.removeEventListener("resize", handleWinResize);
      container.removeEventListener("keydown", handleTerminalKeyDownCapture, true);
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      postOpenResizeTimers.forEach((timer) => window.clearTimeout(timer));
      if (resizeDebounceTimerRef.current !== null) {
        window.clearTimeout(resizeDebounceTimerRef.current);
        resizeDebounceTimerRef.current = null;
      }
      receivedFirstFrameRef.current = false;
      terminalReadyRef.current = false;
      incomingBuf.current = [];
      ro.disconnect();
      if (osc52Disposable) osc52Disposable.dispose();
      if (dataDisposable) dataDisposable.dispose();
      if (connectFrame !== null) window.cancelAnimationFrame(connectFrame);
      if (connectionGenerationRef.current === generation + 1) {
        wsRef.current = null;
      }
      if (term) term.dispose();
      inputBuf.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, terminalId, command, directMode, directEndpoint?.terminal_ws_url, customAgentId]);

  /* Dynamic xterm theme switching */
  useEffect(() => {
    const term = xtermRef.current;
    const container = containerRef.current;
    if (!term) return;
    const nextTheme = getXtermTheme(theme);
    term.options.theme = {
      ...nextTheme,
      background: resolvePanelBackground(container, nextTheme.background),
    };
  }, [theme]);


  /* Re-fit and force PTY size sync when this pane becomes the focused/active one */
  useEffect(() => {
    isActiveRef.current = isActive;
    if (!isActive) return;
    const focusFrame = window.requestAnimationFrame(() => {
      xtermRef.current?.focus();
      onActiveFocusRef.current?.();
    });
    const timer1 = window.setTimeout(() => {
      xtermRef.current?.focus();
      onActiveFocusRef.current?.();
      scheduleFitBurst();
      scheduleResizeAfterFit();
    }, 150);
    const timer2 = window.setTimeout(() => {
      scheduleFitBurst();
      scheduleResizeAfterFit();
    }, 400);
    const cleanup = scheduleFitBurst();
    return () => {
      cleanup();
      window.cancelAnimationFrame(focusFrame);
      window.clearTimeout(timer1);
      window.clearTimeout(timer2);
    };
  }, [isActive]);

  useEffect(() => {
    const timer1 = window.setTimeout(() => {
      scheduleFitBurst();
      scheduleResizeAfterFit();
    }, 150);
    const timer2 = window.setTimeout(() => {
      scheduleFitBurst();
      scheduleResizeAfterFit();
    }, 400);
    const cleanup = scheduleFitBurst();
    return () => {
      cleanup();
      window.clearTimeout(timer1);
      window.clearTimeout(timer2);
    };
  }, [layoutVersion]);

  /*
   * The container must fill its parent entirely.
   * We use `position: absolute; inset: 0` so xterm gets 100% height.
   * xterm internally creates a canvas that fills the container.
   */
  return (
    <div
      ref={containerRef}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      className="absolute inset-0 box-border overflow-hidden px-0.5 py-0.5"
      style={
        scale !== 1
          ? {
              // Cancel the ancestor page-zoom transform so the terminal has a
              // net-identity transform (correct mouse mapping); the visual zoom
              // comes from the scaled font size instead. The inflated size keeps
              // the terminal filling its panel after the counter-scale.
              width: `${scale * 100}%`,
              height: `${scale * 100}%`,
              transform: `scale(${1 / scale})`,
              transformOrigin: "top left",
            }
          : undefined
      }
    />
  );
}
