import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Square, X } from "lucide-react";

import {
  Dashboard,
  Metric,
  NewSessionDialog,
  RawDialog,
  SearchDialog,
  StatusBar,
  ActivityBar
} from "@/components/ide/app-chrome";
import { SessionWorkspace } from "@/components/ide/session-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  attachTimelineTiming,
  buildTimelineItems,
  describeEvent,
  extractACPXSessionStatus,
  extractSessionIDFromEvent,
  extractSessionModels,
  extractSessionUsage,
  formatACPXTtl,
  formatACPXStatus,
  formatContextUsage,
  formatEventTime,
  formatTurnUsage,
  formatUsageCost,
  isVisibleEvent,
  latestModelID,
  type TaskEvent
} from "@/lib/agent-events";
import { postJSON } from "@/lib/api";
import {
  currentProjectIdFromPath,
  agentDisplayName,
  defaultWorkspacePath,
  isDuplicateEvent,
  isWaitingForAgent,
  mergeTreeEntries,
  pushRoute,
  routeFromLocation,
  searchSessionRecords,
  statusFromEvent,
  uniqueSessionNameFor,
  withEventTimestamp,
  workspaceForPath,
  workspaceNameFromPath
} from "@/lib/session-utils";
import {
  loadAllProjectStates,
  saveAllProjectStates,
  getInitialProjectState,
  type ProjectUIState
} from "@/lib/project-state";
import type { Device, FileEntry, OpenFile, TaskRecord, TerminalResult, WorkspaceResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StudioDashboard, type Project } from "@/components/studio/studio-dashboard";
import { StudioWorkspace } from "@/components/studio/studio-workspace";
import { Sparkles } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type ViewMode = "dashboard" | "task" | "studio_dashboard" | "studio_workspace";

function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [tasks, setTasks] = useState<string[]>([]);
  const [taskRecords, setTaskRecords] = useState<Map<string, TaskRecord>>(new Map());
  const [currentTaskId, setCurrentTaskId] = useState("");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [status, setStatus] = useState("idle");
  const [prompt, setPrompt] = useState("");
  const [view, setView] = useState<ViewMode>("dashboard");
  const [conn, setConn] = useState("Connecting...");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [rawEvent, setRawEvent] = useState<TaskEvent | null>(null);
  const [expandedToolResults, setExpandedToolResults] = useState<Set<string>>(new Set());
  const [fileTree, setFileTree] = useState<FileEntry[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(["."]));
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState("");
  const [fileStatus, setFileStatus] = useState("");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [explorerVisible, setExplorerVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [projectStates, setProjectStates] = useState<Record<string, ProjectUIState>>(() => loadAllProjectStates());
  const [studioProjects, setStudioProjects] = useState<Project[]>([]);
  const [selectedStudioProjectId, setSelectedStudioProjectId] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);
  const eventsRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  // Refs for state that needs to be accessed inside saveProjectUIState (which might be called from unmounted/stale closures)
  const taskRecordsRef = useRef(taskRecords);
  const openFilesRef = useRef(openFiles);
  const activeFilePathRef = useRef(activeFilePath);
  const fileTreeRef = useRef(fileTree);
  const expandedPathsRef = useRef(expandedPaths);
  const terminalLinesRef = useRef(terminalLines);
  const terminalVisibleRef = useRef(terminalVisible);
  const explorerVisibleRef = useRef(explorerVisible);
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  const workspacePathRef = useRef(workspacePath);
  const currentTaskIdRef = useRef(currentTaskId);
  const projectStatesRef = useRef(projectStates);

  useEffect(() => { taskRecordsRef.current = taskRecords; }, [taskRecords]);
  useEffect(() => { openFilesRef.current = openFiles; }, [openFiles]);
  useEffect(() => { activeFilePathRef.current = activeFilePath; }, [activeFilePath]);
  useEffect(() => { fileTreeRef.current = fileTree; }, [fileTree]);
  useEffect(() => { expandedPathsRef.current = expandedPaths; }, [expandedPaths]);
  useEffect(() => { terminalLinesRef.current = terminalLines; }, [terminalLines]);
  useEffect(() => { terminalVisibleRef.current = terminalVisible; }, [terminalVisible]);
  useEffect(() => { explorerVisibleRef.current = explorerVisible; }, [explorerVisible]);
  useEffect(() => { selectedDeviceIdRef.current = selectedDeviceId; }, [selectedDeviceId]);
  useEffect(() => { workspacePathRef.current = workspacePath; }, [workspacePath]);
  useEffect(() => { currentTaskIdRef.current = currentTaskId; }, [currentTaskId]);
  useEffect(() => { projectStatesRef.current = projectStates; }, [projectStates]);

  const getCurrentProjectKey = () => {
    const dId = selectedDeviceIdRef.current;
    const wPath = workspacePathRef.current;
    return dId && wPath ? `${dId}::${wPath}` : "";
  };

  const selectedDevice = devices.find((device) => device.id === selectedDeviceId);
  const selectedWorkspace = selectedDevice?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const currentRecord = currentTaskId ? taskRecords.get(currentTaskId) : undefined;
  const effectiveWorkspacePath = workspacePath.trim() || currentRecord?.workspace_path || "";
  const availableAgents = selectedDevice?.agents?.length
    ? selectedDevice.agents
    : [{ name: selectedDevice?.agent || "claude", label: selectedDevice?.agent_label || agentDisplayName(selectedDevice?.agent || "claude") }];
  const activeAgent = selectedAgent || currentRecord?.agent || selectedDevice?.agent || availableAgents[0]?.name || "claude";
  const agentLabel = availableAgents.find((agent) => agent.name === activeAgent)?.label || agentDisplayName(activeAgent);
  const timelineItems = useMemo(() => buildTimelineItems(events), [events]);
  const timedTimelineItems = useMemo(() => attachTimelineTiming(timelineItems), [timelineItems]);
  const waitingForAgent = useMemo(() => isWaitingForAgent(currentRecord, events), [currentRecord, events]);
  const sessionUsage = useMemo(() => extractSessionUsage(events), [events]);
  const sessionModels = useMemo(() => extractSessionModels(events), [events]);
  const acpxSessionStatus = useMemo(() => extractACPXSessionStatus(events), [events]);
  const currentModelID = currentRecord?.model_id || latestModelID(events) || "";
  const searchResults = useMemo(() => searchSessionRecords(tasks, taskRecords, searchQuery), [tasks, taskRecords, searchQuery]);

  // --- Dynamic Projects Listing derived from Online Devices and Session History ---
  const projects = useMemo(() => {
    const list: Array<{
      key: string;
      deviceId: string;
      deviceName: string;
      workspacePath: string;
      workspaceName: string;
      activeAgent?: string;
      sessionCount: number;
    }> = [];
    const seenKeys = new Set<string>();
    
    // 1. Gather all workspaces declared by online devices
    for (const dev of devices) {
      const workspaces = dev.workspaces || [];
      for (const ws of workspaces) {
        if (!ws.path) continue;
        const key = `${dev.id}::${ws.path}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const projectSessions = [...taskRecords.values()].filter(t => t.device_id === dev.id && t.workspace_path === ws.path);
          const activeAgent = projectSessions[0]?.agent;
          list.push({
            key,
            deviceId: dev.id,
            deviceName: dev.name || dev.id,
            workspacePath: ws.path,
            workspaceName: ws.name || workspaceNameFromPath(ws.path),
            activeAgent,
            sessionCount: projectSessions.length
          });
        }
      }
    }
    
    // 2. Also gather any custom directories found in taskRecords (recent sessions)
    for (const task of taskRecords.values()) {
      if (!task.device_id || !task.workspace_path) continue;
      const key = `${task.device_id}::${task.workspace_path}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        const dev = devices.find(d => d.id === task.device_id);
        const deviceName = dev?.name || task.device_id;
        const projectSessions = [...taskRecords.values()].filter(t => t.device_id === task.device_id && t.workspace_path === task.workspace_path);
        list.push({
          key,
          deviceId: task.device_id,
          deviceName,
          workspacePath: task.workspace_path,
          workspaceName: workspaceNameFromPath(task.workspace_path),
          activeAgent: task.agent,
          sessionCount: projectSessions.length
        });
      }
    }
    return list;
  }, [devices, taskRecords]);

  const currentProjectKey = selectedDeviceId && effectiveWorkspacePath ? `${selectedDeviceId}::${effectiveWorkspacePath}` : "";
  
  // Filter active sessions for the current project context
  const projectTasks = useMemo(() => {
    return tasks.filter(id => {
      const r = taskRecords.get(id);
      return r && r.device_id === selectedDeviceId && r.workspace_path === effectiveWorkspacePath;
    });
  }, [tasks, taskRecords, selectedDeviceId, effectiveWorkspacePath]);


  useEffect(() => {
    const applyRoute = () => {
      const route = routeFromLocation();
      if (route.view === "project" && route.projectId) {
        const parts = route.projectId.split("::");
        if (parts.length === 2) {
          const [dId, wPath] = parts;
          saveProjectUIState(getCurrentProjectKey());
          setSelectedDeviceId(dId);
          setWorkspacePath(wPath);
          const device = devices.find(d => d.id === dId);
          setSelectedWorkspaceId(device?.workspaces.find(w => w.path === wPath)?.id || "");
          
          // Restore project UI state
          const state = projectStatesRef.current[route.projectId] || getInitialProjectState();
          setOpenFiles(state.openFiles || []);
          setActiveFilePath(state.activeFilePath || "");
          setFileTree(state.fileTree || []);
          setExpandedPaths(new Set(state.expandedPaths || ["."]));
          setTerminalLines(state.terminalLines || []);
          setExplorerVisible(state.explorerVisible ?? true);
          setTerminalVisible(state.terminalVisible ?? false);
          setCurrentTaskId(state.activeTaskId || "");
          setFileStatus(state.activeFilePath ? "已打开" : "");
          setView("task");
        }
      } else {
        saveProjectUIState(getCurrentProjectKey());
        setSelectedDeviceId("");
        setWorkspacePath("");
        setSelectedWorkspaceId("");
        setCurrentTaskId("");
        setEvents([]);
        setStatus("idle");
        setView("dashboard");
      }
    };
    applyRoute();
    window.addEventListener("popstate", applyRoute);
    return () => window.removeEventListener("popstate", applyRoute);
  }, [devices]);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let closed = false;
    let ws: WebSocket;

    const connect = () => {
      ws = new WebSocket(`${proto}//${location.host}/ws/web`);
      wsRef.current = ws;
      ws.onopen = () => setConn("Connected");
      ws.onclose = () => {
        setConn("Disconnected");
        if (!closed) setTimeout(connect, 1200);
      };
      ws.onmessage = (message) => {
        const env = JSON.parse(message.data);
        if (env.type === "server.state") {
          const nextDevices = env.payload?.devices || [];
          setDevices(nextDevices);
          ingestTasks(env.payload?.tasks || []);
          setSelectedDeviceId((current) => current || nextDevices[0]?.id || "");
          setSelectedWorkspaceId((current) => current || nextDevices[0]?.workspaces?.[0]?.id || "");
          setSelectedAgent((current) => current || nextDevices[0]?.agents?.[0]?.name || nextDevices[0]?.agent || "claude");
          return;
        }
        if (env.type === "task.event") {
          const payload = withEventTimestamp(env.payload as TaskEvent, env.timestamp);
          if (!payload?.task_id) return;
          mergeTaskEvent(payload);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  async function fetchStudioProjects() {
    try {
      const response = await fetch("/api/project/list");
      if (response.ok) {
        const data = await response.json();
        setStudioProjects(data);
      }
    } catch (e) {
      console.error("failed to fetch studio projects:", e);
    }
  }

  useEffect(() => {
    fetchStudioProjects();
  }, []);

  async function handleSelectStudioProject(projId: string) {
    setSelectedStudioProjectId(projId);
    
    try {
      const response = await fetch(`/api/project/state?project_id=${projId}`);
      if (response.ok) {
        const state = await response.json();
        setOpenFiles(state.openFiles || []);
        setActiveFilePath(state.activeFilePath || "");
        setCurrentTaskId(state.activeTaskId || "");
      }
    } catch (e) {
      console.error("failed to load project state:", e);
    }
    
    const proj = studioProjects.find(p => p.id === projId);
    if (proj) {
      setSelectedDeviceId(proj.device_id);
      setWorkspacePath(proj.workspace_path);
      
      try {
        const result = await postJSON<WorkspaceResult>(`/api/workspace/list?device_id=${encodeURIComponent(proj.device_id)}`, {
          request_id: `list_${Date.now()}`,
          workspace_path: proj.workspace_path,
          path: "."
        });
        handleWorkspaceResult(result);
      } catch (err) {
        console.error("failed to fetch file tree:", err);
      }
    }
    
    setView("studio_workspace" as ViewMode);
  }

  function dispatchTaskCustom(agentType: string, promptText: string) {
    if (!promptText.trim() || !selectedDeviceId || !effectiveWorkspacePath || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const workspace = selectedWorkspace || { id: "", name: "", path: effectiveWorkspacePath };
    const taskId = `ses_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const sessionName = `Chat: ${agentType}`;
    const userEvent: TaskEvent = { task_id: taskId, event_type: "user.prompt", source: "web", timestamp: Math.floor(Date.now() / 1000), data: { prompt: promptText } };

    setCurrentTaskId(taskId);
    setTasks((current) => current.includes(taskId) ? current : [taskId, ...current]);
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(taskId) || { task_id: taskId, events: [] };
      record.workspace_id = workspace.id;
      record.workspace_path = effectiveWorkspacePath;
      record.device_id = selectedDeviceId;
      record.agent = agentType.toLowerCase();
      record.session_name = sessionName;
      record.prompt = promptText;
      record.status = "running";
      record.events = [userEvent];
      next.set(taskId, record);
      return next;
    });

    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "task.dispatch",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: selectedDeviceId },
      payload: {
        task_id: taskId,
        workspace_id: workspace.id,
        workspace_path: effectiveWorkspacePath,
        agent: agentType.toLowerCase(),
        session_name: sessionName,
        model_id: "",
        prompt: promptText
      }
    }));
  }

  useEffect(() => {
    const record = currentTaskId ? taskRecords.get(currentTaskId) : undefined;
    if (!record) return;
    shouldStickToBottomRef.current = true;
    setEvents(record.events ? [...record.events] : []);
    setStatus(record.status || "running");
    setExpandedToolResults(new Set());
  }, [currentTaskId]);

  useEffect(() => {
    const record = currentTaskId ? taskRecords.get(currentTaskId) : undefined;
    if (!record) return;
    setEvents(record.events ? [...record.events] : []);
    setStatus(record.status || "running");
  }, [currentTaskId, taskRecords]);

  useEffect(() => {
    const node = eventsRef.current;
    if (!node || !shouldStickToBottomRef.current) return;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight;
      });
    });
  }, [currentTaskId, events.length, timelineItems.length]);

  function saveProjectUIState(projectKey = getCurrentProjectKey()) {
    if (!projectKey) return;
    setProjectStates((prev) => {
      const next = {
        ...prev,
        [projectKey]: {
          openFiles: openFilesRef.current,
          activeFilePath: activeFilePathRef.current,
          fileTree: fileTreeRef.current,
          expandedPaths: Array.from(expandedPathsRef.current),
          terminalLines: terminalLinesRef.current,
          explorerVisible: explorerVisibleRef.current,
          terminalVisible: terminalVisibleRef.current,
          activeTaskId: currentTaskIdRef.current
        }
      };
      saveAllProjectStates(next);
      return next;
    });
  }

  function restoreProjectUIState(projectKey: string) {
    const state = projectStatesRef.current[projectKey] || getInitialProjectState();
    setOpenFiles(state.openFiles || []);
    setActiveFilePath(state.activeFilePath || "");
    setFileTree(state.fileTree || []);
    setExpandedPaths(new Set(state.expandedPaths || ["."]));
    setTerminalLines(state.terminalLines || []);
    setExplorerVisible(state.explorerVisible ?? true);
    setTerminalVisible(state.terminalVisible ?? false);
    setCurrentTaskId(state.activeTaskId || "");
    setFileStatus(state.activeFilePath ? "已打开" : "");
  }

  function updateStickToBottom() {
    const node = eventsRef.current;
    if (!node) return;
    shouldStickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  function navigateHome() {
    saveProjectUIState(getCurrentProjectKey());
    setSelectedDeviceId("");
    setWorkspacePath("");
    setSelectedWorkspaceId("");
    setCurrentTaskId("");
    setEvents([]);
    setStatus("idle");
    setView("dashboard");
    pushRoute("/");
  }

  function navigateSession(taskId: string) {
    if (!taskId) return;
    shouldStickToBottomRef.current = true;
    setCurrentTaskId(taskId);
    setView("task");
  }

  function ingestTasks(records: TaskRecord[]) {
    setTaskRecords((prev) => {
      const next = new Map(prev);
      for (const record of records) {
        if (record?.task_id) next.set(record.task_id, record);
      }
      const sorted = [...next.values()]
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
        .map((record) => record.task_id);
      setTasks(sorted);
      return next;
    });
  }

  function mergeTaskEvent(event: TaskEvent) {
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(event.task_id) || { task_id: event.task_id, status: "running", events: [] };
      const sessionID = extractSessionIDFromEvent(event);
      if (sessionID) record.session_id = sessionID;
      record.status = statusFromEvent(event.event_type, record.status);
      record.updated_at = Math.floor(Date.now() / 1000);
      record.events = record.events || [];
      if (!isDuplicateEvent(record.events, event)) record.events.push(event);
      next.set(event.task_id, record);
      setTasks((current) => current.includes(event.task_id) ? current : [event.task_id, ...current]);
      return next;
    });
  }

  function dispatchTask() {
    const text = prompt.trim();
    if (!text || !selectedDevice || !effectiveWorkspacePath || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const workspace = workspaceForPath(effectiveWorkspacePath, selectedWorkspace);
    const shouldContinue = Boolean(currentTaskId && currentRecord);
    const taskId = shouldContinue ? currentTaskId : `ses_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const sessionName = currentRecord?.session_name || uniqueSessionNameFor(workspace, activeAgent);
    const modelID = currentRecord?.model_id || latestModelID(events) || "";
    const userEvent: TaskEvent = { task_id: taskId, event_type: "user.prompt", source: "web", timestamp: Math.floor(Date.now() / 1000), data: { prompt: text } };

    if (!shouldContinue) {
      saveProjectUIState(getCurrentProjectKey());
    }
    setCurrentTaskId(taskId);
    setView("task");
    setStatus("running");
    setPrompt("");
    setTasks((current) => current.includes(taskId) ? current : [taskId, ...current]);
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(taskId) || { task_id: taskId, events: [] };
      record.workspace_id = workspace.id;
      record.workspace_path = effectiveWorkspacePath;
      record.device_id = selectedDevice.id;
      record.agent = activeAgent;
      record.session_name = sessionName;
      if (modelID) record.model_id = modelID;
      record.prompt = text;
      record.status = "running";
      record.events = shouldContinue ? [...(record.events || []), userEvent] : [userEvent];
      next.set(taskId, record);
      return next;
    });

    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "task.dispatch",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: selectedDevice.id },
      payload: {
        task_id: taskId,
        workspace_id: workspace.id,
        workspace_path: effectiveWorkspacePath,
        agent: activeAgent,
        session_name: sessionName,
        model_id: modelID,
        prompt: text,
        parent_task_id: shouldContinue ? currentTaskId : "",
        resume_session_id: currentRecord?.session_id || "",
        options: {
          auto_shell: true,
          allowed_tools: ["file", "bash"],
          timeout_seconds: 3600
        }
      }
    }));
  }

  function startNewSession() {
    const path = workspacePath.trim();
    if (!selectedDevice || !path || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const workspace = workspaceForPath(path);
    const agent = activeAgent || selectedDevice.agent || availableAgents[0]?.name || "claude";
    const taskId = `ses_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const sessionName = uniqueSessionNameFor(workspace, agent);
    setSelectedWorkspaceId(workspace?.id || "");
    setWorkspacePath(path);
    setSelectedAgent(agent);
    
    saveProjectUIState(getCurrentProjectKey());
    setCurrentTaskId(taskId);
    setView("task");
    shouldStickToBottomRef.current = true;
    setEvents([]);
    setStatus("creating");
    setPrompt("");
    setExpandedToolResults(new Set());
    const now = Math.floor(Date.now() / 1000);
    setTasks((current) => current.includes(taskId) ? current : [taskId, ...current]);
    setTaskRecords((prev) => {
      const next = new Map(prev);
      next.set(taskId, {
        task_id: taskId,
        device_id: selectedDevice.id,
        workspace_id: workspace.id,
        workspace_path: path,
        agent,
        session_name: sessionName,
        prompt: "",
        status: "creating",
        started_at: now,
        updated_at: now,
        events: []
      });
      return next;
    });
    setNewSessionOpen(false);
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "session.create",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: selectedDevice.id },
      payload: {
        task_id: taskId,
        workspace_id: workspace.id,
        workspace_path: path,
        agent,
        session_name: sessionName,
        options: {
          auto_shell: true,
          allowed_tools: ["file", "bash"],
          timeout_seconds: 3600
        }
      }
    }));
  }

  function selectProject(deviceId: string, path: string) {
    saveProjectUIState(getCurrentProjectKey());
    setSelectedDeviceId(deviceId);
    setWorkspacePath(path);
    
    const device = devices.find(d => d.id === deviceId);
    setSelectedWorkspaceId(device?.workspaces.find(w => w.path === path)?.id || "");
    
    const nextProjectKey = `${deviceId}::${path}`;
    setView("task");
    
    restoreProjectUIState(nextProjectKey);
    pushRoute(`/project/${encodeURIComponent(nextProjectKey)}/home`);
    
    setTimeout(() => {
      sendWorkspaceList(".");
    }, 100);
  }

  function startNewAgentOnCurrentProject(agentOverride?: string) {
    if (!selectedDeviceId || !effectiveWorkspacePath || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const workspace = workspaceForPath(effectiveWorkspacePath, selectedWorkspace);
    const agent = agentOverride || activeAgent || "claude";
    const taskId = `ses_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const sessionName = uniqueSessionNameFor(workspace, agent);
    
    saveProjectUIState(getCurrentProjectKey());
    
    setCurrentTaskId(taskId);
    setEvents([]);
    setStatus("creating");
    setPrompt("");
    setExpandedToolResults(new Set());
    const now = Math.floor(Date.now() / 1000);
    
    setTasks((current) => current.includes(taskId) ? current : [taskId, ...current]);
    setTaskRecords((prev) => {
      const next = new Map(prev);
      next.set(taskId, {
        task_id: taskId,
        device_id: selectedDeviceId,
        workspace_id: workspace.id,
        workspace_path: effectiveWorkspacePath,
        agent,
        session_name: sessionName,
        prompt: "",
        status: "creating",
        started_at: now,
        updated_at: now,
        events: []
      });
      return next;
    });
    
    setView("task");
    
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "session.create",
      version: 1,
      timestamp: now,
      from: "web",
      to: { device_id: selectedDeviceId },
      payload: {
        task_id: taskId,
        workspace_id: workspace.id,
        workspace_path: effectiveWorkspacePath,
        agent,
        session_name: sessionName,
        options: {
          auto_shell: true,
          allowed_tools: ["file", "bash"],
          timeout_seconds: 3600
        }
      }
    }));
  }

  function openTask(taskId: string) {
    const record = taskRecords.get(taskId);
    if (!record) return;
    const deviceId = record.device_id;
    const path = record.workspace_path;
    if (deviceId && path) {
      if (deviceId !== selectedDeviceId || path !== workspacePath) {
        selectProject(deviceId, path);
      }
    }
    setCurrentTaskId(taskId);
    setView("task");
  }

  function stopTask() {
    if (!currentTaskId || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "task.stop",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      payload: { task_id: currentTaskId, reason: "user_requested" }
    }));
    setStatus("stopping");
  }

  function deleteSession(taskId: string, afterDelete: "home" | "next" | "project" = "home") {
    const record = taskRecords.get(taskId);
    if (!record || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const deviceId = record.device_id || selectedDeviceId;
    if (!deviceId) return;
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "session.delete",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      to: { device_id: deviceId },
      payload: {
        task_id: taskId,
        agent: record.agent || activeAgent,
        session_name: record.session_name || "",
        workspace_id: record.workspace_id || "",
        workspace_path: record.workspace_path || ""
      }
    }));
    setTaskRecords((prev) => {
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
    setTasks((current) => current.filter((item) => item !== taskId));
    if (currentTaskId === taskId) {
      if (afterDelete === "project") {
        const remainingInProject = tasks.filter(id => {
          const r = taskRecords.get(id);
          return id !== taskId && r && r.device_id === selectedDeviceId && r.workspace_path === effectiveWorkspacePath;
        });
        if (remainingInProject.length > 0) {
          openTask(remainingInProject[0]);
        } else {
          setCurrentTaskId("");
          setEvents([]);
          setStatus("idle");
        }
      } else if (afterDelete === "next") {
        const nextTask = tasks.find((item) => item !== taskId) || "";
        if (nextTask) openTask(nextTask);
        else navigateHome();
      } else {
        navigateHome();
      }
    }
  }

  function setTaskModel(modelID: string) {
    if (!currentTaskId || !modelID || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setTaskRecords((prev) => {
      const next = new Map(prev);
      const record = next.get(currentTaskId);
      if (record) {
        next.set(currentTaskId, { ...record, model_id: modelID });
      }
      return next;
    });
    wsRef.current.send(JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "task.set_model",
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      from: "web",
      payload: { task_id: currentTaskId, model_id: modelID }
    }));
  }

  async function sendWorkspaceList(path = ".") {
    if (!selectedDevice || !effectiveWorkspacePath) return;
    try {
      const result = await postJSON<WorkspaceResult>(`/api/workspace/list?device_id=${encodeURIComponent(selectedDevice.id)}`, {
        request_id: `fs_${Date.now()}`,
        workspace_id: selectedWorkspaceId,
        workspace_path: effectiveWorkspacePath,
        path
      });
      handleWorkspaceResult(result);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendWorkspaceRead(path: string) {
    if (!selectedDevice || !effectiveWorkspacePath) return;
    setActiveFilePath(path);
    setOpenFiles((current) => current.some((file) => file.path === path) ? current : [...current, { path, content: "", savedContent: "", status: "读取中" }]);
    setFileStatus("读取中");
    try {
      const result = await postJSON<WorkspaceResult>(`/api/workspace/read?device_id=${encodeURIComponent(selectedDevice.id)}`, {
        request_id: `read_${Date.now()}`,
        workspace_id: selectedWorkspaceId,
        workspace_path: effectiveWorkspacePath,
        path
      });
      handleWorkspaceResult(result);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendWorkspaceWrite(path = activeFilePath) {
    const activeFile = openFiles.find((file) => file.path === path);
    if (!selectedDevice || !effectiveWorkspacePath || !activeFile) return;
    setFileStatus("保存中");
    setOpenFiles((current) => current.map((file) => file.path === activeFile.path ? { ...file, status: "保存中" } : file));
    try {
      const result = await postJSON<WorkspaceResult>(`/api/workspace/write?device_id=${encodeURIComponent(selectedDevice.id)}`, {
        request_id: `write_${Date.now()}`,
        workspace_id: selectedWorkspaceId,
        workspace_path: effectiveWorkspacePath,
        path: activeFile.path,
        content: activeFile.content
      });
      handleWorkspaceResult(result);
      setFileStatus("已保存");
      setOpenFiles((current) => current.map((file) => file.path === activeFile.path ? { ...file, savedContent: activeFile.content, status: "已保存" } : file));
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
      setOpenFiles((current) => current.map((file) => file.path === activeFile.path ? { ...file, status: error instanceof Error ? error.message : String(error) } : file));
    }
  }

  async function sendTerminalRun(command: string) {
    const text = command.trim();
    if (!text || !selectedDevice || !effectiveWorkspacePath) return;
    setTerminalRunning(true);
    setTerminalLines((current) => [...current, `$ ${text}`]);
    try {
      const result = await postJSON<TerminalResult>(`/api/terminal/run?device_id=${encodeURIComponent(selectedDevice.id)}`, {
        request_id: `term_${Date.now()}`,
        workspace_id: selectedWorkspaceId,
        workspace_path: effectiveWorkspacePath,
        command: text
      });
      handleTerminalResult(result);
    } catch (error) {
      setTerminalRunning(false);
      setTerminalLines((current) => [...current, error instanceof Error ? error.message : String(error)]);
    }
  }

  function handleWorkspaceResult(result: WorkspaceResult) {
    if (result.error) {
      setFileStatus(result.error);
      return;
    }
    if (result.entries) {
      const rootName = workspaceNameFromPath(result.workspace_path || effectiveWorkspacePath) || "workspace";
      setFileTree((current) => mergeTreeEntries(current, result.path || ".", result.entries || [], rootName));
      setExpandedPaths((current) => new Set(current).add(result.path || "."));
    }
    if (typeof result.content === "string" && result.path) {
      setActiveFilePath(result.path);
      setOpenFiles((current) => {
        const nextFile = { path: result.path || "", content: result.content || "", savedContent: result.content || "", status: "已打开" };
        return current.some((file) => file.path === result.path)
          ? current.map((file) => file.path === result.path ? nextFile : file)
          : [...current, nextFile];
      });
      setFileStatus("已打开");
    }
  }

  function handleTerminalResult(result: TerminalResult) {
    setTerminalRunning(false);
    setTerminalLines((current) => [
      ...current,
      result.output || result.error || "",
      `[exit ${result.exit_code}]`
    ].filter((line) => line !== ""));
  }

  if (view === "studio_dashboard" || view === "studio_workspace") {
    return (
      <div className="flex flex-col h-screen overflow-hidden bg-slate-50 text-slate-800 font-sans antialiased">
        <header className="bg-white border-b border-slate-200 h-14 shrink-0 flex items-center justify-between px-6 z-30 select-none shadow-sm">
          <div className="flex items-center space-x-3">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <span className="text-white font-bold text-sm">P</span>
            </div>
            <span className="font-bold text-lg text-slate-800 tracking-tight">Pocket Studio</span>
            <span className="px-2 py-0.5 text-[9px] uppercase font-bold tracking-widest bg-indigo-50 text-indigo-600 rounded border border-indigo-100">PRO</span>
          </div>

          <div className="flex items-center space-x-6 text-sm">
            {view === "studio_workspace" && (
              <div className="flex items-center space-x-2 text-slate-500 bg-slate-100 px-3 py-1 rounded-full border border-slate-200">
                <span className="text-slate-700 font-semibold">{devices.find(d => d.id === selectedDeviceId)?.name || selectedDeviceId}</span>
                <span className="text-slate-300">/</span>
                <span className="text-slate-700 font-medium truncate max-w-xs">{workspacePath.substring(workspacePath.lastIndexOf("/") + 1) || workspacePath}</span>
              </div>
            )}

            <div className="flex items-center space-x-2">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <span className="text-slate-500 text-xs font-mono uppercase">Connected</span>
            </div>

            {view === "studio_workspace" ? (
              <button
                onClick={() => setView("studio_dashboard" as ViewMode)}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 transition font-bold text-xs text-white shadow"
              >
                <span>返回大厅</span>
              </button>
            ) : (
              <button
                onClick={() => setView("dashboard")}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 transition font-semibold text-xs text-slate-600"
              >
                <span>返回旧版 IDE</span>
              </button>
            )}
          </div>
        </header>

        <main className="grow relative flex overflow-hidden">
          {view === "studio_dashboard" ? (
            <StudioDashboard
              devices={devices}
              projects={studioProjects}
              onSelectProject={handleSelectStudioProject}
              onRefreshProjects={fetchStudioProjects}
            />
          ) : (
            (() => {
              const proj = studioProjects.find(p => p.id === selectedStudioProjectId);
              return proj ? (
                <StudioWorkspace
                  projectId={selectedStudioProjectId}
                  project={proj}
                  devices={devices}
                  fileTree={fileTree}
                  openFiles={openFiles}
                  activeFilePath={activeFilePath}
                  onOpenFile={(path) => {
                    if (path.endsWith(".go") || path.endsWith(".js") || path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".md") || path.endsWith(".json")) {
                      sendWorkspaceRead(path);
                    } else {
                      sendWorkspaceList(path);
                    }
                  }}
                  onCloseFile={(path) => {
                    setOpenFiles((current) => {
                      const remaining = current.filter((file) => file.path !== path);
                      setActiveFilePath((active) => active === path ? remaining[remaining.length - 1]?.path || "" : active);
                      return remaining;
                    });
                  }}
                  onSaveFile={(path, content) => {
                    setOpenFiles((current) => current.map((file) => file.path === path ? { ...file, content } : file));
                    sendWorkspaceWrite(path);
                  }}
                  onSetActiveFile={setActiveFilePath}
                  onCreateAgentSession={dispatchTaskCustom}
                  activeTaskId={currentTaskId}
                  tasks={tasks}
                  taskRecords={taskRecords}
                  onBackToDashboard={() => setView("studio_dashboard" as ViewMode)}
                />
              ) : null;
            })()
          )}
        </main>
      </div>
    );
  }

  return (
    <div className={cn("app-shell ide-app-shell", view === "dashboard" && "ide-app-shell-no-status")}>
      <ActivityBar
        currentProjectKey={currentProjectKey}
        projects={projects}
        view={view}
        onSelectProject={selectProject}
        onOpenDashboard={navigateHome}
        onOpenSearch={() => setSearchOpen(true)}
      />

      <div className="absolute top-3.5 right-4 z-40">
        <button
          onClick={() => {
            setView("studio_dashboard" as ViewMode);
            fetchStudioProjects();
          }}
          className="flex items-center space-x-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-xs font-semibold text-white shadow-md shadow-indigo-500/10 transition select-none animate-bounce"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>切换至新版 Studio</span>
        </button>
      </div>

      <main className="app-main min-h-0">
        {view === "dashboard" ? (
          <Dashboard
            devices={devices}
            tasks={tasks}
            taskRecords={taskRecords}
            projects={projects}
            onSelectProject={selectProject}
            onAddProject={(deviceId, path) => {
              selectProject(deviceId, path);
            }}
          />
        ) : (
          <SessionWorkspace
            activeAgent={activeAgent}
            agentLabel={agentLabel}
            availableAgents={availableAgents}
            currentRecord={currentRecord}
            currentModelID={currentModelID}
            devices={devices}
            effectiveWorkspacePath={effectiveWorkspacePath}
            eventsRef={eventsRef}
            explorerVisible={explorerVisible}
            expandedToolResults={expandedToolResults}
            fileStatus={fileStatus}
            fileTree={fileTree}
            expandedPaths={expandedPaths}
            openFiles={openFiles}
            activeFilePath={activeFilePath}
            prompt={prompt}
            selectedDevice={selectedDevice}
            selectedDeviceId={selectedDeviceId}
            sessionModels={sessionModels}
            terminalLines={terminalLines}
            terminalRunning={terminalRunning}
            terminalVisible={terminalVisible}
            timelineItems={timedTimelineItems}
            waitingForAgent={waitingForAgent}
            projectTasks={projectTasks}
            taskRecords={taskRecords}
            currentTaskId={currentTaskId}
            onSelectTask={navigateSession}
            onDeleteTask={(id) => deleteSession(id, "project")}
            onScroll={updateStickToBottom}
            onDispatch={dispatchTask}
            onAgentChange={setSelectedAgent}
            onDeviceChange={(deviceId) => {
              const device = devices.find((item) => item.id === deviceId);
              setSelectedDeviceId(deviceId);
              setSelectedWorkspaceId(device?.workspaces[0]?.id || "");
              if (device && !workspacePath.trim()) setWorkspacePath(defaultWorkspacePath(device));
              setSelectedAgent(device?.agents?.[0]?.name || device?.agent || "claude");
            }}
            onModelChange={setTaskModel}
            onNewSession={() => setNewSessionOpen(true)}
            onPromptChange={setPrompt}
            onRaw={setRawEvent}
            onActivateFile={setActiveFilePath}
            onCloseFile={(path) => {
              setOpenFiles((current) => {
                const remaining = current.filter((file) => file.path !== path);
                setActiveFilePath((active) => active === path ? remaining[remaining.length - 1]?.path || "" : active);
                return remaining;
              });
            }}
            onRefreshFiles={() => sendWorkspaceList(".")}
            onRunTerminalCommand={sendTerminalRun}
            onStopTask={stopTask}
            onFileChange={(path, content) => {
              setOpenFiles((current) => current.map((file) => file.path === path ? { ...file, content, status: file.status === "已保存" ? "" : file.status } : file));
            }}
            onFileOpen={(entry) => {
              if (entry.is_dir) {
                setExpandedPaths((current) => new Set(current).add(entry.path));
                sendWorkspaceList(entry.path);
              } else {
                sendWorkspaceRead(entry.path);
              }
            }}
            onFileSave={sendWorkspaceWrite}
            onToggleExplorer={() => setExplorerVisible((value) => !value)}
            onToggleTerminal={() => setTerminalVisible((value) => !value)}
            onWorkspacePathChange={setWorkspacePath}
            onToggleToolResult={(id) => {
              setExpandedToolResults((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
          />
        )}
      </main>

      {view === "task" ? (
        <StatusBar
          agentLabel={agentLabel}
          conn={conn}
          deviceName={selectedDevice?.name || selectedDevice?.id || ""}
          eventCount={events.length}
          status={status}
          workspacePath={effectiveWorkspacePath}
        />
      ) : null}

      {inspectorOpen && (
        <div className="fixed inset-0 z-40 bg-background/80" onClick={() => setInspectorOpen(false)}>
          <aside className="inspector-panel absolute right-0 top-0 grid h-full w-[420px] max-w-[92vw] grid-rows-[auto_auto_minmax(0,1fr)] border-l shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b p-4">
              <h2 className="font-semibold">当前任务</h2>
              <Button variant="ghost" size="icon" onClick={() => setInspectorOpen(false)}><X /></Button>
            </div>
            <div className="flex flex-col gap-3 border-b p-4">
              <Metric label="状态" value={status} />
              <Metric label="Agent" value={agentLabel} />
              <Metric label="设备" value={selectedDevice?.name || "-"} />
              <Metric label="目录" value={effectiveWorkspacePath || "-"} />
              <Metric label="acpx 状态" value={formatACPXStatus(acpxSessionStatus)} />
              <Metric label="TTL" value={formatACPXTtl(acpxSessionStatus)} />
              <Metric label="事件" value={String(events.length)} />
              <Metric label="上下文" value={formatContextUsage(sessionUsage)} />
              <Metric label="费用" value={formatUsageCost(sessionUsage)} />
              <Metric label="本轮 Token" value={formatTurnUsage(sessionUsage)} />
              <Button className="w-full" variant="destructive" disabled={!currentTaskId} onClick={stopTask}><Square />停止任务</Button>
            </div>
            <div className="min-h-0 overflow-auto p-4">
              <h2 className="mb-2 text-xs font-medium uppercase text-muted-foreground">执行流</h2>
              {events.slice().reverse().map((event, index) => (
                <button
                  key={`${event.event_id || index}`}
                  className={cn("execution-event flex w-full items-center justify-between gap-2 border-b py-2 text-left text-xs text-muted-foreground hover:text-foreground", !isVisibleEvent(event) && "execution-event-muted")}
                  title="查看原始事件"
                  onClick={() => setRawEvent(event)}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{describeEvent(event).title} {event.sequence ? `#${event.sequence}` : ""}</span>
                    <span className="block text-[11px] text-muted-foreground/80">{formatEventTime(event)}</span>
                  </span>
                  <Badge variant="outline">Raw</Badge>
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}

      {searchOpen && (
        <SearchDialog
          query={searchQuery}
          results={searchResults}
          taskRecords={taskRecords}
          onClose={() => setSearchOpen(false)}
          onOpenTask={(taskId) => {
            setSearchOpen(false);
            openTask(taskId);
          }}
          onQueryChange={setSearchQuery}
        />
      )}

      <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
        <NewSessionDialog
          devices={devices}
          selectedDeviceId={selectedDeviceId}
          workspacePath={workspacePath}
          selectedAgent={activeAgent}
          onDeviceChange={(deviceId) => {
            const device = devices.find((item) => item.id === deviceId);
            setSelectedDeviceId(deviceId);
            setSelectedWorkspaceId(device?.workspaces[0]?.id || "");
            setWorkspacePath(defaultWorkspacePath(device));
            setSelectedAgent(device?.agents?.[0]?.name || device?.agent || "claude");
          }}
          onWorkspacePathChange={setWorkspacePath}
          onAgentChange={setSelectedAgent}
          onCreate={startNewSession}
        />
      </Dialog>
      {rawEvent && <RawDialog event={rawEvent} onClose={() => setRawEvent(null)} />}
    </div>
  );
}


createRoot(document.getElementById("root")!).render(<App />);
