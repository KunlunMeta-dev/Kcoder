import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openRegistrationStore, REGISTRATION_STORE_ERROR_CODES as CODES } from '../src/registration-store.mjs';

const linux = process.platform === 'linux';
const self = fileURLToPath(import.meta.url);
const id = stat => [String(stat.dev), String(stat.ino)];
const maybe = async path => fs.lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });

async function inspect(path, suffix = '.lock') {
  const canonical = path + suffix, metadata = JSON.parse(await fs.readFile(canonical, 'utf8'));
  assert.equal(metadata.version, 2); assert.equal(metadata.canonicalName, basename(canonical));
  assert.match(metadata.owner, /^[a-f0-9]{48}$/);
  assert.equal(metadata.candidate.name, `.registration-lock-candidate-${metadata.owner}`);
  const candidate = join(dirname(canonical), metadata.candidate.name), directory = await fs.lstat(candidate, { bigint: true });
  const named = await fs.lstat(canonical, { bigint: true }), alias = await fs.lstat(join(candidate, 'metadata.json'), { bigint: true });
  assert.deepEqual(id(directory), [metadata.candidate.dev, metadata.candidate.ino]);
  assert.deepEqual(id(named), id(alias)); assert.equal(named.nlink, 2n); assert.equal(alias.nlink, 2n);
  assert.ok(directory.isDirectory()); assert.ok(named.isFile());
  return { canonical, metadata, candidate, identity: id(named) };
}

async function runWorker(input) {
  const canonical = input.path + '.lock', open = fs.open, link = fs.link, unlink = fs.unlink, lstat = fs.lstat;
  let barrierHit = false, links = 0, ownedHandle, opened = false;
  const next = () => new Promise(resolve => process.once('message', resolve));
  const checkpoint = async phase => {
    if (input.pause !== phase || barrierHit) return;
    barrierHit = true; process.send({ type: 'checkpoint', phase }); await next();
  };
  fs.lstat = async (...args) => {
    const result = await lstat(...args);
    if (basename(String(args[0])).startsWith('.registration-lock-candidate-')) await checkpoint('candidate-observed');
    return result;
  };
  fs.open = async (...args) => {
    const handle = await open(...args), path = String(args[0]);
    const creation = Boolean(args[1] & constants.O_CREAT) && (path === canonical ||
      (basename(path) === 'metadata.json' && basename(dirname(path)).startsWith('.registration-lock-candidate-')));
    if (creation) { ownedHandle = handle; await checkpoint('metadata-open'); }
    return new Proxy(handle, { get(target, property) {
      if (creation && property === 'writeFile' && input.pause === 'metadata-half') return async value => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), middle = Math.floor(bytes.length / 2);
        await target.writeFile(bytes.subarray(0, middle)); await checkpoint('metadata-half');
        return target.writeFile(bytes.subarray(middle));
      };
      if (path === dirname(canonical) && property === 'sync') return async () => {
        if (await maybe(canonical)) {
          if (input.fault === 'parent-sync') throw Object.assign(new Error('Controlled parent sync failure'), { code: 'EIO' });
          await target.sync(); await checkpoint('parent-synced'); return;
        }
        if (input.fault === 'stale-removal-sync' && await maybe(canonical + '.reap'))
          throw Object.assign(new Error('Controlled stale removal sync failure'), { code: 'EIO' });
        if (opened && ['release-sync', 'release-sync-and-close'].includes(input.fault))
          throw Object.assign(new Error('Controlled release sync failure'), { code: 'EIO' });
        return target.sync();
      };
      if (path === dirname(canonical) && property === 'close' && input.fault === 'release-sync-and-close') return async () => {
        await target.close();
        if (opened && !await maybe(canonical)) throw Object.assign(new Error('Controlled secondary close failure'), { code: 'EIO' });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  fs.link = async (...args) => {
    if (args[1] === canonical + '.reap') {
      await checkpoint('reaper-before-link'); const result = await link(...args); await checkpoint('reaper-after-link'); return result;
    }
    if (args[1] !== canonical) return link(...args);
    links++; await checkpoint('before-link'); const result = await link(...args);
    await checkpoint('after-link');
    if (input.fault?.startsWith('link-')) throw Object.assign(new Error('Controlled lost link reply'),
      { code: input.fault === 'link-eexist' ? 'EEXIST' : 'EIO' });
    return result;
  };
  fs.unlink = async (...args) => {
    const result = await unlink(...args);
    if (args[0] === canonical) await checkpoint('canonical-unlinked');
    return result;
  };
  process.send({ type: 'ready' }); await next();
  if (input.legacy) {
    // Format compatibility fixture, not an old runtime or a production v1 writer.
    const handle = await fs.open(canonical, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const value = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
    const start = value.slice(value.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
    await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, hostname: hostname(), processStart: start,
      startedAt: Date.now(), owner: randomBytes(24).toString('hex') }) + '\n'); await handle.sync();
    process.send({ type: 'opened', ok: true }); await next(); await handle.close(); process.disconnect(); return;
  }
  let store;
  try {
    store = await openRegistrationStore({ path: input.path });
    opened = true;
    process.send({ type: 'opened', ok: true, links });
  } catch (error) {
    process.send({ type: 'opened', ok: false, code: error.code, unknown: error.externalOutcome === 'unknown',
      cleanupUnconfirmed: error.cleanupUnconfirmed === true, links, ownedHandleClosed: !ownedHandle || ownedHandle.fd === -1 });
  }
  await next();
  if (store) {
    try { await store.close(); process.send({ type: 'closed', ok: true, ownedHandleClosed: !ownedHandle || ownedHandle.fd === -1 }); }
    catch (error) { process.send({ type: 'closed', ok: false, code: error.code,
      cleanupUnconfirmed: error.cleanupUnconfirmed, ownedHandleClosed: !ownedHandle || ownedHandle.fd === -1,
      primarySyncKept: error.cause?.message === 'Controlled release sync failure' }); }
  }
  process.disconnect();
}

if (process.argv[2] === '--production-lock-worker') {
  await runWorker(JSON.parse(process.argv[3])).catch(error => {
    process.send?.({ type: 'failure', code: error.code }); process.exitCode = 1; process.disconnect?.();
  });
} else {
  const resources = new WeakMap();
  function owned(t) {
    if (resources.has(t)) return resources.get(t);
    const state = { roots: [], children: [], stores: [] }; resources.set(t, state);
    t.after(async () => {
      for (const child of state.children) if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
      await Promise.all(state.children.map(child => child.done));
      for (const store of state.stores) await store.close();
      for (const root of state.roots) {
        const current = await maybe(root.path);
        if (current && JSON.stringify(id(current)) !== JSON.stringify(root.identity)) throw new Error('Owned root changed');
        await fs.rm(root.path, { recursive: true, force: true });
      }
      t.diagnostic(JSON.stringify({ ownedChildrenExited: state.children.length, ownedRootsRemoved: state.roots.length }));
    });
    return state;
  }
  async function fixture(t) {
    const root = await fs.mkdtemp(join(tmpdir(), 'registration-lock-production-'));
    owned(t).roots.push({ path: root, identity: id(await fs.lstat(root)) });
    return { root, path: join(root, 'registration.json'), open: async () => {
      const store = await openRegistrationStore({ path: join(root, 'registration.json') }); owned(t).stores.push(store); return store;
    } };
  }
  async function child(t, input) {
    const process = spawn(globalThis.process.execPath, [self, '--production-lock-worker', JSON.stringify(input)],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    process.stdout.resume(); process.stderr.resume();
    const queue = [], waiters = []; let settled = false, finish;
    const done = new Promise(resolve => { finish = value => {
      if (settled) return; settled = true; resolve(value);
      for (const waiter of waiters) waiter.reject(new Error('Owned worker exited before event'));
    }; });
    process.once('exit', (code, signal) => finish({ code, signal })); process.once('error', () => finish({ spawnFailed: true }));
    process.on('message', event => {
      const index = waiters.findIndex(waiter => waiter.type === event.type && (!waiter.phase || waiter.phase === event.phase));
      if (index < 0) queue.push(event); else waiters.splice(index, 1)[0].resolve(event);
    });
    const timeout = setTimeout(() => process.kill('SIGKILL'), 8000); done.then(() => clearTimeout(timeout));
    owned(t).children.push({ process, done });
    const take = (type, phase) => {
      const index = queue.findIndex(event => event.type === type && (!phase || event.phase === phase));
      return index >= 0 ? Promise.resolve(queue.splice(index, 1)[0])
        : new Promise((resolve, reject) => waiters.push({ type, phase, resolve, reject }));
    };
    await take('ready'); return { process, done, take, next: () => process.send('continue') };
  }

  for (const pause of ['metadata-open', 'metadata-half']) {
    test(`production publishes only a metadata-complete canonical after SIGKILL at ${pause}`, { skip: !linux }, async t => {
      const f = await fixture(t), worker = await child(t, { path: f.path, pause }); worker.next();
      await worker.take('checkpoint', pause); worker.process.kill('SIGKILL'); assert.equal((await worker.done).signal, 'SIGKILL');
      assert.equal(await maybe(f.path + '.lock'), null);
      const store = await f.open(); await inspect(f.path); await store.close();
    });
  }
  for (const pause of ['before-link', 'after-link', 'parent-synced']) {
    test(`production recovers a confirmed dead owner at ${pause} without partial metadata`, { skip: !linux }, async t => {
      const f = await fixture(t), worker = await child(t, { path: f.path, pause }); worker.next();
      await worker.take('checkpoint', pause);
      if (pause === 'before-link') assert.equal(await maybe(f.path + '.lock'), null); else await inspect(f.path);
      worker.process.kill('SIGKILL'); assert.equal((await worker.done).signal, 'SIGKILL');
      const store = await f.open(); const current = await inspect(f.path);
      assert.equal(current.metadata.pid, process.pid); await store.close();
    });
  }
  test('production v2 locks use the exact two-link alias and data images stay single-link', { skip: !linux }, async t => {
    const f = await fixture(t), store = await f.open(); await inspect(f.path);
    await store.createAccount({ username: 'owned', password: 'Owned production lock password!', maxGateways: 1 });
    assert.equal((await fs.lstat(f.path)).nlink, 1); await store.close();
    await fs.link(f.path, join(f.root, 'data-image-peer'));
    await assert.rejects(f.open(), { code: CODES.unsafe });
    assert.equal((await fs.lstat(f.path)).nlink, 2); assert.equal(await maybe(f.path + '.lock'), null);
  });
  for (const fault of ['link-eio', 'link-eexist', 'parent-sync']) {
    test(`production retains original publication on ${fault} and reports unknown without retry`, { skip: !linux }, async t => {
      const f = await fixture(t), worker = await child(t, { path: f.path, fault }); worker.next();
      const result = await worker.take('opened'); assert.equal(result.ok, false);
      assert.equal(result.code, 'REGISTRATION_LOCK_UNCONFIRMED'); assert.equal(result.unknown, true);
      assert.equal(result.links, 1); assert.equal(result.ownedHandleClosed, true); await inspect(f.path);
      await assert.rejects(f.open(), { code: CODES.locked }); worker.next(); assert.equal((await worker.done).code, 0);
      const recovered = await f.open(); await inspect(f.path); await recovered.close();
    });
  }
  test('two production writers elect one owner and never clean the winner', { skip: !linux }, async t => {
    for (let round = 0; round < 4; round++) {
      const f = await fixture(t), pair = await Promise.all([child(t, { path: f.path, pause: 'before-link' }), child(t, { path: f.path, pause: 'before-link' })]);
      pair.forEach(worker => worker.next()); await Promise.all(pair.map(worker => worker.take('checkpoint', 'before-link')));
      pair.forEach(worker => worker.next()); const results = await Promise.all(pair.map(worker => worker.take('opened')));
      assert.equal(results.filter(result => result.ok).length, 1);
      const winner = results.findIndex(result => result.ok); assert.equal(results[1 - winner].code, CODES.locked);
      assert.equal((await inspect(f.path)).metadata.pid, pair[winner].process.pid);
      pair.forEach(worker => worker.next()); assert.equal((await pair[winner].take('closed')).ok, true);
      for (const worker of pair) assert.equal((await worker.done).code, 0);
    }
  });
  test('unknown old metadata and unknown reap files remain untouched', { skip: !linux }, async t => {
    for (const kind of ['canonical', 'reap']) {
      const f = await fixture(t), path = f.path + '.lock';
      if (kind === 'canonical') await fs.writeFile(path, '{old-partial', { mode: 0o600 });
      else {
        await fs.writeFile(path, JSON.stringify({ version: 1, pid: process.pid, hostname: hostname(),
          processStart: 'different-process-start', startedAt: Date.now(), owner: randomBytes(24).toString('hex') }), { mode: 0o600 });
        await fs.writeFile(path + '.reap', '{old-reap-partial', { mode: 0o600 });
      }
      const protectedPath = kind === 'canonical' ? path : path + '.reap', before = await fs.readFile(protectedPath);
      await assert.rejects(f.open(), { code: CODES.locked }); assert.deepEqual(await fs.readFile(protectedPath), before);
    }
  });
  test('a replaced candidate directory is rejected without deleting its peer or the canonical', { skip: !linux }, async t => {
    const f = await fixture(t), worker = await child(t, { path: f.path }); worker.next(); assert.equal((await worker.take('opened')).ok, true);
    const current = await inspect(f.path), retained = current.candidate + '-retained';
    await fs.rename(current.candidate, retained); await fs.mkdir(current.candidate, { mode: 0o700 });
    await fs.link(current.canonical, join(current.candidate, 'metadata.json')); await fs.unlink(join(retained, 'metadata.json'));
    await fs.writeFile(join(current.candidate, 'peer'), 'must remain'); const before = id(await fs.lstat(current.candidate));
    await assert.rejects(f.open(), { code: CODES.locked }); worker.next();
    const result = await worker.take('closed'); assert.equal(result.ok, false); assert.equal(result.code, CODES.unsafe);
    assert.equal(result.ownedHandleClosed, true); assert.equal((await worker.done).code, 0);
    assert.deepEqual(id(await fs.lstat(current.candidate)), before); assert.equal(await fs.readFile(join(current.candidate, 'peer'), 'utf8'), 'must remain');
    assert.deepEqual(id(await fs.lstat(current.canonical)), current.identity);
  });
  test('old owner close preserves a real replacement owner and unknown retained aliases', { skip: !linux }, async t => {
    const f = await fixture(t), worker = await child(t, { path: f.path }); worker.next(); assert.equal((await worker.take('opened')).ok, true);
    await fs.rename(f.path + '.lock', join(f.root, 'retained-original'));
    const peer = await f.open(), before = await inspect(f.path); worker.next();
    assert.equal((await worker.take('closed')).ok, true); assert.equal((await worker.done).code, 0);
    assert.deepEqual((await inspect(f.path)).identity, before.identity); assert.deepEqual(peer.list(), []);
    assert.ok(await maybe(join(f.root, 'retained-original'))); await peer.close();
  });
  test('closing an already absent owned namespace only closes its own descriptor', { skip: !linux }, async t => {
    const f = await fixture(t), store = await f.open(); await fs.rm(f.root, { recursive: true, force: true });
    await store.close(); assert.equal(await maybe(f.path + '.lock'), null);
  });
  for (const pause of ['reaper-before-link', 'reaper-after-link']) {
    test(`reaper publication SIGKILL at ${pause} has complete metadata and never adopts unknown guards`, { skip: !linux }, async t => {
      const f = await fixture(t), original = await child(t, { path: f.path }); original.next();
      assert.equal((await original.take('opened')).ok, true); original.process.kill('SIGKILL'); await original.done;
      const recovery = await child(t, { path: f.path, pause }); recovery.next();
      await recovery.take('checkpoint', pause); recovery.process.kill('SIGKILL'); await recovery.done;
      if (pause === 'reaper-before-link') {
        assert.equal(await maybe(f.path + '.lock.reap'), null); const next = await f.open(); await next.close();
      } else {
        const guard = await inspect(f.path, '.lock.reap');
        const before = await fs.readFile(f.path + '.lock.reap');
        assert.equal(guard.metadata.pid, recovery.process.pid); await assert.rejects(f.open(), { code: CODES.locked });
        assert.deepEqual(await fs.readFile(f.path + '.lock.reap'), before);
      }
    });
  }
  for (const kind of ['release-kill', 'release-sync']) {
    test(`release ${kind} retains unreferenced owned metadata and never blocks or replays a new owner`, { skip: !linux }, async t => {
      const f = await fixture(t), worker = await child(t, { path: f.path,
        ...(kind === 'release-kill' ? { pause: 'canonical-unlinked' } : { fault: 'release-sync' }) });
      worker.next(); assert.equal((await worker.take('opened')).ok, true); const prior = await inspect(f.path); worker.next();
      if (kind === 'release-kill') {
        await worker.take('checkpoint', 'canonical-unlinked'); worker.process.kill('SIGKILL'); await worker.done;
      } else {
        const closed = await worker.take('closed'); assert.equal(closed.ok, false); assert.equal(closed.code, CODES.unsafe);
        assert.equal(closed.cleanupUnconfirmed, true); assert.equal(closed.ownedHandleClosed, true); await worker.done;
      }
      assert.equal(await maybe(prior.canonical), null); assert.ok(await maybe(prior.candidate));
      const next = await f.open(); await next.close(); assert.ok(await maybe(prior.candidate), 'unknown orphan is retained');
    });
  }
  for (const kind of ['extra-link', 'duplicate-json', 'oversized', 'traversal', 'invalid-start']) {
    test(`cold v2 ${kind} fails closed without weakening alias or parser rules`, { skip: !linux }, async t => {
      const f = await fixture(t), worker = await child(t, { path: f.path }); worker.next();
      assert.equal((await worker.take('opened')).ok, true); const current = await inspect(f.path);
      const bytes = await fs.readFile(current.canonical, 'utf8');
      if (kind === 'extra-link') await fs.link(current.canonical, join(f.root, 'unknown-extra-link'));
      if (kind === 'duplicate-json') await fs.writeFile(current.canonical, bytes.replace('{', '{"version":2,'));
      if (kind === 'oversized') await fs.writeFile(current.canonical, ' '.repeat(4097));
      if (kind === 'traversal') {
        const metadata = JSON.parse(bytes); metadata.candidate.name = '../peer'; await fs.writeFile(current.canonical, JSON.stringify(metadata));
      }
      if (kind === 'invalid-start') {
        const metadata = JSON.parse(bytes); metadata.processStart = ''; await fs.writeFile(current.canonical, JSON.stringify(metadata));
      }
      const protectedBytes = await fs.readFile(current.canonical); await assert.rejects(f.open(), { code: CODES.locked });
      worker.next(); const closed = await worker.take('closed'); assert.equal(closed.ok, false); assert.equal(closed.ownedHandleClosed, true);
      await worker.done; assert.deepEqual(await fs.readFile(current.canonical), protectedBytes);
    });
  }
  test('a complete foreign-host legacy lock is not guessed dead using a local PID', { skip: !linux }, async t => {
    const f = await fixture(t), canonical = f.path + '.lock';
    const bytes = JSON.stringify({ version: 1, pid: 2147483647, hostname: 'owned-foreign-lock-host.invalid',
      processStart: null, startedAt: Date.now(), owner: randomBytes(24).toString('hex') });
    await fs.writeFile(canonical, bytes, { mode: 0o600 }); await assert.rejects(f.open(), { code: CODES.locked });
    assert.equal(await fs.readFile(canonical, 'utf8'), bytes);
  });
  test('candidate cleanup retains unknown files and does not recursively remove the directory', { skip: !linux }, async t => {
    const f = await fixture(t), worker = await child(t, { path: f.path }); worker.next();
    assert.equal((await worker.take('opened')).ok, true); const current = await inspect(f.path);
    await fs.writeFile(join(current.candidate, 'unknown-peer'), 'must remain'); worker.next();
    const closed = await worker.take('closed'); assert.equal(closed.ok, false); assert.equal(closed.cleanupUnconfirmed, true);
    assert.equal(closed.ownedHandleClosed, true); await worker.done;
    assert.equal(await maybe(current.canonical), null);
    assert.equal(await fs.readFile(join(current.candidate, 'unknown-peer'), 'utf8'), 'must remain');
    const next = await f.open(); await next.close();
    assert.equal(await fs.readFile(join(current.candidate, 'unknown-peer'), 'utf8'), 'must remain');
  });
  test('warm account projections perform no filesystem work and immediately observe committed revocation', { skip: !linux }, async t => {
    const f = await fixture(t), store = await f.open(), proof = randomBytes(32).toString('base64url');
    const password = 'Owned warm lock password 2026!';
    await store.createAccount({ username: 'warm', password, maxGateways: 1 }); await store.signInAccount({ username: 'warm', password }, proof);
    let operations = 0;
    const names = ['open', 'readFile', 'lstat', 'readdir', 'writeFile', 'link', 'mkdir', 'unlink', 'rmdir'];
    const mocks = names.map(name => {
      const original = fs[name]; return t.mock.method(fs, name, (...args) => { operations++; return original(...args); });
    });
    try {
      for (let index = 0; index < 40; index++) {
        assert.equal(store.getAccountSession(proof).username, 'warm'); store.managementSnapshot(); store.list();
      }
      assert.equal(operations, 0);
    } finally { for (const mocked of mocks) mocked.mock.restore(); }
    await store.revokeAccountSession(proof); assert.equal(store.getAccountSession(proof), null); await store.close();
  });
  test('stale-owner retirement sync failure preserves its original candidate and cleanup uncertainty', { skip: !linux }, async t => {
    const f = await fixture(t), original = await child(t, { path: f.path }); original.next();
    assert.equal((await original.take('opened')).ok, true); const prior = await inspect(f.path);
    original.process.kill('SIGKILL'); await original.done;
    const recovery = await child(t, { path: f.path, fault: 'stale-removal-sync' }); recovery.next();
    const failure = await recovery.take('opened'); assert.equal(failure.ok, false); assert.equal(failure.code, CODES.unsafe);
    assert.equal(failure.cleanupUnconfirmed, true); assert.equal(failure.ownedHandleClosed, true);
    assert.equal(await maybe(prior.canonical), null); assert.ok(await maybe(prior.candidate));
    recovery.next(); assert.equal((await recovery.done).code, 0);
    const next = await f.open(); await next.close(); assert.ok(await maybe(prior.candidate));
  });
  test('a busy lock probe does not create or write another candidate', { skip: !linux }, async t => {
    const f = await fixture(t), store = await f.open(); let writes = 0;
    const open = fs.open, mkdir = fs.mkdir, link = fs.link;
    const mocks = [
      t.mock.method(fs, 'open', (...args) => { if (args[1] & constants.O_CREAT) writes++; return open(...args); }),
      t.mock.method(fs, 'mkdir', (...args) => { writes++; return mkdir(...args); }),
      t.mock.method(fs, 'link', (...args) => { writes++; return link(...args); }),
    ];
    try { await assert.rejects(f.open(), { code: CODES.locked }); assert.equal(writes, 0); }
    finally { for (const mocked of mocks) mocked.mock.restore(); }
    await store.close();
  });
  test('publication handoff rechecks its original canonical after awaited parent sync', { skip: !linux }, async t => {
    const f = await fixture(t), worker = await child(t, { path: f.path, pause: 'parent-synced' }); worker.next();
    await worker.take('checkpoint', 'parent-synced'); const original = await inspect(f.path);
    await fs.rename(original.canonical, join(f.root, 'retained-before-handoff'));
    const peer = await f.open(), current = await inspect(f.path); worker.next();
    const result = await worker.take('opened'); assert.equal(result.ok, false);
    assert.equal(result.code, 'REGISTRATION_LOCK_UNCONFIRMED'); assert.equal(result.unknown, true);
    assert.equal(result.ownedHandleClosed, true); assert.deepEqual((await inspect(f.path)).identity, current.identity);
    assert.ok(await maybe(original.candidate)); assert.deepEqual(peer.list(), []);
    worker.next(); await worker.done; await peer.close();
  });
  test('a complete v1 lock respects its live owner and is recoverable after confirmed SIGKILL', { skip: !linux }, async t => {
    const f = await fixture(t), legacy = await child(t, { path: f.path, legacy: true }); legacy.next();
    assert.equal((await legacy.take('opened')).ok, true); const before = await fs.readFile(f.path + '.lock');
    await assert.rejects(f.open(), { code: CODES.locked }); assert.deepEqual(await fs.readFile(f.path + '.lock'), before);
    legacy.process.kill('SIGKILL'); assert.equal((await legacy.done).signal, 'SIGKILL');
    const store = await f.open(); assert.equal((await inspect(f.path)).metadata.pid, process.pid); await store.close();
  });
  test('a secondary directory close failure does not replace the original release sync failure', { skip: !linux }, async t => {
    const f = await fixture(t), worker = await child(t, { path: f.path, fault: 'release-sync-and-close' }); worker.next();
    assert.equal((await worker.take('opened')).ok, true); const current = await inspect(f.path); worker.next();
    const closed = await worker.take('closed'); assert.equal(closed.ok, false); assert.equal(closed.primarySyncKept, true);
    assert.equal(closed.cleanupUnconfirmed, true); assert.equal(closed.ownedHandleClosed, true); await worker.done;
    assert.ok(await maybe(current.candidate)); assert.equal(await maybe(current.canonical), null);
  });
  test('prepublication candidate replacement is refused rather than adopting a peer directory', { skip: !linux }, async t => {
    const f = await fixture(t), worker = await child(t, { path: f.path, pause: 'candidate-observed' }); worker.next();
    await worker.take('checkpoint', 'candidate-observed');
    const name = (await fs.readdir(f.root)).find(name => name.startsWith('.registration-lock-candidate-'));
    const candidate = join(f.root, name); await fs.rename(candidate, candidate + '-retained');
    await fs.mkdir(candidate, { mode: 0o700 }); await fs.writeFile(join(candidate, 'peer'), 'must remain');
    const before = id(await fs.lstat(candidate)); worker.next(); const result = await worker.take('opened');
    assert.equal(result.ok, false); assert.equal(result.code, CODES.unsafe);
    assert.equal(await maybe(f.path + '.lock'), null); assert.deepEqual(id(await fs.lstat(candidate)), before);
    assert.equal(await maybe(join(candidate, 'metadata.json')), null);
    assert.equal(await fs.readFile(join(candidate, 'peer'), 'utf8'), 'must remain');
    worker.next(); await worker.done;
  });
}
