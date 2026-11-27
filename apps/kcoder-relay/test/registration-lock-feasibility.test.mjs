// Primitive experiments only. The production registration store is not changed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const linux = process.platform === 'linux';
const file = fileURLToPath(import.meta.url);
const owners = new Map();
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;
const namedStat = path => fs.lstat(path, { bigint: true });
async function maybeStat(path) { try { return await namedStat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
async function syncDirectory(path) {
  const held = await fs.open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { await held.sync(); } finally { await held.close(); }
}
async function processStart(pid) {
  const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
}
function ownedRegularFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid());
}
function ownedDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid());
}

async function prepareCandidate(canonical, checkpoint) {
  const owner = randomBytes(24).toString('hex');
  const candidate = join(dirname(canonical), `.registration-lock-candidate-${owner}`);
  await fs.mkdir(candidate);
  const directoryIdentity = identity(await namedStat(candidate));
  const metadata = { version: 2, pid: process.pid, hostname: hostname(), processStart: await processStart(process.pid),
    startedAt: Date.now(), owner, canonicalName: basename(canonical), candidate: { name: basename(candidate), ...directoryIdentity } };
  const path = join(candidate, 'metadata.json');
  const handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  owners.get(dirname(canonical))?.handles.add(handle);
  const heldIdentity = identity(await handle.stat({ bigint: true }));
  const state = { canonical, candidate, path, directoryIdentity, heldIdentity, metadata, handle };
  const bytes = Buffer.from(JSON.stringify(metadata) + '\n'), middle = Math.floor(bytes.length / 2);
  await checkpoint('candidate-empty', state);
  await handle.writeFile(bytes.subarray(0, middle));
  await checkpoint('candidate-partial', state);
  await handle.writeFile(bytes.subarray(middle));
  await handle.sync(); await syncDirectory(candidate);
  await checkpoint('candidate-complete', state);
  return state;
}

async function readPublished(canonical) {
  // This checks experimental alias relations, not the production schema or stale-reaper protocol.
  const before = await namedStat(canonical);
  if (!ownedRegularFile(before) || before.nlink !== 2n || before.size > 4096n) throw new Error('UNVERIFIED_PUBLICATION');
  const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const held = await handle.stat({ bigint: true }), bytes = Buffer.alloc(4097);
    if (!same(identity(before), identity(held))) throw new Error('UNVERIFIED_PUBLICATION');
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, null);
      if (!part.bytesRead) break; length += part.bytesRead;
    }
    if (length > 4096 || BigInt(length) !== held.size) throw new Error('UNVERIFIED_PUBLICATION');
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (metadata.version !== 2 || !/^[a-f0-9]{48}$/.test(metadata.owner) || !Number.isSafeInteger(metadata.pid) || metadata.pid < 1 ||
        !/^\d+$/.test(metadata.processStart) || metadata.canonicalName !== basename(canonical) ||
        metadata.candidate?.name !== `.registration-lock-candidate-${metadata.owner}`)
      throw new Error('UNVERIFIED_PUBLICATION');
    const candidate = join(dirname(canonical), metadata.candidate.name), directory = await namedStat(candidate);
    const alias = await namedStat(join(candidate, 'metadata.json'));
    const after = await handle.stat({ bigint: true }), named = await namedStat(canonical);
    if (!ownedDirectory(directory) || !same(identity(directory), metadata.candidate) || !ownedRegularFile(alias) ||
        alias.nlink !== 2n || !same(identity(alias), identity(held)) || !same(identity(named), identity(held)) ||
        after.nlink !== 2n || after.size !== held.size || after.mtimeNs !== held.mtimeNs || after.ctimeNs !== held.ctimeNs)
      throw new Error('UNVERIFIED_PUBLICATION');
    return { metadata, heldIdentity: identity(held), directoryIdentity: identity(directory), candidate };
  } finally { await handle.close(); }
}

async function removeOwnedCandidate(state) {
  const directory = await maybeStat(state.candidate), leaf = await maybeStat(state.path);
  if (!directory || !leaf || !ownedDirectory(directory) || !same(identity(directory), state.directoryIdentity) ||
      !ownedRegularFile(leaf) || !same(identity(leaf), state.heldIdentity)) return false;
  await fs.unlink(state.path); await fs.rmdir(state.candidate); return true;
}
async function releaseOwned(state) {
  let released = false;
  const current = await maybeStat(state.canonical);
  if (current && ownedRegularFile(current) && same(identity(current), state.heldIdentity)) {
    const verified = await readPublished(state.canonical);
    if (verified.metadata.owner !== state.metadata.owner) throw new Error('OWNER_CHANGED');
    await fs.unlink(state.canonical); released = true;
  }
  const candidateRemoved = await removeOwnedCandidate(state);
  await state.handle?.close();
  return { canonicalRemoved: released, candidateRemoved };
}
async function publishHardlink(canonical, checkpoint = async () => {}, link = fs.link) {
  const state = await prepareCandidate(canonical, checkpoint);
  try { await link(state.path, canonical); }
  catch (error) {
    const current = error.code === 'EEXIST' ? await maybeStat(canonical).catch(() => null) : null;
    if (current && !same(identity(current), state.heldIdentity)) {
      await removeOwnedCandidate(state); await state.handle.close(); return { acquired: false };
    }
    // An uncertain publication must keep its exact candidate, even if link's reply was lost.
    await state.handle.close();
    const unconfirmed = Object.assign(new Error('Experimental lock publication is unconfirmed', { cause: error }),
      { code: 'EXPERIMENT_PUBLICATION_UNCONFIRMED', publication: 'unconfirmed' });
    Object.defineProperty(unconfirmed, 'state', { value: publicState(state) });
    throw unconfirmed;
  }
  await checkpoint('canonical-linked', state);
  await syncDirectory(dirname(canonical));
  await checkpoint('canonical-synced', state);
  return { acquired: true, state };
}

function publicState(state) {
  return { canonical: state.canonical, candidate: state.candidate, path: state.path,
    directoryIdentity: state.directoryIdentity, heldIdentity: state.heldIdentity, metadata: state.metadata };
}
async function worker(input) {
  const message = () => new Promise(resolve => process.once('message', resolve));
  const checkpoint = async (phase, state) => {
    process.send({ type: 'checkpoint', phase, state: publicState(state) });
    if (input.pause === phase) await message();
  };
  process.send({ type: 'ready' }); await message();
  if (input.kind === 'legacy') {
    // Historical primitive only: the original production source is retained as read-only evidence.
    const handle = await fs.open(input.canonical, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    process.send({ type: 'checkpoint', phase: 'legacy-empty' }); await message();
    try { await handle.writeFile('{}\n'); await handle.sync(); } finally { await handle.close(); }
  } else if (input.kind === 'directory') {
    const state = await prepareCandidate(input.canonical, checkpoint);
    if (await maybeStat(input.canonical)) throw new Error('EXISTING_TARGET');
    await checkpoint('directory-pre-rename', state);
    try { await fs.rename(state.candidate, input.canonical); process.send({ type: 'result', acquired: true }); }
    catch (error) {
      await removeOwnedCandidate(state);
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(error.code)) throw error;
      process.send({ type: 'result', acquired: false });
    } finally { await state.handle.close(); }
  } else {
    const result = await publishHardlink(input.canonical, checkpoint);
    process.send({ type: 'result', acquired: result.acquired, ...(result.state ? { state: publicState(result.state) } : {}) });
    if (result.acquired) {
      await message();
      process.send({ type: 'released', ...await releaseOwned(result.state) });
    }
  }
  process.disconnect();
}

if (process.argv[2] === '--registration-lock-worker') {
  await worker(JSON.parse(process.argv[3])).catch(error => {
    process.send?.({ type: 'failure', message: error.message, code: error.code }); process.exitCode = 1; process.disconnect?.();
  });
} else {
  const resources = new WeakMap();
  function ownedResources(t) {
    if (resources.has(t)) return resources.get(t);
    const owned = { roots: [], children: [], handles: new Set() }; resources.set(t, owned);
    t.after(async () => {
      // Children must be gone before any of their private directories are removed.
      for (const child of owned.children) if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
      await Promise.all(owned.children.map(child => child.done));
      for (const handle of owned.handles) await handle.close();
      for (const root of owned.roots) {
        const current = await maybeStat(root.path);
        if (current && (!privateDirectory(current) || !same(identity(current), root.identity))) throw new Error('Owned experiment root changed');
        if (current) await fs.rm(root.path, { recursive: true, force: true });
        owners.delete(root.path);
      }
      t.diagnostic(JSON.stringify({ ownedChildrenExited: owned.children.length, ownedRootsRemoved: owned.roots.length }));
    });
    return owned;
  }
  async function fixture(t) {
    const root = await fs.mkdtemp(join(tmpdir(), 'registration-lock-feasibility-'));
    const owned = ownedResources(t); owned.roots.push({ path: root, identity: identity(await namedStat(root)) }); owners.set(root, owned);
    return { root, canonical: join(root, 'registration.json.lock') };
  }
  async function child(t, input) {
    const process = spawn(globalThis.process.execPath, [file, '--registration-lock-worker', JSON.stringify(input)],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const queued = [], waiting = []; let stderr = '';
    let finish, settled = false;
    const done = new Promise(resolve => { finish = outcome => {
      if (settled) return; settled = true; resolve(outcome);
      for (const waiter of waiting) waiter.reject(new Error('Owned child exited before checkpoint'));
    }; });
    process.once('exit', (code, signal) => finish({ code, signal }));
    process.once('error', () => finish({ code: null, signal: null, spawnFailed: true }));
    ownedResources(t).children.push({ process, done });
    process.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
    process.on('message', event => {
      const index = waiting.findIndex(waiter => waiter.type === event.type && (!waiter.phase || waiter.phase === event.phase));
      if (index < 0) queued.push(event); else waiting.splice(index, 1)[0].resolve(event);
    });
    const watchdog = setTimeout(() => process.kill('SIGKILL'), 8000);
    done.then(() => clearTimeout(watchdog));
    const take = (type, phase) => {
      const index = queued.findIndex(event => event.type === type && (!phase || event.phase === phase));
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => waiting.push({ type, phase, resolve, reject }));
    };
    await take('ready');
    return { process, take, done, start: () => process.send('start'), next: () => process.send('continue'), stderr: () => stderr };
  }

  test('historical legacy O_EXCL primitive leaves an empty canonical after metadata-before-write SIGKILL', { skip: !linux }, async t => {
    const f = await fixture(t), owned = await child(t, { kind: 'legacy', canonical: f.canonical });
    owned.start(); await owned.take('checkpoint', 'legacy-empty'); owned.process.kill('SIGKILL');
    assert.equal((await owned.done).signal, 'SIGKILL'); assert.equal((await namedStat(f.canonical)).size, 0n);
    const { openRegistrationStore } = await import('../src/registration-store.mjs');
    await assert.rejects(openRegistrationStore({ path: f.canonical.slice(0, -5) }), { code: 'REGISTRATION_STORE_LOCKED' });
    assert.equal((await namedStat(f.canonical)).size, 0n, 'unknown old damaged canonical is preserved');
    assert.equal((await publishHardlink(f.canonical)).acquired, false);
    assert.equal((await namedStat(f.canonical)).size, 0n, 'the new publication primitive also preserves it');
  });

  for (const phase of ['candidate-empty', 'candidate-partial', 'candidate-complete', 'canonical-linked', 'canonical-synced']) {
    test(`hardlink publication survives actual SIGKILL at ${phase}`, { skip: !linux }, async t => {
      const f = await fixture(t), owned = await child(t, { kind: 'hardlink', canonical: f.canonical, pause: phase });
      owned.start(); const checkpoint = await owned.take('checkpoint', phase); owned.process.kill('SIGKILL');
      assert.equal((await owned.done).signal, 'SIGKILL');
      if (phase.startsWith('candidate-')) {
        assert.equal(await maybeStat(f.canonical), null);
        const later = await publishHardlink(f.canonical); assert.equal(later.acquired, true);
        assert.ok(later.state.metadata.owner !== checkpoint.state.metadata.owner, 'a later writer creates its own candidate');
        await releaseOwned(later.state);
        assert.ok(await maybeStat(checkpoint.state.candidate), 'unreferenced crash candidate is not adopted or guessed away');
      } else {
        const read = await readPublished(f.canonical);
        assert.equal(read.metadata.pid, owned.process.pid); assert.ok(read.metadata.owner === checkpoint.state.metadata.owner, 'the original complete metadata survives');
        // Recovery here uses a known owned child's confirmed exit, not a guessed stale PID or age.
        const released = await releaseOwned(checkpoint.state); assert.equal(released.canonicalRemoved, true);
        assert.equal(await maybeStat(f.canonical), null);
        const later = await publishHardlink(f.canonical); assert.equal(later.acquired, true); await releaseOwned(later.state);
      }
    });
  }

  test('two real hardlink publishers have exactly one winner and never remove the winner on EEXIST', { skip: !linux }, async t => {
    for (let round = 0; round < 4; round++) {
      const f = await fixture(t);
      const pair = await Promise.all([child(t, { canonical: f.canonical, pause: 'candidate-complete' }), child(t, { canonical: f.canonical, pause: 'candidate-complete' })]);
      for (const owned of pair) owned.start(); await Promise.all(pair.map(owned => owned.take('checkpoint', 'candidate-complete')));
      for (const owned of pair) owned.next(); const results = await Promise.all(pair.map(owned => owned.take('result')));
      assert.equal(results.filter(result => result.acquired).length, 1);
      const winner = results.findIndex(result => result.acquired), verified = await readPublished(f.canonical);
      assert.ok(verified.metadata.owner === results[winner].state.metadata.owner, 'the atomic winner remains authoritative');
      pair[winner].next(); assert.equal((await pair[winner].take('released')).canonicalRemoved, true);
      for (const owned of pair) assert.equal((await owned.done).code, 0);
    }
  });

  for (const kind of ['damaged-file', 'empty-directory', 'nonempty-directory', 'symlink']) {
    test(`hardlink never overwrites a canonical peer (${kind})`, { skip: !linux }, async t => {
      const f = await fixture(t), owned = await child(t, { canonical: f.canonical, pause: 'candidate-complete' });
      owned.start(); await owned.take('checkpoint', 'candidate-complete');
      if (kind === 'damaged-file') await fs.writeFile(f.canonical, '{incomplete');
      else if (kind === 'symlink') await fs.symlink('missing-owned-peer', f.canonical);
      else { await fs.mkdir(f.canonical); if (kind === 'nonempty-directory') await fs.writeFile(join(f.canonical, 'peer'), 'preserved'); }
      const before = identity(await namedStat(f.canonical)); owned.next();
      assert.equal((await owned.take('result')).acquired, false); assert.equal((await owned.done).code, 0);
      assert.deepEqual(identity(await namedStat(f.canonical)), before);
      if (kind === 'damaged-file') assert.equal(await fs.readFile(f.canonical, 'utf8'), '{incomplete');
      if (kind === 'nonempty-directory') assert.equal(await fs.readFile(join(f.canonical, 'peer'), 'utf8'), 'preserved');
    });
  }

  test('known alias constraints reject an extra hardlink and a replaced candidate directory', { skip: !linux }, async t => {
    const f = await fixture(t), published = await publishHardlink(f.canonical), state = published.state;
    const extra = join(f.root, 'unknown-alias'); await fs.link(f.canonical, extra);
    await assert.rejects(readPublished(f.canonical), /UNVERIFIED_PUBLICATION/); await fs.unlink(extra);
    const retained = state.candidate + '-retained'; await fs.rename(state.candidate, retained);
    await fs.mkdir(state.candidate); await fs.link(f.canonical, join(state.candidate, 'metadata.json'));
    // Even after removing the old alias, the replacement directory has no original identity.
    await fs.unlink(join(retained, 'metadata.json'));
    await assert.rejects(readPublished(f.canonical), /UNVERIFIED_PUBLICATION/);
    await state.handle.close();
  });

  test('candidate names stay bounded for a long supported canonical basename', { skip: !linux }, async t => {
    const f = await fixture(t), canonical = join(f.root, 'r'.repeat(220) + '.lock');
    const published = await publishHardlink(canonical);
    assert.ok(basename(published.state.candidate).length < 100);
    assert.equal((await readPublished(canonical)).metadata.canonicalName, basename(canonical));
    assert.equal((await releaseOwned(published.state)).canonicalRemoved, true);
  });

  test('a replaced canonical peer is preserved by the previous owner release', { skip: !linux }, async t => {
    const f = await fixture(t), owned = await child(t, { canonical: f.canonical }); owned.start();
    const result = await owned.take('result'); assert.equal(result.acquired, true);
    await fs.rename(f.canonical, join(f.root, 'retained-original'));
    await fs.writeFile(f.canonical, 'opaque peer metadata'); const before = identity(await namedStat(f.canonical));
    owned.next(); assert.equal((await owned.take('released')).canonicalRemoved, false);
    assert.equal((await owned.done).code, 0); assert.deepEqual(identity(await namedStat(f.canonical)), before);
    assert.equal(await fs.readFile(f.canonical, 'utf8'), 'opaque peer metadata');
    assert.ok(await maybeStat(join(f.root, 'retained-original')));
  });

  test('a lost link receipt retains the complete known alias instead of calling publication definitely failed', { skip: !linux }, async t => {
    for (const code of ['EIO', 'EEXIST']) {
      const f = await fixture(t); let failure;
      try {
        await publishHardlink(f.canonical, async () => {}, async (source, target) => {
          await fs.link(source, target); throw Object.assign(new Error('Controlled lost link receipt'), { code });
        });
      } catch (error) { failure = error; }
      assert.equal(failure?.code, 'EXPERIMENT_PUBLICATION_UNCONFIRMED');
      const read = await readPublished(f.canonical); assert.equal(read.metadata.pid, process.pid);
      assert.equal((await namedStat(f.canonical)).nlink, 2n);
      assert.equal((await releaseOwned(failure.state)).canonicalRemoved, true);
    }
  });

  test('nonempty directory CAS has one winner but a peer empty directory can be overwritten after its last check', { skip: !linux }, async t => {
    const f = await fixture(t), pair = await Promise.all([child(t, { kind: 'directory', canonical: f.canonical, pause: 'directory-pre-rename' }), child(t, { kind: 'directory', canonical: f.canonical, pause: 'directory-pre-rename' })]);
    for (const owned of pair) owned.start(); await Promise.all(pair.map(owned => owned.take('checkpoint', 'directory-pre-rename')));
    for (const owned of pair) owned.next(); const results = await Promise.all(pair.map(owned => owned.take('result')));
    assert.equal(results.filter(result => result.acquired).length, 1); for (const owned of pair) assert.equal((await owned.done).code, 0);
    const other = await fixture(t), paused = await child(t, { kind: 'directory', canonical: other.canonical, pause: 'directory-pre-rename' });
    paused.start(); await paused.take('checkpoint', 'directory-pre-rename'); await fs.mkdir(other.canonical);
    const before = identity(await namedStat(other.canonical)); paused.next();
    assert.equal((await paused.take('result')).acquired, true); assert.equal((await paused.done).code, 0);
    assert.notDeepEqual(identity(await namedStat(other.canonical)), before, 'rename is not a general no-replace primitive');
  });
}
