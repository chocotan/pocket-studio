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

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(websocketURL("/ws/web"));
    socket.onmessage = (event) => {
      const envelope = parseEnvelope(event.data);
      if (envelope) onEnvelope(envelope);
    };
    socket.onclose = () => {
      if (closed) return;
      reconnectTimer = window.setTimeout(connect, 1500);
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
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
