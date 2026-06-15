import { readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const terminalTypes = readFileSync(new URL("../src/components/studio/terminal-types.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/components/studio/studio-layout.ts", import.meta.url), "utf8");

assert(
  terminalTypes.includes('"agy" | "online"'),
  "TerminalKind should include online",
);
assert(
  terminalTypes.includes('{ value: "online", label: "在线类型", title: "在线类型", command: "online"'),
  "online terminal definition should use the daemon sentinel command",
);
assert(
  terminalTypes.includes('normalized === "online" || normalized === "acpx" || normalized.startsWith("acpx ")'),
  "online/acpx commands should resolve to the online terminal kind",
);
assert(
  layout.includes('newTerminalType: isTerminalKind(raw?.newTerminalType) ? raw.newTerminalType : "bash"'),
  "persisted terminal type sanitation should keep valid kinds and fall back to bash",
);
