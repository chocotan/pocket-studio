import { useState, useEffect, useMemo } from "react";
import { StudioDashboard, type Project } from "./components/studio/studio-dashboard";
import { StudioWorkspace } from "./components/studio/studio-workspace";
import type { Device } from "./lib/types";
import { getJSON, loadClientConfig } from "./lib/api";
import { loadZoom, saveZoom, type PageZoom } from "./lib/zoom";

const PROJECT_ORDER_KEY = "pocket-studio-project-order";

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
  const orderedProjects = useMemo(() => orderProjects(projects, projectOrder), [projectOrder, projects]);

  useEffect(() => {
    saveZoom(pageZoom);
  }, [pageZoom]);

  useEffect(() => {
    saveProjectOrder(mergeProjectOrder(projectOrder, projects));
  }, [projectOrder, projects]);

  useEffect(() => {
    void loadClientConfig().then((cfg) => {
      syncAppImageURL(cfg.server_url, cfg.access_token || "");
    }).finally(refreshAll);
  }, []);

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
