import React from "react";
import { Globe2, Terminal as TerminalIcon } from "lucide-react";
import { Antigravity, ClaudeCode, Codex, KiloCode, OpenCode } from "@lobehub/icons/es/icons";

export type TerminalKind = "bash" | "claude" | "codex" | "opencode" | "kilo" | "pi" | "agy" | "online";
export type SplitDirection = "left" | "right" | "top" | "bottom";
export type TerminalAccent = "indigo" | "violet" | "emerald" | "amber" | "cyan" | "rose" | "lime";
export type TerminalTitleSource = "initial" | "tmux";
export type StudioTheme = "light" | "claude" | "dark" | "synthwave" | "onedark";

export interface TerminalTitleState {
  title: string;
  fullTitle?: string;
  command: string;
  source: TerminalTitleSource;
}

export interface TerminalTypeDefinition {
  value: TerminalKind;
  label: string;
  title: string;
  command: string;
  accent: TerminalAccent;
  logo: React.ReactNode;
}

export const TERMINAL_TYPES: TerminalTypeDefinition[] = [
  { value: "bash", label: "普通终端", title: "Shell", command: "", accent: "indigo", logo: <TerminalIcon className="h-3 w-3" /> },
  { value: "claude", label: "Claude Code", title: "Claude Code", command: "claude", accent: "violet", logo: <ClaudeCode width={14} height={14} /> },
  { value: "codex", label: "Codex", title: "Codex", command: "codex", accent: "emerald", logo: <Codex width={14} height={14} /> },
  { value: "opencode", label: "OpenCode", title: "OpenCode", command: "opencode", accent: "amber", logo: <OpenCode width={14} height={14} /> },
  { value: "kilo", label: "Kilo Code", title: "Kilo Code", command: "kilo", accent: "lime", logo: <KiloCode width={14} height={14} /> },
  { value: "pi", label: "Pi", title: "Pi", command: "pi", accent: "cyan", logo: <span className="text-[10px] font-black leading-none">π</span> },
  { value: "agy", label: "Antigravity", title: "Antigravity", command: "agy", accent: "rose", logo: <Antigravity width={14} height={14} /> },
  { value: "online", label: "在线类型", title: "在线类型", command: "online", accent: "cyan", logo: <Globe2 className="h-3 w-3" /> },
];

export function terminalType(value: TerminalKind) {
  return TERMINAL_TYPES.find((item) => item.value === value) || TERMINAL_TYPES[0];
}

export function terminalTypeFromCommand(command: string, fallback: TerminalKind): TerminalKind {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "online" || normalized === "acpx" || normalized.startsWith("acpx ")) return "online";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("kilo")) return "kilo";
  if (normalized === "pi" || normalized.startsWith("pi-")) return "pi";
  if (normalized.includes("agy") || normalized.includes("antigravity")) return "agy";
  return fallback;
}

export function isTerminalKind(value: unknown): value is TerminalKind {
  return typeof value === "string" && TERMINAL_TYPES.some((item) => item.value === value);
}

export function makeId(prefix: string) {
  const randomId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}

export function cleanTerminalTitle(title: string, fallback: string, kind?: TerminalKind): string {
  void kind;
  const normalized = title.trim();
  if (!normalized) return fallback;

  const quotedPocketTitle = extractQuotedPocketTitle(normalized);
  if (quotedPocketTitle) return quotedPocketTitle;

  return normalized;
}

export function isPlaceholderTerminalTitle(title: string, command?: string) {
  const normalizedTitle = cleanTerminalTitle(title, "");
  const normalizedCommand = (command || "").trim();
  if (!normalizedTitle) return true;
  if (/^(term|pane|panel)-[a-z0-9_-]+$/i.test(normalizedTitle)) return true;
  if (normalizedCommand && normalizedTitle === normalizedCommand) return true;
  return false;
}

function extractQuotedPocketTitle(title: string) {
  if (!title.startsWith("pocket-studio-")) return "";
  const matches = Array.from(title.matchAll(/"([^"]+)"/g));
  const quoted = matches.at(-1)?.[1]?.trim();
  return quoted || "";
}
