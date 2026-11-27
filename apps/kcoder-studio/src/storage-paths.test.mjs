import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, lstat, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { defaultStorageLocation, readStorageLocationRecord, resolveStoragePaths, loadStoragePaths, loadStorageContext,
  STORAGE_STARTUP_ENV, STORAGE_LOCATION_MAX_BYTES } from './storage-paths.mjs';

const fixture = JSON.parse(await readFile(new URL('../../../tests/fixtures/storage-locations.json', import.meta.url), 'utf8'));

function materialize(value, home, paths) {
  if (value?.path && Array.isArray(value.path)) return paths.join(...value.path.map(part => part === '$home' ? home : part));
  if (Array.isArray(value)) return value.map(item => materialize(item, home, paths));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, materialize(item, home, paths)]));
  return value;
}

for (const platform of ['linux', 'darwin', 'win32']) {
  const paths = platform === 'win32' ? win32 : posix;
  const home = platform === 'win32' ? paths.join('C:', paths.sep, 'Users', 'fixture') : '/fixture/user';
  for (const raw of fixture.startupContexts) {
    test(`shared owned-child context: ${platform}: ${raw.name}`, async () => {
      const entry = materialize(raw, home, paths);
      const invoke = () => loadStoragePaths({ home, platform,
        env: { ...entry.env, [STORAGE_STARTUP_ENV]: JSON.stringify(entry.context) } });
      if (entry.error) await assert.rejects(invoke(), { code: entry.error });
      else for (const [key, value] of Object.entries(entry.expected)) assert.deepEqual((await invoke())[key], value);
    });
  }
}

test('captured child context excludes unrelated configuration and secrets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'storage-context-inputs-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { KCODER_HOME: join(home, 'Owned'), UNRELATED_CREDENTIAL: 'fixture-only-marker' };
  const captured = await loadStorageContext({ env, home, consumer: 'desktop' });
  assert(!JSON.stringify(captured.context).includes('fixture-only-marker'));
  const restored = await loadStoragePaths({ home, env: { [STORAGE_STARTUP_ENV]: JSON.stringify(captured.context) },
    cwd: join(home, 'OtherWorkspace'), consumer: 'cli' });
  assert.deepEqual(restored, captured.paths);
  assert.deepEqual(await readdir(home), []);
});

for (const platform of ['linux', 'darwin', 'win32']) {
  const paths = platform === 'win32' ? win32 : posix;
  const home = platform === 'win32' ? paths.join('C:', paths.sep, 'Users', 'fixture') : paths.join(paths.sep, 'fixture', 'user');
  for (const raw of fixture.cases.filter(item => !item.platforms || item.platforms.includes(platform))) {
    test(`shared storage contract: ${platform}: ${raw.name}`, () => {
      const entry = materialize(raw, home, paths);
      const invoke = () => resolveStoragePaths({ ...entry, home, platform, platformConfig: paths.join(home, 'platform') });
      if (entry.error) assert.throws(invoke, { code: entry.error });
      else {
        const result = invoke();
        for (const [field, expected] of Object.entries(entry.expected)) assert.deepEqual(result[field], expected, field);
      }
    });
  }
}

test('bounded read-only location queries leave metadata and bytes unchanged', async t => {
  const owned = await mkdtemp(join(tmpdir(), 'kcoder-storage-paths-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const missing = join(owned, 'missing', 'kcoder-storage.json');
  assert.equal(await readStorageLocationRecord(missing), null);
  assert.deepEqual(await readdir(owned), []);
  const file = join(owned, 'location.json');
  const bytes = JSON.stringify({ version: 1, revision: 1, dataRoot: join(owned, 'Data'), cacheRoot: join(owned, 'Cache') });
  await writeFile(file, bytes);
  const before = await lstat(file);
  for (let index = 0; index < 3; index++) assert.equal((await readStorageLocationRecord(file)).revision, 1);
  const after = await lstat(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.deepEqual(await readdir(owned), ['location.json']);
  await writeFile(file, Buffer.alloc(STORAGE_LOCATION_MAX_BYTES + 1));
  await assert.rejects(readStorageLocationRecord(file), { code: 'STORAGE_RECORD_INVALID' });
  await writeFile(file, Buffer.from([0xff]));
  await assert.rejects(readStorageLocationRecord(file), { code: 'STORAGE_RECORD_INVALID' });
  await writeFile(file, 'null');
  await assert.rejects(readStorageLocationRecord(file), { code: 'STORAGE_RECORD_INVALID' });
});

test('Home overrides do not read a missing or damaged personal locator', async t => {
  const owned = await mkdtemp(join(tmpdir(), 'kcoder-storage-override-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const env = { KCODER_HOME: join(owned, 'Isolated') };
  const result = await loadStoragePaths({ home: join(owned, 'NoPersonal'), env });
  assert.equal(result.dataRoot, env.KCODER_HOME);
  assert.equal(result.layout, 'custom');
  assert.deepEqual(await readdir(owned), []);
  assert.deepEqual(env, { KCODER_HOME: join(owned, 'Isolated') });
});

test('directory and symlink locators do not redirect a Home', async t => {
  const owned = await mkdtemp(join(tmpdir(), 'kcoder-storage-links-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  await assert.rejects(readStorageLocationRecord(owned), { code: 'STORAGE_RECORD_INVALID' });
  if (process.platform !== 'win32') {
    const link = join(owned, 'location.json');
    await symlink(owned, link);
    await assert.rejects(readStorageLocationRecord(link), { code: 'STORAGE_RECORD_INVALID' });
  }
});

test('new selections use the actual OS cache base without changing legacy queries', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const paths = platform === 'win32' ? win32 : posix;
    const home = platform === 'win32' ? 'C:\\Users\\fixture' : '/fixture/user';
    const platformCache = paths.join(home, 'OSCache');
    const selected = defaultStorageLocation({ home, platformCache, platform });
    assert.equal(selected.dataRoot, paths.join(home, '.config', 'kcoder'));
    assert.equal(selected.cacheRoot, paths.join(platformCache, 'kcoder', ...(platform === 'win32' ? ['cache'] : [])));
    assert.equal(resolveStoragePaths({ home, platform }).cacheRoot, paths.join(home, '.config', 'kcoder', 'tmp'));
  }
});

test('Windows default cache child remains independent of retained LocalAppData/kcoder siblings', {
  skip: process.platform !== 'win32' && 'Requires the actual Windows filesystem',
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'kcoder-windows-cache-parent-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const localAppData = join(home, 'AppData', 'Local'), parent = join(localAppData, 'kcoder');
  for (const name of ['backups', 'builds', 'repairs', 'tests']) {
    await mkdir(join(parent, name), { recursive: true });
    await writeFile(join(parent, name, 'retained.txt'), `original ${name}`);
  }

  const selected = defaultStorageLocation({ home, platformCache: localAppData });
  assert.equal(selected.cacheRoot, join(parent, 'cache'));
  await mkdir(selected.cacheRoot);
  assert.deepEqual((await readdir(parent)).sort(), ['backups', 'builds', 'cache', 'repairs', 'tests']);
  for (const name of ['backups', 'builds', 'repairs', 'tests']) {
    assert.equal(await readFile(join(parent, name, 'retained.txt'), 'utf8'), `original ${name}`);
  }
});

test('Windows conflicting path aliases fail before loading a personal selection', async () => {
  for (const name of ['KCODER_CONFIG_DIR', 'KCODER_HOME', 'KCODER_CACHE_DIR',
    'KCODER_STUDIO_DATA_DIR', 'KCODER_STUDIO_SERVERS_STORE', 'KCODER_STUDIO_DESKTOP_USER_DATA_DIR']) {
    for (const names of [[name, name.toLowerCase()], [name.toLowerCase(), name]]) {
      const env = { [names[0]]: 'C:\\First', [names[1]]: 'D:\\Second' };
      await assert.rejects(loadStoragePaths({ home: 'C:\\Users\\fixture', platform: 'win32', env }), { code: 'STORAGE_ENV_CONFLICT' });
    }
  }
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`host adapter pins legacy relative paths to startup cwd: ${platform}`, async () => {
    const paths = platform === 'win32' ? win32 : posix;
    const home = platform === 'win32' ? 'C:\\Owned\\Home' : '/owned/home';
    const cwd = paths.join(home, 'Startup');
    for (const [name, field, relative] of [
      ['KCODER_HOME', 'dataRoot', 'Profile'],
      ['KCODER_CONFIG_DIR', 'dataRoot', 'Config'],
      ['KCODER_STUDIO_SERVERS_STORE', 'gatewayRoot', paths.join('Catalog', 'servers.json')],
      ['KCODER_STUDIO_DESKTOP_USER_DATA_DIR', 'desktopRoot', 'Desktop'],
    ]) {
      const env = { KCODER_HOME: paths.join(home, 'Isolated'), [name]: relative };
      const original = { ...env };
      const result = await loadStoragePaths({ home, cwd, platform, env });
      const expected = paths.resolve(cwd, relative);
      assert.equal(result[field], name === 'KCODER_STUDIO_SERVERS_STORE' ? paths.dirname(expected) : expected);
      assert.deepEqual(env, original, 'caller environment is not rewritten');
      assert.throws(() => resolveStoragePaths({ home, platform, env }), { code: 'STORAGE_PATH_INVALID' });
    }
    for (const name of ['KCODER_CACHE_DIR', 'KCODER_STUDIO_DATA_DIR']) {
      await assert.rejects(loadStoragePaths({ home, cwd, platform,
        env: { KCODER_HOME: paths.join(home, 'Isolated'), [name]: 'Relative' } }), { code: 'STORAGE_PATH_INVALID' });
    }
  });
}

test('an undefined Windows spelling does not hide the actual Home override', async () => {
  const env = { KCODER_HOME: undefined, kcoder_home: 'C:\\Owned\\Profile' };
  const result = await loadStoragePaths({ home: 'C:\\NoPersonal', platform: 'win32', env });
  assert.equal(result.dataRoot, env.kcoder_home);
  assert.equal(result.sources.dataRoot, 'homeOverride');
});

test('Windows rooted legacy overrides inherit the startup drive but not a foreign drive cwd', async () => {
  const options = { home: 'C:\\NoPersonal', cwd: 'D:\\Owned\\Startup', platform: 'win32' };
  const result = await loadStoragePaths({ ...options, env: { KCODER_HOME: '\\Profile' } });
  assert.equal(result.dataRoot, 'D:\\Profile');
  await assert.rejects(loadStoragePaths({ ...options, env: { KCODER_HOME: 'C:Profile' } }), { code: 'STORAGE_PATH_INVALID' });
});

test('actual Windows Unicode and long selected paths retain their bytes and remain query-only', {
  skip: process.platform !== 'win32' && 'Requires the actual Windows filesystem',
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'kcoder-storage-long-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataRoot = join(home, ...Array(12).fill('中文 长目录 With Spaces'), 'Data');
  assert.ok(dataRoot.length > 260);
  const record = { version: 1, revision: 1, dataRoot, cacheRoot: join(home, '缓存 Cache') };
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, '会话 附件.txt'), '原始数据');
  await mkdir(join(home, '.config'));
  const locator = join(home, '.config', 'kcoder-storage.json');
  const bytes = JSON.stringify(record);
  await writeFile(locator, bytes);
  const before = await stat(locator);
  const names = await readdir(home);
  const selected = await loadStoragePaths({ home, env: {}, consumer: 'desktop' });
  assert.equal(selected.dataRoot, dataRoot);
  assert.equal(selected.cacheRoot, record.cacheRoot);
  assert.equal(await readFile(join(selected.dataRoot, '会话 附件.txt'), 'utf8'), '原始数据');
  assert.equal(await readFile(locator, 'utf8'), bytes);
  assert.equal((await stat(locator)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(home), names, 'query must not create the selected cache');
  await writeFile(join(selected.dataRoot, '新写入.txt'), '新位置');
  assert.equal(await readFile(join(dataRoot, '新写入.txt'), 'utf8'), '新位置');
});
