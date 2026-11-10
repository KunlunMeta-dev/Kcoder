import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPrivateResource, isProductionDependencyEntry } from '../scripts/stage-native-resources.mjs';

test('dependency staging excludes third-party tests without dropping runtime entries', () => {
  for (const name of ['test', 'tests', '__tests__', '__fixtures__', 'coverage']) {
    assert.equal(isProductionDependencyEntry(name, true), false, name);
  }
  for (const name of ['dijkstra.test.js', 'parser.spec.mjs', 'buffer.test.cjs']) {
    assert.equal(isProductionDependencyEntry(name, false), false, name);
  }
  for (const name of ['lib', 'dist', 'src', 'package.json', 'LICENSE', 'test-utils.js', 'dijkstra.js']) {
    assert.equal(isProductionDependencyEntry(name, name === 'lib' || name === 'dist' || name === 'src'), true, name);
  }
});

test('new runtime copies remove checkout group-write permissions while preserving source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-owned-stage-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.mjs'), destination = join(root, 'entry.mjs');
  await writeFile(source, 'export const owned = true', { mode: 0o664 });
  const before = (await stat(source)).mode;
  await copyPrivateResource(source, destination);
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.equal((await stat(source)).mode, before);
  await assert.rejects(copyPrivateResource(source, destination), { code: 'EEXIST' });
});
