import { useState, useEffect, useMemo, useRef } from "react";
import { StudioDashboard, type Project } from "./components/studio/studio-dashboard";
import { StudioWorkspace } from "./components/studio/studio-workspace";
import type { NotificationJumpTarget, TerminalAlertEvent, TerminalNotification } from "./components/studio/terminal-notifications";
import type { Device } from "./lib/types";
import { getJSON, postJSON, loadClientConfig } from "./lib/api";
import { pocketElectronAPI } from "./lib/electron-api";
import { loadZoom, saveZoom, type PageZoom } from "./lib/zoom";
import { isTerminalKind, terminalType, type TerminalKind } from "./components/studio/terminal-types";
import { createStudioWebTransport, type StudioWebTransport, type StudioEnvelope } from "./components/studio/web-transport";

const FAVORITES_KEY = "pocket-studio-favorites";
const MAX_TERMINAL_NOTIFICATIONS = 100;

export default function App() {
  const initialProjectId = projectIdFromPath();
  const [view, setView] = useState<"studio_dashboard" | "studio_workspace">(
    initialProjectId ? "studio_workspace" : "studio_dashboard"
  );
  const [devices, setDevices] = useState<Device[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
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
  const webTransportRef = useRef<StudioWebTransport | null>(null);
  const refreshProjectsRef = useRef<() => void>(() => {});
  const orderedProjects = projects;
  const favoriteProjects = useMemo(() => favoriteProjectsFrom(projects, favorites), [favorites, projects]);
  const favoriteIdSet = useMemo(() => new Set(favorites), [favorites]);
  const envelopeHandlerRef = useRef<(envelope: StudioEnvelope) => void>(() => {});
  const unreadProjectIds = useMemo(() => new Set(terminalNotifications.filter((item) => !item.read).map((item) => item.projectId)), [terminalNotifications]);
  const unreadTerminalIds = useMemo(
    () => new Set(terminalNotifications.filter((item) => !item.read && item.projectId === selectedProjectId).map((item) => item.tabId)),
    [selectedProjectId, terminalNotifications]
  );

  useEffect(() => {
    saveZoom(pageZoom);
  }, [pageZoom]);

  useEffect(() => {
    // Drop favorites whose project no longer exists, and persist.
    if (projects.length === 0) return;
    const known = new Set(projects.map((project) => project.id));
    setFavorites((current) => {
      const pruned = current.filter((id) => known.has(id));
      if (pruned.length === current.length) {
        saveFavorites(current);
        return current;
      }
      saveFavorites(pruned);
      return pruned;
    });
  }, [projects]);

  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);

  useEffect(() => {
    projectsRef.current = projects;
    orderedProjectsRef.current = orderedProjects;
  }, [orderedProjects, projects]);

  useEffect(() => {
    envelopeHandlerRef.current = (envelope) => {
      if (envelope.type === "terminal.stream.alert") {
        const payload = envelope.payload;
        if (!payload || typeof payload !== "object") return;
        const alert = payload as Record<string, unknown>;
        if (typeof alert.project_id !== "string" || typeof alert.terminal_id !== "string") return;
        addTerminalNotification({
          projectId: alert.project_id,
          tabId: alert.terminal_id,
          panelId: typeof alert.panel_id === "string" ? alert.panel_id : "",
          title: notificationTerminalTitle(alert.title, alert.agent),
          reason: typeof alert.reason === "string" ? alert.reason : "bell",
          message: typeof alert.message === "string" ? alert.message : "",
        });
        return;
      }
      if (envelope.type === "server.state") {
        const stateData = envelope.payload;
        if (stateData && typeof stateData === "object") {
          const typedState = stateData as { devices?: unknown[] };
          if (Array.isArray(typedState.devices)) {
            setDevices(typedState.devices.filter(isDevice));
          }
        }
      }
    };
  }, []);

  useEffect(() => {
    void loadClientConfig().then((cfg) => {
      syncAppImageURL(cfg.server_url, cfg.access_token || "");
    }).finally(() => {
      setClientConfigLoaded(true);
      refreshAll();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!clientConfigLoaded) return;
    const transport = createStudioWebTransport({
      onEnvelope: (envelope) => envelopeHandlerRef.current(envelope),
    });
    webTransportRef.current = transport;
    return () => {
      if (webTransportRef.current === transport) webTransportRef.current = null;
      transport.close();
    };
  }, [clientConfigLoaded]);

  useEffect(() => {
    if (!clientConfigLoaded) return;
    const interval = window.setInterval(() => {
      void refreshProjects();
    }, 60000);
    return () => window.clearInterval(interval);
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


  async function refreshProjects() {
    try {
      const projectData = await getJSON<unknown>("/api/project/list");
      if (Array.isArray(projectData)) {
        setProjects(projectData.filter(isProject));
      } else if (isObject(projectData) && Array.isArray(projectData.projects)) {
        setProjects(projectData.projects);
      }
    } catch (err) {
      console.error("failed to refresh projects:", err);
    }
  }

  refreshProjectsRef.current = () => { void refreshProjects(); };

  async function refreshAll() {
    try {
      const stateData = await getJSON<unknown>("/api/state");
      if (isObject(stateData) && Array.isArray(stateData.devices)) {
        setDevices(stateData.devices);
      } else if (Array.isArray(stateData)) {
        setDevices(stateData.filter(isDevice));
      }

      await refreshProjects();
    } catch (err) {
      console.error("failed to fetch devices/projects:", err);
    }
  }

  function handleSelectProject(projectId: string) {
    setSelectedProjectId(projectId);
    setView("studio_workspace");
    pushPath(studioPath(`/projects/${encodeURIComponent(projectId)}`));
  }

  async function handleDeleteProject(projectId: string) {
    try {
      const response = await postJSON<unknown>("/api/project/delete", {
        project_id: projectId,
      });
      if (isObject(response) && response.success === true) {
        setProjects((current) => current.filter((p) => p.id !== projectId));
      }
    } catch (err) {
      console.error("failed to delete project:", err);
      alert("删除项目失败，请重试");
    }
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
    setTerminalNotifications((current) => {
      const now = Date.now();
      return current.map((item) => (
        item.id === notification.id && !item.read ? { ...item, read: true, readAt: now } : item
      ));
    });
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

  function handleToggleFavorite(projectId: string) {
    setFavorites((current) => {
      const next = current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId];
      saveFavorites(next);
      return next;
    });
  }

  function handleProjectUpdated(updated: Project) {
    setProjects((current) => {
      let found = false;
      const next = current.map((project) => {
        if (project.id !== updated.id) return project;
        found = true;
        return { ...project, ...updated };
      });
      return found ? next : [...next, updated];
    });
  }

  function handleMoveFavorite(projectId: string, direction: "up" | "down") {
    setFavorites((current) => {
      const next = moveInList(current, projectId, direction);
      saveFavorites(next);
      return next;
    });
  }

  const activeProject = orderedProjects.find((p) => p.id === selectedProjectId);
  const showWorkspace = view === "studio_workspace" && activeProject;
  return (
    <div className="h-full w-full">
      {!showWorkspace ? (
        <StudioDashboard
          devices={devices}
          projects={orderedProjects}
          favoriteProjects={favoriteProjects}
          favoriteIds={favoriteIdSet}
          onToggleFavorite={handleToggleFavorite}
          onMoveFavorite={handleMoveFavorite}
          onSelectProject={handleSelectProject}
          onDeleteProject={handleDeleteProject}
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
          <StudioWorkspace
            projectId={selectedProjectId}
            project={activeProject}
            projects={orderedProjects}
            favoriteProjects={favoriteProjects}
            favoriteIds={favoriteIdSet}
            onToggleFavorite={handleToggleFavorite}
            onMoveFavorite={handleMoveFavorite}
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
            onProjectUpdated={handleProjectUpdated}
            onBackToDashboard={() => {
              refreshAll();
              setView("studio_dashboard");
              setSelectedProjectId("");
              pushPath(studioPath("/"));
            }}
          />
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

function loadFavorites() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveFavorites(favorites: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

// Favorited projects in favorite order, skipping any that no longer exist.
function favoriteProjectsFrom(projects: Project[], favorites: string[]) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const result: Project[] = [];
  for (const id of favorites) {
    const project = byId.get(id);
    if (project) result.push(project);
  }
  return result;
}

function moveInList(list: string[], id: string, direction: "up" | "down") {
  const index = list.indexOf(id);
  if (index === -1) return list;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= list.length) return list;
  const next = [...list];
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  return next;
}

function displayDeviceName(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  const withoutAddress = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (withoutAddress) return withoutAddress;
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
  const electronAPI = pocketElectronAPI();
  if (!electronAPI?.syncDaemonConfig) {
    return;
  }
  await electronAPI.syncDaemonConfig({
    server_url: serverURL,
    token,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDevice(value: unknown): value is Device {
  return isObject(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isProject(value: unknown): value is Project {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.device_id === "string"
    && typeof value.workspace_path === "string";
}
