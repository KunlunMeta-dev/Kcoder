import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import test from 'node:test';
import { loadStorageContext } from './storage-paths.mjs';
import { acquireStorageInstance, loadStorageNative } from './storage-lease.mjs';

const PRIMARY = 'kcoder-storage-writers.lock', SECONDARY = 'kcoder-storage-instances.lock';
const leaf = role => `kcoder-storage-retired-${role}.json`;

async function explicit(home, root, consumer = 'cli', gateway = root) {
  return loadStorageContext({ home, consumer, env: { KCODER_HOME: root, KCODER_CACHE_DIR: join(home, 'ExplicitCache'),
    KCODER_STUDIO_DATA_DIR: gateway, KCODER_STUDIO_DESKTOP_USER_DATA_DIR: root } });
}

if (process.argv[2] === '--owned-rust-probe') {
  const [home, source, target] = process.argv.slice(3);
  const native = await loadStorageNative();
  await assert.rejects(acquireStorageInstance(await explicit(home, source), { native }), { code: 'STORAGE_SOURCE_RETIRED' });
  const admitted = await acquireStorageInstance(await explicit(home, target), { native }); admitted.close();
  console.log('source-retirement-rust-probe-ok');
} else if (process.argv[2] === '--owned-pending-probe') {
  const [home, root, expected] = process.argv.slice(3);
  const native = await loadStorageNative();
  if (expected === 'allowed') {
    const instance = await acquireStorageInstance(await explicit(home, root), { native }); instance.close();
  } else {
    await assert.rejects(acquireStorageInstance(await explicit(home, root), { native }), { code: expected });
  }
  console.log('target-pending-rust-probe-ok');
} else {
  async function fixture(t, role = 'native') {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'source-retirement-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const selected = await loadStorageContext({ home, env: {}, consumer: 'cli' });
    const source = selected.paths.dataRoot;
    await mkdir(source, { recursive: true });
    const native = await loadStorageNative();
    const writer = native.tryShared(source, PRIMARY, false); assert.ok(writer);
    t.after(() => native.close(writer));
    const controlDirectory = join(home, '.config');
    const gate = native.tryShared(controlDirectory, 'kcoder-storage.lock', false); assert.ok(gate);
    const controlIdentity = JSON.parse(native.readSourceRetirement(gate, 'control')).rootIdentity; native.close(gate);
    const rootIdentity = JSON.parse(native.readSourceRetirement(writer, role)).rootIdentity;
    const targetData = role === 'native' ? join(home, 'Target') : source;
    const targetRoot = role === 'native' ? targetData : join(targetData, 'studio', role);
    await mkdir(targetRoot, { recursive: true });
    const marker = { version: 1, operationId: 'original', role, sourceRoot: source, sourceIdentity: rootIdentity,
      targetRoot, selectionRevision: 1, controlDirectory, controlIdentity };
    // The owned fixture uses the same ordinary OS defaults as production.
    // Renaming a closed empty fixture lock grants no authority.
    const temporary = native.tryShared(source, SECONDARY, false); assert.ok(temporary); native.close(temporary);
    await rename(join(source, SECONDARY), join(source, leaf(role)));
    const text = JSON.stringify(marker); await writeFile(join(source, leaf(role)), text);
    const observed = JSON.parse(native.readSourceRetirement(writer, role));
    const target = { version: 1, revision: 1, dataRoot: targetData, cacheRoot: join(home, 'TargetCache'), operationId: 'original' };
    const from = { ...selected.paths };
    if (role === 'gateway') from.gatewayRoot = source;
    if (role === 'desktop') from.desktopRoot = source;
    const receipt = { plan: { version: 1, operationId: 'original', original: null, from, target,
      components: [{ domain: role, source, destination: targetRoot, sourceIdentity: rootIdentity, estimatedBytes: 0 }],
      targetBindings: [], launchIntent: 'verifyOnly' }, phase: 'verified', disposition: 'complete', errorCode: null,
      ownerReceipts: { [`source-retirement-${role}`]: { version: 1, marker, markerIdentity: observed.marker.identity,
        markerSha256: createHash('sha256').update(text).digest('hex'), cleaned: false } } };
    const operation = join(controlDirectory, 'kcoder-storage-migrations', 'original'); await mkdir(operation, { recursive: true });
    const archive = join(operation, 'receipt.json'); await writeFile(archive, JSON.stringify(receipt));
    await writeFile(join(controlDirectory, 'kcoder-storage-migrations', 'current.json'), JSON.stringify('original'));
    const business = join(source, 'original-identity-and-task-bytes'); await writeFile(business, 'preserve exact business bytes');
    return { home, native, writer, source, targetData, targetRoot, marker, receipt, archive, business };
  }

  test('explicit Native/Gateway/Desktop refuse a retired source without touching its business bytes', async t => {
    const f = await fixture(t);
    for (const consumer of ['cli', 'gateway', 'desktop']) {
      await assert.rejects(acquireStorageInstance(await explicit(f.home, f.source, consumer), { native: f.native }), { code: 'STORAGE_SOURCE_RETIRED' });
    }
    assert.equal(await readFile(f.business, 'utf8'), 'preserve exact business bytes');
    const current = await acquireStorageInstance(await explicit(f.home, f.targetData), { native: f.native }); current.close();
  });

  test('retired Gateway role leaves in-place Native and the new Gateway child directory available', async t => {
    const f = await fixture(t, 'gateway');
    const native = await acquireStorageInstance(await explicit(f.home, f.source), { native: f.native }); native.close();
    await assert.rejects(acquireStorageInstance(await explicit(f.home, f.source, 'gateway'), { native: f.native }), { code: 'STORAGE_SOURCE_RETIRED' });
    const current = await acquireStorageInstance(await explicit(f.home, f.source, 'gateway', f.targetRoot), { native: f.native }); current.close();
  });

  test('an original archive decides source refusal even when current points to a later operation', async t => {
    const f = await fixture(t);
    await writeFile(join(f.marker.controlDirectory, 'kcoder-storage-migrations', 'current.json'), JSON.stringify('later-operation'));
    await mkdir(join(f.marker.controlDirectory, 'kcoder-storage-migrations', 'later-operation'));
    await writeFile(join(f.marker.controlDirectory, 'kcoder-storage-migrations', 'later-operation', 'receipt.json'), 'corrupt unrelated archive');
    await writeFile(join(f.marker.controlDirectory, 'kcoder-storage.json'), 'corrupt personal locator');
    await assert.rejects(acquireStorageInstance(await explicit(f.home, f.source), { native: f.native }), { code: 'STORAGE_SOURCE_RETIRED' });
  });

  test('missing or damaged original receipts fail closed', async t => {
    for (const damage of [false, true]) {
      const f = await fixture(t);
      if (damage) await writeFile(f.archive, 'damaged'); else await rm(f.archive);
      await assert.rejects(acquireStorageInstance(await explicit(f.home, f.source), { native: f.native }));
      assert.equal(await readFile(f.business, 'utf8'), 'preserve exact business bytes');
    }
  });

  test('normalized declared component paths still bind the same original source role', async t => {
    const f = await fixture(t);
    f.receipt.plan.components[0].source = f.source + sep + '..' + sep + basename(f.source);
    await writeFile(f.archive, JSON.stringify(f.receipt));
    await assert.rejects(acquireStorageInstance(await explicit(f.home, f.source), { native: f.native }), { code: 'STORAGE_SOURCE_RETIRED' });
  });

  test('unknown marker bytes or a marker copied to another root cannot establish admission facts', async t => {
    const f = await fixture(t);
    const original = await readFile(join(f.source, leaf('native')));
    await writeFile(join(f.source, leaf('native')), 'unknown persistent payload');
    await assert.rejects(acquireStorageInstance(await explicit(f.home, f.source), { native: f.native }), { code: 'STORAGE_SOURCE_RETIREMENT_INVALID' });
    assert.equal(await readFile(join(f.source, leaf('native')), 'utf8'), 'unknown persistent payload');
    const other = join(f.home, 'Other'); await mkdir(other);
    const privateLeaf = f.native.tryShared(other, SECONDARY, false); f.native.close(privateLeaf);
    await rename(join(other, SECONDARY), join(other, leaf('native'))); await writeFile(join(other, leaf('native')), original);
    await assert.rejects(acquireStorageInstance(await explicit(f.home, other), { native: f.native }), { code: 'STORAGE_SOURCE_RETIREMENT_INVALID' });
  });

  test('NAPI fixed-leaf reads reject forged/closed leases and arbitrary leaf selection', async t => {
    const f = await fixture(t);
    assert.throws(() => f.native.readSourceRetirement({}, 'native'), { code: 'NATIVE_STORAGE_HANDLE_INVALID' });
    assert.throws(() => f.native.readSourceRetirement(f.writer, '../credentials.json'), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
    assert.throws(() => f.native.readSourceRetirement(f.writer, 'control'), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
    assert.throws(() => f.native.readSourceRetirement(f.writer, 'operation:original'), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
    const gate = f.native.tryShared(f.marker.controlDirectory, 'kcoder-storage.lock', false);
    try {
      assert.throws(() => f.native.readSourceRetirement(gate, 'operation:../credentials.json'), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
      assert.throws(() => f.native.readSourceRetirement(gate, 'pending'), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
    } finally { f.native.close(gate); }
    f.native.close(f.writer);
    assert.throws(() => f.native.readSourceRetirement(f.writer, 'native'), { code: 'NATIVE_STORAGE_LEASE_CLOSED' });
  });
}
