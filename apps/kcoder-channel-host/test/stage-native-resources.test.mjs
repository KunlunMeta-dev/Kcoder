import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyResource, copyResources, isProductionDependencyEntry } from '../scripts/stage-native-resources.mjs';

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

test('runtime resources copy exclusively without changing the source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-owned-stage-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.mjs'), destination = join(root, 'entry.mjs');
  await writeFile(source, 'export const owned = true');
  await copyResource(source, destination);
  assert.equal(await readFile(destination, 'utf8'), 'export const owned = true');
  await assert.rejects(copyResource(source, destination), { code: 'EEXIST' });
});

test('bounded copies hash every destination and preserve the requested manifest order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-owned-stage-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = [];
  for (let index = 0; index < 13; index++) {
    const source = join(root, `source-${index}`), content = Buffer.alloc(65537 + index, index);
    await writeFile(source, content);
    resources.push({ source, path: `nested/${index}.mjs`, bytes: content.length });
  }
  const output = join(root, 'output');
  const files = await copyResources(resources, output);
  assert.deepEqual(files.map(file => file.path), resources.map(file => file.path));
  for (const file of files) {
    const destination = join(output, file.path), bytes = await readFile(destination);
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.deepEqual(Object.keys(file).sort(), ['bytes', 'path', 'sha256']);
  }
});

test('copy failure preserves an existing file and settles writes before owner cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-owned-stage-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), output = join(root, 'output');
  await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 42));
  await mkdir(output); await writeFile(join(output, '0'), 'preserved');
  await assert.rejects(copyResources(Array.from({ length: 12 }, (_, index) => ({
    source, path: String(index), bytes: 2 * 1024 * 1024,
  })), output), { code: 'EEXIST' });
  assert.equal(await readFile(join(output, '0'), 'utf8'), 'preserved');
  for (const name of (await readdir(output)).filter(name => name !== '0')) {
    assert.equal((await readFile(join(output, name))).length, 2 * 1024 * 1024);
  }
  await rm(output, { recursive: true });
});

test('four controlled copies are joined on failure without claiming more queued files', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-owned-stage-workers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await writeFile(source, 'bytes');
  const original = fs.copyFile, ready = Promise.withResolvers(), gates = [];
  const mocked = t.mock.method(fs, 'copyFile', async (...args) => {
    const gate = Promise.withResolvers(); gates.push(gate);
    if (gates.length === 4) ready.resolve();
    if (gates.length > 4) throw Error('Unexpected additional copy');
    await gate.promise;
    return original(...args);
  });
  syncBuiltinESMExports();
  let settled = false;
  const operation = copyResources(Array.from({ length: 9 }, (_, index) => ({
    source, path: String(index), bytes: 5,
  })), join(root, 'output')).finally(() => { settled = true; });
  const rejected = assert.rejects(operation, /controlled copy failure/);
  try {
    await ready.promise;
    assert.equal(gates.length, 4);
    gates[0].reject(Error('controlled copy failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'Owner cleanup must still wait for the other started copies');
    for (const gate of gates.slice(1)) gate.resolve();
    await rejected;
    assert.equal(gates.length, 4, 'Failure must prevent claiming another queued file');
  } finally {
    for (const gate of gates) gate.resolve();
    await operation.catch(() => {});
    mocked.mock.restore(); syncBuiltinESMExports();
  }
});

test('queued copies recheck source kind and size before opening a destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-owned-stage-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), output = join(root, 'output');
  await writeFile(source, 'bytes');
  await assert.rejects(copyResources([{ source, path: 'wrong-size', bytes: 1 }], output), /source changed/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    const link = join(root, 'link'); await symlink(source, link);
    await assert.rejects(copyResources([{ source: link, path: 'linked', bytes: 5 }], output), /source changed/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});
