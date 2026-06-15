import { useState, useEffect, useMemo, useRef } from "react";
import { StudioDashboard, type Project } from "./components/studio/studio-dashboard";
import { StudioWorkspace } from "./components/studio/studio-workspace";
import type { NotificationJumpTarget, TerminalAlertEvent, TerminalNotification } from "./components/studio/terminal-notifications";
import type { Device } from "./lib/types";
import { getJSON, loadClientConfig, websocketURL } from "./lib/api";
import { loadZoom, saveZoom, type PageZoom } from "./lib/zoom";
import { isTerminalKind, terminalType, type TerminalKind } from "./components/studio/terminal-types";

const PROJECT_ORDER_KEY = "pocket-studio-project-order";
const MAX_TERMINAL_NOTIFICATIONS = 100;

export default function App() {
  const initialProjectId = projectIdFromPath();
  const [view, setView] = useState<"studio_dashboard" | "studio_workspace">(
    initialProjectId ? "studio_workspace" : "studio_dashboard"
  );
  const [devices, setDevices] = useState<Device[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId);
  const [pageZoom, setPageZoom] = useState<PageZoom>(() => loadZoom());
  const [terminalNotifications, setTerminalNotifications] = useState<TerminalNotification[]>([]);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [notificationJumpTarget, setNotificationJumpTarget] = useState<NotificationJumpTarget | null>(null);
  const [clientConfigLoaded, setClientConfigLoaded] = useState(false);
  const notificationDedupRef = useRef<Map<string, number>>(new Map());
  const devicesRef = useRef<Device[]>([]);
  const projectsRef = useRef<Project[]>([]);
  const orderedProjectsRef = useRef<Project[]>([]);
  const orderedProjects = useMemo(() => orderProjects(projects, projectOrder), [projectOrder, projects]);
  const unreadProjectIds = useMemo(() => new Set(terminalNotifications.filter((item) => !item.read).map((item) => item.projectId)), [terminalNotifications]);
  const unreadTerminalIds = useMemo(
    () => new Set(terminalNotifications.filter((item) => !item.read && item.projectId === selectedProjectId).map((item) => item.tabId)),
    [selectedProjectId, terminalNotifications]
  );

  useEffect(() => {
    saveZoom(pageZoom);
  }, [pageZoom]);

  useEffect(() => {
    saveProjectOrder(mergeProjectOrder(projectOrder, projects));
  }, [projectOrder, projects]);

  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);

  useEffect(() => {
    projectsRef.current = projects;
    orderedProjectsRef.current = orderedProjects;
  }, [orderedProjects, projects]);

  useEffect(() => {
    void loadClientConfig().then((cfg) => {
      syncAppImageURL(cfg.server_url, cfg.access_token || "");
    }).finally(() => {
      setClientConfigLoaded(true);
      refreshAll();
    });
  }, []);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(websocketURL("/ws/web"));
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const env = JSON.parse(event.data) as { type?: string; payload?: any };
          if (env.type !== "terminal.stream.alert") return;
          const payload = typeof env.payload === "string" ? JSON.parse(env.payload) : env.payload;
          if (!payload?.project_id || !payload?.terminal_id) return;
          addTerminalNotification({
            projectId: payload.project_id,
            tabId: payload.terminal_id,
            panelId: payload.panel_id || "",
            title: notificationTerminalTitle(payload.title, payload.agent),
            reason: payload.reason || "bell",
            message: payload.message || "",
          });
        } catch {
          // Ignore non-envelope messages.
        }
      };
      socket.onclose = () => {
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    if (!clientConfigLoaded) return;
    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [clientConfigLoaded]);

  useEffect(() => {
    const handlePopState = () => {
      const projectId = projectIdFromPath();
      setSelectedProjectId(projectId);
      setView(projectId ? "studio_workspace" : "studio_dashboard");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!selectedProjectId || orderedProjects.length === 0) return;
    if (!orderedProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId("");
      setView("studio_dashboard");
      replacePath(studioPath("/"));
    }
  }, [orderedProjects, selectedProjectId]);

  async function refreshAll() {
    try {
      const stateData = await getJSON<any>("/api/state");
      if (stateData && stateData.devices) {
        setDevices(stateData.devices);
      } else if (Array.isArray(stateData)) {
        setDevices(stateData);
      }

      const projectData = await getJSON<any>("/api/project/list");
      if (Array.isArray(projectData)) {
        setProjects(projectData);
      } else if (projectData && projectData.projects) {
        setProjects(projectData.projects);
      }
    } catch (err) {
      console.error("failed to fetch devices/projects:", err);
    }
  }

  function handleSelectProject(projectId: string) {
    setSelectedProjectId(projectId);
    setView("studio_workspace");
    pushPath(studioPath(`/projects/${encodeURIComponent(projectId)}`));
  }

  function addTerminalNotification(event: TerminalAlertEvent & { projectId: string }) {
    const project = orderedProjectsRef.current.find((item) => item.id === event.projectId) || projectsRef.current.find((item) => item.id === event.projectId);
    const device = project ? devicesRef.current.find((item) => item.id === project.device_id) : undefined;
    const dedupKey = `${event.projectId}:${event.tabId}:${event.reason || ""}:${event.message || ""}`;
    const now = Date.now();
    const lastSeen = notificationDedupRef.current.get(dedupKey) || 0;
    if (now - lastSeen < 800) return;
    notificationDedupRef.current.set(dedupKey, now);
    for (const [key, value] of notificationDedupRef.current) {
      if (now - value > 10_000) notificationDedupRef.current.delete(key);
    }
    setTerminalNotifications((current) => [
      {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        projectId: event.projectId,
        projectName: project?.name || event.projectId,
        deviceName: displayDeviceName(device?.name || project?.device_id || ""),
        panelId: event.panelId,
        tabId: event.tabId,
        terminalTitle: event.title || "Terminal",
        message: (event.message || "").trim(),
        reason: event.reason,
        createdAt: now,
        read: false,
      },
      ...current,
    ].slice(0, MAX_TERMINAL_NOTIFICATIONS));
  }

  function handleSelectNotification(notification: TerminalNotification) {
    setNotificationJumpTarget({
      projectId: notification.projectId,
      panelId: notification.panelId,
      tabId: notification.tabId,
      nonce: Date.now(),
    });
    setNotificationCenterOpen(false);
    handleSelectProject(notification.projectId);
  }

  function handleNotificationJumpHandled(nonce: number) {
    setNotificationJumpTarget((current) => current?.nonce === nonce ? null : current);
  }

  function handleTerminalFocused(projectId: string, tabId: string) {
    setTerminalNotifications((current) => {
      let changed = false;
      const now = Date.now();
      const next = current.map((item) => {
        if (item.projectId !== projectId || item.tabId !== tabId || item.read) return item;
        changed = true;
        return { ...item, read: true, readAt: now };
      });
      return changed ? next : current;
    });
  }

  function handleMarkAllNotificationsRead() {
    const now = Date.now();
    setTerminalNotifications((current) => current.map((item) => item.read ? item : { ...item, read: true, readAt: now }));
  }

  function handleMoveProject(projectId: string, direction: "up" | "down") {
    setProjectOrder((current) => moveProjectInOrder(current, orderedProjects, projectId, direction));
  }

  const activeProject = orderedProjects.find((p) => p.id === selectedProjectId);
  return (
    <div className="h-full w-full">
      {view === "studio_dashboard" ? (
        <StudioDashboard
          devices={devices}
          projects={orderedProjects}
          onSelectProject={handleSelectProject}
          onMoveProject={handleMoveProject}
          onRefreshProjects={refreshAll}
          pageZoom={pageZoom}
          onPageZoomChange={setPageZoom}
          notifications={terminalNotifications}
          notificationCenterOpen={notificationCenterOpen}
          onNotificationCenterOpenChange={setNotificationCenterOpen}
          onSelectNotification={handleSelectNotification}
          onMarkAllNotificationsRead={handleMarkAllNotificationsRead}
        />
      ) : (
        activeProject && (
          <StudioWorkspace
            projectId={selectedProjectId}
            project={activeProject}
            projects={orderedProjects}
            devices={devices}
            pageZoom={pageZoom}
            onPageZoomChange={setPageZoom}
            onSelectProject={handleSelectProject}
            onTerminalFocused={handleTerminalFocused}
            notificationJumpTarget={notificationJumpTarget}
            onNotificationJumpHandled={handleNotificationJumpHandled}
            alertProjectIds={unreadProjectIds}
            alertTerminalIds={unreadTerminalIds}
            notifications={terminalNotifications}
            notificationCenterOpen={notificationCenterOpen}
            onNotificationCenterOpenChange={setNotificationCenterOpen}
            onSelectNotification={handleSelectNotification}
            onMarkAllNotificationsRead={handleMarkAllNotificationsRead}
            onBackToDashboard={() => {
              refreshAll();
              setView("studio_dashboard");
              setSelectedProjectId("");
              pushPath(studioPath("/"));
            }}
          />
        )
      )}
    </div>
  );
}

function projectIdFromPath() {
  const path = stripStudioPrefix(window.location.pathname);
  const match = path.match(/^\/projects\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function studioPath(path: string) {
  if (window.location.protocol === "pocket-studio:") {
    return path;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `/studio${normalized === "/" ? "/" : normalized}`;
}

function stripStudioPrefix(path: string) {
  if (path === "/studio") return "/";
  if (path.startsWith("/studio/")) {
    return path.slice("/studio".length) || "/";
  }
  return path;
}

function pushPath(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
}

function replacePath(path: string) {
  if (window.location.pathname === path) return;
  window.history.replaceState({}, "", path);
}

function loadProjectOrder() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROJECT_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveProjectOrder(order: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

function mergeProjectOrder(order: string[], projects: Project[]) {
  const projectIds = projects.map((project) => project.id);
  const knownIds = new Set(projectIds);
  const orderedKnown = order.filter((id) => knownIds.has(id));
  const orderedSet = new Set(orderedKnown);
  return [...orderedKnown, ...projectIds.filter((id) => !orderedSet.has(id))];
}

function orderProjects(projects: Project[], order: string[]) {
  const rank = new Map(mergeProjectOrder(order, projects).map((id, index) => [id, index]));
  return [...projects].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

function moveProjectInOrder(order: string[], projects: Project[], projectId: string, direction: "up" | "down") {
  const nextOrder = mergeProjectOrder(order, projects);
  const index = nextOrder.indexOf(projectId);
  if (index === -1) return nextOrder;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= nextOrder.length) return nextOrder;
  [nextOrder[index], nextOrder[swapWith]] = [nextOrder[swapWith], nextOrder[index]];
  return nextOrder;
}

function displayDeviceName(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  const withoutProtocol = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = withoutProtocol.split(/[/:?#]/, 1)[0] || withoutProtocol;
  return host.split(".")[0] || host || raw;
}

function notificationTerminalTitle(title: unknown, agent: unknown) {
  const explicitTitle = typeof title === "string" ? title.trim() : "";
  if (explicitTitle) return explicitTitle;
  const kind = terminalKindFromAgent(agent);
  return kind ? terminalType(kind).title : "Terminal";
}

function terminalKindFromAgent(agent: unknown): TerminalKind | "" {
  if (typeof agent !== "string") return "";
  const normalized = agent.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "";
  if (normalized === "claude-code") return "claude";
  if (normalized === "kilocode" || normalized === "kilo-code") return "kilo";
  if (normalized === "antigravity") return "agy";
  return isTerminalKind(normalized) ? normalized : "";
}

function syncAppImageURL(serverURL: string, token: string) {
  if (window.location.protocol !== "pocket-studio:") {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const currentServerURL = params.get("server_url") || "";
  const currentToken = params.get("token") || "";
  if (currentServerURL === serverURL && currentToken === token && !params.has("server_url_source")) {
    return;
  }
  params.set("server_url", serverURL);
  if (token) {
    params.set("token", token);
  } else {
    params.delete("token");
  }
  params.delete("server_url_source");
  window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
  void syncAppImageDaemon(serverURL, token);
}

async function syncAppImageDaemon(serverURL: string, token: string) {
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.syncDaemonConfig) {
    return;
  }
  await electronAPI.syncDaemonConfig({
    server_url: serverURL,
    token,
  });
}
