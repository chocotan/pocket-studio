import React, { useState, useEffect, useRef } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import Editor from "@monaco-editor/react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  Folder,
  FileText,
  FileCode,
  Sparkles,
  Bot,
  Terminal as TerminalIcon,
  X,
  Plus,
  Send,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  Home,
  MessageSquare,
  Cpu,
  Code2
} from "lucide-react";
import type { Device, FileEntry, OpenFile } from "@/lib/types";
import { postJSON } from "@/lib/api";
import type { Project } from "./studio-dashboard";

interface StudioWorkspaceProps {
  projectId: string;
  project: Project;
  devices: Device[];
  fileTree: FileEntry[];
  openFiles: OpenFile[];
  activeFilePath: string;
  onOpenFile: (path: string) => void;
  onCloseFile: (path: string) => void;
  onSaveFile: (path: string, content: string) => void;
  onSetActiveFile: (path: string) => void;
  onCreateAgentSession: (agentType: string, prompt: string) => void;
  activeTaskId: string;
  tasks: string[];
  taskRecords: any;
  onBackToDashboard: () => void;
}

export function StudioWorkspace({
  projectId,
  project,
  devices,
  fileTree,
  openFiles,
  activeFilePath,
  onOpenFile,
  onCloseFile,
  onSaveFile,
  onSetActiveFile,
  onCreateAgentSession,
  activeTaskId,
  tasks,
  taskRecords,
  onBackToDashboard
}: StudioWorkspaceProps) {
  // Tabs management
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [newAgentType, setNewAgentType] = useState("Gemini");
  const [newAgentPrompt, setNewAgentPrompt] = useState("");

  // Track expanded paths in sidebar
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set([".", "internal"]));

  // Set initial tabs based on open files and tasks
  useEffect(() => {
    const tabs: string[] = [];
    openFiles.forEach(f => {
      tabs.push(`file-${f.path}`);
    });
    // Include active project tasks as agent tabs
    const projTasks = tasks.filter(id => {
      const r = taskRecords.get(id);
      return r && r.device_id === project.device_id && r.workspace_path === project.workspace_path;
    });
    projTasks.forEach(tId => {
      tabs.push(`agent-${tId}`);
    });

    setOpenTabs(tabs);

    if (activeFilePath) {
      setActiveTabId(`file-${activeFilePath}`);
    } else if (activeTaskId) {
      setActiveTabId(`agent-${activeTaskId}`);
    } else if (tabs.length > 0) {
      setActiveTabId(tabs[0]);
    }
  }, [openFiles, activeFilePath, activeTaskId, tasks, project]);

  // Synchronize state back to parent
  useEffect(() => {
    // Save UI state to server
    const stateObj = {
      openFiles,
      activeFilePath: activeTabId.startsWith("file-") ? activeTabId.replace("file-", "") : "",
      expandedPaths: Array.from(expandedPaths),
      activeTaskId: activeTabId.startsWith("agent-") ? activeTabId.replace("agent-", "") : "",
      openTabs
    };
    postJSON("/api/project/state", {
      project_id: projectId,
      state: stateObj
    }).catch(err => console.error("failed to save project state:", err));
  }, [openTabs, activeTabId, expandedPaths, openFiles, projectId]);

  function switchTab(tabId: string) {
    setActiveTabId(tabId);
    if (tabId.startsWith("file-")) {
      const path = tabId.replace("file-", "");
      onSetActiveFile(path);
    }
  }

  function handleCloseTab(tabId: string, e: React.MouseEvent) {
    e.stopPropagation();
    const nextTabs = openTabs.filter(id => id !== tabId);
    setOpenTabs(nextTabs);

    if (tabId.startsWith("file-")) {
      const path = tabId.replace("file-", "");
      onCloseFile(path);
    }

    if (activeTabId === tabId) {
      if (nextTabs.length > 0) {
        switchTab(nextTabs[nextTabs.length - 1]);
      } else {
        setActiveTabId("");
      }
    }
  }

  function handleCreateAgentSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newAgentPrompt.trim()) return;
    onCreateAgentSession(newAgentType, newAgentPrompt.trim());
    setNewAgentPrompt("");
    setCreateAgentOpen(false);
  }

  // --- RECURSIVE FILE TREE COMPONENT ---
  function toggleExpand(path: string) {
    setExpandedPaths(current => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderFileTreeNodes(entries: FileEntry[], parentPath = ".") {
    // Sort directories first
    const sorted = [...entries].sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name);
    });

    return sorted.map((entry) => {
      const isDir = entry.is_dir;
      const isExpanded = expandedPaths.has(entry.path);
      const isFileOpened = openFiles.some(f => f.path === entry.path);
      const isFileActive = activeTabId === `file-${entry.path}`;

      if (isDir) {
        return (
          <div key={entry.path} className="space-y-1">
            <div
              onClick={() => toggleExpand(entry.path)}
              className="flex items-center space-x-1.5 p-1 rounded hover:bg-slate-100 text-slate-600 cursor-pointer select-none text-xs transition"
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              )}
              <Folder className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
              <span className="truncate">{entry.name}</span>
            </div>
            {isExpanded && entry.children && (
              <div className="pl-4 border-l border-slate-200/80 ml-2.5 space-y-1">
                {renderFileTreeNodes(entry.children, entry.path)}
              </div>
            )}
          </div>
        );
      } else {
        const isGo = entry.name.endsWith(".go");
        return (
          <div
            key={entry.path}
            onClick={() => onOpenFile(entry.path)}
            className={`flex items-center space-x-1.5 p-1 rounded hover:bg-slate-100 cursor-pointer text-xs transition ${
              isFileActive ? "text-indigo-600 bg-indigo-50/60 font-semibold" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {isGo ? (
              <FileCode className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
            ) : (
              <FileText className="h-3.5 w-3.5 text-slate-400 shrink-0" />
            )}
            <span className="truncate">{entry.name}</span>
          </div>
        );
      }
    });
  }

  // Count active project agent sessions
  const activeAgentCount = openTabs.filter(id => id.startsWith("agent-")).length;

  return (
    <div className="grow flex overflow-hidden bg-slate-50 text-slate-800">
      <Group className="h-full w-full" orientation="horizontal">
        {/* Sidebar Panel (Left) */}
        <Panel defaultSize={20} minSize={15} maxSize={30}>
          <aside className="h-full border-r border-slate-200 bg-white flex flex-col overflow-hidden select-none">
            {/* Sidebar Header */}
            <div className="h-10 border-b border-slate-100 flex items-center px-4 justify-between bg-slate-50 shrink-0">
              <span className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">项目文件管理器</span>
              <FolderOpen className="h-3.5 w-3.5 text-indigo-500" />
            </div>

            {/* Scrollable File Explorer */}
            <div className="grow overflow-y-auto p-3 space-y-1">
              <div className="flex items-center space-x-1.5 p-1 rounded hover:bg-slate-100 text-slate-700 cursor-pointer font-bold text-xs select-none mb-2">
                <FolderOpen className="h-3.5 w-3.5 text-indigo-500" />
                <span className="truncate">{project.name}</span>
              </div>
              <div className="pl-2 space-y-1">
                {renderFileTreeNodes(fileTree)}
              </div>
            </div>

            {/* Sidebar Info Footer */}
            <div className="border-t border-slate-200 bg-slate-50 p-4 flex flex-col space-y-2 shrink-0">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">当前活跃映射</span>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between text-slate-500">
                  <span className="flex items-center space-x-1.5">
                    <Bot className="h-3.5 w-3.5 text-indigo-500" />
                    <span>Agent 会话</span>
                  </span>
                  <span className="font-mono text-slate-700 font-semibold">{activeAgentCount}</span>
                </div>
                <div className="flex items-center justify-between text-slate-500">
                  <span className="flex items-center space-x-1.5">
                    <TerminalIcon className="h-3.5 w-3.5 text-indigo-400" />
                    <span>Tmux 终端</span>
                  </span>
                  <span className="font-mono text-slate-700 font-semibold">1</span>
                </div>
              </div>
            </div>
          </aside>
        </Panel>

        <Separator className="w-1 bg-slate-200 hover:bg-indigo-500 cursor-col-resize transition-colors" />

        {/* Main Code & Terminal Area (Right) */}
        <Panel defaultSize={80}>
          <Group className="h-full w-full" orientation="vertical">
            {/* Top pane: Tabbed Main Content Area */}
            <Panel defaultSize={65} minSize={40}>
              <div className="h-full flex flex-col overflow-hidden bg-white">
                {/* Tab bar */}
                <div className="h-10 border-b border-slate-200 bg-slate-50 flex items-center justify-between px-2 overflow-x-auto select-none shrink-0">
                  <div className="flex items-center space-x-1 overflow-x-auto pr-8">
                    {openTabs.map((tabId) => {
                      const isActive = activeTabId === tabId;
                      let name = "";
                      let isFile = false;
                      let isGo = false;

                      if (tabId.startsWith("file-")) {
                        isFile = true;
                        const path = tabId.replace("file-", "");
                        name = path.substring(path.lastIndexOf("/") + 1) || path;
                        isGo = name.endsWith(".go");
                      } else if (tabId.startsWith("agent-")) {
                        const tId = tabId.replace("agent-", "");
                        const r = taskRecords.get(tId);
                        name = r?.session_name || `Agent: ${r?.agent || "AI"}`;
                      }

                      return (
                        <div
                          key={tabId}
                          onClick={() => switchTab(tabId)}
                          className={`h-8 px-3 rounded-t-lg border-t-2 flex items-center space-x-2 cursor-pointer transition select-none text-xs shrink-0 ${
                            isActive
                              ? "bg-white border-indigo-600 text-slate-800 font-semibold shadow-sm"
                              : "bg-slate-100 border-transparent text-slate-500 hover:bg-slate-200/60 hover:text-slate-700"
                          }`}
                        >
                          {isFile ? (
                            isGo ? (
                              <FileCode className="h-3.5 w-3.5 text-indigo-500" />
                            ) : (
                              <FileText className="h-3.5 w-3.5 text-slate-400" />
                            )
                          ) : (
                            <Sparkles className="h-3.5 w-3.5 text-indigo-500 animate-pulse" />
                          )}
                          <span>{name}</span>
                          <X
                            onClick={(e) => handleCloseTab(tabId, e)}
                            className="h-3 w-3 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-200 p-0.5"
                          />
                        </div>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => setCreateAgentOpen(true)}
                    className="flex items-center justify-center h-7 w-7 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition"
                    title="新建 AI Agent 会话"
                  >
                    <Plus className="h-4.5 w-4.5" />
                  </button>
                </div>

                {/* Tab content viewport */}
                <div className="grow relative overflow-hidden bg-slate-50/50">
                  {activeTabId === "" ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 select-none">
                      <Bot className="h-12 w-12 mb-3 text-slate-300" />
                      <span className="text-xs">没有打开的文件或 Agent 会话</span>
                      <button
                        onClick={() => setCreateAgentOpen(true)}
                        className="mt-4 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition shadow"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>拉起 AI Agent 对话</span>
                      </button>
                    </div>
                  ) : activeTabId.startsWith("file-") ? (
                    (() => {
                      const path = activeTabId.replace("file-", "");
                      const openFileObj = openFiles.find((f) => f.path === path);
                      return openFileObj ? (
                        <div className="absolute inset-0 flex flex-col bg-white">
                          <div className="grow relative">
                            <Editor
                              height="100%"
                              defaultLanguage={path.endsWith(".go") ? "go" : "markdown"}
                              value={openFileObj.content}
                              theme="vs" // Premium Light Theme
                              options={{
                                fontSize: 13,
                                fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
                                minimap: { enabled: true },
                                lineNumbers: "on",
                                automaticLayout: true,
                              }}
                              onChange={(val) => onSaveFile(path, val || "")}
                            />
                          </div>
                          <div className="h-6 border-t border-slate-100 bg-slate-50 flex items-center justify-between px-4 text-[10px] text-slate-400 select-none shrink-0 font-mono">
                            <span>编辑中: {path}</span>
                            <span>{openFileObj.status || "已同步"}</span>
                          </div>
                        </div>
                      ) : null;
                    })()
                  ) : activeTabId.startsWith("agent-") ? (
                    (() => {
                      const tId = activeTabId.replace("agent-", "");
                      const r = taskRecords.get(tId);
                      // Ingest events
                      const rEvents = r?.events || [];
                      return (
                        <div className="absolute inset-0 flex flex-col bg-slate-50/30">
                          <div className="grow overflow-y-auto p-6 space-y-4" id={`chat-${tId}`}>
                            {rEvents.length === 0 ? (
                              <div className="text-center text-slate-400 py-10 text-xs select-none">
                                已拉起协作者，请输入指令开始工作。
                              </div>
                            ) : (
                              rEvents.map((evt: any, index: number) => {
                                const isUser = evt.source === "user";
                                // simple parse content
                                let textContent = "";
                                try {
                                  const payload = JSON.parse(evt.data);
                                  textContent = payload.prompt || payload.text || evt.event_type;
                                } catch (e) {
                                  textContent = evt.event_type || String(evt.data);
                                }

                                return (
                                  <div key={index} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                                    <div className={`max-w-[85%] flex items-start space-x-2.5 ${isUser ? "flex-row-reverse space-x-reverse" : ""}`}>
                                      <div className={`h-8 w-8 rounded-lg shrink-0 flex items-center justify-center text-xs font-bold border ${
                                        isUser
                                          ? "bg-indigo-50 border-indigo-100 text-indigo-600"
                                          : "bg-emerald-50 border-emerald-100 text-emerald-600"
                                      }`}>
                                        {isUser ? "ME" : "AI"}
                                      </div>
                                      <div className={`rounded-xl px-4 py-2.5 text-xs leading-relaxed ${
                                        isUser
                                          ? "bg-indigo-600 text-white rounded-tr-none shadow-sm"
                                          : "bg-white text-slate-700 border border-slate-200/80 rounded-tl-none shadow-sm"
                                      }`}>
                                        {!isUser && (
                                          <div className="text-[9px] uppercase tracking-wider font-bold text-emerald-500 mb-1 flex items-center space-x-1">
                                            <ShieldCheck className="h-3 w-3" />
                                            <span>已通过 Agent 鉴权</span>
                                          </div>
                                        )}
                                        <div className="whitespace-pre-wrap">{textContent}</div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>

                          <div className="p-3 border-t border-slate-200 bg-white shrink-0">
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                const input = document.getElementById(`input-${tId}`) as HTMLInputElement;
                                if (!input || !input.value.trim()) return;
                                // Simulating chat submission
                                onCreateAgentSession(r.agent, input.value.trim());
                                input.value = "";
                              }}
                              className="relative flex items-center"
                            >
                              <input
                                type="text"
                                id={`input-${tId}`}
                                autoComplete="off"
                                className="w-full bg-slate-50 border border-slate-200 hover:border-slate-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 rounded-xl pl-3 pr-10 py-2.5 text-xs text-slate-800 focus:outline-none transition"
                                placeholder="输入指令并发送给 AI 协作者..."
                              />
                              <button
                                type="submit"
                                className="absolute right-1.5 h-7 w-7 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center transition shadow-sm"
                              >
                                <Send className="h-3.5 w-3.5" />
                              </button>
                            </form>
                          </div>
                        </div>
                      );
                    })()
                  ) : null}
                </div>
              </div>
            </Panel>

            <Separator className="h-1 bg-slate-200 hover:bg-indigo-500 cursor-row-resize transition-colors" />

            {/* Bottom Pane: Real Tmux Terminal xterm.js */}
            <Panel defaultSize={35} minSize={20}>
              <div className="h-full flex flex-col bg-slate-950 overflow-hidden relative">
                {/* Tmux tabs bar */}
                <div className="h-9 border-b border-slate-900 bg-slate-950 flex items-center justify-between px-3 select-none shrink-0 text-xs">
                  <div className="flex items-center space-x-1.5">
                    <div className="px-2 py-0.5 rounded bg-indigo-600 text-white font-mono font-bold">
                      [tmux 0:bash]*
                    </div>
                  </div>
                  <div className="flex items-center space-x-2 text-[10px] text-slate-500 font-mono">
                    <span>ACTIVE TMUX STREAM</span>
                    <button
                      onClick={onBackToDashboard}
                      className="h-6 px-2.5 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900 text-slate-400 hover:text-white transition flex items-center space-x-1"
                      title="返回大厅"
                    >
                      <Home className="h-3 w-3" />
                      <span>大厅</span>
                    </button>
                  </div>
                </div>

                {/* Canvas container */}
                <div className="grow p-3 relative overflow-hidden" style={{ minHeight: "80px" }}>
                  <div ref={useTerminal(projectId)} className="absolute inset-2" />
                </div>
              </div>
            </Panel>
          </Group>
        </Panel>
      </Group>

      {/* New Agent Modal Dialog */}
      {createAgentOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-slate-200/80 animate-in fade-in-50 zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
              <h3 className="font-bold text-slate-800 flex items-center space-x-2">
                <Sparkles className="h-4.5 w-4.5 text-indigo-500" />
                <span>选择协作者并拉起会话</span>
              </h3>
              <button
                onClick={() => setCreateAgentOpen(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1 hover:bg-slate-100 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateAgentSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">选择 Agent 类型</label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: "Gemini", name: "Gemini", icon: Sparkles, color: "text-amber-500", desc: "谷歌多模态/超长上下文" },
                    { id: "Codex", name: "Codex", icon: Code2, color: "text-indigo-500", desc: "代码生成与重构调试" },
                    { id: "ClaudeCode", name: "ClaudeCode", icon: TerminalIcon, color: "text-orange-500", desc: "Sonnet 高性能终端级开发" },
                    { id: "OpenCode", name: "OpenCode", icon: Cpu, color: "text-emerald-500", desc: "DeepSeek/Qwen 开放生态" },
                    { id: "Pi", name: "Pi", icon: MessageSquare, color: "text-pink-500", desc: "头脑风暴与高情商协同", full: true }
                  ].map((agent) => {
                    const isSelected = newAgentType === agent.id;
                    const Icon = agent.icon;
                    return (
                      <label
                        key={agent.id}
                        onClick={() => setNewAgentType(agent.id)}
                        className={`relative flex flex-col p-3 rounded-xl border cursor-pointer select-none transition ${
                          isSelected
                            ? "border-indigo-600 bg-indigo-50/40"
                            : "border-slate-200 hover:border-slate-350 bg-white"
                        } ${agent.full ? "col-span-2" : ""}`}
                      >
                        <input
                          type="radio"
                          name="new-agent-type"
                          value={agent.id}
                          checked={isSelected}
                          onChange={() => {}}
                          className="absolute top-2.5 right-2.5 accent-indigo-600"
                        />
                        <span className="text-xs font-bold text-slate-800 flex items-center space-x-1">
                          <Icon className={`h-3.5 w-3.5 ${agent.color}`} />
                          <span>{agent.name}</span>
                        </span>
                        <span className="text-[9px] text-slate-400 mt-1">{agent.desc}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">首发提示词 (Prompt)</label>
                <textarea
                  required
                  value={newAgentPrompt}
                  onChange={(e) => setNewAgentPrompt(e.target.value)}
                  rows={3}
                  className="w-full bg-slate-50 border border-slate-200 hover:border-slate-300 focus:border-indigo-500 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 transition"
                  placeholder="例如：我想让你重构 main.go 以支持多通道管理。"
                />
              </div>

              <div className="pt-2 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setCreateAgentOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-xs font-semibold text-white shadow"
                >
                  拉起会话
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// --- CUSTOM CUSTOM HOOK FOR TMUX INTERACTIVE TERMINAL STREAM ---
function useTerminal(projectId: string) {
  const terminalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerminal({
      cursorBlink: true,
      fontSize: 11,
      fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#0f172a", // Hybrid slate dark console background
        foreground: "#cbd5e1",
        cursor: "#94a3b8",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    try {
      fitAddon.fit();
    } catch (e) {
      console.warn("fit terminal fail initial:", e);
    }

    // Connect real-time tmux WebSocket stream
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/terminal?project_id=${projectId}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buf) => {
          term.write(new Uint8Array(buf));
        });
      } else {
        term.write(event.data);
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize((size) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: size.cols,
            rows: size.rows,
          })
        );
      }
    });

    // Handle container resize observer
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch (e) {
        // ignore fits
      }
    });

    if (terminalRef.current.parentElement) {
      resizeObserver.observe(terminalRef.current.parentElement);
    }

    return () => {
      ws.close();
      term.dispose();
      resizeObserver.disconnect();
    };
  }, [projectId]);

  return terminalRef;
}
