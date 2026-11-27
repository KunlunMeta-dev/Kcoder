import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDesktopStorage as configureStorageLayout } from './storage-startup.mjs';
import { createServerLaunchConfiguration } from '../src/server-launch-config.mjs';
import { loadStorageContext, STORAGE_STARTUP_ENV } from '../src/storage-paths.mjs';

// Layout tests isolate path creation from the separate real native-lease integration.
const configureDesktopStorage = options => configureStorageLayout({ ...options,
  acquireLease: async () => ({ verify() {}, close() {} }) });

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'desktop-storage-startup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const app = {
    getPath(name) { return name === 'home' ? home : join(home, 'Platform'); },
    setPath(name, path) { calls.push([name, path]); },
    commandLine: { appendSwitch(name, value) { calls.push([name, value]); } },
  };
  const record = { version: 1, revision: 1, dataRoot: join(home, 'Data'), cacheRoot: join(home, 'Cache') };
  const location = join(home, '.config', 'kcoder-storage.json');
  const select = async value => {
    await mkdir(join(home, '.config'), { recursive: true });
    await writeFile(location, JSON.stringify(value));
  };
  return { home, calls, app, record, location, select };
}

test('Windows rejects a deep browser root before opening an instance or creating its folders', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), deep = join(f.home, 'x'.repeat(180));
  await f.select({ ...f.record, dataRoot: deep });
  let acquired = false;
  await assert.rejects(configureStorageLayout({ app: f.app, env: {}, acquireLease: async () => { acquired = true; } }),
    { code: 'STORAGE_BROWSER_PROFILE_PATH_TOO_LONG' });
  assert.equal(acquired, false); assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(join(deep, 'settings.json')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(f.location, 'utf8')), { ...f.record, dataRoot: deep });
});

test('legacy desktop preserves its existing catalog and does not initialize Native Home or cache', async t => {
  const f = await fixture(t);
  const desktop = join(f.home, 'Platform', 'kcoder-studio');
  await mkdir(desktop, { recursive: true });
  await writeFile(join(desktop, 'servers.json'), JSON.stringify([{ id: 'kept', label: 'Existing', transport: 'local' }]));
  const configured = await configureDesktopStorage({ app: f.app, env: {} });
  assert.deepEqual(f.calls, [['userData', desktop], ['sessionData', desktop]]);
  assert.deepEqual(await readdir(f.home), ['Platform']);
  const gateway = await createServerLaunchConfiguration({ home: f.home, env: configured.env,
    repoRoot: f.home, defaultBinary: () => '/owned/cli' });
  assert.equal(gateway.accountStorageRoot, desktop);
  assert.equal(gateway.storagePaths.layout, 'legacy');
  assert.equal(gateway.storagePaths.externallyConfigured, false);
  assert.equal((await gateway.loadCatalog()).servers[0].id, 'kept');
});

test('first-launch selection finishes and reloads before any production Electron path or writer lease', async t => {
  const f = await fixture(t);
  const sequence = [];
  const configured = await configureStorageLayout({ app: f.app, env: {},
    prepareInitialSelection: async selected => {
      sequence.push('choose');
      assert.equal(selected.paths.layout, 'legacy');
      assert.deepEqual(f.calls, []);
      await mkdir(f.record.dataRoot);
      await f.select(f.record);
      return true;
    },
    createStartupClient() { assert.fail('the selected unified layout needs no legacy worker'); },
    acquireLease: async selected => {
      sequence.push('lease');
      assert.equal(selected.paths.dataRoot, f.record.dataRoot);
      assert.deepEqual(f.calls, []);
      return { verify() {}, close() {} };
    } });
  assert.equal(configured.paths.selectionRevision, 1);
  assert.deepEqual(sequence, ['choose', 'lease']);
  assert.deepEqual(f.calls, [['userData', join(f.record.dataRoot, 'studio', 'desktop')],
    ['sessionData', join(f.record.dataRoot, 'studio', 'desktop')]]);
});

test('cancelled or unconfirmed first-launch child prevents production profile creation', async t => {
  const f = await fixture(t);
  await assert.rejects(configureStorageLayout({ app: f.app, env: {},
    prepareInitialSelection: async () => { throw Object.assign(new Error('STORAGE_FIRST_LAUNCH_CANCELLED'), { code: 'STORAGE_FIRST_LAUNCH_CANCELLED' }); },
    acquireLease() { assert.fail('cancelled UI must not acquire a business lease'); } }), { code: 'STORAGE_FIRST_LAUNCH_CANCELLED' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.home), []);
});

test('selected session state stays persistent when the separate browser cache is cleared', async t => {
  const f = await fixture(t);
  await mkdir(f.record.dataRoot);
  await f.select(f.record);
  const configured = await configureDesktopStorage({ app: f.app, env: {} });
  const desktop = join(f.record.dataRoot, 'studio', 'desktop');
  const browser = join(f.record.cacheRoot, 'browser-cache', 'desktop');
  assert.deepEqual(f.calls, [['userData', desktop], ['sessionData', desktop]]);
  assert.equal(configured.browserCacheRoot, browser);
  await writeFile(join(desktop, 'persistent-session-fixture'), 'keep-cookies-and-drafts');
  await rm(f.record.cacheRoot, { recursive: true });
  const restored = await configureDesktopStorage({ app: f.app, env: configured.env });
  assert.deepEqual(restored.paths, configured.paths);
  assert.equal(await readFile(join(desktop, 'persistent-session-fixture'), 'utf8'), 'keep-cookies-and-drafts');
  const gateway = await createServerLaunchConfiguration({ home: f.home, env: restored.env,
    repoRoot: f.home, defaultBinary: () => '/owned/cli' });
  assert.equal(gateway.accountStorageRoot, join(f.record.dataRoot, 'studio', 'gateway'));
  assert.equal(gateway.storagePaths.sources.dataRoot, 'selection');
  assert.equal(gateway.storagePaths.externallyConfigured, false);
  assert(!Object.hasOwn(configured.env, 'KCODER_HOME'));
});

test('missing selected data or a stale inherited selection fails before any Electron path is changed', async t => {
  const f = await fixture(t);
  await f.select(f.record);
  await assert.rejects(configureDesktopStorage({ app: f.app, env: {} }), { code: 'STORAGE_DATA_ROOT_UNAVAILABLE' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.home), ['.config']);
  const captured = await loadStorageContext({ home: f.home, env: {}, consumer: 'desktop' });
  await f.select({ ...f.record, revision: 2 });
  await assert.rejects(configureDesktopStorage({ app: f.app,
    env: { [STORAGE_STARTUP_ENV]: JSON.stringify(captured.context) } }), { code: 'STORAGE_SELECTION_CHANGED' });
  assert.deepEqual(f.calls, []);
});

test('a blocked cache does not create a persistent Desktop profile or change Electron paths', async t => {
  const f = await fixture(t);
  await mkdir(f.record.dataRoot);
  await f.select(f.record);
  await writeFile(f.record.cacheRoot, 'owned obstruction');
  await assert.rejects(configureDesktopStorage({ app: f.app, env: {} }), /STORAGE_TARGET_NOT_DIRECTORY/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.record.dataRoot), []);
  assert.equal(await readFile(f.record.cacheRoot, 'utf8'), 'owned obstruction');
});

test('an active migration blocks Desktop before persistent profile or cache initialization', async t => {
  const f = await fixture(t);
  const initial = await loadStorageContext({ home: f.home, platformConfig: f.app.getPath('appData'), env: {}, consumer: 'desktop' });
  const operation = 'owned-move';
  const controls = join(f.home, '.config', 'kcoder-storage-migrations');
  await mkdir(join(controls, operation), { recursive: true });
  await writeFile(join(controls, 'current.json'), JSON.stringify(operation));
  const receipt = { plan: { version: 1, operationId: operation, original: null, from: initial.paths,
    target: { ...f.record, operationId: operation }, components: [], launchIntent: 'desktop' },
    phase: 'stopping', disposition: 'active' };
  await writeFile(join(controls, operation, 'receipt.json'), JSON.stringify(receipt));
  await assert.rejects(configureDesktopStorage({ app: f.app, env: {} }), { code: 'STORAGE_MIGRATION_PENDING' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.home), ['.config']);
  receipt.phase = 'copying'; receipt.disposition = 'deferred'; receipt.errorCode = 'STORAGE_COPY_FAILED';
  await writeFile(join(controls, operation, 'receipt.json'), JSON.stringify(receipt));
  await configureDesktopStorage({ app: f.app, env: {} });
  assert.equal(f.calls[0][0], 'userData', 'a settled precommit failure permits the original desktop');
  assert(!f.calls.some(([name]) => name === 'disk-cache-dir'));
});
