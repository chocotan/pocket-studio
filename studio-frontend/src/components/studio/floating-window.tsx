import React, { useRef } from "react";

interface FloatingWindowProps {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  isMaximized: boolean;
  isMinimized: boolean;
  focused: boolean;
  onFocus: () => void;
  onUpdatePosition: (x: number, y: number) => void;
  onUpdateSize: (x: number, y: number, w: number, h: number) => void;
  onToggleMaximize: () => void;
  onMinimize: () => void;
  children: (props: {
    isFloating: boolean;
    isMaximized: boolean;
    onMinimize: () => void;
    onMaximize: () => void;
    onHeaderPointerDown: (e: React.PointerEvent) => void;
    onHeaderDoubleClick: (e: React.MouseEvent) => void;
  }) => React.ReactNode;
}

interface DragState {
  type: "drag" | "resize";
  direction?: "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
  pointerId: number;
}

export function FloatingWindow({
  x,
  y,
  width,
  height,
  zIndex,
  isMaximized,
  isMinimized,
  focused,
  onFocus,
  onUpdatePosition,
  onUpdateSize,
  onToggleMaximize,
  onMinimize,
  children,
}: FloatingWindowProps) {
  const dragStateRef = useRef<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (isMinimized) return null;

  const handlePointerDown = (
    e: React.PointerEvent,
    actionType: "drag" | "resize",
    dir?: DragState["direction"]
  ) => {
    if (e.button !== 0) return;
    
    e.stopPropagation();
    onFocus();

    const container = containerRef.current;
    if (container) {
      try {
        container.setPointerCapture(e.pointerId);
      } catch (err) {
        console.warn("Failed to set pointer capture", err);
      }
    }

    dragStateRef.current = {
      type: actionType,
      direction: dir,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: x,
      startTop: y,
      startWidth: width,
      startHeight: height,
      pointerId: e.pointerId,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (drag.type === "drag") {
      const nextX = drag.startLeft + dx;
      const nextY = drag.startTop + dy;
      if (containerRef.current) {
        containerRef.current.style.left = `${nextX}px`;
        containerRef.current.style.top = `${nextY}px`;
      }
    } else if (drag.type === "resize" && drag.direction) {
      let nextLeft = drag.startLeft;
      let nextTop = drag.startTop;
      let nextWidth = drag.startWidth;
      let nextHeight = drag.startHeight;

      const minWidth = 320;
      const minHeight = 240;

      if (drag.direction.includes("e")) {
        nextWidth = Math.max(minWidth, drag.startWidth + dx);
      } else if (drag.direction.includes("w")) {
        const computedWidth = drag.startWidth - dx;
        if (computedWidth >= minWidth) {
          nextWidth = computedWidth;
          nextLeft = drag.startLeft + dx;
        }
      }

      if (drag.direction.includes("s")) {
        nextHeight = Math.max(minHeight, drag.startHeight + dy);
      } else if (drag.direction.includes("n")) {
        const computedHeight = drag.startHeight - dy;
        if (computedHeight >= minHeight) {
          nextHeight = computedHeight;
          nextTop = drag.startTop + dy;
        }
      }

      if (containerRef.current) {
        containerRef.current.style.left = `${nextLeft}px`;
        containerRef.current.style.top = `${nextTop}px`;
        containerRef.current.style.width = `${nextWidth}px`;
        containerRef.current.style.height = `${nextHeight}px`;
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    dragStateRef.current = null;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (drag.type === "drag") {
      onUpdatePosition(drag.startLeft + dx, drag.startTop + dy);
    } else if (drag.type === "resize" && drag.direction) {
      let nextLeft = drag.startLeft;
      let nextTop = drag.startTop;
      let nextWidth = drag.startWidth;
      let nextHeight = drag.startHeight;

      const minWidth = 320;
      const minHeight = 240;

      if (drag.direction.includes("e")) {
        nextWidth = Math.max(minWidth, drag.startWidth + dx);
      } else if (drag.direction.includes("w")) {
        const computedWidth = drag.startWidth - dx;
        if (computedWidth >= minWidth) {
          nextWidth = computedWidth;
          nextLeft = drag.startLeft + dx;
        }
      }

      if (drag.direction.includes("s")) {
        nextHeight = Math.max(minHeight, drag.startHeight + dy);
      } else if (drag.direction.includes("n")) {
        const computedHeight = drag.startHeight - dy;
        if (computedHeight >= minHeight) {
          nextHeight = computedHeight;
          nextTop = drag.startTop + dy;
        }
      }

      onUpdateSize(nextLeft, nextTop, nextWidth, nextHeight);
    }
  };

  const handleHeaderPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, [role='tab'], input, select, textarea, svg")) {
      return;
    }
    handlePointerDown(e, "drag");
  };

  const handleHeaderDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, [role='tab'], input, select, textarea, svg")) {
      return;
    }
    onToggleMaximize();
  };

  const windowStyle: React.CSSProperties = isMaximized
    ? {
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        zIndex,
        transition: "all 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
      }
    : {
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        zIndex,
        transition: dragStateRef.current ? "none" : "transform 0.15s ease, width 0.15s ease, height 0.15s ease",
      };

  const resizeZones: Array<{ dir: DragState["direction"]; className: string }> = [
    { dir: "n", className: "absolute top-0 left-1 right-1 h-1.5 cursor-ns-resize z-50" },
    { dir: "s", className: "absolute bottom-0 left-1 right-1 h-1.5 cursor-ns-resize z-50" },
    { dir: "e", className: "absolute right-0 top-1 bottom-1 w-1.5 cursor-ew-resize z-50" },
    { dir: "w", className: "absolute left-0 top-1 bottom-1 w-1.5 cursor-ew-resize z-50" },
    { dir: "nw", className: "absolute top-0 left-0 w-2.5 h-2.5 cursor-nwse-resize z-50" },
    { dir: "ne", className: "absolute top-0 right-0 w-2.5 h-2.5 cursor-nesw-resize z-50" },
    { dir: "sw", className: "absolute bottom-0 left-0 w-2.5 h-2.5 cursor-nesw-resize z-50" },
    { dir: "se", className: "absolute bottom-0 right-0 w-2.5 h-2.5 cursor-nwse-resize z-50" },
  ];

  return (
    <div
      ref={containerRef}
      style={windowStyle}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className={`group/window flex flex-col overflow-hidden bg-card rounded-lg border-2 shadow-xl ${
        focused
          ? "border-primary/95 ring-2 ring-primary/20"
          : "border-border/80 hover:border-border-muted shadow-md"
      }`}
      onPointerDownCapture={() => {
        onFocus();
      }}
      onPointerDown={() => {
        onFocus();
      }}
    >
      {!isMaximized &&
        resizeZones.map(({ dir, className }) => (
          <div
            key={dir}
            className={className}
            onPointerDown={(e) => handlePointerDown(e, "resize", dir)}
          />
        ))}

      <div className="relative flex-1 min-h-0 min-w-0">
        {children({
          isFloating: true,
          isMaximized,
          onMinimize,
          onMaximize: onToggleMaximize,
          onHeaderPointerDown: handleHeaderPointerDown,
          onHeaderDoubleClick: handleHeaderDoubleClick,
        })}
      </div>
    </div>
  );
}
