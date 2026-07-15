import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import {
  Braces,
  ChevronRight,
  Code2,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoveRight,
  RefreshCw,
  Search,
  Trash2,
  X,
  List,
  FolderTree,
  ArrowUp,
  Eye,
  EyeOff,
} from "lucide-react";
import { postJSON } from "@/lib/api";

interface WorkspaceListResult {
  workspace_path?: string;
  path?: string;
  entries?: FileEntry[];
  error?: string;
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  modified?: number;
}

interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  modified?: number;
  children?: FileTreeNode[];
  loaded?: boolean;
}

import { type StudioTheme, type TerminalKind } from "./terminal-types";
import { createPortal } from "react-dom";
import { TerminalTypeMenu } from "./terminal-panel-view";
import type { Project } from "./studio-dashboard";
import type { Device } from "@/lib/types";

interface FileExplorerTabProps {
  projectId: string;
  workspacePath: string;
  active: boolean;
  layoutVersion: number;
  onOpenFile: (path: string) => void;
  theme?: StudioTheme;
  projects?: Project[];
  devices?: Device[];
  onCreateTab?: (kind: TerminalKind, tabProjectId?: string, filePath?: string) => void;
  onCreateFileExplorer?: (tabProjectId?: string, filePath?: string) => void;
  onCreateAgentChat?: (agentKind: string, agentRuntime?: "direct_acp", tabProjectId?: string, filePath?: string) => void;
}

function FileExplorerTabView({
  projectId,
  workspacePath,
  active,
  layoutVersion,
  onOpenFile,
  theme = "light",
  projects = [],
  devices = [],
  onCreateTab,
  onCreateFileExplorer,
  onCreateAgentChat,
}: FileExplorerTabProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  void theme;
  const [treeData, setTreeData] = useState<FileTreeNode[]>([]);
  const [error, setError] = useState("");
  const [loadingRoot, setLoadingRoot] = useState(true);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<FileTreeNode | null>(null);
  const [height, setHeight] = useState(320);

  const [explorerRootPath, setExplorerRootPath] = useState("");
  const [viewMode, setViewMode] = useState<"tree" | "list">("tree");
  const [currentFolderPath, setCurrentFolderPath] = useState("");
  const [listEntries, setListEntries] = useState<FileTreeNode[]>([]);
  const [loadingFolder, setLoadingFolder] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileTreeNode } | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const filteredTreeData = useMemo(() => {
    if (showHidden) return treeData;
    const filterNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
      return nodes
        .filter((n) => !n.name.startsWith("."))
        .map((n) => {
          if (n.children) {
            return {
              ...n,
              children: filterNodes(n.children),
            };
          }
          return n;
        });
    };
    return filterNodes(treeData);
  }, [treeData, showHidden]);

  const filteredListEntries = useMemo(() => {
    if (showHidden) return listEntries;
    return listEntries.filter((n) => !n.name.startsWith("."));
  }, [listEntries, showHidden]);

  const [sortField, setSortField] = useState<"name" | "size" | "modified" | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const sortedListEntries = useMemo(() => {
    const baseList = [...filteredListEntries];
    if (!sortField) return baseList;

    baseList.sort((a, b) => {

      let valA: any = "";
      let valB: any = "";

      if (sortField === "name") {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      } else if (sortField === "size") {
        valA = a.size || 0;
        valB = b.size || 0;
      } else if (sortField === "modified") {
        valA = a.modified ? new Date(a.modified).getTime() : 0;
        valB = b.modified ? new Date(b.modified).getTime() : 0;
      }

      if (valA < valB) return sortDirection === "asc" ? -1 : 1;
      if (valA > valB) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });

    return baseList;
  }, [filteredListEntries, sortField, sortDirection]);

  const handleSort = (field: "name" | "size" | "modified") => {
    if (sortField === field) {
      if (sortDirection === "asc") {
        setSortDirection("desc");
      } else {
        setSortField(null);
      }
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const renderSortIndicator = (field: "name" | "size" | "modified") => {
    if (sortField !== field) return null;
    return (
      <span className="ml-1 inline-block text-[10px] text-indigo-500 font-bold">
        {sortDirection === "asc" ? "▲" : "▼"}
      </span>
    );
  };

  const resolvedRootPath = useMemo(() => {
    return explorerRootPath || workspacePath;
  }, [explorerRootPath, workspacePath]);

  const rootName = useMemo(() => {
    return basename(resolvedRootPath) || resolvedRootPath || "根目录";
  }, [resolvedRootPath]);

  function getParentOfPath(path: string) {
    if (!path || path === "/") return "/";
    const parts = path.replace(/\/+$/, "").split("/");
    parts.pop();
    const parent = parts.join("/");
    return parent || "/";
  }

  const handleGoUp = () => {
    const parent = getParentOfPath(resolvedRootPath);
    setExplorerRootPath(parent);
  };

  useEffect(() => {
    setCurrentFolderPath(explorerRootPath);
  }, [explorerRootPath]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRoot(true);
    setError("");
    loadDirectory(explorerRootPath)
      .then((children) => {
        if (cancelled) return;
        setTreeData([{
          id: explorerRootPath || ".",
          name: rootName,
          path: explorerRootPath,
          isDir: true,
          loaded: true,
          children,
        }]);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingRoot(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, workspacePath, explorerRootPath, rootName]);

  useEffect(() => {
    let cancelled = false;
    setLoadingFolder(true);
    loadDirectory(currentFolderPath)
      .then((children) => {
        if (cancelled) return;
        setListEntries(children);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingFolder(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, currentFolderPath]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const nextHeight = Math.max(160, Math.floor(element.clientHeight - 122));
      setHeight(nextHeight);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layoutVersion, active]);

  async function loadDirectory(path: string) {
    const result = await postJSON<WorkspaceListResult>("/api/project/files", {
      project_id: projectId,
      path,
    });
    if (result.error) throw new Error(result.error);
    return (result.entries || []).map(toTreeNode);
  }

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      postJSON<{ entries?: FileEntry[]; error?: string }>("/api/project/search-files", {
        project_id: projectId,
        query,
        limit: 80,
      })
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.error) throw new Error(result.error);
          setSearchResults(result.entries || []);
          setError("");
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setSearchResults([]);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [projectId, searchQuery]);

  function handleToggle(id: string) {
    const node = findTreeNode(treeData, id);
    if (!node || !node.isDir || node.loaded) return;
    setLoadingPaths((prev) => new Set(prev).add(node.path));
    loadDirectory(node.path)
      .then((children) => {
        setTreeData((prev) => updateNode(prev, id, { loaded: true, children }));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(node.path);
          return next;
        });
      });
  }

  function refresh() {
    setTreeData([]);
    setError("");
    setLoadingRoot(true);
    loadDirectory(explorerRootPath)
      .then((children) => {
        setTreeData([{
          id: explorerRootPath || ".",
          name: rootName,
          path: explorerRootPath,
          isDir: true,
          loaded: true,
          children,
        }]);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingRoot(false));

    setLoadingFolder(true);
    loadDirectory(currentFolderPath)
      .then(setListEntries)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingFolder(false));
  }

  function parentPath(path: string) {
    if (!path) return "";
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
  }

  function actionBasePath() {
    if (!selectedEntry) return explorerRootPath;
    return selectedEntry.isDir ? selectedEntry.path : parentPath(selectedEntry.path);
  }

  async function runFileAction(action: string, path: string, target = "") {
    const result = await postJSON<{ success?: boolean; error?: string }>("/api/project/file/action", {
      project_id: projectId,
      action,
      path,
      target,
    });
    if (result.error) throw new Error(result.error);
    refresh();
    setSearchQuery("");
  }

  function createFile() {
    const base = actionBasePath();
    const name = window.prompt("新建文件路径", base ? `${base}/untitled.txt` : "untitled.txt");
    if (!name) return;
    runFileAction("create_file", name).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  function createDirectory() {
    const base = actionBasePath();
    const name = window.prompt("新建目录路径", base ? `${base}/new-folder` : "new-folder");
    if (!name) return;
    runFileAction("mkdir", name).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  function deleteSelected() {
    if (!selectedEntry || !selectedEntry.path) return;
    if (!window.confirm(`删除 ${selectedEntry.path}？`)) return;
    runFileAction("delete", selectedEntry.path)
      .then(() => setSelectedEntry(null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  function moveSelected() {
    if (!selectedEntry || !selectedEntry.path) return;
    const target = window.prompt("移动到路径", selectedEntry.path);
    if (!target || target === selectedEntry.path) return;
    runFileAction("move", selectedEntry.path, target)
      .then(() => setSelectedEntry(null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  function createFileInDir(dirPath: string) {
    const name = window.prompt("新建文件路径", dirPath ? `${dirPath}/untitled.txt` : "untitled.txt");
    if (!name) return;
    runFileAction("create_file", name)
      .then(() => {
        if (viewMode === "list") {
          return loadDirectory(currentFolderPath).then(setListEntries);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  function createDirectoryInDir(dirPath: string) {
    const name = window.prompt("新建目录路径", dirPath ? `${dirPath}/new-folder` : "new-folder");
    if (!name) return;
    runFileAction("mkdir", name)
      .then(() => {
        if (viewMode === "list") {
          return loadDirectory(currentFolderPath).then(setListEntries);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
      {error && (
        <div className="mx-2 mt-2 rounded-md border border-rose-200/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/40 px-2 bg-muted/20">
        <ToolbarButton title="向上一级" onClick={handleGoUp}>
          <ArrowUp className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
        </ToolbarButton>
        <div className="h-4 w-px bg-border" />
        <ToolbarButton title="新建文件" onClick={createFile}><FilePlus2 className="h-3.5 w-3.5" /></ToolbarButton>
        <ToolbarButton title="新建目录" onClick={createDirectory}><FolderPlus className="h-3.5 w-3.5" /></ToolbarButton>
        <ToolbarButton title="移动" onClick={moveSelected} disabled={!selectedEntry?.path}><MoveRight className="h-3.5 w-3.5" /></ToolbarButton>
        <ToolbarButton title="删除" onClick={deleteSelected} disabled={!selectedEntry?.path}><Trash2 className="h-3.5 w-3.5" /></ToolbarButton>
        <div className="h-4 w-px bg-border" />
        {/* Toggle Display Mode */}
        <ToolbarButton
          title={viewMode === "tree" ? "切换为列表模式" : "切换为树形模式"}
          onClick={() => setViewMode((prev) => (prev === "tree" ? "list" : "tree"))}
        >
          {viewMode === "tree" ? <List className="h-3.5 w-3.5" /> : <FolderTree className="h-3.5 w-3.5" />}
        </ToolbarButton>
        {/* Toggle Hidden Files */}
        <ToolbarButton
          title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
          onClick={() => setShowHidden((prev) => !prev)}
        >
          {showHidden ? (
            <Eye className="h-3.5 w-3.5 text-indigo-500" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </ToolbarButton>
        <ToolbarButton title="刷新" onClick={refresh}>
          <RefreshCw className={`h-3.5 w-3.5 ${loadingRoot ? "animate-spin" : ""}`} />
        </ToolbarButton>
        {selectedEntry?.path ? (
          <span className="ml-2 min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={selectedEntry.path}>
            {selectedEntry.path}
          </span>
        ) : (
          <span className="ml-2 min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={resolvedRootPath}>
            {resolvedRootPath}
          </span>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/40 px-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          placeholder="搜索文件"
          className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setSearchQuery("");
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="清空搜索"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 px-1.5 py-2">
        {searchQuery.trim() ? (
          <SearchResults
            results={searchResults}
            searching={searching}
            onOpenFile={onOpenFile}
          />
        ) : viewMode === "list" ? (
          <div className="overflow-auto h-full text-foreground/90 select-none" style={{ height }}>
            {loadingFolder && listEntries.length === 0 ? (
              <div className="px-2 py-1 text-[11px] text-slate-400">加载中...</div>
            ) : (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-border/40 text-muted-foreground font-semibold text-left">
                    <th className="py-1 px-2 cursor-pointer select-none hover:bg-muted/50 transition-colors" onClick={() => handleSort("name")}>
                      名称 {renderSortIndicator("name")}
                    </th>
                    <th className="py-1 px-2 w-20 text-right cursor-pointer select-none hover:bg-muted/50 transition-colors" onClick={() => handleSort("size")}>
                      大小 {renderSortIndicator("size")}
                    </th>
                    <th className="py-1 px-2 w-32 text-right cursor-pointer select-none hover:bg-muted/50 transition-colors" onClick={() => handleSort("modified")}>
                      修改时间 {renderSortIndicator("modified")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {currentFolderPath !== explorerRootPath && (
                    <tr
                      className="hover:bg-muted/70 cursor-default transition-colors text-indigo-650 dark:text-indigo-400 font-semibold"
                      onDoubleClick={() => {
                        setCurrentFolderPath(getParentOfPath(currentFolderPath));
                      }}
                    >
                      <td className="py-1 px-2 flex items-center gap-1.5">
                        <FolderOpen className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        <span>.. (返回上一级)</span>
                      </td>
                      <td className="py-1 px-2 text-right">-</td>
                      <td className="py-1 px-2 text-right">-</td>
                    </tr>
                  )}
                  {sortedListEntries.map((node) => {
                    const Icon = node.isDir ? Folder : fileIconForPath(node.path);
                    const isSelected = selectedEntry?.path === node.path;
                    return (
                      <tr
                        key={node.id}
                        onClick={() => setSelectedEntry(node)}
                        onDoubleClick={() => {
                          if (node.isDir) {
                            setCurrentFolderPath(node.path);
                          } else {
                            onOpenFile(node.path);
                          }
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setSelectedEntry(node);
                          setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            node,
                          });
                        }}
                        className={`hover:bg-muted/70 cursor-default transition-colors ${
                          isSelected
                            ? "bg-indigo-500/15 font-semibold text-indigo-650 dark:text-indigo-400"
                            : "text-foreground/80 hover:text-foreground"
                        }`}
                      >
                        <td className="py-1 px-2">
                          <div className="flex items-center gap-1.5 truncate">
                            <span className={fileIconClass(node)}>
                              <Icon className="h-3.5 w-3.5 shrink-0" />
                            </span>
                            <span className="truncate">{node.name}</span>
                          </div>
                        </td>
                        <td className="py-1 px-2 text-right text-muted-foreground">{formatSize(node.size)}</td>
                        <td className="py-1 px-2 text-right text-muted-foreground">{formatDate(node.modified)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        ) : loadingRoot && treeData.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-slate-400">加载文件...</div>
        ) : (
          <Tree<FileTreeNode>
            key={`${projectId}:${resolvedRootPath}`}
            data={filteredTreeData}
            width="100%"
            height={height}
            rowHeight={24}
            indent={16}
            openByDefault={false}
            initialOpenState={{ [explorerRootPath || "."]: true }}
            disableDrag
            disableDrop
            disableEdit
            childrenAccessor={(node) => node.isDir ? (node.children || []) : null}
            idAccessor={(node) => node.id}
            onToggle={handleToggle}
          >
            {(props) => (
              <FileTreeRow
                {...props}
                loadingPaths={loadingPaths}
                onSelectEntry={setSelectedEntry}
                onOpenFile={onOpenFile}
                onContextMenu={(event, node) => {
                  setContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    node,
                  });
                }}
              />
            )}
          </Tree>
        )}
      </div>

      {/* Context Menu Popup via React Portal to prevent scale/transform offset */}
      {contextMenu && createPortal(
        <>
          <div
            className="fixed inset-0 z-[9998] cursor-default"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          <TerminalTypeMenu
            align="left"
            style={{
              position: "fixed",
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
              zIndex: 9999,
            }}
            projects={projects}
            devices={devices}
            projectId={projectId}
            dirPath={contextMenu.node.isDir ? contextMenu.node.path : parentPath(contextMenu.node.path)}
            onNewFile={(dirPath) => {
              setContextMenu(null);
              createFileInDir(dirPath);
            }}
            onNewFolder={(dirPath) => {
              setContextMenu(null);
              createDirectoryInDir(dirPath);
            }}
            onSelect={(kind, tabProjectId) => {
              setContextMenu(null);
              if (onCreateTab) {
                onCreateTab(kind, tabProjectId, contextMenu.node.path);
              }
            }}
            onFileExplorer={(tabProjectId) => {
              setContextMenu(null);
              if (onCreateFileExplorer) {
                onCreateFileExplorer(tabProjectId, contextMenu.node.path);
              }
            }}
            onAddAgentChat={(agentKind, agentRuntime, tabProjectId) => {
              setContextMenu(null);
              if (onCreateAgentChat) {
                onCreateAgentChat(agentKind, agentRuntime, tabProjectId, contextMenu.node.path);
              }
            }}
          />
        </>,
        document.body
      )}
    </div>
  );
}

export const FileExplorerTab = memo(FileExplorerTabView);

function FileTreeRow({
  node,
  style,
  loadingPaths,
  onSelectEntry,
  onOpenFile,
  onContextMenu,
}: NodeRendererProps<FileTreeNode> & {
  loadingPaths: Set<string>;
  onSelectEntry: (entry: FileTreeNode) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, node: FileTreeNode) => void;
}) {
  const loading = loadingPaths.has(node.data.path);
  const Icon = node.data.isDir ? (node.isOpen ? FolderOpen : Folder) : fileIconForPath(node.data.path);
  return (
    <div
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        node.select();
        onSelectEntry(node.data);
        if (node.data.isDir) {
          if (node.data.loaded) {
            node.toggle();
          } else {
            node.open();
            node.activate();
          }
        } else {
          node.activate();
          onOpenFile(node.data.path);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        node.select();
        onSelectEntry(node.data);
        onContextMenu(event, node.data);
      }}
      className={`group flex cursor-default select-none items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
        node.isSelected
          ? "bg-indigo-500/15 text-indigo-650 dark:text-indigo-400 font-semibold"
          : "text-foreground/80 hover:bg-muted/70 hover:text-foreground"
      }`}
      title={node.data.path || node.data.name}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400">
        {node.data.isDir ? (
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${node.isOpen ? "rotate-90" : ""}`} />
        ) : null}
      </span>
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${fileIconClass(node.data)}`}>
        <Icon className={`h-3.5 w-3.5 ${loading ? "animate-pulse" : ""}`} />
      </span>
      <span className="min-w-0 flex-1 truncate">{node.data.name}</span>
    </div>
  );
}

function SearchResults({
  results,
  searching,
  onOpenFile,
}: {
  results: FileEntry[];
  searching: boolean;
  onOpenFile: (path: string) => void;
}) {
  if (searching && results.length === 0) {
    return <div className="px-2 py-1 text-[11px] text-slate-400">搜索中...</div>;
  }
  if (!searching && results.length === 0) {
    return <div className="px-2 py-1 text-[11px] text-slate-400">没有匹配文件</div>;
  }
  return (
    <div className="space-y-0.5">
      {results.map((item) => (
        <button
          key={item.path}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenFile(item.path);
          }}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-foreground/80 hover:bg-muted/70 hover:text-foreground transition-colors"
          title={item.path}
        >
          {(() => {
            const Icon = fileIconForPath(item.path);
            return <Icon className={`h-3.5 w-3.5 shrink-0 ${fileIconClass({ path: item.path, isDir: false } as FileTreeNode)}`} />;
          })()}
          <span className="min-w-0 flex-1 truncate">{item.path}</span>
        </button>
      ))}
    </div>
  );
}

function toTreeNode(entry: FileEntry): FileTreeNode {
  return {
    id: entry.path || entry.name,
    name: entry.name,
    path: entry.path,
    isDir: entry.is_dir,
    size: entry.size,
    modified: entry.modified,
    loaded: !entry.is_dir,
    children: entry.is_dir ? [] : undefined,
  };
}

function updateNode(nodes: FileTreeNode[], id: string, patch: Partial<FileTreeNode>): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.id === id) return { ...node, ...patch };
    if (!node.children) return node;
    return { ...node, children: updateNode(node.children, id, patch) };
  });
}

function findTreeNode(nodes: FileTreeNode[], id: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findTreeNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

function basename(path: string) {
  const normalized = path.replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function ToolbarButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function fileIconForPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"].includes(ext)) return FileImage;
  if (["zip", "gz", "tar", "rar", "7z", "jar", "war"].includes(ext)) return FileArchive;
  if (["json", "jsonc"].includes(ext)) return FileJson;
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte"].includes(ext)) return FileCode2;
  if (["go", "java", "kt", "py", "rs", "c", "cpp", "h", "hpp", "cs", "php", "rb"].includes(ext)) return Code2;
  if (["css", "scss", "less", "html", "xml", "yaml", "yml", "toml"].includes(ext)) return Braces;
  if (["md", "txt", "log", "sql"].includes(ext)) return FileText;
  return File;
}

function fileIconClass(node: Pick<FileTreeNode, "isDir" | "path">) {
  if (node.isDir) return "text-amber-500";
  const ext = node.path.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"].includes(ext)) return "text-pink-500";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte"].includes(ext)) return "text-sky-600";
  if (["json", "jsonc"].includes(ext)) return "text-amber-600";
  if (["md", "txt", "log"].includes(ext)) return "text-slate-500";
  if (["zip", "gz", "tar", "rar", "7z", "jar", "war"].includes(ext)) return "text-violet-500";
  return "text-slate-400";
}

function formatSize(bytes?: number) {
  if (bytes === undefined || bytes === null || bytes === 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp?: number) {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
