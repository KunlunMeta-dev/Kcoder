import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadStorageNative } from '../src/storage-lease.mjs';

const INSTANCES = 'kcoder-storage-instances.lock';
const ARGUMENT = { code: 'NATIVE_STORAGE_ARGUMENT_INVALID' };
const CHANGED = { code: 'NATIVE_STORAGE_BINDING_CHANGED' };

async function owned(run) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'storage-native-observation-'));
  const leases = [];
  let native;
  try {
    native = await loadStorageNative();
    const take = (name = INSTANCES, exclusive = false, scope = root) => {
      const lease = native[exclusive ? 'tryExclusive' : 'tryShared'](scope, name, false);
      assert.ok(lease, 'the test must hold its original owned lease');
      leases.push(lease);
      return lease;
    };
    await run({ root, native, take });
  } finally {
    if (native) for (const lease of leases.reverse()) native.close(lease);
    await rm(root, { recursive: true, force: true });
  }
}

function observe(native, lease, relative, kind) {
  const text = native.observeEntry(lease, relative, kind);
  assert.equal(typeof text, 'string');
  const facts = JSON.parse(text);
  assert.deepEqual(Object.keys(facts).sort(), ['identity', 'links']);
  assert.equal(typeof facts.identity, 'string');
  assert.ok(facts.identity.length > 0);
  if (kind === 'directory') assert.equal(facts.links, null);
  else assert.match(facts.links, /^[1-9][0-9]*$/);
  // The identity stays opaque; parsing it into JS Numbers would lose native bits.
  return facts;
}

test('native observations expose metadata without parsing payloads or writing owned entries', () => owned(async ({ root, native, take }) => {
  await mkdir(join(root, 'ordinary', 'nested'), { recursive: true });
  const path = join(root, 'ordinary', 'nested', 'opaque.bin');
  const bytes = Buffer.alloc(128 * 1024, 255);
  await writeFile(path, bytes);
  const lease = take();
  const before = await lstat(path, { bigint: true });
  observe(native, lease, 'ordinary/nested', 'directory');
  const file = observe(native, lease, 'ordinary/nested/opaque.bin', 'file');
  assert.equal(file.links, '1');
  assert.equal(native.verify(lease), true);
  const after = await lstat(path, { bigint: true });
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink']) assert.equal(after[field], before[field], field);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readdir(join(root, 'ordinary', 'nested')), ['opaque.bin']);
  assert.deepEqual((await readdir(root)).sort(), [INSTANCES, 'ordinary'].sort());
}));

test('native observations reject invalid kinds, outside paths, closed leases and foreign objects', () => owned(async ({ root, native, take }) => {
  await mkdir(join(root, 'child'));
  await writeFile(join(root, 'payload'), 'keep');
  const lease = take();
  for (const path of ['', '.', '..', '../payload', 'child/../../payload', root]) {
    assert.throws(() => native.observeEntry(lease, path, 'file'), ARGUMENT);
  }
  for (const kind of ['', 'Directory', 'symlink', 'readWrite', 1]) {
    assert.throws(() => native.observeEntry(lease, 'child', kind), ARGUMENT);
  }
  for (const foreign of [{}, { ...lease }, Object.create(lease), new Proxy(lease, {}), null, 4]) {
    assert.throws(() => native.observeEntry(foreign, 'child', 'directory'), { code: 'NATIVE_STORAGE_HANDLE_INVALID' });
  }
  for (const name of ['kcoder-storage.lock', 'kcoder-storage-writers.lock']) {
    assert.throws(() => native.observeEntry(take(name), 'child', 'directory'), ARGUMENT);
  }
  assert.throws(() => native.observeEntry(lease, 'absent', 'file'));
  assert.throws(() => native.observeEntry(lease, 'payload', 'directory'));
  assert.throws(() => native.observeEntry(lease, 'child', 'file'));
  assert.equal(native.verify(lease), true);
  native.close(lease);
  assert.throws(() => native.observeEntry(lease, 'child', 'directory'), { code: 'NATIVE_STORAGE_LEASE_CLOSED' });
  await assert.rejects(lstat(join(root, 'absent')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'payload'), 'utf8'), 'keep');
}));

test('native observations retain the original exclusive lock and bound the existing 128-owner metadata budget', () => owned(async ({ root, native, take }) => {
  for (let index = 0; index < 641; index++) await mkdir(join(root, `entry-${index}`));
  const lease = take(INSTANCES, true);
  const first = observe(native, lease, 'entry-0', 'directory');
  for (let index = 0; index < 70; index++) assert.deepEqual(observe(native, lease, 'entry-0', 'directory'), first);
  for (let index = 1; index < 640; index++) observe(native, lease, `entry-${index}`, 'directory');
  assert.throws(() => native.observeEntry(lease, 'entry-640', 'directory'), ARGUMENT);
  assert.throws(() => native.observeEntry(lease, 'entry-0', 'file'), ARGUMENT);
  assert.equal(native.verify(lease), true);
  assert.equal(native.trySharedExisting(root, INSTANCES), null, 'observation/failed observation must not unlock a duplicated original lock');
  native.close(lease);
  const recovered = take(INSTANCES, true);
  assert.equal(native.verify(recovered), true);
}));

test('native linked-file observations preserve exact links and reject a later link-count change', () => owned(async ({ root, native, take }) => {
  const path = join(root, 'payload');
  await writeFile(path, 'known linked bytes');
  await link(path, join(root, 'alias'));
  const lease = take();
  const original = observe(native, lease, 'payload', 'file');
  assert.equal(original.links, '2');
  assert.deepEqual(observe(native, lease, 'alias', 'file'), original);
  assert.equal(native.verify(lease), true);
  await link(path, join(root, 'third'));
  assert.throws(() => native.verify(lease), CHANGED);
  assert.throws(() => native.observeEntry(lease, 'payload', 'file'));
  assert.equal(await readFile(path, 'utf8'), 'known linked bytes');
  assert.equal((await lstat(path, { bigint: true })).nlink, 3n);
}));

test('native observation close releases only its owned handles and keeps a peer instance locked', () => owned(async ({ root, native, take }) => {
  await mkdir(join(root, 'entry'));
  const first = take(), peer = take();
  observe(native, first, 'entry', 'directory');
  observe(native, peer, 'entry', 'directory');
  assert.equal(native.close(first), true);
  assert.equal(native.close(first), false);
  assert.equal(native.verify(peer), true);
  assert.equal(native.tryExclusive(root, INSTANCES, false), null);
  native.close(peer);
  const recovered = take(INSTANCES, true);
  assert.equal(native.verify(recovered), true);
  assert.deepEqual(await readdir(join(root, 'entry')), []);
}));

test('native observations reject directory and same-byte file replacements', async t => {
  for (const kind of ['directory', 'file']) await t.test(kind, async subtest => owned(async ({ root, native, take }) => {
    const path = join(root, 'entry');
    if (kind === 'directory') await mkdir(path); else await writeFile(path, 'same bytes');
    const lease = take();
    observe(native, lease, 'entry', kind);
    try { await rename(path, join(root, 'original')); }
    catch (error) {
      assert.equal(process.platform, 'win32');
      assert.ok(['EACCES', 'EPERM', 'EBUSY'].includes(error.code));
      assert.equal(native.verify(lease), true);
      assert.equal(native.tryExclusive(root, INSTANCES, false), null);
      subtest.skip(`Windows refused held ${kind} rename (${error.code}); replacement detection requires an executable owned rename`);
      return;
    }
    if (kind === 'directory') await mkdir(path); else await writeFile(path, 'same bytes');
    assert.throws(() => native.verify(lease), CHANGED);
    assert.throws(() => native.observeEntry(lease, 'entry', kind));
    assert.ok(await lstat(join(root, 'original')));
  }));
});

test('native observations reject a changed parent even when its original child is moved back', {
  skip: process.platform === 'win32' ? 'held-directory rename may be blocked by Windows; Unix covers the surviving-child parent swap' : false,
}, () => owned(async ({ root, native, take }) => {
  await mkdir(join(root, 'parent'));
  await writeFile(join(root, 'parent', 'entry'), 'same object');
  const lease = take();
  observe(native, lease, 'parent/entry', 'file');
  await rename(join(root, 'parent'), join(root, 'detached'));
  await mkdir(join(root, 'parent'));
  await rename(join(root, 'detached', 'entry'), join(root, 'parent', 'entry'));
  assert.throws(() => native.verify(lease), CHANGED);
  assert.equal(await readFile(join(root, 'parent', 'entry'), 'utf8'), 'same object');
}));

test('native observations never follow a leaf or parent symlink outside their root', {
  skip: process.platform === 'win32' ? 'symlink creation requires a separately authorized owned Windows prerequisite' : false,
}, () => owned(async ({ root, native, take }) => {
  const scope = join(root, 'held');
  await mkdir(scope);
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'payload'), 'outside bytes');
  await symlink('../outside', join(scope, 'parent-link'));
  await symlink('../outside/payload', join(scope, 'file-link'));
  const lease = take(INSTANCES, false, scope);
  for (const [path, kind] of [['parent-link', 'directory'], ['parent-link/payload', 'file'], ['file-link', 'file']]) {
    assert.throws(() => native.observeEntry(lease, path, kind));
  }
  assert.equal(native.verify(lease), true);
  assert.equal(await readFile(join(root, 'outside', 'payload'), 'utf8'), 'outside bytes');
}));
