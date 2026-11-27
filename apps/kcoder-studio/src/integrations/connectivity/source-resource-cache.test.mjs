import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, unlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSourceComponent, cleanupStaleSourceComponents, readSourceComponentMarker,
  releaseSourceComponent, sourceComponentKey } from './source-resource-cache.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kcoder-source-cache-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'channel-host'), parent = join(root, 'tmp');
  await mkdir(join(sourceRoot, 'src'), { recursive: true });
  await mkdir(parent);
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(sourceRoot, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(join(sourceRoot, 'src/entry.mjs'), 'export const value = 1;\n');
  const stageScript = join(sourceRoot, 'stage.mjs');
  await writeFile(stageScript, '// staging policy fixture\n');
  const staged = [];
  // Controlled staging: a tiny sealed component in the requested exclusive directory.
  const stage = async output => {
    await mkdir(output);
    const bytes = Buffer.from(`component ${staged.length}`);
    await writeFile(join(output, 'entry.mjs'), bytes);
    const manifest = Buffer.from(JSON.stringify({ files: [{ path: 'entry.mjs', bytes: bytes.length, sha256: sha(bytes) }] }) + '\n');
    await writeFile(join(output, 'channel-resource-manifest.json'), manifest);
    staged.push(output);
    return { componentRoot: output, manifestSha256: sha(manifest) };
  };
  return { root, sourceRoot, parent, stageScript, stage, staged };
}
const leaseCount = async handle => (await readdir(join(handle.owner, 'leases'))).length;

test('a valid keyed copy is reused across starts and each release removes only its own lease', async t => {
  const context = await fixture(t);
  const first = await acquireSourceComponent(context);
  const second = await acquireSourceComponent(context);
  assert.equal(context.staged.length, 1, 'the second start reuses the copy without staging');
  assert.equal(second.componentRoot, first.componentRoot);
  assert.equal(second.manifestSha256, first.manifestSha256);
  assert.equal(await leaseCount(first), 2);
  const marker = await readSourceComponentMarker(first.owner);
  assert.equal(marker.mode, 'shared');
  assert.equal(marker.sourceRoot, context.sourceRoot);
  await releaseSourceComponent(first);
  assert.equal(await leaseCount(first), 1);
  await releaseSourceComponent(second);
  await releaseSourceComponent(second);
  assert.equal(await leaseCount(first), 0);
  assert.ok((await lstat(first.componentRoot)).isDirectory());
});

test('source, lock or staging-policy changes select a new copy; the old one goes only after its leases end', async t => {
  const context = await fixture(t);
  const key = await sourceComponentKey(context.sourceRoot, context.stageScript);
  const old = await acquireSourceComponent(context);
  await writeFile(join(context.sourceRoot, 'src/entry.mjs'), 'export const value = 2;\n');
  assert.notEqual(await sourceComponentKey(context.sourceRoot, context.stageScript), key);
  const current = await acquireSourceComponent(context);
  assert.notEqual(current.owner, old.owner);
  assert.equal(context.staged.length, 2);
  // The older copy is still leased by this live process and stays.
  assert.ok((await lstat(old.componentRoot)).isDirectory());
  await releaseSourceComponent(old);
  await writeFile(join(context.sourceRoot, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
  const after = await acquireSourceComponent(context);
  await assert.rejects(lstat(old.owner), { code: 'ENOENT' });
  // The released current-key copy of the previous start is also stale now.
  await releaseSourceComponent(current);
  await releaseSourceComponent(after);
  await writeFile(context.stageScript, '// changed staging policy\n');
  const policy = await acquireSourceComponent(context);
  assert.notEqual(policy.owner, after.owner);
  await assert.rejects(lstat(current.owner), { code: 'ENOENT' });
  await releaseSourceComponent(policy);
});

test('cleanup never touches legacy, foreign-marker or live copies; dead staging is removed', async t => {
  const context = await fixture(t);
  const legacy = join(context.parent, 'kcoder-native-channel-resources-AbC123');
  await mkdir(join(legacy, 'component'), { recursive: true });
  const foreign = join(context.parent, 'kcoder-native-channel-resources-v2-0000000000000000-ffff');
  await mkdir(foreign);
  await writeFile(join(foreign, 'kcoder-owner.json'), JSON.stringify({ schemaVersion: 1,
    kind: 'kcoder-native-channel-source-resources', uid: process.getuid?.(), sourceRoot: '/another/checkout', key: 'x', mode: 'shared' }));
  const dead = join(context.parent, 'kcoder-native-channel-resources-stage-dead01');
  const live = join(context.parent, 'kcoder-native-channel-resources-ephemeral-live01');
  for (const [path, pid] of [[dead, 2 ** 30], [live, process.pid]]) {
    await mkdir(path);
    await writeFile(join(path, 'kcoder-owner.json'), JSON.stringify({ schemaVersion: 1,
      kind: 'kcoder-native-channel-source-resources', uid: process.getuid?.() ?? (await import('node:os')).userInfo().username,
      sourceRoot: context.sourceRoot, key: 'k', mode: path === dead ? 'staging' : 'ephemeral', pid }));
  }
  const isAlive = pid => pid === process.pid;
  const removed = await cleanupStaleSourceComponents({ sourceRoot: context.sourceRoot, key: 'current', parent: context.parent, isAlive });
  assert.deepEqual(removed, [dead]);
  for (const kept of [legacy, foreign, live]) assert.ok((await lstat(kept)).isDirectory(), kept);
});

test('a damaged unleased copy is restaged; a damaged leased copy falls back to a private ephemeral copy', async t => {
  const context = await fixture(t);
  const first = await acquireSourceComponent(context);
  await releaseSourceComponent(first);
  // Simulate temporary-directory aging removing a declared file.
  await unlink(join(first.componentRoot, 'entry.mjs'));
  const repaired = await acquireSourceComponent(context);
  assert.equal(repaired.owner, first.owner);
  assert.equal(context.staged.length, 2);
  await unlink(join(repaired.componentRoot, 'entry.mjs'));
  const fallback = await acquireSourceComponent(context);
  assert.equal(fallback.shared, false);
  assert.notEqual(fallback.owner, repaired.owner);
  assert.ok((await lstat(repaired.owner)).isDirectory(), 'a leased copy is never removed by another start');
  await releaseSourceComponent(fallback);
  await assert.rejects(lstat(fallback.owner), { code: 'ENOENT' });
  await releaseSourceComponent(repaired);
});
