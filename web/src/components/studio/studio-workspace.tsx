import React, { useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  Bot,
  Terminal as TerminalIcon,
  ArrowLeft,
  CircleDot,
  X,
} from "lucide-react";
import { XtermInstance } from "./xterm-instance";
import type { Project } from "./studio-dashboard";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* ─── Tree node types ──────────────────────────── */
export interface TerminalPane {
  type: "pane";
  id: string;
  title: string;
  termType: "bash" | "claude";
  focus: boolean;
}

export interface SplitGroup {
  type: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  children: LayoutNode[];
}

export type LayoutNode = TerminalPane | SplitGroup;

interface StudioWorkspaceProps {
  projectId: string;
  project: Project;
  onBackToDashboard: () => void;
}

/* ─── SVG Icons for the 4-way split actions ───── */
function SplitLeftIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <rect x="1.5" y="1.5" width="17" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="10" y1="2" x2="10" y2="18" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 10L5 8M5 8L3 10M5 8V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SplitRightIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <rect x="1.5" y="1.5" width="17" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="10" y1="2" x2="10" y2="18" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 10L15 8M15 8L17 10M15 8V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SplitTopIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <rect x="1.5" y="1.5" width="17" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 7L8 5M8 5L10 3M8 5H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SplitBottomIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <rect x="1.5" y="1.5" width="17" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 13L8 15M8 15L10 17M8 15H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Main Workspace Component ─────────────────── */
export function StudioWorkspace({
  projectId,
  project,
  onBackToDashboard,
}: StudioWorkspaceProps) {
  const [layoutTree, setLayoutTree] = useState<LayoutNode>({
    type: "pane",
    id: "pane-default",
    title: "Bash",
    termType: "bash",
    focus: true,
  });
  const [focusedId, setFocusedId] = useState<string>("pane-default");

  /* ── Tree helpers ── */
  function countPanes(node: LayoutNode): number {
    if (node.type === "pane") return 1;
    return node.children.reduce((a, c) => a + countPanes(c), 0);
  }

  function setFocusInTree(node: LayoutNode, id: string | null): LayoutNode {
    if (node.type === "pane") return { ...node, focus: node.id === id };
    return { ...node, children: node.children.map((c) => setFocusInTree(c, id)) };
  }

  function performSplit(
    node: LayoutNode,
    targetId: string,
    direction: "left" | "right" | "top" | "bottom",
    newPane: TerminalPane
  ): LayoutNode {
    if (node.type === "pane") {
      if (node.id !== targetId) return node;
      const isH = direction === "left" || direction === "right";
      const newFirst = direction === "left" || direction === "top";
      return {
        type: "split",
        id: `split-${Math.random().toString(36).slice(2)}`,
        orientation: isH ? "horizontal" : "vertical",
        children: newFirst ? [newPane, node] : [node, newPane],
      };
    }
    return { ...node, children: node.children.map((c) => performSplit(c, targetId, direction, newPane)) };
  }

  function removePane(node: LayoutNode, targetId: string): LayoutNode | null {
    if (node.type === "pane") return node.id === targetId ? null : node;
    const filtered = node.children
      .map((c) => removePane(c, targetId))
      .filter((c): c is LayoutNode => c !== null);
    if (filtered.length === 0) return null;
    if (filtered.length === 1) return filtered[0];
    return { ...node, children: filtered };
  }

  function firstPane(node: LayoutNode): TerminalPane {
    if (node.type === "pane") return node;
    return firstPane(node.children[0]);
  }

  /* ── Actions ── */
  function handleFocus(id: string) {
    setFocusedId(id);
    setLayoutTree((prev) => setFocusInTree(prev, id));
  }

  function handleSplit(paneId: string, dir: "left" | "right" | "top" | "bottom") {
    const newId = `pane-${Math.random().toString(36).slice(2)}`;
    const newPane: TerminalPane = {
      type: "pane",
      id: newId,
      title: "Bash",
      termType: "bash",
      focus: true,
    };
    setLayoutTree((prev) => {
      const unfocused = setFocusInTree(prev, null);
      return performSplit(unfocused, paneId, dir, newPane);
    });
    setFocusedId(newId);
  }

  function handleClose(paneId: string) {
    if (countPanes(layoutTree) <= 1) return;
    setLayoutTree((prev) => {
      const simplified = removePane(prev, paneId);
      if (!simplified) {
        return { type: "pane", id: "pane-default", title: "Bash", termType: "bash", focus: true };
      }
      if (focusedId === paneId) {
        const fp = firstPane(simplified);
        setFocusedId(fp.id);
        return setFocusInTree(simplified, fp.id);
      }
      return simplified;
    });
  }

  /* ── Renderer ── */
  function renderNode(node: LayoutNode): React.ReactNode {
    if (node.type === "pane") {
      return (
        <TerminalPaneView
          key={node.id}
          pane={node}
          totalPanes={countPanes(layoutTree)}
          onFocus={handleFocus}
          onSplit={handleSplit}
          onClose={handleClose}
          projectId={projectId}
        />
      );
    }

    const isH = node.orientation === "horizontal";
    return (
      <Group
        key={node.id}
        orientation={isH ? "horizontal" : "vertical"}
        style={{
          display: "flex",
          flexDirection: isH ? "row" : "column",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {node.children.map((child, i) => (
          <React.Fragment key={child.id || i}>
            {i > 0 && (
              <Separator
                className={isH ? "resize-handle-horizontal" : "resize-handle-vertical"}
              />
            )}
            <Panel
              minSize={10}
              style={{ position: "relative", overflow: "hidden", minWidth: 0, minHeight: 0 }}
            >
              {renderNode(child)}
            </Panel>
          </React.Fragment>
        ))}
      </Group>
    );
  }

  return (
    /* Full viewport — flex column so header + canvas stack */
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "var(--font-sans)",
      }}
      className="bg-[oklch(0.96_0.006_250)] select-none"
    >
      {/* ── Top Header ── */}
      <header className="shrink-0 h-12 bg-white/95 backdrop-blur-md border-b border-slate-200/70 flex items-center justify-between px-5 z-50 shadow-sm">
        {/* Left: Logo + project breadcrumb */}
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center shadow-md shadow-indigo-500/30 flex-shrink-0">
            <span className="text-white font-black text-[11px] leading-none">P</span>
          </div>
          <span className="font-bold text-slate-800 text-sm tracking-tight">Pocket Studio</span>
          <span className="px-2 py-0.5 text-[9px] uppercase font-bold tracking-widest bg-indigo-50 text-indigo-600 rounded border border-indigo-100">
            PRO
          </span>

          <div className="ml-2 h-4 w-px bg-slate-200" />

          <div className="flex items-center gap-1.5 text-xs text-slate-500 bg-slate-100/80 px-3 py-1 rounded-full border border-slate-200/60">
            <span className="font-semibold text-slate-700">Local</span>
            <span className="text-slate-300">/</span>
            <span className="text-indigo-600 font-semibold truncate max-w-[160px]">{project.name}</span>
          </div>
        </div>

        {/* Right: Status + Back */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <CircleDot className="h-3 w-3 text-emerald-500 animate-pulse" />
            <span className="text-[10px] text-slate-500 font-mono font-bold uppercase tracking-wider">
              Connected
            </span>
          </div>

          <button
            type="button"
            onClick={onBackToDashboard}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 border border-slate-200 hover:border-slate-300 shadow-sm font-semibold text-xs transition-all active:scale-95 duration-150 cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5 text-slate-400" />
            返回项目大厅
          </button>
        </div>
      </header>

      {/* ── Terminal Canvas — takes all remaining height ── */}
      <main
        style={{
          flex: "1 1 0",
          minHeight: 0,
          padding: "10px",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* This div fills main and is the root for the layout tree */}
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {renderNode(layoutTree)}
        </div>
      </main>
    </div>
  );
}

/* ─── Terminal Pane View ───────────────────────── */
function TerminalPaneView({
  pane,
  totalPanes,
  onFocus,
  onSplit,
  onClose,
  projectId,
}: {
  pane: TerminalPane;
  totalPanes: number;
  onFocus: (id: string) => void;
  onSplit: (id: string, dir: "left" | "right" | "top" | "bottom") => void;
  onClose: (id: string) => void;
  projectId: string;
}) {
  const isFocused = pane.focus;
  const isClaude = pane.termType === "claude";

  const splitActions = [
    { dir: "left"   as const, Icon: SplitLeftIcon,   label: "向左分割" },
    { dir: "right"  as const, Icon: SplitRightIcon,  label: "向右分割" },
    { dir: "top"    as const, Icon: SplitTopIcon,    label: "向上分割" },
    { dir: "bottom" as const, Icon: SplitBottomIcon, label: "向下分割" },
  ];

  return (
    /* Outer wrapper: fills the Panel container completely */
    <div
      onClick={() => onFocus(pane.id)}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: "12px",
      }}
      className={`transition-all duration-200 bg-white ${
        isFocused
          ? isClaude
            ? "border border-violet-300/70 shadow-[0_0_0_2px_rgba(139,92,246,0.10),0_6px_24px_rgba(139,92,246,0.08)]"
            : "border border-indigo-300/70 shadow-[0_0_0_2px_rgba(99,102,241,0.10),0_6px_24px_rgba(99,102,241,0.08)]"
          : "border border-slate-200/80 hover:border-slate-300/80 shadow-sm"
      }`}
    >
      {/* ── Header bar (fixed height 36px) ── */}
      <div
        style={{ height: 36, flexShrink: 0 }}
        className={`px-3 flex items-center justify-between gap-2 border-b ${
          isFocused ? "bg-slate-50 border-slate-200/80" : "bg-white border-slate-100"
        }`}
      >
        {/* Left: Icon + title + focus dot */}
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`h-5 w-5 rounded-md flex items-center justify-center flex-shrink-0 ${
              isFocused
                ? isClaude
                  ? "bg-violet-100 text-violet-600"
                  : "bg-indigo-100 text-indigo-600"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {isClaude ? <Bot className="h-3 w-3" /> : <TerminalIcon className="h-3 w-3" />}
          </div>
          <span className="text-[11px] font-mono font-bold text-slate-700 truncate">{pane.title}</span>
          {isFocused && (
            <span
              className={`h-1.5 w-1.5 rounded-full flex-shrink-0 animate-pulse ${
                isClaude ? "bg-violet-500" : "bg-indigo-500"
              }`}
            />
          )}
        </div>

        {/* Right: Split actions + close */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {splitActions.map(({ dir, Icon, label }) => (
            <Tooltip key={dir}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onSplit(pane.id, dir); }}
                    className="h-6 w-6 flex items-center justify-center rounded-md text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all duration-150 cursor-pointer"
                  />
                }
              >
                <Icon />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[10px] font-medium">
                {label}
              </TooltipContent>
            </Tooltip>
          ))}

          {totalPanes > 1 && (
            <>
              <div className="h-3.5 w-px bg-slate-200 mx-1" />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onClose(pane.id); }}
                      className="h-6 w-6 flex items-center justify-center rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-all duration-150 cursor-pointer"
                    />
                  }
                >
                  <X className="h-3 w-3" />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-[10px] font-medium">
                  关闭终端
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* ── Terminal canvas: fills remaining height ── */}
      <div style={{ flex: "1 1 0", minHeight: 0, position: "relative", background: "#fafafa" }}>
        <XtermInstance
          projectId={projectId}
          terminalId={pane.id}
          command={pane.termType}
          isActive={isFocused}
        />
      </div>
    </div>
  );
}
