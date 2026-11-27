import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerLaunchConfiguration } from './server-launch-config.mjs';
import { appServerEnvironment } from './server-config.js';

test('startup factory keeps lazy binary, scenario, workspace and private storage defaults', async t => {
  const home = await mkdtemp(join(tmpdir(), 'server-launch-home-')); t.after(() => rm(home, { recursive: true, force: true }));
  let calls = 0;
  const env = { KCODER_STUDIO_KCODER_BIN: '/owned/explicit', KCODER_STUDIO_WORKSPACE: '/owned/work', KCODER_STUDIO_SCENARIO: 'selected', KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_DATA_DIR: '/owned/private', KCODER_STUDIO_CHROMIUM_BIN: '/owned/chrome', KCODER_STUDIO_CHROMIUM_NO_SANDBOX: '1' };
  const config = await createServerLaunchConfiguration({ home, env, repoRoot: '/owned/repo', defaultBinary() { calls++; return '/owned/default' } });
  assert.equal(calls, 0); assert.equal(config.appServerBin, '/owned/explicit'); assert.equal(config.workspace, '/owned/work');
  assert.equal(config.scenario, 'selected'); assert.equal(config.mock, true); assert.equal(config.serversStore, null); assert.equal(config.accountStorageRoot, '/owned/private');
  assert.deepEqual(config.serverDefaults, { repoRoot: '/owned/repo', appServerBin: '/owned/explicit', workspace: '/owned/work', chromiumBin: '/owned/chrome', chromiumNoSandbox: true });
  const fallback = await createServerLaunchConfiguration({ home, env: {}, repoRoot: '/owned/repo', defaultBinary() { calls++; return '/owned/default' } });
  assert.equal(calls, 1); assert.equal(fallback.appServerBin, '/owned/default'); assert.equal(fallback.scenario, ''); assert.equal(fallback.workspace, '/owned/repo'); assert.equal(fallback.mock, false);
});
test('the extracted original loader keeps store then inline then file precedence and the exact catalog map', async t => {
  const root = await mkdtemp(join(tmpdir(), 'server-launch-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const stored = join(root, 'servers.json'), file = join(root, 'file.json');
  const entry = id => ({ id, label: id, transport: 'local' });
  await writeFile(stored, JSON.stringify([entry('stored')])); await writeFile(file, JSON.stringify([entry('file')]));
  const env = { KCODER_STUDIO_SERVERS_STORE: stored, KCODER_STUDIO_SERVERS: JSON.stringify([entry('inline')]), KCODER_STUDIO_SERVERS_FILE: file };
  const create = () => createServerLaunchConfiguration({ home: root, env, repoRoot: root, defaultBinary: () => '/owned/kcoder' });
  const fromStore = await (await create()).loadCatalog(); assert.equal(fromStore.servers[0].id, 'stored'); assert.equal(fromStore.serversById.get('stored'), fromStore.servers[0]);
  await rm(stored); assert.equal((await (await create()).loadCatalog()).servers[0].id, 'inline'); delete env.KCODER_STUDIO_SERVERS;
  assert.equal((await (await create()).loadCatalog()).servers[0].id, 'file'); delete env.KCODER_STUDIO_SERVERS_FILE;
  assert.equal((await (await create()).loadCatalog()).servers[0].id, 'local');
  await writeFile(stored, '{invalid'); await assert.rejects((await create()).loadCatalog(), SyntaxError);
});

test('the actual Gateway factory uses one selected root and catalog without initializing either', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-selected-storage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const control = join(home, '.config'); await mkdir(control);
  const dataRoot = join(home, 'Data'), cacheRoot = join(home, 'Cache');
  await mkdir(dataRoot);
  const bytes = JSON.stringify({ version: 1, revision: 1, dataRoot, cacheRoot });
  const location = join(control, 'kcoder-storage.json'); await writeFile(location, bytes);
  const env = {};
  const configuration = await createServerLaunchConfiguration({ env, home, repoRoot: home, defaultBinary: () => '/owned/cli' });
  assert.equal(configuration.accountStorageRoot, join(dataRoot, 'studio', 'gateway'));
  assert.equal(configuration.serversStore, join(dataRoot, 'studio', 'gateway', 'servers.json'));
  assert.equal(configuration.storagePaths.sources.gatewayRoot, 'selection');
  assert.equal(configuration.storagePaths.cacheRoot, cacheRoot);
  const selectedChild = configuration.launchSpec({ id: 'local', transport: 'local', runtime: 'kcoder',
    command: '/owned/cli', cwd: home });
  assert.equal(selectedChild.env.KCODER_HOME, undefined, 'derived roots must not become explicit Home overrides');
  assert.equal(selectedChild.env.KCODER_CONFIG_DIR, undefined);
  assert.deepEqual(JSON.parse(selectedChild.env.KCODER_STORAGE_CONTEXT_V1).record,
    JSON.parse(bytes));
  assert.deepEqual((await readdir(home)).sort(), ['.config', 'Data']);
  assert.deepEqual(await readdir(control), ['kcoder-storage.json']);
  assert.deepEqual(env, {});
  env.KCODER_STUDIO_SERVERS_STORE = join(home, 'Wrong', 'servers.json');
  assert.equal((await configuration.loadCatalog()).servers[0].id, 'local');
  assert.deepEqual((await readdir(home)).sort(), ['.config', 'Data']);
  await rm(dataRoot, { recursive: true });
  await assert.rejects(createServerLaunchConfiguration({ env: {}, home, repoRoot: home,
    defaultBinary: () => '/owned/cli' }), { code: 'STORAGE_DATA_ROOT_UNAVAILABLE' });
  assert.deepEqual(await readdir(home), ['.config']);
  await writeFile(location, '{broken');
  let binaryCalls = 0;
  await assert.rejects(createServerLaunchConfiguration({ env: {}, home, repoRoot: home,
    defaultBinary() { binaryCalls++; return '/owned/cli'; } }), { code: 'STORAGE_RECORD_INVALID' });
  assert.equal(binaryCalls, 0, 'invalid selection fails before resolving Native startup');
});

test('local child Home overrides stay absolute across workspace changes without reaching SSH targets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-child-storage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const name of ['KCODER_HOME', 'KCODER_CONFIG_DIR']) {
    const env = { [name]: 'owned-relative-profile', KCODER_CACHE_DIR: join(home, 'cache'),
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: 'owned-relative-desktop',
      KCODER_STUDIO_SERVERS_STORE: 'owned-relative-catalog.json' };
    const config = await createServerLaunchConfiguration({ env, home, repoRoot: home, defaultBinary: () => '/owned/cli' });
    const local = { id: 'local', transport: 'local', runtime: 'kcoder', command: '/owned/cli', cwd: home };
    const spec = config.launchSpec(local, { workspacePath: join(home, 'different-workspace') });
    assert.equal(spec.env[name], join(process.cwd(), 'owned-relative-profile'));
    assert.equal(spec.env.KCODER_CACHE_DIR, join(home, 'cache'));
    const childEnv = appServerEnvironment(env, spec.env);
    assert.equal(childEnv[name], join(process.cwd(), 'owned-relative-profile'));
    assert.equal(childEnv.KCODER_CACHE_DIR, join(home, 'cache'));
    assert.equal(childEnv.KCODER_STUDIO_SERVERS_STORE, undefined);
    assert.equal(childEnv.KCODER_STUDIO_DESKTOP_USER_DATA_DIR, undefined);
    const remote = config.launchSpec({ id: 'ssh', runtime: 'kcoder', transport: 'ssh', host: 'example.test', command: 'kcoder' });
    assert.equal(remote.env, undefined);
    assert(!remote.args.join(' ').includes('owned-relative-profile'));
    assert.equal(env[name], 'owned-relative-profile');
  }
  const config = await createServerLaunchConfiguration({ home, repoRoot: home, defaultBinary: () => '/owned/cli',
    env: { KCODER_CONFIG_DIR: 'priority-profile', KCODER_HOME: 'lower-priority-home' } });
  const spec = config.launchSpec({ id: 'local', transport: 'local', runtime: 'kcoder', command: '/owned/cli', cwd: home });
  assert.equal(spec.env.KCODER_CONFIG_DIR, join(process.cwd(), 'priority-profile'));
  assert.equal(spec.env.KCODER_HOME, join(process.cwd(), 'lower-priority-home'));
});
