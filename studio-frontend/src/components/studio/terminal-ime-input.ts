export function createTerminalImeCompositionGuard() {
  let compositionActive = false;

  return {
    start() {
      compositionActive = true;
    },
    end() {
      compositionActive = false;
    },
    shouldBypassXtermKeyEvent(event: Pick<KeyboardEvent, "isComposing">) {
      return compositionActive || event.isComposing;
    },
  };
}
