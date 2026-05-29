import { useEffect, useMemo, useRef, useState } from "react";
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
  children?: FileTreeNode[];
  loaded?: boolean;
}

interface FileExplorerTabProps {
  projectId: string;
  workspacePath: string;
  active: boolean;
  layoutVersion: number;
  onOpenFile: (path: string) => void;
}

export function FileExplorerTab({ projectId, workspacePath, active, layoutVersion, onOpenFile }: FileExplorerTabProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [treeData, setTreeData] = useState<FileTreeNode[]>([]);
  const [error, setError] = useState("");
  const [loadingRoot, setLoadingRoot] = useState(true);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<FileTreeNode | null>(null);
  const [height, setHeight] = useState(320);
  const rootName = useMemo(() => basename(workspacePath) || workspacePath || "工作目录", [workspacePath]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRoot(true);
    setError("");
    loadDirectory("")
      .then((children) => {
        if (cancelled) return;
        setTreeData([{
          id: ".",
          name: rootName,
          path: "",
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
  }, [projectId, workspacePath, rootName]);

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
    loadDirectory("")
      .then((children) => {
        setTreeData([{
          id: ".",
          name: rootName,
          path: "",
          isDir: true,
          loaded: true,
          children,
        }]);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingRoot(false));
  }

  function parentPath(path: string) {
    if (!path) return "";
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
  }

  function actionBasePath() {
    if (!selectedEntry) return "";
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

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col bg-[#fbfbfb]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-slate-200/70 px-3">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-slate-700">{rootName}</div>
          <div className="truncate text-[10px] text-slate-400">{workspacePath}</div>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            refresh();
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
          aria-label="刷新文件资源管理器"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loadingRoot ? "animate-spin" : ""}`} />
        </button>
      </div>
      {error && (
        <div className="mx-2 mt-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
          {error}
        </div>
      )}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-slate-100 px-2">
        <ToolbarButton title="新建文件" onClick={createFile}><FilePlus2 className="h-3.5 w-3.5" /></ToolbarButton>
        <ToolbarButton title="新建目录" onClick={createDirectory}><FolderPlus className="h-3.5 w-3.5" /></ToolbarButton>
        <ToolbarButton title="移动" onClick={moveSelected} disabled={!selectedEntry?.path}><MoveRight className="h-3.5 w-3.5" /></ToolbarButton>
        <ToolbarButton title="删除" onClick={deleteSelected} disabled={!selectedEntry?.path}><Trash2 className="h-3.5 w-3.5" /></ToolbarButton>
        <div className="h-4 w-px bg-slate-200" />
        <ToolbarButton title="刷新" onClick={refresh}><RefreshCw className={`h-3.5 w-3.5 ${loadingRoot ? "animate-spin" : ""}`} /></ToolbarButton>
        {selectedEntry?.path && (
          <span className="ml-1 min-w-0 flex-1 truncate text-[10px] text-slate-400" title={selectedEntry.path}>
            {selectedEntry.path}
          </span>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-slate-100 px-2">
        <Search className="h-3.5 w-3.5 text-slate-400" />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          placeholder="搜索文件"
          className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-700 outline-none placeholder:text-slate-400"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setSearchQuery("");
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
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
        ) : loadingRoot && treeData.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-slate-400">加载文件...</div>
        ) : (
          <Tree<FileTreeNode>
            key={`${projectId}:${workspacePath}`}
            data={treeData}
            width="100%"
            height={height}
            rowHeight={24}
            indent={16}
            openByDefault={false}
            initialOpenState={{ ".": true }}
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
              />
            )}
          </Tree>
        )}
      </div>
    </div>
  );
}

function FileTreeRow({
  node,
  style,
  loadingPaths,
  onSelectEntry,
  onOpenFile,
}: NodeRendererProps<FileTreeNode> & {
  loadingPaths: Set<string>;
  onSelectEntry: (entry: FileTreeNode) => void;
  onOpenFile: (path: string) => void;
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
      className={`group flex cursor-default select-none items-center gap-1 rounded px-1.5 text-[11px] ${
        node.isSelected ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"
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
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-slate-600 hover:bg-slate-100 hover:text-indigo-700"
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
