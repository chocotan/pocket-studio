import { readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const terminalTypes = readFileSync(new URL("../src/components/studio/terminal-types.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/components/studio/studio-layout.ts", import.meta.url), "utf8");

assert(
  !terminalTypes.includes('"online"') && !terminalTypes.includes("在线类型"),
  "online terminal type should not be exposed in the frontend",
);
assert(
  layout.includes('newTerminalType: isTerminalKind(raw?.newTerminalType) ? raw.newTerminalType : "bash"'),
  "persisted terminal type sanitation should keep valid kinds and fall back to bash",
);
