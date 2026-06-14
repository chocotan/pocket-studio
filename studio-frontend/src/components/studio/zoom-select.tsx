import { Percent } from "lucide-react";
import { type PageZoom, ZOOM_OPTIONS } from "@/lib/zoom";
import { cn } from "@/lib/utils";

interface ZoomSelectProps {
  value: PageZoom;
  onChange: (zoom: PageZoom) => void;
  compact?: boolean;
}

export function ZoomSelect({ value, onChange, compact = false }: ZoomSelectProps) {
  function handleChange(nextValue: string) {
    const nextZoom = Number(nextValue) as PageZoom;
    onChange(nextZoom);
  }

  return (
    <label
      className={cn(
        "flex items-center rounded-lg border border-slate-200/70 bg-white text-[11px] font-semibold text-slate-500 shadow-sm dark:border-slate-700/70 dark:bg-slate-800/70 dark:text-slate-400",
        compact ? "gap-0 px-1 py-0.5" : "gap-1.5 px-2 py-1"
      )}
    >
      {!compact && <Percent className="h-3.5 w-3.5" aria-hidden="true" />}
      <span className="sr-only">面板缩放比例</span>
      <select
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        className={cn(
          "h-5 rounded-md border border-slate-200 bg-slate-50 px-1 text-[11px] font-bold text-slate-700 outline-none transition-colors hover:bg-white focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200 dark:hover:bg-slate-900",
          compact ? "min-w-10" : "min-w-16"
        )}
        title="面板缩放比例"
      >
        {ZOOM_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {compact ? option : `${option}%`}
          </option>
        ))}
      </select>
    </label>
  );
}
