import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';

const addonPath = process.argv[2];
assert.ok(addonPath && isAbsolute(addonPath), 'supply the absolute built .node addon path');
assert.equal(typeof global.gc, 'function', 'run this owned suite with --expose-gc');
const addon = createRequire(import.meta.url)(addonPath);
const name = 'kcoder-storage-writers.lock';
assert.equal(addon.abiVersion, 1);

async function owned(run) {
  const root = mkdtempSync(join(tmpdir(), 'kcoder-native-storage-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

function close(lease) {
  if (lease != null) addon.close(lease);
}

test('existing-only acquisition creates nothing and distinguishes missing from busy', () => owned(async (root) => {
  assert.equal(addon.trySharedExisting(join(root, 'absent'), name), undefined);
  assert.equal(existsSync(join(root, 'absent')), false);
  assert.equal(addon.trySharedExisting(root, name), undefined);
  assert.deepEqual(readdirSync(root), []);
  const lease = addon.tryExclusive(root, name, false);
  try {
    assert.ok(lease);
    assert.equal(addon.trySharedExisting(root, name), null);
    assert.equal(addon.verify(lease), true);
  } finally {
    close(lease);
  }
}));

test('shared leases survive closing a peer and close is idempotent', () => owned(async (root) => {
  const first = addon.tryShared(root, name, false);
  const second = addon.trySharedExisting(root, name);
  try {
    assert.ok(first && second);
    assert.equal(addon.tryExclusive(root, name, false), null);
    assert.equal(addon.close(first), true);
    assert.equal(addon.close(first), false);
    assert.throws(() => addon.verify(first), { code: 'NATIVE_STORAGE_LEASE_CLOSED' });
    assert.equal(addon.verify(second), true);
    assert.equal(addon.tryExclusive(root, name, false), null);
  } finally {
    close(first);
    close(second);
  }
  const exclusive = addon.tryExclusive(root, name, false);
  assert.ok(exclusive);
  close(exclusive);
}));

test('foreign values, cloned wrappers and unsupported lock names are rejected', () => owned(async (root) => {
  for (const invalid of ['credentials.json.lock', '../kcoder-storage.lock', 'kcoder-storage.lock:stream']) {
    assert.throws(() => addon.tryShared(root, invalid, false), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
  }
  assert.throws(() => addon.tryShared('relative', name, true), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
  assert.throws(() => addon.tryShared(root, name, 1), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
  assert.throws(() => addon.trySharedExisting(root, name, true), { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' });
  assert.deepEqual(readdirSync(root), []);
  const lease = addon.tryShared(root, name, false);
  try {
    for (const foreign of [{}, { ...lease }, Object.create(lease), new Proxy(lease, {}), null, 4]) {
      assert.throws(() => addon.verify(foreign), { code: 'NATIVE_STORAGE_HANDLE_INVALID' });
      assert.throws(() => addon.close(foreign), { code: 'NATIVE_STORAGE_HANDLE_INVALID' });
    }
    assert.equal(addon.verify(lease), true);
  } finally {
    close(lease);
  }
}));

test('another loaded image cannot reinterpret a private lease Box', {
  skip: process.platform === 'win32' ? 'loaded DLL cleanup needs an owned child on Windows' : false,
}, () => owned(async (root) => {
  const secondImage = join(root, 'second-storage-image.node');
  copyFileSync(addonPath, secondImage);
  const other = createRequire(import.meta.url)(secondImage);
  const lease = addon.tryShared(root, name, false);
  try {
    assert.throws(() => other.verify(lease), { code: 'NATIVE_STORAGE_HANDLE_INVALID' });
    assert.throws(() => other.close(lease), { code: 'NATIVE_STORAGE_HANDLE_INVALID' });
    assert.equal(addon.verify(lease), true);
  } finally {
    close(lease);
  }
}));

test('a separate Node process holds the same OS lock until its actual exit', () => owned(async (root) => {
  const child = fork(fileURLToPath(new URL('./holder.mjs', import.meta.url)), [addonPath, root, name], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stderr.on('data', (bytes) => { diagnostics = (diagnostics + bytes).slice(-8192); });
  const exited = once(child, 'exit');
  try {
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(() => { throw new Error(`owned holder exited before readiness: ${diagnostics}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('owned holder timed out')), 5000).unref()),
    ]);
    assert.deepEqual(ready, { held: true });
    assert.equal(addon.tryExclusive(root, name, false), null);
    child.send('exit');
    const [code] = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('owned holder did not exit')), 5000).unref()),
    ]);
    assert.equal(code, 0, diagnostics);
    const lease = addon.tryExclusive(root, name, false);
    assert.ok(lease);
    close(lease);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}));

test('GC finalization releases an abandoned native lease', () => owned(async (root) => {
  let abandoned = addon.tryExclusive(root, name, false);
  assert.ok(abandoned);
  abandoned = null;
  let recovered = null;
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      global.gc();
      await nextTurn();
      recovered = addon.tryExclusive(root, name, false);
      if (recovered !== null) break;
    }
    assert.ok(recovered, 'GC must release the real held file, not retain a registry entry');
  } finally {
    close(recovered);
  }
}));

test('worker environment teardown releases its retained native lease', () => owned(async (root) => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const addon = require(workerData.addonPath);
    globalThis.held = addon.tryExclusive(workerData.root, workerData.name, false);
    parentPort.postMessage({ held: globalThis.held !== null });
    parentPort.on('message', () => {});
  `, { eval: true, execArgv: [], workerData: { addonPath, root, name } });
  try {
    const [ready] = await once(worker, 'message');
    assert.deepEqual(ready, { held: true });
    assert.equal(addon.tryExclusive(root, name, false), null);
  } finally {
    await worker.terminate();
  }
  const lease = addon.tryExclusive(root, name, false);
  assert.ok(lease);
  close(lease);
}));

test('verification rejects a replaced leaf or the OS prevents replacement', t => owned(async (root) => {
  const lease = addon.tryShared(root, name, false);
  try {
    try {
      renameSync(join(root, name), join(root, 'detached-lock'));
    } catch (error) {
      assert.equal(process.platform, 'win32');
      assert.ok(['EACCES', 'EPERM', 'EBUSY'].includes(error.code));
      assert.equal(addon.verify(lease), true);
      assert.equal(addon.tryExclusive(root, name, false), null);
      t.skip(`Windows refused held lock rename (${error.code}); replacement detection requires an executable owned rename`);
      return;
    }
    const replacement = addon.tryShared(root, name, false);
    close(replacement);
    assert.throws(() => addon.verify(lease), { code: 'NATIVE_STORAGE_BINDING_CHANGED' });
  } finally {
    close(lease);
  }
}));
