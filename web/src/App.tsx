import { useState, useEffect } from "react";
import { StudioDashboard, type Project } from "./components/studio/studio-dashboard";
import { StudioWorkspace } from "./components/studio/studio-workspace";
import type { Device } from "./lib/types";

export default function App() {
  const initialProjectId = projectIdFromPath();
  const [view, setView] = useState<"studio_dashboard" | "studio_workspace">(
    initialProjectId ? "studio_workspace" : "studio_dashboard"
  );
  const [devices, setDevices] = useState<Device[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId);

  useEffect(() => {
    refreshAll();
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
      const host = window.location.host ? "" : "http://localhost:18080";

      const devRes = await fetch(`${host}/api/state`);
      if (devRes.ok) {
        const data = await devRes.json();
        if (data && data.devices) {
          setDevices(data.devices);
        } else if (Array.isArray(data)) {
          setDevices(data);
        }
      }

      const projRes = await fetch(`${host}/api/project/list`);
      if (projRes.ok) {
        const data = await projRes.json();
        if (Array.isArray(data)) {
          setProjects(data);
        } else if (data && data.projects) {
          setProjects(data.projects);
        }
      }
    } catch (err) {
      console.error("failed to fetch devices/projects:", err);
      // Fallback mock data for demo
      setDevices([
        {
          id: "dev_local",
          name: window.location.hostname || "localhost",
          workspaces: [{ id: "ws-1", name: "Agent", path: "/home/choco/Agent" }],
        },
      ]);
      setProjects([
        {
          id: "proj-99856689",
          name: "test-project",
          device_id: "dev_local",
          workspace_path: "/home/choco/Agent",
          agent_ids: [],
          tmux_ids: [],
        },
      ]);
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
