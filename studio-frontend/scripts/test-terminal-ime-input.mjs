import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root,
  configFile: join(root, "vite.config.ts"),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { createTerminalImeCompositionGuard } = await vite.ssrLoadModule(
    "/src/components/studio/terminal-ime-input.ts",
  );
  const guard = createTerminalImeCompositionGuard();

  assert.equal(
    guard.shouldBypassXtermKeyEvent({ isComposing: true }),
    true,
    "composing punctuation must bypass xterm keydown handling",
  );
  assert.equal(
    guard.shouldBypassXtermKeyEvent({ isComposing: false }),
    false,
    "ordinary punctuation must keep using xterm keydown handling",
  );
  guard.start();
  assert.equal(
    guard.shouldBypassXtermKeyEvent({ isComposing: false }),
    true,
    "tracked composition must override an unreliable KeyboardEvent.isComposing value",
  );
  guard.end();
  assert.equal(
    guard.shouldBypassXtermKeyEvent({ isComposing: false }),
    false,
    "ordinary key handling must resume after composition ends",
  );

  console.log("terminal IME input tests: PASS");
} finally {
  await vite.close();
}
