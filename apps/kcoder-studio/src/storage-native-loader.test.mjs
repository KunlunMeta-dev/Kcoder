import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

const INVALID = { code: 'STORAGE_NATIVE_RESOURCE_INVALID' };
let imports = 0;

async function fixture(t, { windows = false, cargoLinks = false } = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'storage-loader-metadata-'));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalTarget = process.env.KCODER_TARGET_DIR;
  const library = windows || process.platform === 'win32' ? 'kcoder_native_storage.dll'
    : process.platform === 'darwin' ? 'libkcoder_native_storage.dylib' : 'libkcoder_native_storage.so';
  const image = join(root, 'debug', library), alias = join(dirname(image), 'deps', library);
  await fs.mkdir(dirname(alias), { recursive: true });
  const bytes = Buffer.from('owned fake image; process.dlopen is mocked, no native code executes');
  await fs.writeFile(image, bytes);
  if (cargoLinks) await fs.link(image, alias);
  const open = fs.open, lstat = fs.lstat, readFile = fs.readFile;
  const state = { pathInodeChanged: false, foreignBefore: false, foreignAfter: false,
    aliasForeign: false, symlink: false, oversized: false, extraLinks: false, changedAfter: null,
    afterLoad: false, loads: 0, payloadReads: 0, opens: 0, closes: 0 };
  const shape = (info, options, named, candidate) => {
    const bigint = options?.bigint;
    const number = value => bigint ? BigInt(value) : Number(value);
    const changed = state.afterLoad ? state.changedAfter : null;
    return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
      ...(windows ? {
        dev: named ? number(0) : number(info.dev + number(
          candidate === alias && state.aliasForeign || candidate === image &&
          (state.afterLoad ? state.foreignAfter : state.foreignBefore) ? 1 : 0)),
        ino: number((1n << 54n) + (named && state.pathInodeChanged ? 1n : 0n)),
      } : {}),
      nlink: state.extraLinks ? number(3) : changed === 'links' ? info.nlink + number(1) : info.nlink,
      size: state.oversized ? number(64n * 1024n * 1024n + 1n) : changed === 'size' ? info.size + number(1) : info.size,
      ...(bigint && changed === 'mtime' ? { mtimeNs: info.mtimeNs + 1n } : {}),
      ...(named && state.symlink ? { isSymbolicLink: () => true } : {}),
    });
  };
  const mocks = [
    t.mock.method(fs, 'lstat', async (path, options) => {
      const info = await lstat(path, options);
      return path === image || path === alias ? shape(info, options, true, path) : info;
    }),
    t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await open(path, ...args);
      if (path !== image && path !== alias) return handle;
      state.opens++;
      const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
      // Distinguish the retained original FD from a newly opened current name.
      const candidate = state.opens === 1 ? null : path;
      t.mock.method(handle, 'stat', async options => shape(await stat(options), options, false, candidate));
      t.mock.method(handle, 'close', async () => { state.closes++; return close(); });
      for (const method of ['read', 'readFile']) t.mock.method(handle, method, () => {
        state.payloadReads++; throw new Error('metadata validation must not read image payloads');
      });
      return handle;
    }),
    t.mock.method(fs, 'readFile', async (path, ...args) => {
      if (path === image || path === alias) {
        state.payloadReads++; throw new Error('metadata validation must not hash/read the image');
      }
      return readFile(path, ...args);
    }),
    t.mock.method(process, 'dlopen', (module, path) => {
      assert.equal(path, image);
      state.loads++;
      state.afterLoad = true;
      module.exports = { abiVersion: 1, ...Object.fromEntries([
        'tryShared', 'tryExclusive', 'trySharedExisting', 'verify', 'close', 'readSourceRetirement',
      ].map(name => [name, () => {}])) };
    }),
  ];
  if (windows) Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  process.env.KCODER_TARGET_DIR = root;
  syncBuiltinESMExports();
  t.after(async () => {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalTarget === undefined) delete process.env.KCODER_TARGET_DIR;
    else process.env.KCODER_TARGET_DIR = originalTarget;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, image, alias, bytes, state, async load() {
    state.afterLoad = false; state.opens = 0; state.closes = 0;
    const { loadStorageNative } = await import(`./storage-lease.mjs?metadata-test=${++imports}`);
    try { return await loadStorageNative(); }
    finally { assert.equal(state.closes, state.opens, 'every owned image FD must close on success or refusal'); }
  } };
}

test('native loader checks actual owned file metadata without reading bytes; dlopen is mocked', async t => {
  const f = await fixture(t), before = await fs.stat(f.image, { bigint: true });
  assert.equal((await f.load()).abiVersion, 1);
  assert.equal(f.state.loads, 1);
  assert.equal(f.state.payloadReads, 0);
  const after = await fs.stat(f.image, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.deepEqual((await fs.readdir(dirname(f.image))).sort(), ['deps', basename(f.image)].sort());
});

test('native loader Windows-shaped snapshots keep exact large indices with path dev zero', async t => {
  const f = await fixture(t, { windows: true });
  assert.equal((await f.load()).abiVersion, 1);
  f.state.pathInodeChanged = true;
  await assert.rejects(f.load(), INVALID);
  assert.equal(f.state.loads, 1, 'an adjacent large file index must be rejected before dlopen');
});

test('native loader Windows named handles require the held volume both before and after dlopen', async t => {
  const f = await fixture(t, { windows: true });
  f.state.foreignBefore = true;
  await assert.rejects(f.load(), INVALID);
  assert.equal(f.state.loads, 0);
  f.state.foreignBefore = false; f.state.foreignAfter = true;
  await assert.rejects(f.load(), INVALID);
  assert.equal(f.state.loads, 1);
});

test('native loader Cargo two-link aliases need their own actual held identity proof', async t => {
  const f = await fixture(t, { windows: true, cargoLinks: true });
  assert.equal((await f.load()).abiVersion, 1);
  f.state.aliasForeign = true;
  await assert.rejects(f.load(), INVALID);
  assert.equal(f.state.loads, 1, 'matching path metadata alone must not admit the Cargo alias');
});

test('native loader retains symlink, size and extra-link refusal before dlopen', async t => {
  const f = await fixture(t, { windows: true });
  for (const field of ['symlink', 'oversized', 'extraLinks']) {
    f.state[field] = true;
    await assert.rejects(f.load(), INVALID);
    f.state[field] = false;
  }
  assert.equal(f.state.loads, 0);
});

test('native loader rejects size, mtime or link changes made during dlopen', async t => {
  const f = await fixture(t, { windows: true });
  for (const change of ['size', 'mtime', 'links']) {
    f.state.changedAfter = change;
    await assert.rejects(f.load(), INVALID);
  }
  assert.equal(f.state.loads, 3);
  assert.equal(f.state.payloadReads, 0);
});
