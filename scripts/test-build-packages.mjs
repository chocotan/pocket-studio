#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontendPackage = JSON.parse(await readFile(join(root, 'studio-frontend', 'package.json'), 'utf8'));
const buildPackages = await readFile(join(root, 'scripts', 'build-packages.sh'), 'utf8');

for (const platform of ['linux', 'mac', 'win']) {
  const packageScript = frontendPackage.scripts[`package:electron:${platform}`];
  assert.ok(packageScript, `missing package:electron:${platform}`);
  assert.doesNotMatch(packageScript, /npm run build/, `package:electron:${platform} must reuse the existing dist`);
  assert.equal(
    frontendPackage.scripts[`build:electron:${platform}`],
    `npm run build && npm run package:electron:${platform}`,
  );
}

assert.match(buildPackages, /npm run "package:electron:\$\{PLATFORM\}"/);
assert.doesNotMatch(buildPackages, /npm run "build:electron:\$\{PLATFORM\}"/);

console.log('build-packages regression: PASS');
