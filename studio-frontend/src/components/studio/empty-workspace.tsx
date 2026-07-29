import { FolderTree, Terminal as TerminalIcon } from "lucide-react";
import type { Device } from "@/lib/types";
import { availableTerminalTypes, type TerminalKind } from "./terminal-types";

export function EmptyWorkspace({
  device,
  onCreate,
  onCreateFileExplorer,
}: {
  device?: Device;
  onCreate: (kind: TerminalKind) => void;
  onCreateFileExplorer?: () => void;
}) {
  const terminalTypes = availableTerminalTypes(device);

  return (
    <div className="absolute inset-0 flex items-center justify-center border border-dashed border-border/80 bg-background/80">
      <div className="w-full max-w-xl px-6 text-center animate-fade-in">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm">
          <TerminalIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold tracking-tight text-foreground">当前工作区没有打开的 Panel</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">选择一个终端类型开始新的 panel。</p>
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {onCreateFileExplorer && (
            <button
              type="button"
              onClick={onCreateFileExplorer}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-left text-xs font-semibold text-foreground/80 shadow-sm transition-all duration-150 hover:border-primary/35 hover:bg-accent/60 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary">
                <FolderTree className="h-3.5 w-3.5" />
              </span>
              <span className="truncate">文件</span>
            </button>
          )}
          {terminalTypes.map((item) => (
            <button
              key={item.value}
              type="button"
              data-testid={`empty-create-${item.value}`}
              onClick={() => onCreate(item.value)}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-left text-xs font-semibold text-foreground/80 shadow-sm transition-all duration-150 hover:border-primary/35 hover:bg-accent/60 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {item.logo}
              </span>
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
