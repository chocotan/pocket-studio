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
    void loadClientConfig().finally(refreshAll);
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
      replacePath("/");
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
    pushPath(`/projects/${encodeURIComponent(projectId)}`);
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
              pushPath("/");
            }}
          />
        )
      )}
    </div>
  );
}

function projectIdFromPath() {
  const match = window.location.pathname.match(/^\/projects\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function pushPath(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
}

function replacePath(path: string) {
  if (window.location.pathname === path) return;
  window.history.replaceState({}, "", path);
}
