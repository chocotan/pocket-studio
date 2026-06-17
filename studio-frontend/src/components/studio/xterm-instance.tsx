import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { StudioTheme } from "./terminal-types";
import { websocketURL } from "@/lib/api";
import { pocketElectronAPI } from "@/lib/electron-api";

export function getXtermTheme(theme: StudioTheme) {
  if (theme === "dark") {
    return {
      background:          "#1b222c",
      foreground:          "#f1f5f9",
      cursor:              "#818cf8",
      cursorAccent:        "#0f172a",
      selectionBackground: "rgba(99, 102, 241, 0.35)",
      selectionForeground: "#f1f5f9",
      black:               "#1f2937",
      red:                 "#ef4444",
      green:               "#10b981",
      yellow:              "#f59e0b",
      blue:                "#3b82f6",
      magenta:             "#d946ef",
      cyan:                "#06b6d4",
      white:               "#f3f4f6",
      brightBlack:         "#9ca3af",
      brightRed:           "#f87171",
      brightGreen:         "#34d399",
      brightYellow:        "#fbbf24",
      brightBlue:          "#60a5fa",
      brightMagenta:       "#c084fc",
      brightCyan:          "#22d3ee",
      brightWhite:         "#ffffff",
    };
  } else if (theme === "synthwave") {
    return {
      background:          "#231032",
      foreground:          "#f9e5ff",
      cursor:              "#ff7edb",
      cursorAccent:        "#1c0d2e",
      selectionBackground: "rgba(217, 70, 239, 0.3)",
      selectionForeground: "#f9e5ff",
      black:               "#25123e",
      red:                 "#fe4450",
      green:               "#3fe59a",
      yellow:              "#fede5d",
      blue:                "#2de2e6",
      magenta:             "#ff7edb",
      cyan:                "#06b6d4",
      white:               "#f3f4f6",
      brightBlack:         "#fede5d",
      brightRed:           "#fe4450",
      brightGreen:         "#3fe59a",
      brightYellow:        "#fede5d",
      brightBlue:          "#2de2e6",
      brightMagenta:       "#ff7edb",
      brightCyan:          "#2de2e6",
      brightWhite:         "#ffffff",
    };
  } else if (theme === "onedark") {
    return {
      background:          "#262b35",
      foreground:          "#abb2bf",
      cursor:              "#528bff",
      cursorAccent:        "#1e222a",
      selectionBackground: "rgba(82, 139, 255, 0.3)",
      selectionForeground: "#abb2bf",
      black:               "#1e222a",
      red:                 "#e06c75",
      green:               "#98c379",
      yellow:              "#d19a66",
      blue:                "#61afef",
      magenta:             "#c678dd",
      cyan:                "#56b6c2",
      white:               "#abb2bf",
      brightBlack:         "#5c6370",
      brightRed:           "#e06c75",
      brightGreen:         "#98c379",
      brightYellow:        "#d19a66",
      brightBlue:          "#61afef",
      brightMagenta:       "#c678dd",
      brightCyan:          "#56b6c2",
      brightWhite:         "#ffffff",
    };
  } else if (theme === "claude") {
    return {
      background:          "#fbf4e8",
      foreground:          "#2b2118",
      cursor:              "#b66a2c",
      cursorAccent:        "#fbf4e8",
      selectionBackground: "rgba(182, 106, 44, 0.20)",
      selectionForeground: "#2b2118",
      black:               "#2b2118",
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
  } else {
    // Light
    return {
      background:          "#ffffff",
      foreground:          "#1e293b",
      cursor:              "#4f46e5",
      cursorAccent:        "#ffffff",
      selectionBackground: "rgba(99, 102, 241, 0.18)",
      selectionForeground: "#1e293b",
      black:               "#1e293b",
      red:                 "#e11d48",
      green:               "#16a34a",
      yellow:              "#ca8a04",
      blue:                "#2563eb",
      magenta:             "#9333ea",
      cyan:                "#0891b2",
      white:               "#f1f5f9",
      brightBlack:         "#64748b",
      brightRed:           "#f43f5e",
      brightGreen:         "#22c55e",
      brightYellow:        "#eab308",
      brightBlue:          "#3b82f6",
      brightMagenta:       "#a855f7",
      brightCyan:          "#06b6d4",
      brightWhite:         "#ffffff",
    };
  }
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


interface XtermInstanceProps {
  projectId: string;
  terminalId: string;
  command: string;
  isActive: boolean;
  layoutVersion?: number;
  theme?: StudioTheme;
  onTitleChange?: (title: string, command?: string, fullTitle?: string) => void;
  onActiveFocus?: () => void;
}


export function XtermInstance({
  projectId,
  terminalId,
  command,
  isActive,
  layoutVersion = 0,
  theme = "light",
  onTitleChange,
  onActiveFocus,
}: XtermInstanceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef    = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef       = useRef<WebSocket | null>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  const reconnectTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const receivedFirstFrameRef = useRef(false);
  const resizeDebounceTimerRef = useRef<number | null>(null);
  const terminalReadyRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const onActiveFocusRef = useRef(onActiveFocus);
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
    isActiveRef.current = isActive;
  }, [isActive]);

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let term: XTerminal | null = null;
    let fitAddon: FitAddon | null = null;
    let connectFrame: number | null = null;
    let cancelInitialFit: (() => void) | null = null;
    let cancelFontFit: (() => void) | null = null;
    let cancelCopyPasteShortcut: (() => void) | null = null;
    let cancelPasteHandler: (() => void) | null = null;
    let cancelFocusHandler: (() => void) | null = null;
    let osc52Disposable: { dispose: () => void } | null = null;
    const postOpenResizeTimers: number[] = [];

    let initialized = false;
    disposedRef.current = false;

    const initTerminalAndWS = () => {
      if (initialized || disposedRef.current) return;
      initialized = true;
      receivedFirstFrameRef.current = false;
      terminalReadyRef.current = false;
      incomingBuf.current = [];

      /* ── 1. Create xterm.js instance ── */
      const terminalTheme = getXtermTheme(theme);
      term = new XTerminal({
        cursorBlink:   true,
        cursorStyle:   "bar",
        fontSize:      12,
        fontFamily:    "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
        lineHeight:    1.2,
        scrollback:    0,
        scrollSensitivity: 1,
        scrollOnUserInput: true,
        allowProposedApi: true,
        theme: {
          ...terminalTheme,
          background: resolvePanelBackground(container, terminalTheme.background),
        }
      });

      xtermRef.current = term;
      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);

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

      const handleCopyPasteShortcut = (event: KeyboardEvent) => {
        if (!isActiveRef.current) return;
        if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
        const key = event.key.toLowerCase();
        if (key === "c") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          const selection = term?.getSelection();
          if (!selection) return;
          void writeClipboardText(selection);
        } else if (key === "v") {
          if (!navigator.clipboard?.readText || !window.isSecureContext) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          void navigator.clipboard.readText().then((text) => {
            if (text) term?.paste(text);
          }).catch(() => {});
        }
      };
      const handlePaste = (event: ClipboardEvent) => {
        if (!isActiveRef.current) return;
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return;
        event.preventDefault();
        event.stopPropagation();
        term?.paste(text);
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
          if (disposedRef.current) return;
          if (fitAndNotify({ notify: false })) {
            terminalReadyRef.current = true;
            flushTerminalData();
          }
        });
      });

      cancelInitialFit = scheduleFitBurst();
      cancelFontFit = scheduleFitBurst();
      void document.fonts?.ready.then(() => {
        if (!disposedRef.current && fitAddon) {
          try {
            fitAddon.fit();
          } catch {
            // Later resize events will retry if font metrics are not ready.
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
      if (initialSize.cols > 0 && initialSize.rows > 0) {
        wsParams.set("cols", String(initialSize.cols));
        wsParams.set("rows", String(initialSize.rows));
      }
      const wsUrl = websocketURL("/ws/terminal", wsParams);
      let connectAttempts = 0;
      let connectedOnce = false;

      const connect = () => {
        if (disposedRef.current) return;
        connectAttempts += 1;
        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;
        socket.binaryType = "arraybuffer";

        socket.onopen = () => {
          connectedOnce = true;
          connectAttempts = 0;
          for (const chunk of inputBuf.current) {
            socket.send(chunk);
          }
          inputBuf.current = [];
          lastSentSizeRef.current = null;
          fitAndResize(true);
          scheduleFitBurst({ notify: true });
          [500, 2000].forEach((delay) => {
            postOpenResizeTimers.push(window.setTimeout(() => {
              fitAndResize(true);
            }, delay));
          });
        };

        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            writeTerminalData(new Uint8Array(event.data));
          } else if (typeof event.data === "string") {
            try {
              const message = JSON.parse(event.data) as { type?: string; title?: string; full_title?: string; command?: string };
              if (message.type === "title" && typeof message.title === "string") {
                onTitleChangeRef.current?.(message.title, message.command, message.full_title);
                return;
              }
            } catch {
              // Plain terminal text
            }
            writeTerminalData(event.data);
          }
        };

        socket.onerror = () => {
          if (disposedRef.current) return;
          if (!connectedOnce && connectAttempts >= 3) {
            term!.write(`\r\n\x1b[31m[WebSocket connection failed: ${wsUrl}]\x1b[0m\r\n`);
          }
        };

        socket.onclose = () => {
          if (disposedRef.current) return;
          if (connectedOnce) {
            term!.write("\r\n\x1b[33m[Connection closed, reconnecting...]\x1b[0m\r\n");
          }
          const delay = Math.min(5000, 300 * connectAttempts);
          reconnectTimerRef.current = window.setTimeout(connect, delay);
        };
      };

      connectFrame = window.requestAnimationFrame(connect);

      /* ── 3. User input → WS ── */
      term.onData((data) => {
        const current = wsRef.current;
        if (current?.readyState === WebSocket.OPEN) {
          current.send(data);
        } else {
          inputBuf.current.push(data);
        }
      });
    };

    // Check size immediately to see if we can initialize right away
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      initTerminalAndWS();
    }

    /* ── 4. Resize observer — refit when container dimensions change ── */
    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        if (!initialized) {
          initTerminalAndWS();
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
      disposedRef.current = true;
      if (cancelCopyPasteShortcut) cancelCopyPasteShortcut();
      if (cancelPasteHandler) cancelPasteHandler();
      if (cancelFocusHandler) cancelFocusHandler();
      if (cancelInitialFit) cancelInitialFit();
      if (cancelFontFit) cancelFontFit();
      window.removeEventListener("resize", handleWinResize);
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
      if (connectFrame !== null) window.cancelAnimationFrame(connectFrame);
      if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
      if (term) term.dispose();
      inputBuf.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, terminalId, command]);

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
      className="absolute inset-0 box-border overflow-hidden px-0.5 py-0.5"
    />
  );
}
