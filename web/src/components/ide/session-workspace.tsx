import React, { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerminal } from "@xterm/xterm";
import ReactMarkdown from "react-markdown";
import { Tree, type NodeApi } from "react-arborist";
import { Group, Panel, Separator } from "react-resizable-panels";
import remarkGfm from "remark-gfm";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  MessageSquare,
  LoaderCircle,
  PanelBottom,
  PanelLeft,
  RefreshCw,
  Save,
  Search,
  Send,
  Square,
  Terminal as TerminalIcon,
  X
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  displayTitle,
  formatEventTime,
  messageTone,
  toolInput,
  toolName,
  toolOutputForEvent,
  toolStatusLabel,
  toolTitle,
  toolUseSummary,
  type AgentModel,
  type TaskEvent,
  type TimedTimelineItem,
  type TimelineItem
} from "@/lib/agent-events";
import type { AgentCapability, Device, FileEntry, OpenFile, TaskRecord } from "@/lib/types";
import { agentDisplayName, defaultWorkspacePath, languageForPath, workspaceNameFromPath } from "@/lib/session-utils";
import { cn } from "@/lib/utils";

type FixedTabID = "explorer" | "chat" | "terminal";
type FileTabID = `file:${string}`;
type TabID = FixedTabID | FileTabID;
type TabGroupID = "left" | "main" | "bottom";

type TabState = Record<string, TabGroupID>;
type ActiveTabs = Record<TabGroupID, TabID | "">;
type CollapsedTabs = Record<TabGroupID, boolean>;

const DEFAULT_TAB_STATE: TabState = {
  explorer: "left",
  chat: "main",
  terminal: "bottom"
};

const DEFAULT_ACTIVE_TABS: ActiveTabs = {
  left: "explorer",
  main: "chat",
  bottom: "terminal"
};

export function SessionWorkspace({
  activeAgent,
  agentLabel,
  availableAgents,
  currentModelID,
  devices,
  effectiveWorkspacePath,
  eventsRef,
  explorerVisible,
  expandedToolResults,
  fileStatus,
  fileTree,
  expandedPaths,
  openFiles,
  activeFilePath,
  prompt,
  selectedDevice,
  selectedDeviceId,
  sessionModels,
  terminalLines,
  terminalRunning,
  terminalVisible,
  timelineItems,
  waitingForAgent,
  onDispatch,
  onAgentChange,
  onDeviceChange,
  onModelChange,
  onScroll,
  onPromptChange,
  onRaw,
  onActivateFile,
  onCloseFile,
  onRefreshFiles,
  onRunTerminalCommand,
  onStopTask,
  onFileChange,
  onFileOpen,
  onFileSave,
  onToggleExplorer,
  onToggleTerminal,
  onWorkspacePathChange,
  onToggleToolResult
}: {
  activeAgent: string;
  agentLabel: string;
  availableAgents: AgentCapability[];
  currentRecord: TaskRecord | undefined;
  currentModelID: string;
  devices: Device[];
  effectiveWorkspacePath: string;
  eventsRef: React.RefObject<HTMLDivElement | null>;
  explorerVisible: boolean;
  expandedToolResults: Set<string>;
  fileStatus: string;
  fileTree: FileEntry[];
  expandedPaths?: Set<string>;
  openFiles: OpenFile[];
  activeFilePath: string;
  prompt: string;
  selectedDevice: Device | undefined;
  selectedDeviceId: string;
  sessionModels: AgentModel[];
  terminalLines: string[];
  terminalRunning: boolean;
  terminalVisible: boolean;
  timelineItems: TimedTimelineItem[];
  waitingForAgent: boolean;
  onDispatch: () => void;
  onAgentChange: (agent: string) => void;
  onDeviceChange: (deviceId: string) => void;
  onModelChange: (modelID: string) => void;
  onNewSession: () => void;
  onScroll: () => void;
  onPromptChange: (value: string) => void;
  onRaw: (event: TaskEvent) => void;
  onActivateFile: (path: string) => void;
  onCloseFile: (path: string) => void;
  onRefreshFiles: () => void;
  onRunTerminalCommand: (command: string) => void;
  onStopTask: () => void;
  onFileChange: (path: string, content: string) => void;
  onFileOpen: (entry: FileEntry) => void;
  onFileSave: () => void;
  onToggleExplorer: () => void;
  onToggleTerminal: () => void;
  onWorkspacePathChange: (value: string) => void;
  onToggleToolResult: (id: string) => void;
}) {
  const canSend = Boolean(prompt.trim() && selectedDevice && effectiveWorkspacePath);
  const emptySession = timelineItems.length === 0 && !waitingForAgent;
  const [tabState, setTabState] = useState<TabState>(DEFAULT_TAB_STATE);
  const [activeTabs, setActiveTabs] = useState<ActiveTabs>(DEFAULT_ACTIVE_TABS);
  const [collapsedTabs, setCollapsedTabs] = useState<CollapsedTabs>({ left: false, main: false, bottom: false });
  const fileTabs = openFiles.map((file) => fileTabID(file.path));
  const visibleTabIds = ["explorer", "chat", ...fileTabs, "terminal"] as TabID[];
  const tabsByGroup = (group: TabGroupID) => visibleTabIds.filter((id) => tabState[id] === group);
  const leftTabs = tabsByGroup("left");
  const mainTabs = tabsByGroup("main");
  const bottomTabs = tabsByGroup("bottom");
  const activeLeftTab = collapsedTabs.left ? "" : normalizeActiveTab("left", leftTabs, activeTabs.left);
  const activeMainTab = collapsedTabs.main ? "" : normalizeActiveTab("main", mainTabs, activeTabs.main);
  const activeBottomTab = terminalVisible && !collapsedTabs.bottom ? normalizeActiveTab("bottom", bottomTabs, activeTabs.bottom) : "";

  useEffect(() => {
    if (!activeFilePath) return;
    const tab = fileTabID(activeFilePath);
    setTabState((current) => {
      const group = current[tab] || "main";
      setActiveTabs((active) => ({ ...active, [group]: tab }));
      setCollapsedTabs((collapsed) => ({ ...collapsed, [group]: false }));
      return current[tab] ? current : { ...current, [tab]: "main" };
    });
  }, [activeFilePath]);

  function activateTab(group: TabGroupID, tab: TabID) {
    if (isFileTab(tab)) onActivateFile(pathFromFileTab(tab));
    if (group === "bottom" && !terminalVisible) {
      onToggleTerminal();
      setCollapsedTabs((current) => ({ ...current, bottom: false }));
      setActiveTabs((current) => ({ ...current, bottom: tab }));
      return;
    }
    if (group === "bottom" && terminalVisible && activeTabs.bottom === tab && !collapsedTabs.bottom) {
      onToggleTerminal();
    }
    setCollapsedTabs((current) => ({ ...current, [group]: activeTabs[group] === tab && !current[group] }));
    setActiveTabs((current) => ({ ...current, [group]: current[group] === tab ? "" : tab }));
  }

  function moveTab(tab: TabID, target: TabGroupID) {
    setTabState((current) => ({ ...current, [tab]: target }));
    setActiveTabs((current) => ({ ...current, [target]: tab }));
    setCollapsedTabs((current) => ({ ...current, [target]: false }));
    if (isFileTab(tab)) onActivateFile(pathFromFileTab(tab));
  }

  const renderTab = (tab: TabID) => {
    if (tab === "explorer") {
      return (
        <WorkspacePanel
          fileTree={fileTree}
          expandedPaths={expandedPaths}
          workspacePath={effectiveWorkspacePath}
          onOpen={onFileOpen}
          onRefresh={onRefreshFiles}
        />
      );
    }
    if (isFileTab(tab)) {
      const path = pathFromFileTab(tab);
      const file = openFiles.find((item) => item.path === path);
      if (!file) return <TabGroupEmpty label="文件未打开" />;
      return (
        <EditorPane content={file.content} path={file.path} onChange={(content) => onFileChange(file.path, content)} />
      );
    }
    if (tab === "terminal") {
      return <TerminalPane lines={terminalLines} running={terminalRunning} onRun={onRunTerminalCommand} />;
    }
    return (
      <ChatPane
        agentLabel={agentLabel}
        currentModelID={currentModelID}
        eventsRef={eventsRef}
        expandedToolResults={expandedToolResults}
        prompt={prompt}
        sessionModels={sessionModels}
        timelineItems={timelineItems}
        waitingForAgent={waitingForAgent}
        canSend={canSend}
        onDispatch={onDispatch}
        onModelChange={onModelChange}
        onPromptChange={onPromptChange}
        onRaw={onRaw}
        onScroll={onScroll}
        onStopTask={onStopTask}
        onToggleToolResult={onToggleToolResult}
      />
    );
  };

  return (
    <section className="ide-workbench min-h-0">
      {emptySession ? (
        <div className="session-canvas min-h-0 overflow-auto px-6 py-5 max-sm:px-4">
          <StartSessionPanel
            activeAgent={activeAgent}
            agentLabel={agentLabel}
            availableAgents={availableAgents}
            canSend={canSend}
            currentModelID={currentModelID}
            devices={devices}
            effectiveWorkspacePath={effectiveWorkspacePath}
            isLoading={waitingForAgent}
            models={sessionModels}
            prompt={prompt}
            selectedDevice={selectedDevice}
            selectedDeviceId={selectedDeviceId}
            onAgentChange={onAgentChange}
            onDeviceChange={onDeviceChange}
            onDispatch={onDispatch}
            onModelChange={onModelChange}
            onPromptChange={onPromptChange}
            onWorkspacePathChange={onWorkspacePathChange}
          />
        </div>
      ) : (
        <Group className="h-full w-full" orientation="horizontal" resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}>
          {leftTabs.length > 0 ? (
            <>
              <Panel defaultSize="18%" minSize="12%" maxSize="34%">
                <TabGroup group="left" tabs={leftTabs} activeTab={activeLeftTab} files={openFiles} onActivate={activateTab} onCloseFile={onCloseFile} onDropTab={moveTab} onSaveFile={onFileSave}>
                  {activeLeftTab ? renderTab(activeLeftTab) : <TabGroupEmpty label="左侧标签组" />}
                </TabGroup>
              </Panel>
              <Separator className="resize-handle" id="left-main-tabs-separator" />
            </>
          ) : null}
          <Panel defaultSize={leftTabs.length > 0 ? "82%" : "100%"} minSize="45%">
            <Group className="h-full w-full" orientation="vertical" resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}>
              <Panel defaultSize={bottomTabs.length > 0 ? "70%" : "100%"} minSize="35%">
                <TabGroup group="main" tabs={mainTabs} activeTab={activeMainTab} files={openFiles} onActivate={activateTab} onCloseFile={onCloseFile} onDropTab={moveTab} onSaveFile={onFileSave}>
                  {activeMainTab ? renderTab(activeMainTab) : <TabGroupEmpty label="主编辑区" />}
                </TabGroup>
              </Panel>
              {bottomTabs.length > 0 && terminalVisible ? (
                <>
                  <Separator className="resize-handle-horizontal" id="main-bottom-tabs-separator" />
                  <Panel defaultSize="30%" minSize="16%" maxSize="55%">
                    <TabGroup group="bottom" tabs={bottomTabs} activeTab={activeBottomTab} files={openFiles} onActivate={activateTab} onCloseFile={onCloseFile} onDropTab={moveTab} onSaveFile={onFileSave}>
                      {activeBottomTab ? renderTab(activeBottomTab) : <TabGroupEmpty label="底部标签组" />}
                    </TabGroup>
                  </Panel>
                </>
              ) : null}
              {bottomTabs.length > 0 && !terminalVisible ? (
                <div className="bottom-tab-dock">
                  <TabStrip group="bottom" tabs={bottomTabs} activeTab="" files={openFiles} onActivate={activateTab} onCloseFile={onCloseFile} onDropTab={moveTab} onSaveFile={onFileSave} />
                </div>
              ) : null}
            </Group>
          </Panel>
        </Group>
      )}
    </section>
  );
}

function normalizeActiveTab(group: TabGroupID, tabs: TabID[], active: TabID | "") {
  if (active && tabs.includes(active)) return active;
  if (group === "main" && tabs.includes("chat")) return "chat";
  return tabs[0] || "";
}

function TabGroup({
  activeTab,
  children,
  files,
  group,
  tabs,
  onActivate,
  onCloseFile,
  onDropTab,
  onSaveFile
}: {
  activeTab: TabID | "";
  children: React.ReactNode;
  files: OpenFile[];
  group: TabGroupID;
  tabs: TabID[];
  onActivate: (group: TabGroupID, tab: TabID) => void;
  onCloseFile: (path: string) => void;
  onDropTab: (tab: TabID, group: TabGroupID) => void;
  onSaveFile: (path?: string) => void;
}) {
  return (
    <section
      className="tab-group"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const tab = event.dataTransfer.getData("application/x-pocketstudio-tab") as TabID;
        if (tab) onDropTab(tab, group);
      }}
    >
      <TabStrip group={group} tabs={tabs} activeTab={activeTab} files={files} onActivate={onActivate} onCloseFile={onCloseFile} onDropTab={onDropTab} onSaveFile={onSaveFile} />
      <div className="tab-content">{children}</div>
    </section>
  );
}

function TabStrip({
  activeTab,
  files,
  group,
  tabs,
  onActivate,
  onCloseFile,
  onDropTab,
  onSaveFile
}: {
  activeTab: TabID | "";
  files: OpenFile[];
  group: TabGroupID;
  tabs: TabID[];
  onActivate: (group: TabGroupID, tab: TabID) => void;
  onCloseFile: (path: string) => void;
  onDropTab: (tab: TabID, group: TabGroupID) => void;
  onSaveFile: (path?: string) => void;
}) {
  return (
    <div
      className="tab-strip"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const tab = event.dataTransfer.getData("application/x-pocketstudio-tab") as TabID;
        if (tab) onDropTab(tab, group);
      }}
    >
      {tabs.map((tab) => (
        <button
          className={cn("workspace-tab", activeTab === tab && "workspace-tab-active")}
          draggable
          key={tab}
          type="button"
          onClick={() => onActivate(group, tab)}
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-pocketstudio-tab", tab);
            event.dataTransfer.effectAllowed = "move";
          }}
        >
          {tabIcon(tab)}
          <span className="truncate">{tabLabel(tab)}</span>
          {isFileTab(tab) ? (
            <span className="workspace-tab-actions">
              {fileDirty(files, pathFromFileTab(tab)) ? <span className="workspace-tab-dirty" aria-label="未保存" /> : null}
              <span
                className="workspace-tab-icon-button"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  onSaveFile(pathFromFileTab(tab));
                }}
                aria-label="保存文件"
              >
                <Save className="size-3" />
              </span>
              <span
                className="workspace-tab-icon-button"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseFile(pathFromFileTab(tab));
                }}
                aria-label="关闭文件"
              >
                <X className="size-3" />
              </span>
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function TabGroupEmpty({ label }: { label: string }) {
  return <div className="tab-group-empty">{label}</div>;
}

function tabLabel(tab: TabID) {
  if (tab === "explorer") return "资源管理器";
  if (tab === "chat") return "对话";
  if (tab === "terminal") return "终端";
  const path = pathFromFileTab(tab);
  return path.split(/[\\/]/).filter(Boolean).pop() || "文件";
}

function tabIcon(tab: TabID) {
  if (tab === "explorer") return <PanelLeft className="size-3.5" />;
  if (tab === "terminal") return <TerminalIcon className="size-3.5" />;
  if (isFileTab(tab)) return <FileCode2 className="size-3.5" />;
  return <MessageSquare className="size-3.5" />;
}

function fileTabID(path: string): FileTabID {
  return `file:${path}`;
}

function isFileTab(tab: TabID): tab is FileTabID {
  return tab.startsWith("file:");
}

function pathFromFileTab(tab: FileTabID) {
  return tab.slice("file:".length);
}

function fileDirty(files: OpenFile[], path: string) {
  const file = files.find((item) => item.path === path);
  return Boolean(file && file.content !== file.savedContent);
}

function StartSessionPanel({
  activeAgent,
  agentLabel,
  availableAgents,
  canSend,
  currentModelID,
  devices,
  effectiveWorkspacePath,
  isLoading,
  models,
  prompt,
  selectedDevice,
  selectedDeviceId,
  onAgentChange,
  onDeviceChange,
  onDispatch,
  onModelChange,
  onPromptChange,
  onWorkspacePathChange
}: {
  activeAgent: string;
  agentLabel: string;
  availableAgents: AgentCapability[];
  canSend: boolean;
  currentModelID: string;
  devices: Device[];
  effectiveWorkspacePath: string;
  isLoading: boolean;
  models: AgentModel[];
  prompt: string;
  selectedDevice: Device | undefined;
  selectedDeviceId: string;
  onAgentChange: (agent: string) => void;
  onDeviceChange: (deviceId: string) => void;
  onDispatch: () => void;
  onModelChange: (modelID: string) => void;
  onPromptChange: (value: string) => void;
  onWorkspacePathChange: (value: string) => void;
}) {
  return (
    <div className="start-session min-h-[calc(100dvh-8rem)]">
      <div className="start-session-inner">
        <h2 className="start-session-title">开启新的开发任务</h2>
        <div className="start-controls">
          <label className="start-control">
            <span className="ml-1 text-muted-foreground">开发环境</span>
            <Select value={selectedDeviceId || "none"} onValueChange={onDeviceChange}>
              <SelectTrigger className="bg-card shadow-sm"><SelectValue placeholder="选择机器" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {devices.length === 0 && <SelectItem value="none" disabled>暂无机器</SelectItem>}
                  {devices.map((item) => <SelectItem key={item.id} value={item.id}>{item.name || item.id}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className="start-control">
            <span className="ml-1 text-muted-foreground">AI 引擎</span>
            <Select value={activeAgent || "none"} onValueChange={onAgentChange}>
              <SelectTrigger className="bg-card shadow-sm"><SelectValue placeholder="选择 Agent" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {availableAgents.length === 0 && <SelectItem value="none" disabled>暂无 Agent</SelectItem>}
                  {availableAgents.map((agent) => <SelectItem key={agent.name} value={agent.name}>{agent.label || agentDisplayName(agent.name)}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className="start-control">
            <span className="ml-1 text-muted-foreground">项目目录</span>
            <Input
              className="bg-card shadow-sm"
              value={effectiveWorkspacePath}
              onChange={(event) => onWorkspacePathChange(event.target.value)}
              placeholder={defaultWorkspacePath(selectedDevice)}
            />
          </label>
        </div>
        <div className="start-composer shadow-sm">
          <Textarea
            className="start-composer-input resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.ctrlKey || event.metaKey || event.shiftKey) return;
              event.preventDefault();
              onDispatch();
            }}
            placeholder={`发消息给 ${agentLabel || "Agent"}，描述你想实现的特性、或者遇到的 Bug...`}
          />
          <div className="start-composer-actions">
            <div className="start-composer-tools">
              <ComposerModelSelect currentModelID={currentModelID} models={models} onChange={onModelChange} />
            </div>
            <Button className="start-send-button transition-colors" disabled={!canSend || isLoading} size="icon" type="button" onClick={onDispatch} aria-label="发送">
              {isLoading ? <LoaderCircle className="animate-spin" /> : <Send />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspacePanel({
  fileTree,
  expandedPaths,
  workspacePath,
  onOpen,
  onRefresh
}: {
  fileTree: FileEntry[];
  expandedPaths?: Set<string>;
  workspacePath: string;
  onOpen: (entry: FileEntry) => void;
  onRefresh: () => void;
}) {
  useEffect(() => {
    if (workspacePath) onRefresh();
  }, [workspacePath]);
  const data = fileTree.length ? fileTree : [{ id: ".", name: workspaceNameFromPath(workspacePath) || "workspace", path: ".", is_dir: true, children: [] }];
  
  // Use a key to force re-render when the expanded paths set is reset entirely (e.g. session switch)
  const treeKey = expandedPaths?.has(".") ? "tree-with-root" : "tree-empty";
  
  return (
    <section className="workspace-panel">
      <aside className="workspace-explorer">
        <div className="workspace-root">
          <span className="truncate" title={workspacePath}>{workspacePath || "未选择目录"}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md hover:bg-muted" onClick={onRefresh}><RefreshCw className="size-3.5" /></Button>
        </div>
        <div className="workspace-tree">
          <Tree<FileEntry>
            key={treeKey}
            data={data}
            idAccessor="id"
            childrenAccessor="children"
            openByDefault={false}
            initialOpenState={expandedPaths ? Array.from(expandedPaths).reduce((acc, path) => ({ ...acc, [path]: true }), {}) : {}}
            rowHeight={28}
            width="100%"
            height={720}
            onActivate={(node) => onOpen(node.data)}
            onToggle={(id: string) => {
               const node = data.find(d => d.id === id) || findNode(data, id);
               // Arborist just gives us the ID toggled, we can assume if we trigger onOpen 
               // and it has no children yet, it will fetch them.
               if (node && node.is_dir) {
                   onOpen(node);
               }
            }}
          >
            {FileNode}
          </Tree>
        </div>
      </aside>
    </section>
  );
}

function findNode(nodes: FileEntry[], id: string): FileEntry | undefined {
    for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
            const found = findNode(node.children, id);
            if (found) return found;
        }
    }
    return undefined;
}

function FileNode({ node, style }: { node: NodeApi<FileEntry>; style: React.CSSProperties }) {
  const Icon = node.data.is_dir ? (node.isOpen ? FolderOpen : Folder) : FileText;
  return (
    <div
      className={cn("file-node", node.isSelected && "file-node-selected")}
      style={{ ...style, paddingLeft: `${node.level * 14 + 8}px` }}
      onClick={() => {
        if (node.data.is_dir) node.toggle();
        node.activate();
      }}
    >
      {node.data.is_dir ? <ChevronRight className={cn("file-chevron", node.isOpen && "file-chevron-open")} /> : <span className="file-chevron-placeholder" />}
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{node.data.name}</span>
    </div>
  );
}

function ChatPane({
  agentLabel,
  currentModelID,
  eventsRef,
  expandedToolResults,
  prompt,
  sessionModels,
  timelineItems,
  waitingForAgent,
  canSend,
  onDispatch,
  onModelChange,
  onPromptChange,
  onRaw,
  onScroll,
  onStopTask,
  onToggleToolResult
}: {
  agentLabel: string;
  currentModelID: string;
  eventsRef: React.RefObject<HTMLDivElement | null>;
  expandedToolResults: Set<string>;
  prompt: string;
  sessionModels: AgentModel[];
  timelineItems: TimedTimelineItem[];
  waitingForAgent: boolean;
  canSend: boolean;
  onDispatch: () => void;
  onModelChange: (modelID: string) => void;
  onPromptChange: (value: string) => void;
  onRaw: (event: TaskEvent) => void;
  onScroll: () => void;
  onStopTask: () => void;
  onToggleToolResult: (id: string) => void;
}) {
  return (
    <section className="chat-pane">
      <div className="session-canvas min-h-0 overflow-auto px-4 py-4" ref={eventsRef} onScroll={onScroll}>
        {timelineItems.map((item, index) => {
          if (item.kind === "tool") {
            return <ToolBlock key={item.uiKey} item={item} resultExpanded={expandedToolResults.has(item.uiKey)} onToggleResult={() => onToggleToolResult(item.uiKey)} onRaw={onRaw} />;
          }
          if (item.kind === "permission") return <PermissionBlock key={item.uiKey} item={item} onRaw={onRaw} />;
          if (item.kind === "commands") return <CommandsBlock key={item.uiKey} item={item} onRaw={onRaw} />;
          if (item.kind === "mode") return <ModeBlock key={item.uiKey} item={item} onRaw={onRaw} />;
          if (item.itemKind === "thinking") return <ThinkingBlock key={`${item.event.event_id || index}`} item={item} onRaw={onRaw} />;
          return <MessageBlock key={`${item.event.event_id || index}`} item={item} agentLabel={agentLabel} onRaw={onRaw} />;
        })}
        {waitingForAgent ? <AgentLoadingBlock agentLabel={agentLabel} /> : null}
      </div>
      <Composer canSend={canSend} currentModelID={currentModelID} isLoading={waitingForAgent} models={sessionModels} prompt={prompt} onDispatch={onDispatch} onModelChange={onModelChange} onPromptChange={onPromptChange} onStopTask={onStopTask} waitingForAgent={waitingForAgent} />
    </section>
  );
}

function EditorPane({
  content,
  path,
  onChange
}: {
  content: string;
  path: string;
  onChange: (content: string) => void;
}) {
  return (
    <section className="editor-pane">
      {path ? (
        <Editor
          height="100%"
          path={path}
          value={content}
          language={languageForPath(path)}
          theme="vs"
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            readOnly: false,
            domReadOnly: false
          }}
          onChange={(value) => onChange(value || "")}
          onMount={(editor) => {
            // Force editor to be editable
            editor.updateOptions({ readOnly: false });
          }}
        />
      ) : (
        <div className="editor-empty">从左侧目录选择文件查看或编辑。</div>
      )}
    </section>
  );
}

function TerminalPane({ lines, running, onRun }: { lines: string[]; running: boolean; onRun: (command: string) => void }) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [command, setCommand] = useState("");

  useEffect(() => {
    if (!terminalRef.current || termRef.current) return;
    const term = new XTerminal({ cursorBlink: true, fontSize: 13, convertEol: true, theme: { background: "#ffffff", foreground: "#1d2129" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    
    // Fit must be called after the terminal is attached to DOM and has dimensions
    // Using a tiny timeout ensures the container layout is settled
    setTimeout(() => {
        try {
            fit.fit();
        } catch (e) {
            console.error("Terminal fit error:", e);
        }
    }, 10);
    
    termRef.current = term;
    fitRef.current = fit;
    
    const onResize = () => {
        try {
            fit.fit();
        } catch (e) {}
    };
    window.addEventListener("resize", onResize);
    
    // Create an observer to resize terminal when its container becomes visible/changes size
    const observer = new ResizeObserver(() => {
       try {
           fit.fit();
       } catch (e) {}
    });
    if (terminalRef.current.parentElement) {
        observer.observe(terminalRef.current.parentElement);
    }
    
    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    for (const line of lines.slice(-200)) {
        if (line && typeof line === 'string') {
            const linesToPrint = line.split('\n');
            linesToPrint.forEach(l => term.writeln(l));
        }
    }
    if (running) term.writeln("运行中...");
  }, [lines, running]);

  return (
    <section className="terminal-pane">
      <div className="terminal-output" ref={terminalRef} />
      <div className="terminal-input-row">
        <span className="text-primary font-bold">❯</span>
        <input
          className="flex-1 bg-transparent border-0 outline-none text-foreground ml-2 focus:ring-0 placeholder:text-muted-foreground/60"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          disabled={running}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (command.trim()) {
               onRun(command);
               setCommand("");
            }
          }}
          placeholder={running ? "命令运行中..." : "在当前工作目录执行命令"}
        />
      </div>
    </section>
  );
}

function Composer({
  canSend,
  currentModelID,
  isLoading,
  models,
  prompt,
  onDispatch,
  onModelChange,
  onPromptChange,
  onStopTask,
  waitingForAgent
}: {
  canSend: boolean;
  currentModelID: string;
  isLoading: boolean;
  models: AgentModel[];
  prompt: string;
  onDispatch: () => void;
  onModelChange: (modelID: string) => void;
  onPromptChange: (value: string) => void;
  onStopTask: () => void;
  waitingForAgent: boolean;
}) {
  return (
    <div className="composer-bar border-t p-4">
      <div className="composer-box mx-auto max-w-5xl rounded-lg border shadow-sm">
        <Textarea
          className="min-h-24 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            event.preventDefault();
            onDispatch();
          }}
          placeholder="描述要让 Agent 完成的开发任务，Enter 发送，Ctrl+Enter 换行"
        />
        <div className="composer-actions flex items-center justify-between gap-3 border-t px-3 py-2">
          <ComposerModelSelect
            currentModelID={currentModelID}
            models={models}
            onChange={onModelChange}
          />
          <div className="flex items-center gap-2">
            <Button className="h-8 px-2 text-xs" variant="outline" size="sm" disabled={!waitingForAgent} onClick={onStopTask}>
              <Square className="size-3.5" />停止
            </Button>
            <Button className="h-8 px-3 text-xs" disabled={!canSend || isLoading} onClick={onDispatch}>
              {isLoading ? <LoaderCircle className="animate-spin" /> : <Send />}
              {isLoading ? "处理中" : "发送"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComposerModelSelect({
  currentModelID,
  models,
  onChange
}: {
  currentModelID: string;
  models: AgentModel[];
  onChange: (modelID: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (models.length === 0) {
    return (
      <div className="min-w-0 truncate text-xs text-muted-foreground">
        模型 {currentModelID || "默认"}
      </div>
    );
  }
  const visibleModels = currentModelID && !models.some((model) => model.modelId === currentModelID)
    ? [{ modelId: currentModelID, name: currentModelID }, ...models]
    : models;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = normalizedQuery
    ? visibleModels.filter((model) => [model.name, model.modelId, model.description].some((value) => String(value || "").toLowerCase().includes(normalizedQuery)))
    : visibleModels;
  return (
    <div className="relative flex min-w-0 items-center gap-2 text-xs text-muted-foreground" ref={rootRef}>
      <span className="shrink-0">模型</span>
      <Button
        className="h-7 w-[220px] max-w-[52vw] justify-start truncate bg-background px-2 text-xs font-normal"
        variant="outline"
        size="sm"
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setQuery("");
        }}
      >
        <span className="truncate">{currentModelID || "选择模型"}</span>
      </Button>
      {open && (
        <div className="model-popover absolute bottom-9 left-8 z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-md border p-2 shadow-lg">
          <div className="model-search flex items-center gap-2 rounded-md border px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              placeholder="搜索模型"
            />
          </div>
          <div className="mt-2 max-h-64 overflow-auto">
            {filteredModels.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">没有匹配的模型</div>
            ) : filteredModels.map((model) => (
              <button
                className={cn("model-option w-full rounded-md px-2 py-1.5 text-left", model.modelId === currentModelID && "model-option-active")}
                key={model.modelId}
                type="button"
                onClick={() => {
                  onChange(model.modelId);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span className="block truncate text-xs font-medium">{model.modelId}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentLoadingBlock({ agentLabel }: { agentLabel: string }) {
  return (
    <div className="agent-loading-row mx-auto mb-3 flex max-w-5xl justify-start">
      <div className="agent-loading inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <LoaderCircle className="size-4 animate-spin" />
        <span>{agentLabel || "Agent"} 正在处理</span>
      </div>
    </div>
  );
}

function MessageBlock({
  item,
  agentLabel,
  onRaw
}: {
  item: Extract<TimelineItem, { kind: "message" }>;
  agentLabel: string;
  onRaw: (event: TaskEvent) => void;
}) {
  const tone = messageTone(item.itemKind);
  const title = displayTitle(item, agentLabel);
  const event = item.event;
  const isUser = tone === "user";
  const isAssistant = tone === "assistant";
  return (
    <div className={cn(
      "message-item group mx-auto mb-3 flex max-w-5xl",
      isUser ? "justify-end" : "justify-start",
      isAssistant && "message-item-assistant",
      tone === "error" && "message-item-error"
    )}>
      <div className={cn(
        "message-bubble min-w-0",
        tone === "assistant" && "message-assistant",
        tone === "user" && "message-user",
        tone === "error" && "message-error"
      )}>
        <div className="min-w-0">
          <div className="message-meta-row flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {!isUser && <span className="text-xs font-medium text-muted-foreground">{title}</span>}
              <span className="message-time truncate text-xs text-muted-foreground">{formatEventTime(event)}</span>
            </div>
            <Button className="message-raw h-6 shrink-0 px-2 opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(event)}>Raw</Button>
          </div>
          {tone === "assistant"
            ? <MarkdownMessage text={item.summary} />
            : <p className="whitespace-pre-wrap break-words text-sm leading-6">{item.summary}</p>}
          {item.meta && item.meta.length > 0 && <MetaRows rows={item.meta} />}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({ item, onRaw }: { item: Extract<TimelineItem, { kind: "message" }>; onRaw: (event: TaskEvent) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="thinking-summary group mx-auto mb-2 max-w-5xl">
      <div className="thinking-header" onClick={() => setExpanded((value) => !value)}>
        <span className="thinking-icon"><Brain className="size-3.5" /></span>
        <span className="thinking-label">Thinking</span>
        <ChevronRight className={cn("thinking-arrow size-3", expanded && "thinking-arrow-open")} />
        <Button
          className="message-raw ml-1 h-6 px-2 opacity-0 transition-opacity group-hover:opacity-100"
          variant="ghost"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onRaw(item.event);
          }}
        >
          Raw
        </Button>
      </div>
      {expanded && <div className="thinking-body">{item.summary}</div>}
    </div>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-body text-sm leading-6">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function ToolBlock({
  item,
  resultExpanded,
  onToggleResult,
  onRaw
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  resultExpanded: boolean;
  onToggleResult: () => void;
  onRaw: (event: TaskEvent) => void;
}) {
  const toolUse = item.call;
  const name = toolName(toolUse);
  const input = toolInput(toolUse);
  const output = toolOutputForEvent(item.result);
  const hasError = Boolean(output?.isError);
  const summary = toolUseSummary(input, toolUse?.locations);
  const statusLabel = toolStatusLabel(toolUse, Boolean(item.result), hasError);
  const inputJSON = JSON.stringify(input, null, 2);
  const running = !item.result && !hasError;
  return (
    <div className="tool-summary group mx-auto mb-2 max-w-5xl">
      <div className="tool-header">
        <button className="tool-main" type="button" onClick={output ? onToggleResult : undefined}>
          <span className={cn("tool-status-dot", running && "tool-status-running", hasError && "tool-status-error", item.result && !hasError && "tool-status-done")}>
            {running ? <LoaderCircle className="size-3 animate-spin" /> : hasError ? <CircleAlert className="size-3" /> : <CheckCircle2 className="size-3" />}
          </span>
          <span className="tool-title truncate">{toolTitle(name, input, toolUse?.kind)}</span>
          {summary && summary !== "{}" ? <span className="tool-description truncate">{summary}</span> : null}
          <span className="tool-status-label">{statusLabel}</span>
          {output ? <ChevronRight className={cn("tool-arrow size-3", resultExpanded && "tool-arrow-open")} /> : null}
        </button>
        <Button className="message-raw h-6 px-2 opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(item.result || item.event)}>Raw</Button>
      </div>
      {toolUse?.locations?.length ? (
        <div className="tool-locations">
          {toolUse.locations.map((location, index) => location.path ? <code className="tool-location" key={`${location.path}-${index}`}>{location.path}</code> : null)}
        </div>
      ) : null}
      {resultExpanded && output && (
        <div className="tool-detail-panel">
          <div className="tool-detail-section">
            <div className="tool-detail-label">执行工具内容</div>
            <pre className="tool-detail-content">{inputJSON || "-"}</pre>
          </div>
          <div className="tool-detail-section">
            <div className="tool-detail-label">执行工具结果</div>
            <pre className={cn("tool-detail-content", hasError && "tool-detail-content-error")}>{output.summary || "-"}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function PermissionBlock({ item, onRaw }: { item: Extract<TimelineItem, { kind: "permission" }>; onRaw: (event: TaskEvent) => void }) {
  const request = item.request;
  return (
    <div className="system-summary group mx-auto mb-2 max-w-5xl">
      <div className="system-header">
        <span className="system-title">权限请求</span>
        <span className="system-description truncate">{request.title}</span>
        <Badge variant="success">已自动允许</Badge>
        <Button className="h-6 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(item.event)}>Raw</Button>
      </div>
    </div>
  );
}

function CommandsBlock({ item, onRaw }: { item: Extract<TimelineItem, { kind: "commands" }>; onRaw: (event: TaskEvent) => void }) {
  const [expanded, setExpanded] = useState(false);
  const visibleCommands = expanded ? item.commands : item.commands.slice(0, 8);
  const hiddenCount = Math.max(0, item.commands.length - visibleCommands.length);
  return (
    <div className="system-summary group mx-auto mb-2 max-w-5xl">
      <div className="system-header">
        <span className="system-title">可用命令</span>
        <div className="system-chips">
          {visibleCommands.map((command) => <code className="command-chip" key={command.name}>{command.name}</code>)}
        </div>
        {item.commands.length > 8 ? (
          <button className="system-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起" : `展开 ${hiddenCount}`}
          </button>
        ) : null}
        <Button className="h-6 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(item.event)}>Raw</Button>
      </div>
    </div>
  );
}

function ModeBlock({ item, onRaw }: { item: Extract<TimelineItem, { kind: "mode" }>; onRaw: (event: TaskEvent) => void }) {
  const mode = item.modes.find((entry) => entry.id === item.modeID);
  return (
    <div className="system-summary group mx-auto mb-2 max-w-5xl">
      <div className="system-header">
        <span className="system-title">模式</span>
        <Badge variant="secondary">{item.modeID || "-"}</Badge>
        {mode?.description ? <span className="system-description truncate">{mode.description}</span> : null}
        <Button className="h-6 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" size="sm" onClick={() => onRaw(item.event)}>Raw</Button>
      </div>
    </div>
  );
}

function MetaRows({ rows }: { rows: [string, string][] }) {
  return <div className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">{rows.map(([key, value]) => <React.Fragment key={key}><span>{key}</span><code className="truncate font-mono text-foreground">{value}</code></React.Fragment>)}</div>;
}
