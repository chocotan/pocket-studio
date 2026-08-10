export function terminalImagePasteText(command: string, path: string) {
  const normalizedCommand = command.toLowerCase();
  if (normalizedCommand.includes("claude") || normalizedCommand.includes("agy") || normalizedCommand.includes("kilo")) {
    return `/image ${path}`;
  }
  return path;
}
