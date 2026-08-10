type TerminalShortcutEvent = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;
type PreventableTerminalShortcutEvent = TerminalShortcutEvent & Pick<KeyboardEvent, "preventDefault">;

export function isRemoteControlV(event: TerminalShortcutEvent) {
  return event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !event.metaKey
    && event.key.toLowerCase() === "v";
}

export function handleRemoteControlV(event: PreventableTerminalShortcutEvent, input: (data: string) => void) {
  if (!isRemoteControlV(event)) return false;
  event.preventDefault();
  input("\x16");
  return true;
}
