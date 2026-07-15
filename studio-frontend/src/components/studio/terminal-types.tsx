import React from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import type { Device, DeviceAgent } from "@/lib/types";
import {
  Antigravity,
  ClaudeCode,
  Codex,
  Cursor,
  GithubCopilot,
  KiloCode,
  Kimi,
  OpenClaw,
  OpenCode,
  Qwen,
} from "@lobehub/icons/es/icons";

export type TerminalKind = "bash" | "claude" | "codex" | "opencode" | "kilo" | "pi" | "agy" | "qwen" | "kimi" | "copilot" | "cursor" | "openclaw";
export type SplitDirection = "left" | "right" | "top" | "bottom";
export type TerminalAccent = "indigo" | "violet" | "emerald" | "amber" | "cyan" | "rose" | "lime" | "sky" | "slate";
export type TerminalTitleSource = "initial" | "tmux";
export type StudioTheme = "light" | "claude" | "sandalwood" | "dark" | "synthwave" | "onedark" | "charcoal";

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
  { value: "qwen", label: "Qwen Code", title: "Qwen Code", command: "qwen", accent: "cyan", logo: <Qwen width={14} height={14} /> },
  { value: "kimi", label: "Kimi", title: "Kimi", command: "kimi", accent: "sky", logo: <Kimi width={14} height={14} /> },
  { value: "copilot", label: "GitHub Copilot", title: "GitHub Copilot", command: "copilot", accent: "emerald", logo: <GithubCopilot width={14} height={14} /> },
  { value: "cursor", label: "Cursor Agent", title: "Cursor Agent", command: "cursor-agent", accent: "slate", logo: <Cursor width={14} height={14} /> },
  { value: "openclaw", label: "OpenClaw", title: "OpenClaw", command: "openclaw", accent: "rose", logo: <OpenClaw width={14} height={14} /> },
];

export function terminalType(value: TerminalKind) {
  return TERMINAL_TYPES.find((item) => item.value === value) || TERMINAL_TYPES[0];
}

export function agentNameForRuntime(agentKind: string | undefined, _agentRuntime: "direct_acp" | undefined) {
  return normalizeAgentKind(agentKind);
}

export function terminalKindFromAgentKind(agentKind: string | undefined): TerminalKind {
  const normalized = normalizeAgentKind(agentKind);
  if (normalized === "kilocode" || normalized === "kilo-code") return "kilo";
  if (normalized === "claude_code" || normalized === "claude-code") return "claude";
  if (normalized === "antigravity") return "agy";
  return isTerminalKind(normalized) ? normalized : "opencode";
}

function normalizeAgentKind(agentKind: string | undefined) {
  const normalized = (agentKind || "opencode").trim().toLowerCase();
  return normalized || "opencode";
}

export function availableTerminalTypes(device: Device | undefined) {
  return TERMINAL_TYPES.filter((item) => item.value === "bash" || agentAvailable(device, item.value));
}

export function agentAvailable(device: Device | undefined, kind: TerminalKind) {
  if (kind === "bash") return true;
  return agentCapabilityAvailable(device, agentCapabilityNameForTerminalKind(kind));
}

export function agentCapabilityAvailable(device: Device | undefined, capability: string) {
  if (!device) return false;
  if (!Array.isArray(device.agents)) return false;
  const wanted = normalizeAgentCapabilityName(capability);
  return device.agents.some((agent) => normalizeDeviceAgentName(agent) === wanted);
}

export function agentCapabilityNameForTerminalKind(kind: TerminalKind) {
  switch (kind) {
    case "bash":
      return "";
    case "kilo":
      return "kilocode";
    case "agy":
      return "antigravity";
    default:
      return kind;
  }
}

function normalizeDeviceAgentName(agent: DeviceAgent) {
  return normalizeAgentCapabilityName(agent.name);
}

function normalizeAgentCapabilityName(value: string | undefined) {
  const normalized = (value || "").trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "claude-code":
      return "claude";
    case "kilo":
    case "kilo-code":
      return "kilocode";
    case "agy":
      return "antigravity";
    case "cursor-agent":
      return "cursor";
    case "github-copilot":
      return "copilot";
    case "open-claw":
      return "openclaw";
    default:
      return normalized;
  }
}

export function terminalTypeFromCommand(command: string, fallback: TerminalKind): TerminalKind {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized.includes("cursor-agent") || normalized === "cursor" || normalized.startsWith("cursor ")) return "cursor";
  if (normalized === "copilot" || normalized.startsWith("copilot ")) return "copilot";
  if (normalized.includes("openclaw")) return "openclaw";
  if (normalized === "qwen" || normalized.startsWith("qwen ") || normalized.includes("qwen --acp")) return "qwen";
  if (normalized === "kimi" || normalized.startsWith("kimi ")) return "kimi";
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
  if (!normalizedTitle) return true;
  const lowerTitle = normalizedTitle.toLowerCase();
  if (lowerTitle === "xterm" || lowerTitle === "xterm-256color" || lowerTitle === "tmux" || lowerTitle === "tmux-256color" || lowerTitle === "screen" || lowerTitle === "screen-256color") return true;
  if (/^(term|pane|panel)-[a-z0-9_-]+$/i.test(normalizedTitle)) return true;
  const normalizedCommand = (command || "").trim();
  if (normalizedCommand && normalizedTitle === normalizedCommand) return true;
  const commandTitle = knownTerminalTitleForCommand(normalizedCommand);
  if (commandTitle && isDefaultTerminalTitle(normalizedTitle) && normalizedTitle !== commandTitle) return true;
  return false;
}

function knownTerminalTitleForCommand(command: string) {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "bash" || normalized === "zsh" || normalized === "sh") return "Shell";
  if (normalized === "online") return "ACP";
  if (normalized.includes("claude")) return "Claude Code";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("cursor-agent") || normalized === "cursor" || normalized.startsWith("cursor ")) return "Cursor Agent";
  if (normalized === "copilot" || normalized.startsWith("copilot ")) return "GitHub Copilot";
  if (normalized.includes("openclaw")) return "OpenClaw";
  if (normalized === "qwen" || normalized.startsWith("qwen ")) return "Qwen Code";
  if (normalized === "kimi" || normalized.startsWith("kimi ")) return "Kimi";
  if (normalized.includes("opencode")) return "OpenCode";
  if (normalized.includes("kilo")) return "Kilo Code";
  if (normalized === "pi" || normalized.startsWith("pi ")) return "Pi";
  if (normalized === "agy" || normalized.includes("antigravity")) return "Antigravity";
  return "";
}

function isDefaultTerminalTitle(title: string) {
  return ["Shell", "Claude Code", "Codex", "OpenCode", "Kilo Code", "Pi", "Antigravity", "Qwen Code", "Kimi", "GitHub Copilot", "Cursor Agent", "OpenClaw", "ACP"].includes(title);
}

function extractQuotedPocketTitle(title: string) {
  if (!title.startsWith("pocket-studio-")) return "";
  const matches = Array.from(title.matchAll(/"([^"]+)"/g));
  const quoted = matches.at(-1)?.[1]?.trim();
  return quoted || "";
}
