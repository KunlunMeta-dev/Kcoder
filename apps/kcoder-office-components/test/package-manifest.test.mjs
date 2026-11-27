import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink, readFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOfficePackageManifest } from '../src/package-manifest.mjs';

test('the package counts root bytes, retains its license and uses a stable filename order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'office-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules'));
  const files = { 'package.json': '{"name":"fixture","version":"1.0.0"}', 'package-lock.json': '{"packages":{}}',
    'README.md': 'fixture readme', 'LICENSE': 'fixture legal notice', 'src/cli.mjs': 'fixture entry', 'src/a.mjs': 'lowercase', 'src/A.mjs': 'uppercase' };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes);
  const manifest = await createOfficePackageManifest(root);
  assert.equal(manifest.totalBytes, Object.values(files).reduce((total, bytes) => total + Buffer.byteLength(bytes), 0));
  assert.deepEqual(manifest.files.map(file => file.path), ['LICENSE', 'README.md', 'package-lock.json', 'package.json', 'src/A.mjs', 'src/a.mjs', 'src/cli.mjs']);
  assert.equal(manifest.files.find(file => file.path === 'LICENSE')?.legal, true);
});

test('a source swapped to a symlink between lstat and open cannot enter the package manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'office-manifest-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  await writeFile(join(root, 'package-lock.json'), '{"packages":{}}'); await writeFile(join(root, 'README.md'), 'fixture');
  await writeFile(join(root, 'src/cli.mjs'), 'fixture entry');
  const target = join(root, 'src', 'entry.mjs'), outside = join(root, 'outside-fixture.txt');
  await writeFile(target, 'original'); await writeFile(outside, 'must not be read into a manifest');
  const original = fs.lstat; let swapped = false;
  const mocked = t.mock.method(fs, 'lstat', async (path, options) => {
    const result = await original(path, options);
    if (path === target && options?.bigint && !swapped) { swapped = true; await unlink(target); await symlink(outside, target); }
    return result;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(createOfficePackageManifest(root), { message: 'OFFICE_PACKAGE_UNSAFE_ENTRY' }); assert.equal(swapped, true); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('the package manifest CLI recognizes an invocation through a symlink', async t => {
  const root = await mkdtemp(join(tmpdir(), 'office-manifest-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'manifest.mjs'), output = join(root, 'manifest.json');
  await symlink(fileURLToPath(new URL('../src/package-manifest.mjs', import.meta.url)), entry);
  const result = spawnSync(process.execPath, [entry, '--output', output], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).entry, 'src/cli.mjs');
});
