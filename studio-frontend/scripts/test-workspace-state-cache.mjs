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

try {
  const cache = await vite.ssrLoadModule('/src/components/studio/hooks/workspace-state-cache.ts');

  let loadCalls = 0;
  let finishLoad;
  const firstLoad = cache.loadWorkspaceState('project-concurrent', () => {
    loadCalls += 1;
    return new Promise((resolve) => {
      finishLoad = resolve;
    });
  });
  const concurrentLoad = cache.loadWorkspaceState('project-concurrent', () => {
    loadCalls += 1;
    return Promise.resolve({ layoutTree: 'wrong' });
  });

  assert.strictEqual(concurrentLoad, firstLoad, 'concurrent loads must share one request');
  await Promise.resolve();
  finishLoad({ layoutTree: 'first' });
  assert.deepEqual(await firstLoad, { layoutTree: 'first' });
  assert.equal(loadCalls, 1);

  const cachedLoad = await cache.loadWorkspaceState('project-concurrent', () => {
    loadCalls += 1;
    return Promise.resolve({ layoutTree: 'wrong' });
  });
  assert.deepEqual(cachedLoad, { layoutTree: 'first' });
  assert.equal(loadCalls, 1, 'a cached project must not load again');

  cache.cacheWorkspaceState('project-concurrent', { layoutTree: 'edited' });
  assert.deepEqual(
    cache.readWorkspaceStateCache('project-concurrent'),
    { found: true, state: { layoutTree: 'edited' } },
    'local edits must replace the cached server state',
  );

  cache.cacheWorkspaceState('project-null', null);
  assert.deepEqual(
    cache.readWorkspaceStateCache('project-null'),
    { found: true, state: null },
    'an empty state is still a cache hit',
  );

  let retryCalls = 0;
  await assert.rejects(cache.loadWorkspaceState('project-retry', () => {
    retryCalls += 1;
    return Promise.reject(new Error('offline'));
  }));
  assert.deepEqual(
    await cache.loadWorkspaceState('project-retry', () => {
      retryCalls += 1;
      return Promise.resolve({ layoutTree: 'retry' });
    }),
    { layoutTree: 'retry' },
  );
  assert.equal(retryCalls, 2, 'a failed request must not poison future loads');

  console.log('workspace state cache tests: PASS');
} finally {
  await vite.close();
}
