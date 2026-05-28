import { useState, useEffect } from "react";
import { StudioDashboard, type Project } from "./components/studio/studio-dashboard";
import { StudioWorkspace } from "./components/studio/studio-workspace";
import type { Device } from "./lib/types";

export default function App() {
  const [view, setView] = useState<"studio_dashboard" | "studio_workspace">("studio_dashboard");
  const [devices, setDevices] = useState<Device[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

  useEffect(() => {
    refreshAll();
  }, []);

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
          name: "Local Machine",
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
            }}
          />
        )
      )}
    </div>
  );
}
