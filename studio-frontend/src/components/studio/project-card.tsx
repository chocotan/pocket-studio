import { ArrowRight, Folder, FolderGit2, TerminalSquare, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Project } from "./studio-dashboard";

interface ProjectCardProps {
  proj: Project;
  deviceLabel: string;
  index: number;
  onClick: () => void;
  onDelete?: () => void;
}

export function ProjectCard({
  proj,
  deviceLabel,
  index,
  onClick,
  onDelete,
}: ProjectCardProps) {
  return (
    <button
      type="button"
      role="button"
      onClick={onClick}
      className="group grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-slate-200/75 bg-white px-3 py-2.5 text-left shadow-sm transition-colors hover:border-indigo-200 hover:bg-indigo-50/35 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-indigo-400 cursor-pointer sm:grid-cols-[minmax(160px,0.75fr)_minmax(220px,1.35fr)_auto_auto]"
      style={{ animationDelay: `${(index + 1) * 60}ms` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 group-hover:bg-white group-hover:text-indigo-600">
          <FolderGit2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-xs font-bold text-slate-800 group-hover:text-indigo-600">
            {proj.name}
          </h3>
          <div className="mt-1 flex items-center gap-1.5">
            <Badge className="max-w-48 truncate rounded border border-indigo-100 bg-indigo-50 px-1.5 py-0 text-[9px] font-bold text-indigo-600">
              {deviceLabel}
            </Badge>
          </div>
        </div>
      </div>

      <div className="hidden min-w-0 items-center gap-1.5 font-mono text-[10px] text-slate-500 sm:flex">
        <Folder className="h-3.5 w-3.5 shrink-0 text-slate-300" />
        <span className="truncate" title={proj.workspace_path}>{proj.workspace_path}</span>
      </div>

      <div className="hidden items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-bold text-slate-500 sm:flex">
        <TerminalSquare className="h-3.5 w-3.5 text-slate-400" />
        <span>{proj.tmux_ids?.length || 0}</span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600">
          <span className="hidden sm:inline">打开</span>
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`确定要删除项目 "${proj.name}" 吗？这将会销毁其所有关联的终端和后台 tmux 进程。`)) {
                onDelete();
              }
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer"
            title="删除项目"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </button>
  );
}
