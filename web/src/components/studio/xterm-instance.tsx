import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalTitleSource } from "./terminal-types";

interface XtermInstanceProps {
  projectId: string;
  terminalId: string;
  command: string;
  isActive: boolean;
  layoutVersion?: number;
  onTitleChange?: (title: string, command?: string, source?: TerminalTitleSource) => void;
}

export function XtermInstance({ projectId, terminalId, command, isActive, layoutVersion = 0, onTitleChange }: XtermInstanceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef    = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef       = useRef<WebSocket | null>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  const reconnectTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeNotifyTimerRef = useRef<number | null>(null);
  // Buffer keystrokes that arrive before WS is OPEN
  const inputBuf    = useRef<string[]>([]);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  function sendResizeIfChanged() {
    const ws = wsRef.current;
    const t = xtermRef.current;
    if (!t || ws?.readyState !== WebSocket.OPEN) return;
    const nextSize = { cols: t.cols, rows: t.rows };
    const lastSize = lastSentSizeRef.current;
    if (lastSize?.cols === nextSize.cols && lastSize.rows === nextSize.rows) return;
    lastSentSizeRef.current = nextSize;
    ws.send(JSON.stringify({ type: "resize", cols: nextSize.cols, rows: nextSize.rows }));
  }

  function sendResizeNow(force = false) {
    const ws = wsRef.current;
    const t = xtermRef.current;
    if (!t || ws?.readyState !== WebSocket.OPEN) return false;
    const nextSize = { cols: t.cols, rows: t.rows };
    if (nextSize.cols <= 0 || nextSize.rows <= 0) return false;
    const lastSize = lastSentSizeRef.current;
    if (!force && lastSize?.cols === nextSize.cols && lastSize.rows === nextSize.rows) return true;
    lastSentSizeRef.current = nextSize;
    ws.send(JSON.stringify({ type: "resize", cols: nextSize.cols, rows: nextSize.rows }));
    return true;
  }

  function scheduleResizeNotify() {
    if (resizeNotifyTimerRef.current !== null) return;
    resizeNotifyTimerRef.current = window.setTimeout(() => {
      resizeNotifyTimerRef.current = null;
      sendResizeIfChanged();
    }, 60);
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
      if (notify) scheduleResizeNotify();
      return true;
    } catch {
      return false;
    }
  }

  function scheduleFitBurst() {
    const frames: number[] = [];
    const timers: number[] = [];
    frames.push(window.requestAnimationFrame(() => {
      fitAndNotify();
      frames.push(window.requestAnimationFrame(() => fitAndNotify()));
    }));
    [40, 120, 300, 650, 1200].forEach((delay) => {
      timers.push(window.setTimeout(() => fitAndNotify(), delay));
    });
    return () => {
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }

  function forceInitialResize() {
    let cancelled = false;
    const frames: number[] = [];
    const timers: number[] = [];
    const attempt = () => {
      if (cancelled) return;
      const fitted = fitAndNotify({ notify: false });
      if (fitted && sendResizeNow(true)) return;
    };
    frames.push(window.requestAnimationFrame(() => {
      attempt();
      frames.push(window.requestAnimationFrame(attempt));
    }));
    [30, 80, 160, 320, 700, 1200].forEach((delay) => {
      timers.push(window.setTimeout(attempt, delay));
    });
    return () => {
      cancelled = true;
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /* ── 1. Create xterm.js instance ── */
    const term = new XTerminal({
      cursorBlink:   true,
      cursorStyle:   "bar",
      fontSize:      12,
      fontFamily:    "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
      lineHeight:    1.2,
      scrollback:    5000,
      scrollSensitivity: 1,
      scrollOnUserInput: true,
      allowProposedApi: true,
      theme: {
        background:          "#fafafa",
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
      },
    });

    xtermRef.current = term;
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    const titleDisposable = term.onTitleChange((title) => {
      onTitleChangeRef.current?.(title, undefined, "terminal");
    });

    term.attachCustomWheelEventHandler((event) => {
      if (event.ctrlKey) return true;
      const rawDelta = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaY / 18
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * term.rows
          : event.deltaY;
      const lines = Math.sign(rawDelta) * Math.max(1, Math.min(12, Math.round(Math.abs(rawDelta))));
      term.scrollLines(lines);
      event.preventDefault();
      event.stopPropagation();
      return false;
    });

    /* Mount terminal into the container div */
    term.open(container);

    const cancelInitialFit = scheduleFitBurst();
    let cancelInitialResize: (() => void) | null = null;
    let cancelFontFit: (() => void) | null = null;
    void document.fonts?.ready.then(() => {
      if (!disposedRef.current) cancelFontFit = scheduleFitBurst();
    });

    /* ── 2. WebSocket connection ── */
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const currentHost = window.location.hostname || "localhost";
    const currentPort = window.location.port;
    const host = currentPort === "5173"
      ? `${currentHost}:18080`
      : (window.location.host || "localhost:18080");
    const wsUrl = `${proto}//${host}/ws/terminal?project_id=${encodeURIComponent(projectId)}&terminal_id=${encodeURIComponent(terminalId)}&command=${encodeURIComponent(command)}`;

    disposedRef.current = false;
    const connect = () => {
      if (disposedRef.current) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        for (const chunk of inputBuf.current) {
          ws.send(chunk);
        }
        inputBuf.current = [];
        lastSentSizeRef.current = null;
        cancelInitialResize?.();
        cancelInitialResize = forceInitialResize();
        scheduleFitBurst();
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
        } else if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as { type?: string; title?: string; command?: string };
            if (message.type === "title" && typeof message.title === "string") {
              onTitleChangeRef.current?.(message.title, message.command, "tmux");
              return;
            }
          } catch {
            // Plain terminal text from the PTY.
          }
          term.write(event.data);
        }
      };

      ws.onerror = () => {
        if (disposedRef.current) return;
        term.write("\r\n\x1b[31m[WebSocket connection failed]\x1b[0m\r\n");
      };

      ws.onclose = () => {
        if (disposedRef.current) return;
        term.write("\r\n\x1b[33m[Connection closed, reconnecting...]\x1b[0m\r\n");
        reconnectTimerRef.current = window.setTimeout(connect, 1000);
      };
    };
    const connectFrame = window.requestAnimationFrame(connect);

    /* ── 3. User input → WS ── */
    term.onData((data) => {
      const current = wsRef.current;
      if (current?.readyState === WebSocket.OPEN) {
        current.send(data);
      } else {
        inputBuf.current.push(data);
      }
    });

    /* ── 4. Resize observer — refit when container dimensions change ── */
    const ro = new ResizeObserver(() => {
      scheduleFitBurst();
    });

    // Observe the container itself AND its nearest scrollable ancestor
    ro.observe(container);
    if (container.parentElement) ro.observe(container.parentElement);

    /* ── 5. Cleanup ── */
    return () => {
      disposedRef.current = true;
      cancelInitialFit();
      cancelInitialResize?.();
      cancelFontFit?.();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (resizeNotifyTimerRef.current !== null) {
        window.clearTimeout(resizeNotifyTimerRef.current);
        resizeNotifyTimerRef.current = null;
      }
      ro.disconnect();
      titleDisposable.dispose();
      window.cancelAnimationFrame(connectFrame);
      if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
      term.dispose();
      inputBuf.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, terminalId, command]);

  /* Re-fit when this pane becomes the focused/active one */
  useEffect(() => {
    if (!isActive) return;
    return scheduleFitBurst();
  }, [isActive]);

  useEffect(() => {
    return scheduleFitBurst();
  }, [layoutVersion]);

  /*
   * The container must fill its parent entirely.
   * We use `position: absolute; inset: 0` so xterm gets 100% height.
   * xterm internally creates a canvas that fills the container.
   */
  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ padding: "6px 8px" }}
    />
  );
}
