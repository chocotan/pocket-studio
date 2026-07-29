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
      className="group grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border/80 bg-card px-3 py-2.5 text-left shadow-sm transition-all duration-150 hover:border-primary/30 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring cursor-pointer sm:grid-cols-[minmax(160px,0.75fr)_minmax(220px,1.35fr)_auto_auto]"
      style={{ animationDelay: `${(index + 1) * 60}ms` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-card group-hover:text-primary">
          <FolderGit2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-xs font-bold text-foreground transition-colors group-hover:text-primary">
            {proj.name}
          </h3>
          <div className="mt-1 flex items-center gap-1.5">
            <Badge className="max-w-48 truncate rounded border border-primary/15 bg-accent px-1.5 py-0 text-[9px] font-bold text-primary">
              {deviceLabel}
            </Badge>
          </div>
        </div>
      </div>

      <div className="hidden min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground sm:flex">
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        <span className="truncate" title={proj.workspace_path}>{proj.workspace_path}</span>
      </div>

      <div className="hidden items-center gap-1.5 rounded-md border border-border bg-muted/70 px-2 py-1 text-[10px] font-bold text-muted-foreground sm:flex">
        <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground/70" />
        <span>{proj.tmux_ids?.length || 0}</span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-primary">
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
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive cursor-pointer"
            title="删除项目"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </button>
  );
}
