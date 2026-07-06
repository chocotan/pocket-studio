import { directWebsocketURL, websocketURL } from "@/lib/api";
import type { Project } from "../studio-dashboard";

type AgentChatTransport = "direct" | "relay";

export function agentChatDirectEndpointURL(project: Project) {
  if (!project.direct_mode || !project.direct_endpoint?.terminal_ws_url) {
    return "";
  }
  try {
    const endpoint = new URL(project.direct_endpoint.terminal_ws_url);
    endpoint.pathname = "/ws/acpx";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString();
  } catch {
    return "";
  }
}

export function agentChatWebSocketURL(project: Project, taskId: string): { url: string; transport: AgentChatTransport } {
  const directEndpointURL = agentChatDirectEndpointURL(project);
  if (directEndpointURL) {
    return {
      url: directWebsocketURL(
        directEndpointURL,
        new URLSearchParams({ task_id: taskId, project_id: project.id }),
        project.direct_endpoint?.token
      ),
      transport: "direct",
    };
  }
  return {
    url: websocketURL("/ws/acpx", new URLSearchParams({ task_id: taskId })),
    transport: "relay",
  };
}
