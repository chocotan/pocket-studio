import React, { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Image as ImageIcon, Save } from "lucide-react";
import { postJSON } from "@/lib/api";

interface FileReadResult {
  path: string;
  name: string;
  kind: "text" | "image";
  content?: string;
  data_url?: string;
  mime_type?: string;
  size?: number;
  error?: string;
}

import { type StudioTheme } from "./terminal-types";

interface FileViewerTabProps {
  projectId: string;
  path: string;
  active: boolean;
  dragSuspended: boolean;
  theme?: StudioTheme;
}

export function FileViewerTab({ projectId, path, active, dragSuspended, theme = "light" }: FileViewerTabProps) {
  const [file, setFile] = useState<FileReadResult | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const editorRef = useRef<{ focus: () => void; layout: () => void; dispose: () => void } | null>(null);
  const language = useMemo(() => languageFromPath(path), [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDirty(false);
    postJSON<FileReadResult>("/api/project/file/read", {
      project_id: projectId,
      path,
    })
      .then((result) => {
        if (cancelled) return;
        if (result.error) throw new Error(result.error);
        setFile(result);
        setContent(result.content || "");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  useEffect(() => {
    if (dragSuspended) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        editorRef.current?.layout();
      } catch {
        setEditorEpoch((value) => value + 1);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, dragSuspended]);

  useEffect(() => {
    const isMonacoDomError = (value: unknown) => {
      const text = value instanceof Error ? `${value.message}\n${value.stack || ""}` : String(value || "");
      return text.includes("domNode") && text.includes("editor.api");
    };
    const handleError = (event: ErrorEvent) => {
      if (!isMonacoDomError(event.error || event.message)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setEditorEpoch((value) => value + 1);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (!isMonacoDomError(event.reason)) return;
      event.preventDefault();
      setEditorEpoch((value) => value + 1);
    };
    window.addEventListener("error", handleError, true);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError, true);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  function save() {
    if (!file || file.kind !== "text" || !dirty || saving) return;
    setSaving(true);
    setError("");
    postJSON<FileReadResult>("/api/project/file/write", {
      project_id: projectId,
      path,
      content,
    })
      .then((result) => {
        if (result.error) throw new Error(result.error);
        setFile(result);
        setContent(result.content || "");
        setDirty(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3 bg-muted/10">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-bold text-foreground/80">{basename(path)}</div>
          <div className="truncate text-[10px] text-muted-foreground">{path}</div>
        </div>
        {file?.kind === "text" && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              save();
            }}
            disabled={!dirty || saving}
            className="flex h-6 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-bold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 transition-colors cursor-pointer"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "保存中" : dirty ? "保存" : "已保存"}
          </button>
        )}
      </div>
      {error && (
        <div className="mx-2 mt-2 rounded-md border border-rose-200/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">加载文件...</div>
        ) : file?.kind === "image" ? (
          <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/40 p-4">
            {file.data_url ? (
              <img src={file.data_url} alt={file.name || path} className="max-h-full max-w-full object-contain shadow-sm" />
            ) : (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ImageIcon className="h-4 w-4" />
                图片无法预览
              </div>
            )}
          </div>
        ) : file?.kind === "text" ? (
          <MonacoCrashGuard resetKey={`${projectId}:${path}:${editorEpoch}`}>
            {dragSuspended ? (
              <pre className="h-full overflow-auto whitespace-pre-wrap break-words bg-card px-3 py-2 font-mono text-[11px] leading-5 text-foreground/80">
                {content}
              </pre>
            ) : (
              <Editor
                key={`${projectId}:${path}:${editorEpoch}`}
                height="100%"
                language={language}
                value={content}
                theme={theme === "light" ? "vs" : "vs-dark"}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  lineHeight: 18,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  automaticLayout: true,
                  tabSize: 2,
                }}
                onChange={(value) => {
                  setContent(value || "");
                  setDirty(true);
                }}
                onMount={(editor) => {
                  editorRef.current = editor;
                  if (active) editor.focus();
                }}
                onValidate={() => {
                  try {
                    editorRef.current?.layout();
                  } catch {
                    setEditorEpoch((value) => value + 1);
                  }
                }}
              />
            )}
          </MonacoCrashGuard>
        ) : (
          <div className="px-3 py-2 text-[11px] text-slate-400">无法预览该文件</div>
        )}
      </div>
    </div>
  );
}

class MonacoCrashGuard extends React.Component<
  { children: React.ReactNode; resetKey: string },
  { failed: boolean; resetKey: string }
> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; resetKey: string }
  ) {
    if (props.resetKey !== state.resetKey) {
      return { failed: false, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: unknown) {
    console.error("monaco editor crashed:", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center px-3 text-[11px] text-rose-600">
          编辑器渲染失败，请切换标签或重新打开文件。
        </div>
      );
    }
    return this.props.children;
  }
}

function languageFromPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "css":
      return "css";
    case "html":
      return "html";
    case "md":
    case "markdown":
      return "markdown";
    case "go":
      return "go";
    case "java":
      return "java";
    case "xml":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
      return "shell";
    default:
      return "plaintext";
  }
}

function basename(path: string) {
  const normalized = path.replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}
