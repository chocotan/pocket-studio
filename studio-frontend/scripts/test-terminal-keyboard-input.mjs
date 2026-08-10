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
  const { handleRemoteControlV, isRemoteControlV } = await vite.ssrLoadModule(
    "/src/components/studio/terminal-keyboard-input.ts",
  );

  assert.equal(
    isRemoteControlV({ key: "v", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }),
    true,
    "Ctrl+V must be delivered to the remote terminal",
  );
  assert.equal(
    isRemoteControlV({ key: "V", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }),
    false,
    "Ctrl+Shift+V must remain the system clipboard shortcut",
  );
  assert.equal(
    isRemoteControlV({ key: "v", ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }),
    false,
    "Meta+V must not be treated as the remote Ctrl+V control key",
  );

  let prevented = 0;
  const inputs = [];
  const handled = handleRemoteControlV({
    key: "v",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {
      prevented += 1;
    },
  }, (data) => inputs.push(data));
  assert.equal(handled, true, "Ctrl+V must be handled before xterm's native key path");
  assert.equal(prevented, 1, "Ctrl+V must suppress the host clipboard paste");
  assert.deepEqual(inputs, ["\x16"], "Ctrl+V must send exactly one control character");

  const shiftHandled = handleRemoteControlV({
    key: "v",
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    preventDefault() {
      prevented += 1;
    },
  }, (data) => inputs.push(data));
  assert.equal(shiftHandled, false, "Ctrl+Shift+V must stay on the clipboard paste path");
  assert.equal(prevented, 1, "Ctrl+Shift+V must not be suppressed by the control-key handler");
  assert.deepEqual(inputs, ["\x16"], "Ctrl+Shift+V must not emit a terminal control character");

  console.log("terminal keyboard input tests: PASS");
} finally {
  await vite.close();
}
