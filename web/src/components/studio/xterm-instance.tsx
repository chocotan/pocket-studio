import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface XtermInstanceProps {
  projectId: string;
  terminalId: string;
  command: string;
  isActive: boolean;
}

export function XtermInstance({ projectId, terminalId, command, isActive }: XtermInstanceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef    = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef       = useRef<WebSocket | null>(null);
  // Buffer keystrokes that arrive before WS is OPEN
  const inputBuf    = useRef<string[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /* ── 1. Create xterm.js instance ── */
    const term = new XTerminal({
      cursorBlink:   true,
      cursorStyle:   "bar",
      fontSize:      13,
      fontFamily:    "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
      lineHeight:    1.4,
      scrollback:    5000,
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

    /* Mount terminal into the container div */
    term.open(container);

    /* Fit after a short delay to ensure the container has layout dimensions */
    const initialFitTimer = setTimeout(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    }, 50);

    /* ── 2. WebSocket connection ── */
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host  = window.location.host || "localhost:18080";
    const wsUrl = `${proto}//${host}/ws/terminal?project_id=${encodeURIComponent(projectId)}&terminal_id=${encodeURIComponent(terminalId)}&command=${encodeURIComponent(command)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      /* Flush buffered keystrokes */
      for (const chunk of inputBuf.current) {
        ws.send(chunk);
      }
      inputBuf.current = [];

      /* Send initial size to PTY */
      try {
        fitAddon.fit();
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      } catch { /* ignore */ }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else if (typeof event.data === "string") {
        term.write(event.data);
      }
    };

    ws.onerror = () => {
      term.write("\r\n\x1b[31m[WebSocket connection failed — is the server running?]\x1b[0m\r\n");
    };

    ws.onclose = () => {
      term.write("\r\n\x1b[33m[Connection closed]\x1b[0m\r\n");
    };

    /* ── 3. User input → WS ── */
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      } else {
        /* Buffer until WS opens */
        inputBuf.current.push(data);
      }
    });

    /* ── 4. Resize observer — refit when container dimensions change ── */
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch { /* ignore */ }
    });

    // Observe the container itself AND its nearest scrollable ancestor
    ro.observe(container);
    if (container.parentElement) ro.observe(container.parentElement);

    /* ── 5. Cleanup ── */
    return () => {
      clearTimeout(initialFitTimer);
      ro.disconnect();
      ws.close();
      term.dispose();
      inputBuf.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, terminalId, command]);

  /* Re-fit when this pane becomes the focused/active one */
  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(() => {
      const fit = fitAddonRef.current;
      const ws  = wsRef.current;
      const t   = xtermRef.current;
      if (!fit || !t) return;
      try {
        fit.fit();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
        }
      } catch { /* ignore */ }
    }, 80);
    return () => clearTimeout(timer);
  }, [isActive]);

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
