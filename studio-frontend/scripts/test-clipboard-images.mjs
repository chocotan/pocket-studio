import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({
  root,
  configFile: join(root, 'vite.config.ts'),
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

const image = { name: 'clipboard.png', type: 'image/png', size: 8, lastModified: 1 };
const fallbackImage = { name: 'fallback.jpg', type: 'image/jpeg', size: 12, lastModified: 2 };
const textFile = { name: 'notes.txt', type: 'text/plain', size: 5, lastModified: 3 };

try {
  const { imageFilesFromClipboard } = await vite.ssrLoadModule(
    '/src/components/studio/agent-chat/clipboard-images.ts',
  );

  assert.deepEqual(
    imageFilesFromClipboard({
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => image },
      ],
      files: [],
    }),
    [image],
    'clipboard image items must work even when FileList is empty',
  );

  assert.deepEqual(
    imageFilesFromClipboard({ items: [], files: [fallbackImage, textFile] }),
    [fallbackImage],
    'FileList must remain a fallback and non-images must be ignored',
  );

  assert.deepEqual(
    imageFilesFromClipboard({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
      files: [fallbackImage],
    }),
    [fallbackImage],
    'an unavailable clipboard item must fall back to FileList',
  );

  console.log('clipboard image tests: PASS');
} finally {
  await vite.close();
}
