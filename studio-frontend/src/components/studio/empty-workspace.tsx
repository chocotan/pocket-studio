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
    <div className="absolute inset-0 flex items-center justify-center border border-dashed border-slate-300 bg-white/70">
      <div className="w-full max-w-xl px-6 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-500">
          <TerminalIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-slate-800">当前工作区没有打开的 Panel</h2>
        <p className="mt-1 text-xs text-slate-500">选择一个终端类型开始新的 panel。</p>
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {onCreateFileExplorer && (
            <button
              type="button"
              onClick={onCreateFileExplorer}
              className="flex items-center gap-2 border border-slate-200 bg-white px-3 py-2 text-left text-xs font-semibold text-slate-700 transition-colors hover:border-sky-300 hover:bg-sky-50/60 hover:text-sky-700"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-sky-100 text-sky-700">
                <FolderTree className="h-3.5 w-3.5" />
              </span>
              <span className="truncate">文件</span>
            </button>
          )}
          {terminalTypes.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => onCreate(item.value)}
              className="flex items-center gap-2 border border-slate-200 bg-white px-3 py-2 text-left text-xs font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:bg-indigo-50/60 hover:text-indigo-700"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 text-slate-600">
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
