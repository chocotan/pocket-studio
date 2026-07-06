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
        "flex items-center rounded-lg border border-border bg-card text-[11px] font-semibold text-muted-foreground shadow-sm",
        compact ? "h-6 gap-0 px-1" : "gap-1.5 px-2 py-1"
      )}
    >
      {!compact && <Percent className="h-3.5 w-3.5" aria-hidden="true" />}
      <span className="sr-only">面板缩放比例</span>
      <select
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        className={cn(
          "h-5 rounded-md border border-border bg-muted/50 px-1 text-[11px] font-bold text-foreground outline-none transition-colors hover:bg-card focus:border-primary",
          compact ? "min-w-10 text-[10px]" : "min-w-16"
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
