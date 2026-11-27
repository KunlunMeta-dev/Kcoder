import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { browserCachePaths, DESKTOP_BROWSER_PARTITION, prepareBrowserCache, assertDesktopProfilePath, WINDOWS_DESKTOP_ROOT_MAX_UTF16 } from './storage-browser-cache.mjs';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const sharedPaths = JSON.parse(await fs.readFile(new URL('../../../tests/fixtures/storage-browser-cache.json', import.meta.url), 'utf8'));

test('Windows browser paths reserve LevelDB filename space without limiting other platforms', () => {
  assert.equal(WINDOWS_DESKTOP_ROOT_MAX_UTF16, sharedPaths.windowsDesktopRootMaxUtf16);
  const boundary = 'C:\\' + 'x'.repeat(WINDOWS_DESKTOP_ROOT_MAX_UTF16 - 3);
  assert.doesNotThrow(() => assertDesktopProfilePath(boundary, 'win32'));
  for (const path of [boundary + 'x', '\\\\?\\' + boundary + 'x', 'C:\\' + '😀'.repeat(90)]) {
    assert.throws(() => assertDesktopProfilePath(path, 'win32'), { code: 'STORAGE_BROWSER_PROFILE_PATH_TOO_LONG' });
  }
  assert.doesNotThrow(() => assertDesktopProfilePath('/' + 'x'.repeat(400), 'linux'));
});

async function fixture(t) {
  // Canonicalize only our newly allocated fixture, including macOS /var aliases.
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owned-desktop-browser-cache-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { desktopRoot: join(root, '持久 data', 'desktop'), cacheRoot: join(root, '缓存 cache') };
  const paths = browserCachePaths(options);
  return { root, options, paths };
}

async function absent(path) {
  await assert.rejects(fs.lstat(path), { code: 'ENOENT' });
}

async function sameLink(path, target) {
  assert((await fs.lstat(path)).isSymbolicLink());
  assert.equal(await fs.realpath(path), await fs.realpath(target));
}

async function persistentMarkers(paths) {
  await fs.mkdir(join(paths.partitionPath, 'Local Storage'), { recursive: true });
  await fs.writeFile(join(paths.partitionPath, 'Cookies'), 'owned-cookie');
  await fs.writeFile(join(paths.partitionPath, 'Local Storage', 'draft'), 'unsent-draft');
}

async function assertMarkers(paths) {
  assert.equal(await fs.readFile(join(paths.partitionPath, 'Cookies'), 'utf8'), 'owned-cookie');
  assert.equal(await fs.readFile(join(paths.partitionPath, 'Local Storage', 'draft'), 'utf8'), 'unsent-draft');
}

async function oldLink(f, target) {
  await fs.mkdir(f.paths.partitionPath, { recursive: true });
  await fs.symlink(target, f.paths.httpCachePath, linkType);
}

test('paths register the exact persistent partition and distinct HTTP/code leaves', async t => {
  const f = await fixture(t);
  assert.equal(f.paths.partition, DESKTOP_BROWSER_PARTITION);
  assert.equal(f.paths.partition, sharedPaths.partition);
  assert.equal(f.paths.httpCachePath, join(f.options.desktopRoot, sharedPaths.profileCacheRelative));
  assert.equal(f.paths.httpCacheTarget, join(f.options.cacheRoot, sharedPaths.httpCacheRelative));
  assert.equal(f.paths.codeCachePath, join(f.options.cacheRoot, sharedPaths.codeCacheRelative));
  for (const partition of ['', 'default', 'persist:other', 'persist:../kcoder-studio-desktop', 'kcoder-studio-desktop']) {
    assert.throws(() => browserCachePaths({ ...f.options, partition }), { code: 'STORAGE_BROWSER_CACHE_PARTITION_UNSUPPORTED' });
  }
  await absent(f.options.desktopRoot);
  await absent(f.options.cacheRoot);
});

test('pure Windows paths normalize DOS namespace forms without changing the registered leaves', () => {
  const normal = browserCachePaths({ desktopRoot: String.raw`D:\持久\Desktop`, cacheRoot: String.raw`E:\缓存`, platform: 'win32' });
  for (const desktopRoot of [String.raw`\\?\D:\持久\Desktop`, String.raw`\??\D:\持久\Desktop`]) {
    assert.deepEqual(browserCachePaths({ desktopRoot, cacheRoot: String.raw`\\?\E:\缓存`, platform: 'win32' }), normal);
  }
  assert.throws(() => browserCachePaths({ desktopRoot: String.raw`D:relative`, cacheRoot: String.raw`E:\缓存`, platform: 'win32' }),
    { code: 'STORAGE_BROWSER_CACHE_PATH_INVALID' });
});

test('fresh preparation redirects only HTTP cache and preserves Cookie/localStorage files', async t => {
  const f = await fixture(t);
  await persistentMarkers(f.paths);
  const prepared = await prepareBrowserCache(f.options);
  assert.equal(prepared.status, 'created');
  await sameLink(prepared.httpCachePath, prepared.httpCacheTarget);
  assert((await fs.lstat(prepared.codeCachePath)).isDirectory());
  await assertMarkers(f.paths);
  assert.deepEqual(await fs.readdir(prepared.httpCacheTarget), []);
});

test('ordinary idempotent preparation retains the existing exact link and cache contents', async t => {
  const f = await fixture(t);
  await prepareBrowserCache(f.options);
  const identity = await fs.lstat(f.paths.httpCachePath, { bigint: true });
  await fs.writeFile(join(f.paths.httpCacheTarget, 'http-data'), 'rebuildable');
  assert.equal((await prepareBrowserCache(f.options)).status, 'ready');
  assert.equal((await fs.lstat(f.paths.httpCachePath, { bigint: true })).ino, identity.ino);
  assert.equal(await fs.readFile(join(f.paths.httpCacheTarget, 'http-data'), 'utf8'), 'rebuildable');
});

test('clearing the owned cache root leaves a validated dangling link that startup repairs', async t => {
  const f = await fixture(t);
  await persistentMarkers(f.paths);
  await prepareBrowserCache(f.options);
  const identity = await fs.lstat(f.paths.httpCachePath, { bigint: true });
  await fs.rm(f.options.cacheRoot, { recursive: true });
  assert((await fs.lstat(f.paths.httpCachePath)).isSymbolicLink());
  assert.equal((await prepareBrowserCache(f.options)).status, 'ready');
  await sameLink(f.paths.httpCachePath, f.paths.httpCacheTarget);
  assert.equal((await fs.lstat(f.paths.httpCachePath, { bigint: true })).ino, identity.ino);
  await assertMarkers(f.paths);
});

test('a relative link is accepted only when its literal resolution is the exact registered target',
  { skip: process.platform === 'win32' && 'Windows uses absolute junction targets' }, async t => {
    const f = await fixture(t);
    await fs.mkdir(f.paths.partitionPath, { recursive: true });
    await fs.symlink(relative(f.paths.partitionPath, f.paths.httpCacheTarget), f.paths.httpCachePath, 'dir');
    assert.equal((await prepareBrowserCache(f.options)).status, 'ready');
    await sameLink(f.paths.httpCachePath, f.paths.httpCacheTarget);
  });

for (const dangling of [false, true]) {
  test(`startup rejects an ${dangling ? 'absent' : 'existing'} foreign link before creating the chosen target`, async t => {
    const f = await fixture(t);
    const foreign = join(f.root, 'other-owner');
    if (!dangling) {
      await fs.mkdir(foreign);
      await fs.writeFile(join(foreign, 'keep'), 'unrelated');
    }
    await oldLink(f, foreign);
    const before = await fs.readlink(f.paths.httpCachePath);
    await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_LINK_MISMATCH' });
    assert.equal(await fs.readlink(f.paths.httpCachePath), before);
    await absent(f.options.cacheRoot);
    if (!dangling) assert.equal(await fs.readFile(join(foreign, 'keep'), 'utf8'), 'unrelated');
  });
}

for (const populated of [false, true]) {
  test(`startup preserves an existing ordinary ${populated ? 'nonempty' : 'empty'} Cache for offline relocation`, async t => {
    const f = await fixture(t);
    await fs.mkdir(f.paths.httpCachePath, { recursive: true });
    if (populated) await fs.writeFile(join(f.paths.httpCachePath, 'keep'), 'old-cache');
    const before = await fs.lstat(f.paths.httpCachePath, { bigint: true });
    await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_RELOCATION_REQUIRED' });
    assert.equal((await fs.lstat(f.paths.httpCachePath, { bigint: true })).ino, before.ino);
    await absent(f.options.cacheRoot);
    if (populated) assert.equal(await fs.readFile(join(f.paths.httpCachePath, 'keep'), 'utf8'), 'old-cache');
  });
}

test('an ordinary file in the source Cache slot is never replaced', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.paths.partitionPath, { recursive: true });
  await fs.writeFile(f.paths.httpCachePath, 'unknown-file');
  await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_NOT_DIRECTORY' });
  assert.equal(await fs.readFile(f.paths.httpCachePath, 'utf8'), 'unknown-file');
  await absent(f.options.cacheRoot);
});

test('source ancestor links are rejected before creating cache targets', async t => {
  const f = await fixture(t);
  const foreign = join(f.root, 'other-profile');
  await fs.mkdir(foreign);
  await fs.mkdir(f.options.desktopRoot, { recursive: true });
  await fs.symlink(foreign, join(f.options.desktopRoot, 'Partitions'), linkType);
  await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_NOT_DIRECTORY' });
  assert.deepEqual(await fs.readdir(foreign), []);
  await absent(f.options.cacheRoot);
});

test('cache ancestor links and files are rejected before creating a persistent profile', async t => {
  const f = await fixture(t);
  const foreign = join(f.root, 'other-cache');
  await fs.mkdir(foreign);
  await fs.symlink(foreign, f.options.cacheRoot, linkType);
  await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_NOT_DIRECTORY' });
  assert.deepEqual(await fs.readdir(foreign), []);
  await absent(f.options.desktopRoot);
  await fs.unlink(f.options.cacheRoot);
  await fs.writeFile(f.options.cacheRoot, 'not-a-directory');
  await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_NOT_DIRECTORY' });
  await absent(f.options.desktopRoot);
});

test('an exact source link does not authorize following a replaced target leaf', async t => {
  const f = await fixture(t);
  await prepareBrowserCache(f.options);
  await fs.rmdir(f.paths.httpCacheTarget);
  const foreign = join(f.root, 'foreign-target');
  await fs.mkdir(foreign);
  await fs.writeFile(join(foreign, 'keep'), 'unknown');
  await fs.symlink(foreign, f.paths.httpCacheTarget, linkType);
  await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_NOT_DIRECTORY' });
  assert.equal(await fs.readFile(join(foreign, 'keep'), 'utf8'), 'unknown');
});

test('an invalid code-cache destination does not create the missing HTTP target or profile', async t => {
  const f = await fixture(t);
  await fs.mkdir(dirname(f.paths.codeCachePath), { recursive: true });
  await fs.writeFile(f.paths.codeCachePath, 'unknown-file');
  await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_NOT_DIRECTORY' });
  await absent(f.paths.httpCacheTarget);
  await absent(f.options.desktopRoot);
  assert.equal(await fs.readFile(f.paths.codeCachePath, 'utf8'), 'unknown-file');
});

test('a target below the source Cache leaf is rejected before any directories are created', async t => {
  const f = await fixture(t);
  const options = { ...f.options, cacheRoot: join(f.paths.httpCachePath, 'nested-cache') };
  assert.throws(() => browserCachePaths(options), { code: 'STORAGE_BROWSER_CACHE_PATH_OVERLAP' });
  await assert.rejects(prepareBrowserCache(options), { code: 'STORAGE_BROWSER_CACHE_PATH_OVERLAP' });
  await absent(f.options.desktopRoot);
});

test('an explicit legacy root may contain cache siblings without making the HTTP leaf circular', async t => {
  const f = await fixture(t);
  const prepared = await prepareBrowserCache({ ...f.options, cacheRoot: join(f.options.desktopRoot, 'tmp') });
  await sameLink(prepared.httpCachePath, prepared.httpCacheTarget);
});

test('a parent replaced during target preparation is preserved and cannot receive the cache link', async t => {
  const f = await fixture(t);
  await persistentMarkers(f.paths);
  const kept = join(dirname(f.paths.partitionPath), 'held-original-partition');
  const makeDirectory = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (path, ...args) => {
    const result = await makeDirectory(path, ...args);
    if (path === f.paths.codeCachePath) {
      await fs.rename(f.paths.partitionPath, kept);
      await makeDirectory(f.paths.partitionPath);
      await fs.writeFile(f.paths.httpCachePath, 'unknown-replacement');
    }
    return result;
  });
  await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_PATH_CHANGED' });
  assert.equal(await fs.readFile(f.paths.httpCachePath, 'utf8'), 'unknown-replacement');
  assert.equal(await fs.readFile(join(kept, 'Cookies'), 'utf8'), 'owned-cookie');
});

test('an exact link replaced during target preparation is preserved as an unknown identity', async t => {
  const f = await fixture(t);
  await oldLink(f, f.paths.httpCacheTarget);
  const original = await fs.lstat(f.paths.httpCachePath, { bigint: true });
  const kept = join(f.paths.partitionPath, 'kept-original-link');
  const makeDirectory = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (path, ...args) => {
    const result = await makeDirectory(path, ...args);
    if (path === f.paths.codeCachePath) {
      await fs.rename(f.paths.httpCachePath, kept);
      await fs.symlink(f.paths.httpCacheTarget, f.paths.httpCachePath, linkType);
    }
    return result;
  });
  await assert.rejects(prepareBrowserCache(f.options), { code: 'STORAGE_BROWSER_CACHE_PATH_CHANGED' });
  await sameLink(f.paths.httpCachePath, f.paths.httpCacheTarget);
  assert.notEqual((await fs.lstat(f.paths.httpCachePath, { bigint: true })).ino, original.ino);
  assert.equal((await fs.lstat(kept, { bigint: true })).ino, original.ino);
});
