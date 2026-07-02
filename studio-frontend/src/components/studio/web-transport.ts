import { websocketURL } from "@/lib/api";

export interface StudioEnvelope<TPayload = unknown> {
  id?: string;
  type: string;
  version?: number;
  timestamp?: number;
  from?: string;
  to?: {
    device_id?: string;
    task_id?: string;
  };
  trace_id?: string;
  payload?: TPayload;
}

export interface StudioWebTransport {
  close: () => void;
}

interface StudioWebTransportOptions {
  onEnvelope: (envelope: StudioEnvelope) => void;
}

export function createStudioWebTransport({ onEnvelope }: StudioWebTransportOptions): StudioWebTransport {
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let pingTimer: number | null = null;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
  };

  const connect = () => {
    if (closed) return;
    try {
      const url = websocketURL("/ws/web");
      socket = new WebSocket(url);
    } catch (err) {
      console.error("failed to create studio websocket:", err);
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      if (pingTimer !== null) window.clearInterval(pingTimer);
      pingTimer = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 10000);
    };
    socket.onmessage = (event) => {
      const envelope = parseEnvelope(event.data);
      if (envelope) {
        if (envelope.type === "pong") return;
        onEnvelope(envelope);
      }
    };
    socket.onerror = () => {
      // Let onclose drive reconnect. Some WebView builds emit onerror without a
      // useful Error object, so keep this side-effect free.
    };
    socket.onclose = () => {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
      if (closed) return;
      scheduleReconnect();
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingTimer !== null) window.clearInterval(pingTimer);
      socket?.close();
    },
  };
}

function parseEnvelope(data: unknown): StudioEnvelope | null {
  try {
    const parsed = JSON.parse(String(data)) as StudioEnvelope;
    return parsed && typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}
