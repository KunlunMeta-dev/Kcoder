import fs from 'node:fs/promises';
import { posix, win32 } from 'node:path';

export const DESKTOP_BROWSER_PARTITION = 'persist:kcoder-studio-desktop';
// Reserve room for Chromium's partition and LevelDB filenames below MAX_PATH.
export const WINDOWS_DESKTOP_ROOT_MAX_UTF16 = 180;
const PARTITION_NAME = 'kcoder-studio-desktop';

function failure(code, path) {
  return Object.assign(new Error(`${code}: ${path}`), { code, path });
}

function normalized(path, platform) {
  const paths = platform === 'win32' ? win32 : posix;
  if (typeof path !== 'string' || !path || /[\0\r\n]/.test(path)) {
    throw failure('STORAGE_BROWSER_CACHE_PATH_INVALID', path);
  }
  if (platform === 'win32') {
    path = path.replace(/^\\\\\?\\|^\\\?\?\\/, '');
    if (!/^[a-z]:[\\/]/i.test(path)) throw failure('STORAGE_BROWSER_CACHE_PATH_INVALID', path);
  }
  if (!paths.isAbsolute(path)) throw failure('STORAGE_BROWSER_CACHE_PATH_INVALID', path);
  return paths.normalize(path);
}

export function assertDesktopProfilePath(path, platform = process.platform) {
  if (platform === 'win32' && normalized(path, platform).length > WINDOWS_DESKTOP_ROOT_MAX_UTF16) {
    throw failure('STORAGE_BROWSER_PROFILE_PATH_TOO_LONG', path);
  }
}

function pathKey(path, platform) {
  const value = normalized(path, platform);
  return platform === 'win32' ? value.toLowerCase() : value;
}

function overlaps(left, right, platform) {
  const paths = platform === 'win32' ? win32 : posix;
  const within = (parent, child) => {
    const difference = paths.relative(pathKey(parent, platform), pathKey(child, platform));
    return difference === '' || (difference !== '..' && !difference.startsWith(`..${paths.sep}`)
      && !paths.isAbsolute(difference));
  };
  return within(left, right) || within(right, left);
}

/** Only the registered partition's HTTP leaf may redirect outside sessionData. */
export function browserCachePaths({ desktopRoot, cacheRoot, partition = DESKTOP_BROWSER_PARTITION,
  platform = process.platform } = {}) {
  if (partition !== DESKTOP_BROWSER_PARTITION) {
    throw failure('STORAGE_BROWSER_CACHE_PARTITION_UNSUPPORTED', partition);
  }
  const paths = platform === 'win32' ? win32 : posix;
  desktopRoot = normalized(desktopRoot, platform);
  assertDesktopProfilePath(desktopRoot, platform);
  cacheRoot = normalized(cacheRoot, platform);
  const partitionPath = paths.join(desktopRoot, 'Partitions', PARTITION_NAME);
  const httpCachePath = paths.join(partitionPath, 'Cache');
  const target = paths.join(cacheRoot, 'browser-cache', 'desktop', PARTITION_NAME);
  const httpCacheTarget = paths.join(target, 'http');
  const codeCachePath = paths.join(target, 'code');
  if (overlaps(httpCachePath, httpCacheTarget, platform)
    || overlaps(httpCachePath, codeCachePath, platform)) {
    throw failure('STORAGE_BROWSER_CACHE_PATH_OVERLAP', httpCachePath);
  }
  return { desktopRoot, cacheRoot, partition, partitionPath, httpCachePath, httpCacheTarget, codeCachePath };
}

async function entryAt(path) {
  try { return await fs.lstat(path, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function assertDirectory(entry, path) {
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw failure('STORAGE_BROWSER_CACHE_NOT_DIRECTORY', path);
  }
}

// Node lacks held-parent relative operations. These checks detect observed path
// replacement; they do not eliminate races with a malicious concurrent writer.
async function directories(path, create = false) {
  const paths = process.platform === 'win32' ? win32 : posix;
  const root = paths.parse(path).root;
  let current = root;
  const snapshots = [];
  for (const name of ['', ...paths.relative(root, path).split(paths.sep).filter(Boolean)]) {
    if (name) current = paths.join(current, name);
    let entry = await entryAt(current);
    if (!entry) {
      if (!create) break;
      await verifyDirectories(snapshots);
      try { await fs.mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      entry = await entryAt(current);
    }
    if (!entry) throw failure('STORAGE_BROWSER_CACHE_PATH_CHANGED', current);
    assertDirectory(entry, current);
    snapshots.push({ path: current, entry });
  }
  return snapshots;
}

async function verifyDirectories(snapshots) {
  for (const { path, entry } of snapshots) {
    const current = await entryAt(path);
    if (!sameIdentity(entry, current) || !current.isDirectory() || current.isSymbolicLink()) {
      throw failure('STORAGE_BROWSER_CACHE_PATH_CHANGED', path);
    }
  }
}

async function leafAt(path) {
  const entry = await entryAt(path);
  return { entry, target: entry?.isSymbolicLink() ? await fs.readlink(path) : undefined };
}

function pointsTo(leaf, path, target) {
  if (!leaf.entry?.isSymbolicLink()) return false;
  try {
    // Owned Windows junctions have absolute DOS targets; drive-relative forms
    // would depend on ambient process state and cannot establish exact identity.
    const resolved = process.platform === 'win32' ? normalized(leaf.target, process.platform)
      : posix.resolve(posix.dirname(path), leaf.target);
    return pathKey(resolved, process.platform) === pathKey(target, process.platform);
  } catch { return false; }
}

async function verifyLeaf(path, original) {
  const current = await leafAt(path);
  if ((!original.entry && current.entry) || (original.entry
    && (!sameIdentity(original.entry, current.entry) || original.target !== current.target))) {
    throw failure('STORAGE_BROWSER_CACHE_PATH_CHANGED', path);
  }
}

async function inspect(paths) {
  const parents = await directories(paths.partitionPath);
  await verifyDirectories(parents);
  const leaf = await leafAt(paths.httpCachePath);
  await verifyDirectories(parents);
  if (leaf.entry) {
    if (leaf.entry.isSymbolicLink()) {
      if (!pointsTo(leaf, paths.httpCachePath, paths.httpCacheTarget)) {
        throw failure('STORAGE_BROWSER_CACHE_LINK_MISMATCH', paths.httpCachePath);
      }
    } else if (leaf.entry.isDirectory()) {
      throw failure('STORAGE_BROWSER_CACHE_RELOCATION_REQUIRED', paths.httpCachePath);
    } else throw failure('STORAGE_BROWSER_CACHE_NOT_DIRECTORY', paths.httpCachePath);
  }
  // Preflight both destinations before creating either or touching the profile.
  await directories(paths.httpCacheTarget);
  await directories(paths.codeCachePath);
  return { parents, leaf };
}

async function prepareDirectories(paths, inspected) {
  await verifyDirectories(inspected.parents);
  await verifyLeaf(paths.httpCachePath, inspected.leaf);
  const targets = [await directories(paths.httpCacheTarget, true), await directories(paths.codeCachePath, true)];
  await verifyDirectories(inspected.parents);
  await verifyLeaf(paths.httpCachePath, inspected.leaf);
  const parents = await directories(paths.partitionPath, true);
  for (const snapshots of targets) await verifyDirectories(snapshots);
  return { parents, targets };
}

async function publishLink(paths, prepared) {
  await verifyDirectories(prepared.parents);
  for (const snapshots of prepared.targets) await verifyDirectories(snapshots);
  if (await entryAt(paths.httpCachePath)) {
    throw failure('STORAGE_BROWSER_CACHE_PATH_CHANGED', paths.httpCachePath);
  }
  await fs.symlink(paths.httpCacheTarget, paths.httpCachePath, process.platform === 'win32' ? 'junction' : 'dir');
  await verifyDirectories(prepared.parents);
  for (const snapshots of prepared.targets) await verifyDirectories(snapshots);
  if (!pointsTo(await leafAt(paths.httpCachePath), paths.httpCachePath, paths.httpCacheTarget)) {
    throw failure('STORAGE_BROWSER_CACHE_PATH_CHANGED', paths.httpCachePath);
  }
}

/** Call after the Desktop single-instance lock, before creating the Session.
 * Existing directories and cache-root changes use the unified Native executor.
 */
export async function prepareBrowserCache(options) {
  const paths = browserCachePaths({ ...options, platform: process.platform });
  const inspected = await inspect(paths);
  const prepared = await prepareDirectories(paths, inspected);
  if (!inspected.leaf.entry) await publishLink(paths, prepared);
  else {
    await verifyDirectories(prepared.parents);
    await verifyLeaf(paths.httpCachePath, inspected.leaf);
  }
  return { ...paths, status: inspected.leaf.entry ? 'ready' : 'created' };
}
