import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type ShortcutAction = "panel.left" | "panel.right" | "panel.up" | "panel.down" | "panel.newRight";
export type DirectionalShortcutAction = Exclude<ShortcutAction, "panel.newRight">;
export type PanelDirection = "left" | "right" | "up" | "down";
export type ShortcutConfig = Partial<Record<ShortcutAction, string>>;

export const SHORTCUT_STORAGE_KEY = "pocket-studio-shortcuts";

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  "panel.left": "Ctrl+H",
  "panel.right": "Ctrl+L",
  "panel.up": "Ctrl+K",
  "panel.down": "Ctrl+J",
  "panel.newRight": "Ctrl+N",
};

export const PANEL_DIRECTIONS: Record<DirectionalShortcutAction, PanelDirection> = {
  "panel.left": "left",
  "panel.right": "right",
  "panel.up": "up",
  "panel.down": "down",
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  "panel.left": "切到左侧 Panel",
  "panel.right": "切到右侧 Panel",
  "panel.up": "切到上方 Panel",
  "panel.down": "切到下方 Panel",
  "panel.newRight": "右侧创建新 Panel",
};

export const SHORTCUT_ACTIONS = Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[];

export function loadShortcutConfig(): Record<ShortcutAction, string> {
  if (typeof window === "undefined") return DEFAULT_SHORTCUTS;
  try {
    const raw = window.localStorage.getItem(SHORTCUT_STORAGE_KEY);
    if (!raw) return DEFAULT_SHORTCUTS;
    const parsed = JSON.parse(raw) as ShortcutConfig;
    return {
      ...DEFAULT_SHORTCUTS,
      ...Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [ShortcutAction, string] => {
          const [action, value] = entry;
          return action in DEFAULT_SHORTCUTS && typeof value === "string" && value.trim() !== "";
        })
      ),
    };
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

export function saveShortcutConfig(config: Record<ShortcutAction, string>) {
  window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(config));
}

export function resetShortcutConfig() {
  window.localStorage.removeItem(SHORTCUT_STORAGE_KEY);
}

export function normalizeShortcut(value: string) {
  return value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeShortcutPart)
    .join("+");
}

export function shortcutFromEvent(event: KeyboardEvent | ReactKeyboardEvent) {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join("+");
}

export function shortcutFromParts(key: string, modifiers: Set<string>) {
  const parts: string[] = [];
  if (modifiers.has("Ctrl")) parts.push("Ctrl");
  if (modifiers.has("Alt")) parts.push("Alt");
  if (modifiers.has("Meta")) parts.push("Meta");
  if (modifiers.has("Shift")) parts.push("Shift");
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

function normalizeShortcutPart(part: string) {
  const lower = part.toLowerCase();
  if (lower === "cmd" || lower === "command" || lower === "meta") return "Meta";
  if (lower === "control") return "Ctrl";
  if (lower === "option") return "Alt";
  if (lower === "escape") return "Escape";
  if (lower === "space") return " ";
  if (lower.length === 1) return lower.toUpperCase();
  return part[0].toUpperCase() + part.slice(1);
}
