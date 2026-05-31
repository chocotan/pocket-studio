import { useState, useEffect } from "react";
import { StudioDashboard, type Project } from "./components/studio/studio-dashboard";
import { StudioWorkspace } from "./components/studio/studio-workspace";
import type { Device } from "./lib/types";
import { getJSON, loadClientConfig } from "./lib/api";

export default function App() {
  const initialProjectId = projectIdFromPath();
  const [view, setView] = useState<"studio_dashboard" | "studio_workspace">(
    initialProjectId ? "studio_workspace" : "studio_dashboard"
  );
  const [devices, setDevices] = useState<Device[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId);

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
    if (!selectedProjectId || projects.length === 0) return;
    if (!projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId("");
      setView("studio_dashboard");
      replacePath(studioPath("/"));
    }
  }, [projects, selectedProjectId]);

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

  const activeProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="h-full w-full">
      {view === "studio_dashboard" ? (
        <StudioDashboard
          devices={devices}
          projects={projects}
          onSelectProject={handleSelectProject}
          onRefreshProjects={refreshAll}
        />
      ) : (
        activeProject && (
          <StudioWorkspace
            projectId={selectedProjectId}
            project={activeProject}
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
