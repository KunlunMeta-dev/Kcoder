import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadStorageContext, storageLocationFile } from './storage-paths.mjs';
import { acquireStorageInstance, loadStorageNative } from './storage-lease.mjs';
import { readStorageMigration } from './storage-startup.mjs';

const WRITERS = 'kcoder-storage-writers.lock', ID = 'active-startup';
const explicit = (home, root, consumer = 'cli', development = false) => loadStorageContext({ home, consumer, development,
  env: { KCODER_HOME: root, KCODER_CACHE_DIR: join(home, 'ExplicitCache'), KCODER_STUDIO_DATA_DIR: root,
    KCODER_STUDIO_DESKTOP_USER_DATA_DIR: root } });

if (process.argv[2] === '--owned-rust-active-probe') {
  const [home, target] = process.argv.slice(3), native = await loadStorageNative();
  for (const consumer of ['cli', 'gateway', 'desktop']) {
    await assert.rejects(acquireStorageInstance(await explicit(home, target, consumer), { native }), { code: 'STORAGE_MIGRATION_PENDING' });
  }
  console.log('active-operation-rust-probe-ok');
} else {
  async function fixture(t) {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'active-operation-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const native = await loadStorageNative();
    const { paths: from } = await loadStorageContext({ home, env: {}, consumer: 'desktop' });
    const target = { version: 1, revision: 1, dataRoot: join(home, 'Target'), cacheRoot: join(home, 'Cache'), operationId: ID };
    const directoryIdentity = async path => {
      await mkdir(path, { recursive: true });
      const lease = native.tryShared(path, WRITERS, false); assert.ok(lease);
      try { return JSON.parse(native.readSourceRetirement(lease, 'identity')).rootIdentity; }
      finally { native.close(lease); }
    };
    const sourceIdentity = await directoryIdentity(from.dataRoot);
    const targetIdentity = await directoryIdentity(target.dataRoot);
    await mkdir(target.cacheRoot);
    const receipt = { plan: { version: 1, operationId: ID, original: null, from, target,
      components: [{ domain: 'native', source: from.dataRoot, destination: target.dataRoot, sourceIdentity, estimatedBytes: 0 }],
      targetBindings: [{ path: target.dataRoot, existingAncestor: target.dataRoot, ancestorIdentity: targetIdentity }],
      launchIntent: 'verifyOnly' }, phase: 'prepared', disposition: 'active', ownerReceipts: {} };
    const controls = join(home, '.config', 'kcoder-storage-migrations'), operation = join(controls, ID);
    await mkdir(operation, { recursive: true });
    const current = join(controls, 'current.json'), archive = join(operation, 'receipt.json');
    await writeFile(current, JSON.stringify(ID));
    const save = () => writeFile(archive, JSON.stringify(receipt)); await save();
    const business = join(from.dataRoot, 'original-payload'); await writeFile(business, 'preserve exact source bytes');
    return { home, native, from, target, receipt, current, archive, operation, save, business, directoryIdentity };
  }

  test('explicit target roles and nested roots refuse Active after all executor leases are gone', async t => {
    for (const phase of ['prepared', 'committed']) {
      const f = await fixture(t); f.receipt.phase = phase; await f.save();
      for (const root of [f.target.dataRoot, join(f.target.dataRoot, 'Nested')]) {
        for (const consumer of ['cli', 'gateway', 'desktop']) {
          await assert.rejects(acquireStorageInstance(await explicit(f.home, root, consumer), { native: f.native }), { code: 'STORAGE_MIGRATION_PENDING' });
          await assert.rejects(readFile(join(root, 'settings.json')), { code: 'ENOENT' });
          const released = f.native.tryExclusive(root, WRITERS, false); assert.ok(released); f.native.close(released);
        }
      }
      f.receipt.phase = 'verified'; f.receipt.disposition = 'complete'; await f.save();
      const holder = await acquireStorageInstance(await explicit(f.home, f.target.dataRoot, 'desktop'), { native: f.native }); holder.close();
      assert.equal(await readFile(f.business, 'utf8'), 'preserve exact source bytes');
    }
  });

  test('valid unrelated Active scopes leave explicit dev and service paths and personal locator unchanged', async t => {
    const f = await fixture(t), locator = storageLocationFile(f.home);
    await writeFile(locator, 'unknown personal locator is not selected');
    for (const development of [false, true]) {
      const selected = await explicit(f.home, join(f.home, development ? 'Dev' : 'Service'), 'gateway', development);
      const holder = await acquireStorageInstance(selected, { native: f.native }); holder.verify(); holder.close();
    }
    assert.equal(await readFile(locator, 'utf8'), 'unknown personal locator is not selected');
    f.receipt.phase = 'prepared'; f.receipt.disposition = 'deferred'; f.receipt.errorCode = 'OWNED_CANCELLED'; await f.save();
    const original = await acquireStorageInstance(await explicit(f.home, f.from.dataRoot), { native: f.native }); original.close();
  });

  test('unknown global current or receipt metadata cannot be guessed unrelated and never reads the locator', async t => {
    for (const damage of ['current', 'missing-current', 'receipt', 'missing-receipt', 'future-publication']) {
      const f = await fixture(t);
      if (damage === 'current') await writeFile(f.current, 'unknown');
      else if (damage === 'missing-current') await rm(f.current);
      else if (damage === 'receipt') await writeFile(f.archive, 'unknown');
      else if (damage === 'missing-receipt') await rm(f.archive);
      else { f.receipt.ownerReceipts['publish-native'] = { version: 255 }; await f.save(); }
      const locator = storageLocationFile(f.home); await writeFile(locator, 'do not parse or replace this locator');
      const root = join(f.home, 'Unrelated'), selected = await explicit(f.home, root);
      await assert.rejects(acquireStorageInstance(selected, { native: f.native }), error =>
        /^STORAGE_(CONTROL_|COMPONENT_)/.test(error.code ?? '') || error.code === 'STORAGE_OPERATION_MISSING');
      assert.equal(await readFile(locator, 'utf8'), 'do not parse or replace this locator');
      await assert.rejects(readFile(join(root, 'settings.json')), { code: 'ENOENT' });
    }
  });

  test('real writer shares acquired before a later operation announcement still block its exclusive stop', async t => {
    const f = await fixture(t);
    await rm(join(f.home, '.config', 'kcoder-storage-migrations'), { recursive: true });
    const holder = await acquireStorageInstance(await explicit(f.home, f.from.dataRoot), { native: f.native });
    try {
      await mkdir(f.operation, { recursive: true }); await f.save(); await writeFile(f.current, JSON.stringify(ID));
      assert.equal(f.native.tryExclusive(f.from.dataRoot, WRITERS, false), null);
      assert.equal(await readFile(f.business, 'utf8'), 'preserve exact source bytes');
      await assert.rejects(acquireStorageInstance(await explicit(f.home, f.from.dataRoot), { native: f.native }), { code: 'STORAGE_MIGRATION_PENDING' });
    } finally { holder.close(); }
  });

  test('staging and final descendants retain the original identity after either directory is renamed', async t => {
    for (const [published, moved] of [[false, false], [false, true], [true, false], [true, true]]) {
      const f = await fixture(t), stage = join(f.home, `.kcoder-storage-${ID}-native`);
      const stagingIdentity = await f.directoryIdentity(stage);
      const targetParentIdentity = await f.directoryIdentity(f.home);
      const operationDirectoryIdentity = await f.directoryIdentity(f.operation);
      await rm(join(stage, WRITERS)); // No registered ancestor fence: use actual directory facts.
      f.receipt.phase = 'copying';
      f.receipt.plan.targetBindings = [{ path: f.target.dataRoot, existingAncestor: f.home, ancestorIdentity: targetParentIdentity }];
      f.receipt.ownerReceipts['publish-native'] = { version: 1, operationId: ID, domain: 'native',
        sourceIdentity: f.receipt.plan.components[0].sourceIdentity, destination: f.target.dataRoot,
        operationDirectoryIdentity, targetParentIdentity, stagingName: `.kcoder-storage-${ID}-native`, stagingIdentity };
      await f.save();
      const original = published ? f.target.dataRoot : stage;
      if (published) { await rm(f.target.dataRoot, { recursive: true }); await rename(stage, original); }
      const root = moved ? join(f.home, 'RenamedPublication') : original;
      if (moved) await rename(original, root);
      for (const own of [root, join(root, 'Nested')]) {
        await assert.rejects(acquireStorageInstance(await explicit(f.home, own), { native: f.native }), { code: 'STORAGE_MIGRATION_PENDING' });
      }
    }
  });

  test('cache-only Active scopes refuse the unchanged persistent root but never retire it', async t => {
    const f = await fixture(t);
    f.target.dataRoot = f.from.dataRoot;
    f.receipt.plan.components[0].destination = f.from.dataRoot;
    f.receipt.plan.targetBindings = [];
    await f.save();
    await assert.rejects(acquireStorageInstance(await explicit(f.home, f.from.dataRoot), { native: f.native }), { code: 'STORAGE_MIGRATION_PENDING' });
    f.receipt.phase = 'verified'; f.receipt.disposition = 'complete'; await f.save();
    const holder = await acquireStorageInstance(await explicit(f.home, f.from.dataRoot), { native: f.native }); holder.close();
    await assert.rejects(readFile(join(f.from.dataRoot, 'kcoder-storage-retired-native.json')), { code: 'ENOENT' });
  });

  test('the metadata reader creates nothing and does not read an unrelated corrupt locator', async t => {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'active-reader-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    assert.equal(await readStorageMigration(home), undefined);
    assert.deepEqual(await readdir(home), []);
    await mkdir(join(home, '.config')); await writeFile(storageLocationFile(home), 'unreadable personal selection');
    assert.equal(await readStorageMigration(home), undefined);
    assert.deepEqual(await readdir(join(home, '.config')), ['kcoder-storage.json']);
  });
}
