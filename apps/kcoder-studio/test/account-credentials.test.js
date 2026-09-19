import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountCredentialStore } from '../src/account-credentials.js';

const target = { id: 'server', host: 'example.test', user: 'root' };
const alice = { deviceId: 'device-alice-uuid', username: 'alice' };
const bob = { deviceId: 'device-bob-uuid', username: 'bob' };

async function openStore(directory, { seed } = {}) {
  const options = { filePath: join(directory, 'credentials.json'), keyPath: join(directory, 'key') };
  if (seed) await writeFile(options.filePath, seed, { mode: 0o600 });
  const store = createAccountCredentialStore(options);
  await store.load();
  return { store, options };
}

test('remembered credentials are encrypted and scoped to device profile plus target', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-account-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, options } = await openStore(directory);
  await store.save(alice, target, 'private-fixture-password');
  assert.equal((await readFile(options.filePath, 'utf8')).includes('private-fixture-password'), false);

  // The same account remembered from another browser profile is isolated.
  await store.save(bob, target, 'bob-fixture-password');
  const reopened = createAccountCredentialStore(options);
  await reopened.load();
  assert.equal((await reopened.recall(alice, target)).password, 'private-fixture-password');
  assert.equal((await reopened.recall(bob, target)).password, 'bob-fixture-password');
  assert.equal(await reopened.recall({ ...alice, username: 'bob' }, target), null);
  assert.equal(await reopened.recall(alice, { ...target, host: 'other.test' }), null);
  assert.equal(await reopened.recall(alice, { ...target, id: 'other' }), null);

  await reopened.forgetIdentity(alice, target);
  assert.equal(await reopened.recall(alice, target), null);
  assert.equal((await reopened.recall(bob, target)).password, 'bob-fixture-password');
  await reopened.forgetTarget(target);
  assert.equal(await reopened.recall(bob, target), null);
});

test('v1 target-scoped records degrade to a username hint and never authenticate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-account-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = {
    version: 1,
    accounts: {
      server: { binding: JSON.stringify({ id: 'server', host: 'example.test', port: 22, username: 'root/alice', authMethod: 'kcoder-account' }), password: 'ciphertext' },
    },
  };
  const { store, options } = await openStore(directory, { seed: `${JSON.stringify(legacy)}\n` });
  assert.equal(store.legacyUsername(target), 'alice');
  // The v1 secret is dropped during migration; nothing can auto-login with it.
  assert.equal(await store.recall({ deviceId: 'device-alice-uuid', username: 'alice' }, target), null);
  const migrated = JSON.parse(await readFile(options.filePath, 'utf8'));
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.accounts, {});
});

test('rejects invalid identities and passwords before touching storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-account-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store } = await openStore(directory);
  await assert.rejects(store.save({ deviceId: 'short', username: 'alice' }, target, 'long-enough-password'), /设备标识/);
  await assert.rejects(store.save({ deviceId: 'device-alice-uuid', username: 'Alice!' }, target, 'long-enough-password'), /用户名/);
  await assert.rejects(store.save(alice, target, 'short'), /密码长度/);
  await assert.rejects(store.recall(alice, { id: '' }), /运行目标/);
});
