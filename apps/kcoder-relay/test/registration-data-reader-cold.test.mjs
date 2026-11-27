import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openRegistrationStore, REGISTRATION_STORE_ERROR_CODES as CODES } from '../src/registration-store.mjs';

const linux = process.platform === 'linux';
const self = fileURLToPath(import.meta.url);
const image = JSON.stringify({ version: 1, gateways: [{ id: '1'.repeat(32), secret: '2'.repeat(64),
  gatewaySecret: 'owned-cold-reader-internal-secret-0123456789', enrollmentTokenHash: '3'.repeat(64) }] }) + '\n';
const replacement = '{"version":1,"gateways":[]}\n';
const identity = stat => [String(stat.dev), String(stat.ino)];
const maybe = path => fs.lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });

async function worker(input) {
  const open = fs.open, lstat = fs.lstat; let observed = false, changed = false, dataFlags, store;
  const mutate = async () => {
    if (changed) return; changed = true;
    if (input.kind === 'same-inode') {
      await fs.writeFile(input.path, image.replace('"secret":"2', '"secret":"4')); return;
    }
    if (['link-during-read', 'open-hardlink'].includes(input.kind)) { await fs.link(input.path, input.path + '.extra'); return; }
    if (input.kind.includes('missing')) { await fs.unlink(input.path); return; }
    await fs.rename(input.path, input.path + '.retained');
    if (input.kind.includes('fifo')) execFileSync('/usr/bin/mkfifo', ['-m', '600', input.path], { timeout: 2000 });
    else await fs.writeFile(input.path, replacement, { mode: 0o600 });
  };
  fs.lstat = async (...args) => {
    const value = await lstat(...args); if (args[0] === input.path) observed = true; return value;
  };
  fs.open = async (path, flags, ...rest) => {
    if (path !== input.path || typeof flags !== 'number' || (flags & (constants.O_WRONLY | constants.O_RDWR))) return open(path, flags, ...rest);
    if (input.kind.startsWith('open-')) await mutate();
    dataFlags = { nonblock: Boolean(flags & constants.O_NONBLOCK), nofollow: Boolean(flags & (constants.O_NOFOLLOW ?? 0)), preObserved: observed };
    process.send({ type: 'data-open', flags: dataFlags });
    const handle = await open(path, flags, ...rest);
    return new Proxy(handle, { get(target, property) {
      if (property === 'read') return async (...args) => {
        if (!changed && (input.kind.startsWith('before-read') || ['same-inode', 'link-during-read'].includes(input.kind))) await mutate();
        const result = await target.read(...args);
        if (!changed && input.kind.startsWith('after-read') && result.bytesRead) await mutate();
        return result;
      };
      if (property === 'close' && input.closeFailure) return async () => {
        await target.close(); throw Object.assign(new Error('Controlled data descriptor close failure'), { code: 'EIO' });
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  process.send({ type: 'ready' });
  await new Promise(resolve => process.once('message', resolve));
  try {
    store = await openRegistrationStore({ path: input.path });
    process.send({ type: 'result', ok: true, count: store.list().length, flags: dataFlags, changed });
  } catch (error) {
    process.send({ type: 'result', ok: false, code: error.code, flags: dataFlags, changed,
      cleanupUnconfirmed: error.cleanupUnconfirmed === true,
      readCleanupPrivate: Boolean(error.readCleanupError) && !Object.keys(error).includes('readCleanupError') });
  } finally { if (store) await store.close(); process.disconnect(); }
}

if (process.argv[2] === '--cold-reader-worker') {
  await worker(JSON.parse(process.argv[3])).catch(error => {
    process.send?.({ type: 'failure', code: error.code }); process.exitCode = 1; process.disconnect?.();
  });
} else {
  const states = new WeakMap();
  function owned(t) {
    if (states.has(t)) return states.get(t);
    const state = { roots: [], children: [], stores: [] }; states.set(t, state);
    t.after(async () => {
      for (const child of state.children) if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
      await Promise.all(state.children.map(child => child.done));
      for (const store of state.stores) await store.close();
      for (const root of state.roots) {
        const current = await maybe(root.path);
        if (current && JSON.stringify(identity(current)) !== JSON.stringify(root.identity)) throw Error('Owned cold-reader root changed');
        await fs.rm(root.path, { recursive: true, force: true });
      }
      t.diagnostic(JSON.stringify({ ownedChildrenExited: state.children.length, ownedRootsRemoved: state.roots.length }));
    }); return state;
  }
  async function fixture(t, kind = 'regular') {
    const root = await fs.mkdtemp(join(tmpdir(), 'registration-data-reader-'));
    owned(t).roots.push({ path: root, identity: identity(await fs.lstat(root)) });
    const path = join(root, 'registration.json');
    if (kind === 'fifo') execFileSync('/usr/bin/mkfifo', ['-m', '600', path], { timeout: 2000 });
    else if (kind !== 'missing') await fs.writeFile(path, image, { mode: 0o600 });
    if (kind === 'hardlink') await fs.link(path, path + '.peer');
    return { root, path, open: async () => { const store = await openRegistrationStore({ path }); owned(t).stores.push(store); return store; } };
  }
  async function run(t, options) {
    const process = spawn(globalThis.process.execPath, [self, '--cold-reader-worker', JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    process.stdout.resume(); process.stderr.resume(); const queue = [], waiters = []; let settled = false, finish;
    const done = new Promise(resolve => { finish = value => {
      if (settled) return; settled = true; resolve(value);
      for (const waiter of waiters) waiter.reject(Error('Owned cold-reader exited before event'));
    }; });
    process.once('exit', (code, signal) => finish({ code, signal })); process.once('error', () => finish({ spawnFailed: true }));
    process.on('message', event => {
      const index = waiters.findIndex(waiter => waiter.types.includes(event.type));
      if (index < 0) queue.push(event); else waiters.splice(index, 1)[0].resolve(event);
    });
    const take = (...types) => {
      const index = queue.findIndex(event => types.includes(event.type));
      return index >= 0 ? Promise.resolve(queue.splice(index, 1)[0]) : new Promise((resolve, reject) => waiters.push({ types, resolve, reject }));
    };
    owned(t).children.push({ process, done }); const watchdog = setTimeout(() => process.kill('SIGKILL'), 6000); done.then(() => clearTimeout(watchdog));
    await take('ready'); process.send('start');
    const first = await take('data-open', 'result');
    if (first.type === 'result') { assert.equal((await done).code, 0); return first; }
    const result = take('result'); result.catch(() => {}); let timer;
    const output = await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve({ blocked: true, flags: first.flags }), 500); })]);
    clearTimeout(timer);
    if (output.blocked) {
      process.kill('SIGKILL'); assert.equal((await done).signal, 'SIGKILL');
    } else assert.equal((await done).code, 0);
    return output;
  }

  test('a FIFO without any writer is rejected without blocking its owned reader', { skip: !linux }, async t => {
    const f = await fixture(t, 'fifo'), result = await run(t, { path: f.path, kind: 'none' });
    assert.equal(result.blocked, undefined, 'canonical FIFO must not block open before the type guard');
    assert.equal(result.code, CODES.unsafe); assert.equal((await fs.lstat(f.path)).isFIFO(), true);
    assert.equal(await maybe(f.path + '.lock'), null);
  });
  for (const kind of ['open-fifo', 'open-file', 'open-missing', 'before-read-file', 'before-read-missing', 'after-read-file', 'after-read-missing', 'same-inode', 'link-during-read']) {
    test(`observed data image ${kind} is unsafe rather than a new or stale store`, { skip: !linux }, async t => {
      const f = await fixture(t), result = await run(t, { path: f.path, kind });
      assert.equal(result.blocked, undefined, 'regular-to-FIFO replacement must remain nonblocking');
      assert.equal(result.code, CODES.unsafe); assert.equal(result.changed, true);
      if (kind === 'open-fifo') { assert.equal(result.flags.preObserved, true); assert.equal(result.flags.nonblock, true); }
      if (kind.endsWith('-file')) {
        assert.equal(await fs.readFile(f.path, 'utf8'), replacement);
        assert.equal(await fs.readFile(f.path + '.retained', 'utf8'), image);
      }
      if (kind.endsWith('-missing')) assert.equal(await maybe(f.path), null);
      assert.equal(await maybe(f.path + '.lock'), null);
    });
  }
  test('ordinary images and supported old versions load without rewriting their bytes', async t => {
    for (const version of [1, 2, 3, 4, 5, 6]) {
      const f = await fixture(t), document = { version, gateways: [], ...(version > 1 ? { activationCodes: [] } : {}), ...(version > 2 ? { accounts: [] } : {}) };
      const bytes = JSON.stringify(document) + '\n'; await fs.writeFile(f.path, bytes, { mode: 0o600 });
      const before = identity(await fs.lstat(f.path)), store = await f.open(); assert.deepEqual(store.list(), []); await store.close();
      assert.equal(await fs.readFile(f.path, 'utf8'), bytes); assert.deepEqual(identity(await fs.lstat(f.path)), before);
    }
    const empty = await fixture(t, 'missing'), store = await empty.open(); assert.deepEqual(store.list(), []); await store.close();
    assert.equal(await maybe(empty.path), null);
  });
  test('data hardlinks remain rejected and a descriptor close error cannot replace the primary type error', { skip: !linux }, async t => {
    for (const closeFailure of [false, true]) {
      const f = await fixture(t, closeFailure ? 'regular' : 'hardlink'), before = await fs.readFile(f.path);
      const result = await run(t, { path: f.path, kind: closeFailure ? 'open-hardlink' : 'none', closeFailure });
      assert.equal(result.code, CODES.unsafe);
      if (closeFailure) { assert.equal(result.cleanupUnconfirmed, true); assert.equal(result.readCleanupPrivate, true); }
      assert.deepEqual(await fs.readFile(f.path), before); assert.equal((await fs.lstat(f.path)).nlink, 2);
      assert.equal(await maybe(f.path + '.lock'), null);
    }
  });
}
