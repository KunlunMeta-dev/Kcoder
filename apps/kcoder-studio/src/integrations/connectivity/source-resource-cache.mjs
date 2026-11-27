// Source Gateway reuse of its private channel component copy. A copy is
// configuration input for a later Native load, never load authority: the
// app-server still verifies every byte against the sealed manifest first.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';

export const sourceResourcePrefix = 'kcoder-native-channel-resources-';
const markerName = 'kcoder-owner.json';
const leasesName = 'leases';
const markerKind = 'kcoder-native-channel-source-resources';
const manifestName = 'channel-resource-manifest.json';
// Only names this module creates are ever considered for cleanup. Older
// `kcoder-native-channel-resources-XXXXXX` directories carry no marker and stay.
const ownedName = /^kcoder-native-channel-resources-(?:v2|stage|ephemeral)-[A-Za-z0-9_-]+$/;
const fail = code => Object.assign(new Error(code), { code });

const ownerUid = () => (typeof process.getuid === 'function' ? process.getuid() : userInfo().username);

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function ordinaryFileBytes(path, limit) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw fail('CHANNEL_SOURCE_RESOURCE_UNSAFE');
    return await handle.readFile();
  } finally { await handle.close(); }
}

/**
 * Content key of the source inputs: the staging script (its policy), both
 * lockfiles and every byte under src/. Installed dependency bytes are pinned by
 * the lockfiles here and by the staged manifest at the Native load boundary.
 */
export async function sourceComponentKey(sourceRoot, stageScript) {
  const parts = [['policy', 2]];
  for (const [name, path, optional] of [
    ['stage', stageScript], ['package', join(sourceRoot, 'package.json')],
    ['lock', join(sourceRoot, 'package-lock.json')],
    ['installed', join(sourceRoot, 'node_modules/.package-lock.json'), true],
  ]) {
    try { parts.push([name, digest(await ordinaryFileBytes(path, 64 * 1024 * 1024))]); }
    catch (error) { if (!(optional && error.code === 'ENOENT')) throw error; parts.push([name, null]); }
  }
  async function visit(directory, prefix, depth) {
    if (depth > 40) throw fail('CHANNEL_SOURCE_RESOURCE_LIMIT');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}/${entry.name}`, full = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw fail('CHANNEL_SOURCE_RESOURCE_UNSAFE');
      if (entry.isDirectory()) await visit(full, path, depth + 1);
      else if (entry.isFile()) parts.push([path, digest(await ordinaryFileBytes(full, 64 * 1024 * 1024))]);
      else throw fail('CHANNEL_SOURCE_RESOURCE_UNSAFE');
    }
  }
  await visit(join(sourceRoot, 'src'), 'src', 0);
  return digest(Buffer.from(JSON.stringify(parts)));
}

function ownerTag(sourceRoot) {
  return digest(Buffer.from(JSON.stringify([ownerUid(), sourceRoot]))).slice(0, 16);
}

/** Directory must be an ordinary directory before cache lifecycle operations. */
async function ownedDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  return true;
}

async function readMarker(owner) {
  try {
    const value = JSON.parse(await ordinaryFileBytes(join(owner, markerName), 64 * 1024));
    return value && value.schemaVersion === 1 && value.kind === markerKind ? value : null;
  } catch { return null; }
}

async function writeMarker(owner, value) {
  const temporary = join(owner, `.${markerName}.${randomUUID()}`);
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, kind: markerKind, ...value }) + '\n', { flag: 'wx' });
  await rename(temporary, join(owner, markerName));
}

function markerOwnedBy(marker, sourceRoot) {
  return marker && marker.uid === ownerUid() && marker.sourceRoot === sourceRoot;
}

async function liveLeases(owner, isAlive) {
  let names;
  try { names = await readdir(join(owner, leasesName)); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  return names.filter(name => isAlive(Number(name.split('-')[0]))).length;
}

async function addLease(owner, pid) {
  const directory = join(owner, leasesName);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${pid}-${randomUUID()}`);
  await writeFile(path, '', { flag: 'wx' });
  return path;
}

/**
 * Cheap adoption check: the sealed manifest matches the marker and every
 * declared file is present with its declared size. This catches partial
 * temporary-directory aging without hashing; byte proof stays at the load boundary.
 */
async function adoptable(owner, marker, presence = true) {
  const component = join(owner, 'component');
  if (!(await ownedDirectory(component))) return false;
  const bytes = await ordinaryFileBytes(join(component, manifestName), 4 * 1024 * 1024);
  if (digest(bytes) !== marker.manifestSha256) return false;
  if (!presence) return true;
  const manifest = JSON.parse(bytes);
  if (!Array.isArray(manifest.files) || manifest.files.length > 20000) return false;
  for (const file of manifest.files) {
    if (typeof file?.path !== 'string' || file.path.split('/').some(part => !part || part === '.' || part === '..')) return false;
    const info = await lstat(join(component, ...file.path.split('/')));
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) return false;
  }
  return true;
}

async function inspectShared(owner, { sourceRoot, key }, { presence = true } = {}) {
  try {
    if (!(await ownedDirectory(owner))) return { state: 'foreign' };
  } catch (error) { if (error.code === 'ENOENT') return { state: 'absent' }; throw error; }
  const marker = await readMarker(owner);
  if (!markerOwnedBy(marker, sourceRoot) || marker.mode !== 'shared' || marker.key !== key) return { state: 'foreign' };
  try { return (await adoptable(owner, marker, presence)) ? { state: 'valid', marker } : { state: 'damaged' }; }
  catch { return { state: 'damaged' }; }
}

/**
 * Remove only this owner's stale copies: names this module creates, our uid,
 * and a marker naming this uid and source root. Shared copies of
 * another key are removed only when no recorded Gateway lease is alive;
 * staging and ephemeral copies only when their creating process has exited.
 */
export async function cleanupStaleSourceComponents({ sourceRoot, key, parent = tmpdir(), isAlive = processAlive } = {}) {
  const removed = [];
  for (const name of await readdir(parent)) {
    if (!ownedName.test(name)) continue;
    const owner = join(parent, name);
    try {
      if (!(await ownedDirectory(owner))) continue;
      const marker = await readMarker(owner);
      if (!markerOwnedBy(marker, sourceRoot)) continue;
      const stale = marker.mode === 'shared'
        ? marker.key !== key && await liveLeases(owner, isAlive) === 0
        : ['staging', 'ephemeral'].includes(marker.mode) && !isAlive(marker.pid);
      if (!stale) continue;
      await rm(owner, { recursive: true, force: true });
      removed.push(owner);
    } catch { /* Another owner or a concurrent change; leave it untouched. */ }
  }
  return removed;
}

async function createOwnerDirectory(parent, kind) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const directory = join(parent, `${sourceResourcePrefix}${kind}-${randomUUID()}`);
    try { await mkdir(directory); return directory; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw fail('CHANNEL_SOURCE_RESOURCE_UNAVAILABLE');
}

/**
 * Return a leased component for this Gateway. The shared keyed copy is reused
 * when valid; otherwise one new copy is staged and published atomically. A name
 * held by someone else falls back to an ephemeral copy owned by this process.
 */
export async function acquireSourceComponent({ sourceRoot, stageScript, stage, parent = tmpdir(), pid = process.pid, isAlive = processAlive }) {
  sourceRoot = await realpath(sourceRoot);
  parent = await realpath(parent);
  const key = await sourceComponentKey(sourceRoot, stageScript);
  const shared = join(parent, `${sourceResourcePrefix}v2-${ownerTag(sourceRoot)}-${key.slice(0, 32)}`);
  const result = await acquireShared({ sourceRoot, key, shared, stage, parent, pid, isAlive })
    ?? await acquireEphemeral({ sourceRoot, key, stage, parent, pid });
  // Best effort: stale copies never block startup and are never someone else's.
  await cleanupStaleSourceComponents({ sourceRoot, key, parent, isAlive }).catch(() => {});
  return result;
}

async function adoptShared(shared, context) {
  const before = await inspectShared(shared, context);
  if (before.state !== 'valid') return before;
  const lease = await addLease(shared, context.pid);
  // Recheck the marker and sealed manifest after leasing so a concurrent
  // cleanup cannot hand over a removed copy.
  const after = await inspectShared(shared, context, { presence: false });
  if (after.state !== 'valid') { await unlink(lease).catch(() => {}); return after; }
  return { state: 'adopted', handle: Object.freeze({ owner: shared, lease, shared: true,
    componentRoot: join(shared, 'component'), manifestSha256: after.marker.manifestSha256 }) };
}

async function acquireShared(context) {
  const { sourceRoot, key, shared, stage, parent, pid, isAlive } = context;
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = await adoptShared(shared, context);
    if (observed.state === 'adopted') return observed.handle;
    if (observed.state === 'foreign') return null;
    if (observed.state === 'damaged') {
      // Ours by marker but incomplete: replace it only when no Gateway holds it.
      if (await liveLeases(shared, isAlive) !== 0) return null;
      await rm(shared, { recursive: true, force: true });
    }
    const staging = await createOwnerDirectory(parent, 'stage');
    try {
      await writeMarker(staging, { uid: ownerUid(), sourceRoot, key, mode: 'staging', pid });
      const bundle = await stage(join(staging, 'component'));
      await writeMarker(staging, { uid: ownerUid(), sourceRoot, key, mode: 'shared', manifestSha256: bundle.manifestSha256 });
      const lease = await addLease(staging, pid);
      try { await rename(staging, shared); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        // Another Gateway published first; adopt its copy on the next attempt.
        await rm(staging, { recursive: true, force: true });
        continue;
      }
      return Object.freeze({ owner: shared, lease: join(shared, leasesName, basename(lease)), shared: true,
        componentRoot: join(shared, 'component'), manifestSha256: bundle.manifestSha256 });
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  const final = await adoptShared(shared, context);
  return final.state === 'adopted' ? final.handle : null;
}

async function acquireEphemeral({ sourceRoot, key, stage, parent, pid }) {
  const owner = await createOwnerDirectory(parent, 'ephemeral');
  try {
    await writeMarker(owner, { uid: ownerUid(), sourceRoot, key, mode: 'ephemeral', pid });
    const bundle = await stage(join(owner, 'component'));
    return Object.freeze({ owner, lease: null, shared: false, componentRoot: bundle.componentRoot, manifestSha256: bundle.manifestSha256 });
  } catch (error) { await rm(owner, { recursive: true, force: true }); throw error; }
}

/** Release only this Gateway's lease or its own ephemeral copy. */
export async function releaseSourceComponent(handle) {
  if (!handle) return;
  if (handle.shared) { await unlink(handle.lease).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
  await rm(handle.owner, { recursive: true, force: true });
}

export async function readSourceComponentMarker(owner) { return readMarker(owner); }
