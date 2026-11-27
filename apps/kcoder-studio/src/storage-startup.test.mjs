import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStorageStartupReady, readStorageMigration } from './storage-startup.mjs';
import { loadStorageContext, readStorageLocationRecord, resolveStoragePaths, storageLocationFile } from './storage-paths.mjs';
import { prepareStorageBusinessStartup } from './migrations/storage-startup.mjs';

const operationId = 'startup-operation-1';

async function fixture(t, { selected = null, receipt, current = operationId, writeCurrent = true,
  createOperationDirectory = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const config = join(home, '.config');
  await mkdir(config, { recursive: true });
  if (selected) await writeFile(storageLocationFile(home), JSON.stringify(selected));
  const paths = resolveStoragePaths({ home, platformConfig: join(home, 'platform-config'),
    record: selected, consumer: 'desktop' });
  await mkdir(paths.dataRoot, { recursive: true });
  const context = { version: 1, home, platformConfig: join(home, 'platform-config'), overrides: {},
    record: selected, consumer: 'desktop', development: false };
  if (writeCurrent || receipt !== undefined) {
    const controls = join(config, 'kcoder-storage-migrations');
    await mkdir(controls, { recursive: true });
    if (writeCurrent && current !== null) {
      await writeFile(join(controls, 'current.json'), JSON.stringify(current));
    } else if (writeCurrent) {
      await writeFile(join(controls, 'current.json'), 'null');
    }
    if (receipt !== undefined || createOperationDirectory) {
      const operation = join(controls, current);
      await mkdir(operation, { recursive: true });
      if (receipt !== undefined) await writeFile(join(operation, 'receipt.json'), JSON.stringify(receipt));
    }
  }
  return { root, home, config, context, paths };
}

function records(root) {
  const original = { version: 1, revision: 4, dataRoot: join(root, 'previous-data'), cacheRoot: join(root, 'previous-cache') };
  const target = { version: 1, revision: 5, dataRoot: join(root, 'selected-data'),
    cacheRoot: join(root, 'selected-cache'), operationId };
  return { original, target };
}

function completeReceipt(root, { disposition = 'complete', phase = 'verified', errorCode } = {}) {
  const { original, target } = records(root);
  const from = resolveStoragePaths({ home: join(root, 'home'), platformConfig: join(root, 'platform-config'),
    record: original, consumer: 'desktop' });
  return { plan: { version: 1, operationId, original, from, target, components: [], targetBindings: [], launchIntent: 'desktop' },
    phase, disposition, ownerReceipts: { desktop: { published: true } },
    ...(errorCode === undefined ? {} : { errorCode }) };
}

test('accepts a schema-valid settled complete receipt with matching selection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { target } = records(root);
  const f = await fixture(t, { selected: target, receipt: completeReceipt(root) });
  await assert.doesNotReject(assertStorageStartupReady(f));
});

test('Rust receipt schema rejects a complete receipt with omitted required plan facts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-malformed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { target } = records(root);
  const receipt = completeReceipt(root);
  delete receipt.plan.from;
  const f = await fixture(t, { selected: target, receipt });
  await assert.rejects(assertStorageStartupReady(f), { code: 'STORAGE_CONTROL_INVALID' });
});

test('unsupported migration and location record versions retain Rust control error codes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { target } = records(root);
  const planVersion = completeReceipt(root);
  planVersion.plan.version = 2;
  await assert.rejects(assertStorageStartupReady(await fixture(t, { selected: target, receipt: planVersion })),
    { code: 'STORAGE_RECORD_VERSION_UNSUPPORTED' });

  const locationVersion = completeReceipt(root);
  locationVersion.plan.target.version = 2;
  await assert.rejects(assertStorageStartupReady(await fixture(t, { selected: target, receipt: locationVersion })),
    { code: 'STORAGE_RECORD_VERSION_UNSUPPORTED' });
});

test('owner receipt keys and values follow the Rust receipt contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-owner-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { target } = records(root);
  const withoutOwnerReceipts = completeReceipt(root);
  delete withoutOwnerReceipts.ownerReceipts;
  await assert.doesNotReject(assertStorageStartupReady(await fixture(t, { selected: target, receipt: withoutOwnerReceipts })));
  for (const ownerReceipts of [{ 'Desktop': { published: true } }, { desktop: 'published' }]) {
    const receipt = completeReceipt(root);
    receipt.ownerReceipts = ownerReceipts;
    await assert.rejects(assertStorageStartupReady(await fixture(t, { selected: target, receipt })),
      { code: 'STORAGE_CONTROL_INVALID' });
  }
});

test('check_plan rejects target operation, next revision, source revision and root mismatches', async t => {
  for (const mutate of [
    receipt => { receipt.plan.target.operationId = 'different-operation'; },
    receipt => { receipt.plan.target.revision++; },
    receipt => { receipt.plan.from.selectionRevision++; },
    receipt => { receipt.plan.from.dataRoot = join(receipt.plan.from.dataRoot, 'other'); },
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-plan-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { target } = records(root);
    const receipt = completeReceipt(root);
    mutate(receipt);
    const f = await fixture(t, { selected: target, receipt });
    await assert.rejects(assertStorageStartupReady(f), { code: 'STORAGE_OPERATION_INVALID' });
  }
});

test('active operations remain pending and valid deferred receipts retain the original selection', async t => {
  const activeRoot = await mkdtemp(join(tmpdir(), 'kcoder-storage-active-'));
  t.after(() => rm(activeRoot, { recursive: true, force: true }));
  const { original: activeOriginal } = records(activeRoot);
  const active = completeReceipt(activeRoot, { disposition: 'active', phase: 'copying' });
  await assert.rejects(assertStorageStartupReady(await fixture(t, { selected: activeOriginal, receipt: active })),
    { code: 'STORAGE_MIGRATION_PENDING' });

  const deferredRoot = await mkdtemp(join(tmpdir(), 'kcoder-storage-deferred-'));
  t.after(() => rm(deferredRoot, { recursive: true, force: true }));
  const { original } = records(deferredRoot);
  const deferred = completeReceipt(deferredRoot, { disposition: 'deferred', phase: 'prepared', errorCode: 'copy_failed' });
  await assert.doesNotReject(assertStorageStartupReady(await fixture(t, { selected: original, receipt: deferred })));

  for (const state of [
    { disposition: 'active', phase: 'verified' },
    { disposition: 'deferred', phase: 'committed', errorCode: 'copy_failed' },
    { disposition: 'complete', phase: 'verified', errorCode: 'unexpected_error' },
  ]) {
    const invalidRoot = await mkdtemp(join(tmpdir(), 'kcoder-storage-invalid-state-'));
    t.after(() => rm(invalidRoot, { recursive: true, force: true }));
    const { target: invalidTarget } = records(invalidRoot);
    const invalid = completeReceipt(invalidRoot, state);
    await assert.rejects(assertStorageStartupReady(await fixture(t, { selected: invalidTarget, receipt: invalid })),
      { code: 'STORAGE_CONTROL_INVALID' });
  }
});

test('missing control files remain distinct from JSON null and missing referenced receipts', async t => {
  const noSelection = await fixture(t, { selected: null, writeCurrent: false });
  await assert.doesNotReject(assertStorageStartupReady(noSelection));

  const nullCurrent = await fixture(t, { selected: null, current: null });
  await assert.rejects(assertStorageStartupReady(nullCurrent), { code: 'STORAGE_CONTROL_INVALID' });

  const nullReceipt = await fixture(t, { selected: null, receipt: null });
  await assert.rejects(assertStorageStartupReady(nullReceipt), { code: 'STORAGE_CONTROL_INVALID' });

  const missingRoot = await mkdtemp(join(tmpdir(), 'kcoder-storage-missing-'));
  t.after(() => rm(missingRoot, { recursive: true, force: true }));
  const { target } = records(missingRoot);
  const missingCurrent = await fixture(t, { selected: target, writeCurrent: false });
  await assert.rejects(assertStorageStartupReady(missingCurrent), { code: 'STORAGE_OPERATION_MISSING' });
  const missingOperation = await fixture(t, { selected: target, current: operationId });
  await assert.rejects(assertStorageStartupReady(missingOperation), { code: 'STORAGE_OPERATION_MISSING' });
  const missingReceipt = await fixture(t, { selected: target, current: operationId, createOperationDirectory: true });
  await assert.rejects(assertStorageStartupReady(missingReceipt), { code: 'STORAGE_OPERATION_MISSING' });
});

test('startup refuses symlinked Home, config, control and operation ancestors without changing query reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const externalConfig = join(root, 'external-config');
  await mkdir(externalConfig, { recursive: true });
  const queryFixture = await fixture(t, { selected: null, writeCurrent: false });
  const selected = { version: 1, revision: 1, dataRoot: join(root, 'data'), cacheRoot: join(root, 'cache') };
  await writeFile(storageLocationFile(queryFixture.home), JSON.stringify(selected));
  const homeAlias = join(root, 'home-alias');
  await symlink(queryFixture.home, homeAlias, 'dir');
  assert.deepEqual(await readStorageLocationRecord(storageLocationFile(homeAlias)), selected);
  queryFixture.context.home = homeAlias;
  await assert.rejects(assertStorageStartupReady(queryFixture), { code: 'STORAGE_CONTROL_UNAVAILABLE' });

  const configAlias = join(root, 'config-home');
  await mkdir(configAlias);
  await symlink(externalConfig, join(configAlias, '.config'), 'dir');
  const configFixture = await fixture(t, { selected: null, writeCurrent: false });
  configFixture.context.home = configAlias;
  configFixture.paths.selectionRevision = null;
  await assert.rejects(assertStorageStartupReady(configFixture), { code: 'STORAGE_CONTROL_UNAVAILABLE' });

  const controlsHome = join(root, 'controls-home');
  await mkdir(join(controlsHome, '.config'), { recursive: true });
  await symlink(externalConfig, join(controlsHome, '.config', 'kcoder-storage-migrations'), 'dir');
  const controlsFixture = await fixture(t, { selected: null, writeCurrent: false });
  controlsFixture.context.home = controlsHome;
  await assert.rejects(assertStorageStartupReady(controlsFixture), { code: 'STORAGE_CONTROL_INVALID' });

  const operationHome = join(root, 'operation-home');
  const operations = join(operationHome, '.config', 'kcoder-storage-migrations');
  await mkdir(operations, { recursive: true });
  await writeFile(join(operations, 'current.json'), JSON.stringify(operationId));
  await symlink(externalConfig, join(operations, operationId), 'dir');
  const operationFixture = await fixture(t, { selected: null, writeCurrent: false });
  operationFixture.context.home = operationHome;
  await assert.rejects(assertStorageStartupReady(operationFixture), { code: 'STORAGE_CONTROL_INVALID' });
});

for (const completed of [null, { phase: 'verified', disposition: 'complete' }])
test(`a Native ${completed === null ? 'null' : 'verified'} reply with an active receipt remains blocked`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-null-active-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { original } = records(root);
  const f = await fixture(t, { selected: original,
    receipt: completeReceipt(root, { disposition: 'active', phase: 'copying' }) });
  const denied = Object.assign(new Error('control read denied'), { code: 'STORAGE_CONTROL_UNAVAILABLE',
    cause: Object.assign(new Error('permission denied'), { code: 'EACCES' }) });
  let reads = 0, workers = 0, reloads = 0;
  await assert.rejects(prepareStorageBusinessStartup({ selected: f,
    load: async () => { reloads++; return f; },
    readOperation: async () => { reads++; throw denied; },
    createClient: () => {
      workers++;
      return { async startup() { return completed; } };
    },
  }), { code: 'STORAGE_MIGRATION_PENDING' });
  assert.equal(reads, 1);
  assert.equal(workers, 1);
  assert.equal(reloads, 1);
});

for (const name of ['dataRoot', 'cacheRoot', 'gatewayRoot', 'desktopRoot'])
test(`a Native-validated deferred source projects its registered ${name}`, async t => {
  const f = await fixture(t, { writeCurrent: false });
  const from = { ...structuredClone(f.paths), [name]: join(f.root, 'registered-original') };
  const target = { version: 1, revision: 1, dataRoot: f.paths.dataRoot,
    cacheRoot: join(f.root, 'selected-cache'), operationId };
  const receipt = { plan: { version: 1, operationId, original: null, from, target,
    components: [{ domain: 'persistent-root', source: from.dataRoot, destination: target.dataRoot,
      sourceIdentity: 'original-source-identity', estimatedBytes: 0 }], targetBindings: [], launchIntent: 'desktop' },
    phase: 'stopping', disposition: 'deferred', ownerReceipts: {}, errorCode: 'STORAGE_WRITERS_ACTIVE' };
  const controls = join(f.config, 'kcoder-storage-migrations');
  const operation = join(controls, operationId), current = join(controls, 'current.json');
  const file = join(operation, 'receipt.json');
  await mkdir(operation, { recursive: true });
  await writeFile(current, JSON.stringify(operationId));
  await writeFile(file, JSON.stringify(receipt));
  const bytes = await readFile(file);
  await rm(f.paths.dataRoot, { recursive: true });
  await assert.rejects(assertStorageStartupReady(f), { code: 'STORAGE_SELECTION_CHANGED' });
  const projected = await prepareStorageBusinessStartup({ selected: f, load: async () => f,
    createClient: () => ({ async startup() { return receipt; } }),
  });
  assert.equal(projected.paths[name], from[name]);
  assert.equal(projected.deferredReceipt.plan.operationId, operationId);
  let workers = 0;
  const denied = Object.assign(new Error('control access denied'), { code: 'EACCES' });
  await assert.rejects(prepareStorageBusinessStartup({ selected: f, load: async () => f,
    readOperation: async () => { throw denied; },
    createClient: () => ({ async startup() { workers++; return null; } }),
  }), { code: 'STORAGE_SELECTION_CHANGED' });
  assert.equal(workers, 1);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(JSON.parse(await readFile(current, 'utf8')), operationId);
  for (const path of [f.paths.dataRoot, f.paths.gatewayRoot]) await assert.rejects(lstat(path), { code: 'ENOENT' });
});
