import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

const MAX_BYTES = 4096;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ordinaryFile = stat => stat.isFile() && !stat.isSymbolicLink();
const ordinaryDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink();
const stat = path => fs.lstat(path, { bigint: true });
const maybeStat = path => stat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });

/** Lock publication has its own alias rules; data-image single-link validation remains separate. */
export function createRegistrationLock({ fail, codes, parseJsonStrict }) {
  const locked = cause => fail(codes.locked, 'Registration store is locked or its lock requires inspection.', cause);
  const unsafe = cause => fail(codes.unsafe, 'Registration store lock could not be handled safely.', cause);
  const unconfirmed = cause => Object.assign(fail(codes.lockUnconfirmed, 'Registration store lock publication is unconfirmed.', cause),
    { externalOutcome: 'unknown', publicationUnconfirmed: true });
  function cleanupFailure(primary, error) {
    if (!Object.hasOwn(primary, 'cleanupError')) Object.defineProperty(primary, 'cleanupError', { value: error });
    primary.cleanupUnconfirmed = true;
  }
  async function processStart(pid) {
    if (process.platform !== 'linux') return null;
    try {
      const value = await fs.readFile(`/proc/${pid}/stat`, 'utf8'), end = value.lastIndexOf(')');
      return end < 0 ? null : value.slice(end + 1).trim().split(/\s+/)[19] ?? null;
    } catch { return null; }
  }
  async function ownerAlive(metadata) {
    // A local PID cannot establish that an owner on another host has exited.
    if (metadata.hostname !== hostname()) return true;
    try { process.kill(metadata.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return false; if (error.code !== 'EPERM') return true; }
    if (metadata.processStart === null) return true;
    const current = await processStart(metadata.pid);
    return current === null || current === metadata.processStart;
  }
  function validMetadata(value, path) {
    const legacy = value?.version === 1;
    if (!exact(value, ['version', 'pid', 'hostname', 'processStart', 'startedAt', 'owner',
      ...(legacy ? [] : ['canonicalName', 'candidate'])]) || ![1, 2].includes(value.version) ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.hostname !== 'string' || !value.hostname.length || value.hostname.length > 255 ||
      !(value.processStart === null || typeof value.processStart === 'string' && value.processStart.length <= 64) ||
      !Number.isSafeInteger(value.startedAt) || value.startedAt < 1 || typeof value.owner !== 'string' || !/^[a-f0-9]{48}$/.test(value.owner)) return false;
    return legacy || (value.processStart === null || /^\d{1,64}$/.test(value.processStart)) &&
      value.canonicalName === basename(path) && exact(value.candidate, ['name', 'dev', 'ino']) &&
      value.candidate.name === `.registration-lock-candidate-${value.owner}` &&
      typeof value.candidate.dev === 'string' && /^\d+$/.test(value.candidate.dev) &&
      typeof value.candidate.ino === 'string' && /^[1-9]\d*$/.test(value.candidate.ino);
  }
  async function readLock(path) {
    let handle, primary;
    try {
      const before = await stat(path);
      if (!ordinaryFile(before) || ![1n, 2n].includes(before.nlink) || before.size > BigInt(MAX_BYTES)) throw locked();
      handle = await fs.open(path, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
      const held = await handle.stat({ bigint: true });
      if (!same(identity(before), identity(held)) || !ordinaryFile(held) || held.size !== before.size || held.nlink !== before.nlink) throw locked();
      const bytes = Buffer.alloc(MAX_BYTES + 1); let size = 0;
      while (size < bytes.length) {
        const part = await handle.read(bytes, size, bytes.length - size, null);
        if (!part.bytesRead) break; size += part.bytesRead;
      }
      if (size > MAX_BYTES || BigInt(size) !== held.size) throw locked();
      const metadata = parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
      if (!validMetadata(metadata, path)) throw locked();
      let candidate;
      if (metadata.version === 1) { if (held.nlink !== 1n) throw locked(); }
      else {
        if (held.nlink !== 2n) throw locked();
        const directory = join(dirname(path), metadata.candidate.name), directoryInfo = await stat(directory);
        if (!ordinaryDirectory(directoryInfo) || !same(identity(directoryInfo), metadata.candidate)) throw locked();
        const leaf = join(directory, 'metadata.json'), alias = await stat(leaf);
        if (!ordinaryFile(alias) || alias.nlink !== 2n || !same(identity(alias), identity(held))) throw locked();
        const again = await stat(directory);
        if (!ordinaryDirectory(again) || !same(identity(again), metadata.candidate)) throw locked();
        candidate = { directory, leaf, directoryIdentity: identity(directoryInfo), identity: identity(held) };
      }
      const after = await handle.stat({ bigint: true }), named = await stat(path);
      if (!ordinaryFile(named) || !same(identity(named), identity(held)) || named.nlink !== held.nlink || after.nlink !== held.nlink ||
        after.size !== held.size || after.mtimeNs !== held.mtimeNs || after.ctimeNs !== held.ctimeNs) throw locked();
      return { path, metadata, identity: identity(held), candidate };
    } catch (error) { primary = error?.code === codes.locked ? error : locked(error); throw primary; }
    finally {
      if (handle) try { await handle.close(); }
      catch (error) { if (primary) cleanupFailure(primary, error); else throw locked(error); }
    }
  }
  async function openDirectory(path) {
    const before = await stat(path);
    if (!ordinaryDirectory(before)) throw unsafe();
    const handle = await fs.open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      const held = await handle.stat({ bigint: true }), named = await stat(path);
      if (!ordinaryDirectory(held) || !ordinaryDirectory(named) || !same(identity(before), identity(held)) || !same(identity(named), identity(held))) throw unsafe();
      return { path, handle, identity: identity(held) };
    } catch (error) {
      try { await handle.close(); } catch (cleanupError) { cleanupFailure(error, cleanupError); }
      throw error;
    }
  }
  async function verifyDirectory(directory) {
    const current = await stat(directory.path);
    if (!ordinaryDirectory(current) || !same(identity(current), directory.identity)) throw unsafe();
  }
  async function closeDescriptors(state, includeFile = true) {
    let failure;
    for (const key of ['directoryHandle', 'parentHandle', ...(includeFile ? ['handle'] : [])]) {
      const handle = state[key]; state[key] = undefined;
      if (handle) try { await handle.close(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  async function cleanupCandidate(candidate) {
    if (!candidate) return false;
    const directory = await maybeStat(candidate.directory);
    if (!directory || !ordinaryDirectory(directory) || !same(identity(directory), candidate.directoryIdentity)) return false;
    const leaf = await maybeStat(candidate.leaf);
    if (leaf) {
      if (!candidate.identity || !ordinaryFile(leaf) || !same(identity(leaf), candidate.identity)) return false;
      await fs.unlink(candidate.leaf);
    }
    // Unknown files in this directory are retained, never recursively removed.
    await fs.rmdir(candidate.directory);
    return true;
  }
  async function prepare(path) {
    const state = { path }; let primary;
    try {
      const parent = await openDirectory(dirname(path)); state.parentHandle = parent.handle; state.parent = parent;
      const owner = randomBytes(24).toString('hex'), directory = join(dirname(path), `.registration-lock-candidate-${owner}`);
      await fs.mkdir(directory);
      state.candidate = { directory, leaf: join(directory, 'metadata.json'), directoryIdentity: identity(await stat(directory)) };
      const candidateDirectory = await openDirectory(directory); state.directoryHandle = candidateDirectory.handle; state.directory = candidateDirectory;
      if (!same(candidateDirectory.identity, state.candidate.directoryIdentity)) throw unsafe();
      state.metadata = { version: 2, pid: process.pid, hostname: hostname(), processStart: await processStart(process.pid),
        startedAt: Date.now(), owner, canonicalName: basename(path),
        candidate: { name: basename(directory), ...candidateDirectory.identity } };
      if (!validMetadata(state.metadata, path)) throw unsafe();
      const bytes = Buffer.from(JSON.stringify(state.metadata) + '\n'); if (bytes.length > MAX_BYTES) throw unsafe();
      state.handle = await fs.open(state.candidate.leaf, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW);
      state.identity = identity(await state.handle.stat({ bigint: true })); state.candidate.identity = state.identity;
      await state.handle.writeFile(bytes); await state.handle.sync();
      await state.directoryHandle.sync(); await verifyDirectory(candidateDirectory); await verifyDirectory(parent);
      return state;
    } catch (error) {
      primary = unsafe(error);
      if (error?.cleanupUnconfirmed) cleanupFailure(primary, error.cleanupError);
      if (state.handle && !state.candidate.identity) {
        const held = await state.handle.stat({ bigint: true }).catch(() => null);
        if (held) state.candidate.identity = identity(held);
      }
      try { await cleanupCandidate(state.candidate); } catch (error) { cleanupFailure(primary, error); }
      try { await closeDescriptors(state); } catch (error) { cleanupFailure(primary, error); }
      throw primary;
    }
  }
  async function abandon(state, primary) {
    try { await cleanupCandidate(state.candidate); } catch (error) { cleanupFailure(primary, error); }
    try { await closeDescriptors(state); } catch (error) { cleanupFailure(primary, error); }
    if (primary.cleanupUnconfirmed) throw primary;
  }
  async function publish(path) {
    // Busy-path optimization only; link below is the atomic no-replace boundary.
    if (await maybeStat(path)) return null;
    const state = await prepare(path);
    try { await fs.link(state.candidate.leaf, path); }
    catch (error) {
      const current = error.code === 'EEXIST' ? await maybeStat(path).catch(() => null) : null;
      if (current && !same(identity(current), state.identity)) {
        await abandon(state, locked(error)); return null;
      }
      const primary = unconfirmed(error);
      try { await closeDescriptors(state); } catch (error) { cleanupFailure(primary, error); }
      throw primary;
    }
    try {
      const published = await readLock(path);
      if (!same(published.identity, state.identity) || published.metadata.owner !== state.metadata.owner) throw unsafe();
      await state.parentHandle.sync(); await verifyDirectory(state.parent); await verifyDirectory(state.directory);
      await closeDescriptors(state, false);
      const current = await readLock(path);
      if (!same(current.identity, state.identity) || current.metadata.owner !== state.metadata.owner) throw unsafe();
      return { path, handle: state.handle, metadata: state.metadata, identity: state.identity, candidate: state.candidate };
    } catch (error) {
      // Publication may already be durable. Keep the original candidate for reconciliation.
      const primary = unconfirmed(error);
      try { await closeDescriptors(state); } catch (error) { cleanupFailure(primary, error); }
      throw primary;
    }
  }
  async function removeCanonical(record) {
    const named = await maybeStat(record.path);
    if (!named || !named.isFile() || named.isSymbolicLink() || !same(identity(named), record.identity)) return false;
    const current = await readLock(record.path);
    if (!same(current.identity, record.identity) || current.metadata.owner !== record.metadata.owner) return false;
    const last = await maybeStat(record.path);
    if (!last || last.isSymbolicLink() || !same(identity(last), record.identity)) return false;
    try { await fs.unlink(record.path); }
    catch (error) { const primary = unsafe(error); primary.cleanupUnconfirmed = true; throw primary; }
    return true;
  }
  async function syncParent(path) {
    if (process.platform === 'win32') return;
    const parent = await openDirectory(dirname(path)); let primary;
    try { await parent.handle.sync(); await verifyDirectory(parent); }
    catch (error) { primary = error; throw error; }
    finally {
      try { await parent.handle.close(); }
      catch (error) { if (primary) cleanupFailure(primary, error); else throw error; }
    }
  }
  async function release(lock) {
    let primary;
    try {
      const removed = await removeCanonical(lock);
      if (removed) await syncParent(lock.path);
      if (await cleanupCandidate(lock.candidate)) await syncParent(lock.path);
    } catch (error) { primary = error?.code === codes.unsafe ? error : unsafe(error); primary.cleanupUnconfirmed = true; }
    const handle = lock.handle; lock.handle = undefined;
    if (handle) try { await handle.close(); } catch (error) {
      if (primary) cleanupFailure(primary, error); else { primary = unsafe(error); primary.cleanupUnconfirmed = true; }
    }
    if (primary) throw primary;
  }
  async function acquire(storePath) {
    const path = storePath + '.lock', first = await publish(path);
    if (first) return first;
    let existing;
    try { existing = await readLock(path); } catch (error) { throw locked(error); }
    if (await ownerAlive(existing.metadata)) throw locked();
    const reaper = await publish(path + '.reap');
    if (!reaper) throw locked();
    let primary, retiring = false;
    try {
      const current = await readLock(path);
      if (!same(current.identity, existing.identity) || current.metadata.owner !== existing.metadata.owner || await ownerAlive(current.metadata)) throw locked();
      retiring = true;
      if (!await removeCanonical(current)) throw locked();
      await syncParent(path); await cleanupCandidate(current.candidate); await syncParent(path);
    } catch (error) {
      primary = [codes.locked, codes.unsafe, codes.lockUnconfirmed].includes(error?.code) ? error : unsafe(error);
      if (retiring) primary.cleanupUnconfirmed = true;
      throw primary;
    }
    finally {
      try { await release(reaper); } catch (error) { if (primary) cleanupFailure(primary, error); else throw error; }
    }
    const acquired = await publish(path); if (!acquired) throw locked(); return acquired;
  }
  return { acquire, release };
}
