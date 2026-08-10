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
  const { terminalImagePasteText } = await vite.ssrLoadModule(
    "/src/components/studio/terminal-image-paste.ts",
  );
  const temporaryPath = "/tmp/pocket-studio-paste-123/pasted_image.png";

  assert.equal(
    terminalImagePasteText("pi", temporaryPath),
    temporaryPath,
    "Pi must receive the absolute temporary image path",
  );
  assert.equal(
    terminalImagePasteText("claude", temporaryPath),
    `/image ${temporaryPath}`,
    "Claude must keep its image command with the temporary path",
  );
  assert.equal(
    terminalImagePasteText("kilo", temporaryPath),
    `/image ${temporaryPath}`,
    "Kilo must keep its image command with the temporary path",
  );

  console.log("terminal image paste tests: PASS");
} finally {
  await vite.close();
}
