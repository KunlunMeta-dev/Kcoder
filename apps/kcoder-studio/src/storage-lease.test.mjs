import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadStorageContext, storageLocationFile } from './storage-paths.mjs';
import { acquireStorageInstance, loadStorageNative } from './storage-lease.mjs';
import { prepareStorageBusinessStartup } from './migrations/storage-startup.mjs';

async function owned(t) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'storage-admission-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const native = await loadStorageNative();
  const record = { version: 1, revision: 1, dataRoot: join(home, 'Data'), cacheRoot: join(home, 'Cache') };
  await mkdir(join(home, '.config'));
  await mkdir(record.dataRoot);
  await writeFile(storageLocationFile(home), JSON.stringify(record));
  const selected = await loadStorageContext({ home, env: {}, consumer: 'desktop' });
  return { home, native, record, selected };
}

async function deferredLegacy(t, native, { corruptIdentity = false } = {}) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'storage-deferred-legacy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, '.config'), source = join(home, 'Registered-Native');
  await Promise.all([mkdir(config, { recursive: true }), mkdir(join(source, 'tmp'), { recursive: true })]);
  await writeFile(join(source, 'settings.json'), 'original');
  const writer = native.tryShared(source, 'kcoder-storage-writers.lock', false);
  assert.ok(writer);
  const actualIdentity = JSON.parse(native.readSourceRetirement(writer, 'identity')).rootIdentity;
  native.close(writer);
  const original = await loadStorageContext({ home, env: {}, consumer: 'desktop' });
  const from = { ...original.paths, dataRoot: source, cacheRoot: join(source, 'tmp'),
    temporaryRoot: join(source, 'tmp') };
  const operationId = 'installer-deferred-legacy-1';
  const receipt = { plan: { version: 1, operationId, original: null, from,
    target: { version: 1, revision: 1, dataRoot: join(home, 'Target-Data'),
      cacheRoot: join(home, 'Target-Cache'), operationId },
    components: [{ domain: 'persistent-root', source, destination: join(home, 'Target-Data'),
      sourceIdentity: corruptIdentity ? 'changed-source-identity' : actualIdentity, estimatedBytes: 0 }],
    targetBindings: [], launchIntent: 'desktop' },
    phase: 'copying', disposition: 'deferred', ownerReceipts: {}, errorCode: 'STORAGE_OPERATION_CANCELLED' };
  const controls = join(config, 'kcoder-storage-migrations'), operation = join(controls, operationId);
  await mkdir(operation, { recursive: true });
  await writeFile(join(controls, 'current.json'), JSON.stringify(operationId));
  await writeFile(join(operation, 'receipt.json'), JSON.stringify(receipt));
  return { home, source, receipt, selected: { ...original, paths: from, deferredReceipt: receipt } };
}

test('admission releases the short gate but holds instance and root OS leases through close', async t => {
  const f = await owned(t);
  const holder = await acquireStorageInstance(f.selected, { native: f.native });
  t.after(() => holder.close());
  holder.verify();
  const gate = f.native.tryExclusive(join(f.home, '.config'), 'kcoder-storage.lock', false);
  assert.ok(gate, 'an active instance must allow the coordinator to announce stopping');
  try {
    assert.equal(f.native.tryExclusive(join(f.home, '.config'), 'kcoder-storage-instances.lock', false), null);
    assert.equal(f.native.tryExclusive(f.record.dataRoot, 'kcoder-storage-writers.lock', false), null);
    assert.equal(f.native.tryExclusive(f.selected.paths.desktopRoot, 'kcoder-storage-writers.lock', false), null);
    await assert.rejects(acquireStorageInstance(f.selected, { native: f.native }), { code: 'STORAGE_MIGRATION_BUSY' });
  } finally { f.native.close(gate); }
  holder.close(); holder.close();
  assert.throws(() => holder.verify(), { code: 'STORAGE_INSTANCE_CLOSED' });
  for (const [root, name] of [[join(f.home, '.config'), 'kcoder-storage-instances.lock'],
    [f.record.dataRoot, 'kcoder-storage-writers.lock']]) {
    const lease = f.native.tryExclusive(root, name, false);
    assert.ok(lease);
    f.native.close(lease);
  }
});

test('a selection changed while acquiring admission is rejected without opening either business root', async t => {
  const f = await owned(t);
  const newRecord = { ...f.record, revision: 2, dataRoot: join(f.home, 'OtherData') };
  const native = { ...f.native, tryShared(root, name, create) {
    const lease = f.native.tryShared(root, name, create);
    if (name === 'kcoder-storage.lock') writeFileSync(storageLocationFile(f.home), JSON.stringify(newRecord));
    return lease;
  } };
  await assert.rejects(acquireStorageInstance(f.selected, { native }), { code: 'STORAGE_SELECTION_CHANGED' });
  await assert.rejects(readFile(join(f.record.dataRoot, 'kcoder-storage-writers.lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(newRecord.dataRoot, 'kcoder-storage-writers.lock')), { code: 'ENOENT' });
  const gate = f.native.tryExclusive(join(f.home, '.config'), 'kcoder-storage.lock', false);
  assert.ok(gate, 'failed admission must release its owned gate'); f.native.close(gate);
});

test('Deferred legacy admission compares the held Native root with the original component identity', async t => {
  const native = await loadStorageNative();
  const valid = await deferredLegacy(t, native);
  const instance = await acquireStorageInstance(valid.selected, { native });
  try {
    instance.verify();
    assert.equal(valid.selected.paths.dataRoot, valid.source);
    assert.equal(await readFile(join(valid.source, 'settings.json'), 'utf8'), 'original');
  } finally { instance.close(); }

  const replaced = await deferredLegacy(t, native, { corruptIdentity: true });
  await assert.rejects(acquireStorageInstance(replaced.selected, { native }), { code: 'STORAGE_SOURCE_CHANGED' });
  assert.equal(await readFile(join(replaced.source, 'settings.json'), 'utf8'), 'original');
});

test('Unified Deferred startup keeps the original selected root and takes its existing lease', async t => {
  const f = await owned(t), operationId = 'unified-deferred-original-1';
  const rootLease = f.native.tryShared(f.record.dataRoot, 'kcoder-storage-writers.lock', false);
  assert.ok(rootLease);
  const sourceIdentity = JSON.parse(f.native.readSourceRetirement(rootLease, 'identity')).rootIdentity;
  f.native.close(rootLease);
  const target = { version: 1, revision: f.selected.context.record.revision + 1,
    dataRoot: join(f.home, 'Target-Data'), cacheRoot: join(f.home, 'Target-Cache'), operationId };
  const receipt = { plan: { version: 1, operationId, original: f.selected.context.record,
    from: f.selected.paths, target, components: [{ domain: 'persistent-root', source: f.record.dataRoot,
      destination: target.dataRoot, sourceIdentity, estimatedBytes: 0 }], targetBindings: [], launchIntent: 'desktop' },
    phase: 'prepared', disposition: 'deferred', ownerReceipts: {}, errorCode: 'OWNED_CANCELLED' };
  const controls = join(f.home, '.config', 'kcoder-storage-migrations'), operation = join(controls, operationId);
  await mkdir(operation, { recursive: true });
  await writeFile(join(controls, 'current.json'), JSON.stringify(operationId));
  await writeFile(join(operation, 'receipt.json'), JSON.stringify(receipt));

  const selected = await loadStorageContext({ home: f.home, env: {}, consumer: 'desktop' });
  const prepared = await prepareStorageBusinessStartup({ selected,
    createClient() { assert.fail('Unified Deferred must not start a new migration'); } });
  const instance = await acquireStorageInstance(prepared, { native: f.native });
  try {
    instance.verify();
    assert.equal(prepared.paths.dataRoot, f.record.dataRoot);
    assert.equal(f.native.tryExclusive(f.record.dataRoot, 'kcoder-storage-writers.lock', false), null);
  } finally { instance.close(); }
});

test('an explicit nested Home cannot enter business while its ancestor is exclusively migrating', async t => {
  const f = await owned(t);
  const parent = f.native.tryExclusive(f.record.dataRoot, 'kcoder-storage-writers.lock', false);
  assert.ok(parent);
  const selected = await loadStorageContext({ home: f.home, consumer: 'gateway', env: {
    KCODER_HOME: join(f.record.dataRoot, 'Nested'), KCODER_CACHE_DIR: join(f.home, 'NestedCache'),
    KCODER_STUDIO_DATA_DIR: join(f.home, 'Gateway'),
  } });
  try {
    await assert.rejects(acquireStorageInstance(selected, { native: f.native }), { code: 'STORAGE_MIGRATION_BUSY' });
    await assert.rejects(readFile(join(selected.paths.dataRoot, 'settings.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(selected.paths.dataRoot), { code: 'ENOENT' });
  } finally { f.native.close(parent); }
  const holder = await acquireStorageInstance(selected, { native: f.native });
  try { holder.verify(); } finally { holder.close(); }
});

test('explicit instances keep peer shared root leases independent and never rewrite the locator', async t => {
  const f = await owned(t), before = await readFile(storageLocationFile(f.home));
  const selected = await loadStorageContext({ home: f.home, env: {
    KCODER_HOME: join(f.home, 'Explicit'), KCODER_CACHE_DIR: join(f.home, 'ExplicitCache'),
  }, consumer: 'gateway' });
  const first = await acquireStorageInstance(selected, { native: f.native });
  const second = await acquireStorageInstance(selected, { native: f.native });
  try {
    first.close();
    second.verify();
    assert.equal(f.native.tryExclusive(selected.paths.dataRoot, 'kcoder-storage-writers.lock', false), null);
    assert.deepEqual(await readFile(storageLocationFile(f.home)), before);
  } finally { first.close(); second.close(); }
});

test('cache-only admission refuses a real pending stage and releases its leases without changing the locator', async t => {
  const f = await owned(t), publication = await owned(t);
  const WRITERS = 'kcoder-storage-writers.lock', INSTANCES = 'kcoder-storage-instances.lock', CONTROL = 'kcoder-storage.lock';
  const cacheRoot = join(publication.home, '.kcoder-storage-cache-only-cache');
  await mkdir(cacheRoot);
  const peer = f.native.tryShared(cacheRoot, WRITERS, false); assert.ok(peer);
  t.after(() => f.native.close(peer));
  const controlDirectory = join(publication.home, '.config');
  const control = f.native.tryShared(controlDirectory, CONTROL, false); assert.ok(control);
  let controlIdentity;
  try { controlIdentity = JSON.parse(f.native.readSourceRetirement(control, 'control')).rootIdentity; }
  finally { f.native.close(control); }
  const rootIdentity = JSON.parse(f.native.readSourceRetirement(peer, 'identity')).rootIdentity;
  const marker = { version: 1, operationId: 'cache-only', domain: 'cache', rootIdentity, controlDirectory, controlIdentity };
  // Reuse the native private-file creator; an unfinished pending leaf grants no admission authority.
  const privateLeaf = f.native.tryShared(cacheRoot, INSTANCES, false); assert.ok(privateLeaf); f.native.close(privateLeaf);
  const pending = join(cacheRoot, 'kcoder-storage-pending.json');
  await rename(join(cacheRoot, INSTANCES), pending);
  await writeFile(pending, JSON.stringify(marker));
  const pendingBytes = await readFile(pending), locator = await readFile(storageLocationFile(f.home));
  assert.deepEqual(JSON.parse(JSON.parse(f.native.readSourceRetirement(peer, 'pending')).marker.text), marker);
  const selected = await loadStorageContext({ home: f.home, env: { KCODER_CACHE_DIR: cacheRoot }, consumer: 'desktop' });
  assert.equal(selected.paths.dataRoot, f.record.dataRoot);
  assert.equal(selected.paths.cacheRoot, cacheRoot);
  await assert.rejects(acquireStorageInstance(selected, { native: f.native }).then(instance => instance.close()),
    { code: 'STORAGE_MIGRATION_PENDING' });
  f.native.verify(peer);
  assert.deepEqual(await readFile(pending), pendingBytes);
  assert.deepEqual(await readFile(storageLocationFile(f.home)), locator);
  assert.equal(f.native.tryExclusive(cacheRoot, WRITERS, false), null, 'the independent peer share must remain held');
  f.native.close(peer);
  for (const [root, name] of [[join(f.home, '.config'), CONTROL], [join(f.home, '.config'), INSTANCES],
    [f.record.dataRoot, WRITERS], [selected.paths.gatewayRoot, WRITERS], [selected.paths.desktopRoot, WRITERS],
    [cacheRoot, WRITERS], [controlDirectory, CONTROL]]) {
    const released = f.native.tryExclusive(root, name, false);
    assert.ok(released, 'failed admission must release every lease it acquired');
    f.native.close(released);
  }
});
