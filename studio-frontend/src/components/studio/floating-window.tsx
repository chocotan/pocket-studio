/* eslint-disable react-hooks/refs */
import React, { useEffect, useRef, useState } from "react";

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
  scale?: number;
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

interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;

function frameFromDrag(drag: DragState, clientX: number, clientY: number, scale = 1): WindowFrame {
  const normalizedScale = scale > 0 ? scale : 1;
  const dx = (clientX - drag.startX) / normalizedScale;
  const dy = (clientY - drag.startY) / normalizedScale;

  if (drag.type === "drag") {
    return {
      x: drag.startLeft + dx,
      y: drag.startTop + dy,
      width: drag.startWidth,
      height: drag.startHeight,
    };
  }

  let nextLeft = drag.startLeft;
  let nextTop = drag.startTop;
  let nextWidth = drag.startWidth;
  let nextHeight = drag.startHeight;

  if (drag.direction?.includes("e")) {
    nextWidth = Math.max(MIN_WIDTH, drag.startWidth + dx);
  } else if (drag.direction?.includes("w")) {
    nextWidth = Math.max(MIN_WIDTH, drag.startWidth - dx);
    nextLeft = drag.startLeft + (drag.startWidth - nextWidth);
  }

  if (drag.direction?.includes("s")) {
    nextHeight = Math.max(MIN_HEIGHT, drag.startHeight + dy);
  } else if (drag.direction?.includes("n")) {
    nextHeight = Math.max(MIN_HEIGHT, drag.startHeight - dy);
    nextTop = drag.startTop + (drag.startHeight - nextHeight);
  }

  return {
    x: nextLeft,
    y: nextTop,
    width: nextWidth,
    height: nextHeight,
  };
}

function resizeDirectionFromPoint(
  container: HTMLDivElement,
  clientX: number,
  clientY: number
): NonNullable<DragState["direction"]> {
  const rect = container.getBoundingClientRect();
  const horizontal = clientX < rect.left + rect.width / 2 ? "w" : "e";
  const vertical = clientY < rect.top + rect.height / 2 ? "n" : "s";
  return `${vertical}${horizontal}` as NonNullable<DragState["direction"]>;
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
  scale = 1,
  onFocus,
  onUpdatePosition,
  onUpdateSize,
  onToggleMaximize,
  onMinimize,
  children,
}: FloatingWindowProps) {
  const dragStateRef = useRef<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragFrame, setDragFrame] = useState<WindowFrame | null>(null);
  const pendingFrameRef = useRef<WindowFrame | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  if (isMinimized) return null;

  const commitFrame = (frame: WindowFrame) => {
    setDragFrame(frame);
  };

  const scheduleFrame = (frame: WindowFrame) => {
    pendingFrameRef.current = frame;
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const pending = pendingFrameRef.current;
      pendingFrameRef.current = null;
      if (pending) commitFrame(pending);
    });
  };

  const handlePointerDown = (
    e: React.PointerEvent,
    actionType: "drag" | "resize",
    dir?: DragState["direction"]
  ) => {
    e.preventDefault();
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
    const startFrame = { x, y, width, height };
    pendingFrameRef.current = null;
    setDragFrame(startFrame);
  };

  const handleContainerPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 2 && e.metaKey && !isMaximized) {
      const container = containerRef.current;
      if (!container) return;
      handlePointerDown(e, "resize", resizeDirectionFromPoint(container, e.clientX, e.clientY));
      return;
    }
    if (e.button !== 0) return;
    if (!e.metaKey || isMaximized) {
      onFocus();
      return;
    }
    handlePointerDown(e, "drag");
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    scheduleFrame(frameFromDrag(drag, e.clientX, e.clientY, scale));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be released if the pointer left the window.
    }
    dragStateRef.current = null;

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const nextFrame = frameFromDrag(drag, e.clientX, e.clientY, scale);
    pendingFrameRef.current = null;
    setDragFrame(null);

    if (drag.type === "drag") {
      onUpdatePosition(nextFrame.x, nextFrame.y);
    } else if (drag.type === "resize" && drag.direction) {
      onUpdateSize(nextFrame.x, nextFrame.y, nextFrame.width, nextFrame.height);
    }
  };

  const handleHeaderPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
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

  const frame = dragFrame || { x, y, width, height };
  const isInteracting = Boolean(dragFrame);

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
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        zIndex,
        transition: isInteracting ? "none" : "transform 0.15s ease, width 0.15s ease, height 0.15s ease",
        willChange: isInteracting ? "left, top, width, height" : undefined,
        userSelect: isInteracting ? "none" : undefined,
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
      onContextMenu={handleContextMenu}
      className={`group/window flex flex-col overflow-hidden bg-card rounded-lg shadow-xl ${
        focused
          ? "ring-1 ring-primary/25"
          : "shadow-md"
      }`}
      onPointerDownCapture={handleContainerPointerDownCapture}
      onPointerDown={() => {
        onFocus();
      }}
    >
      {!isMaximized &&
        resizeZones.map(({ dir, className }) => (
          <div
            key={dir}
            className={className}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              handlePointerDown(e, "resize", dir);
            }}
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
