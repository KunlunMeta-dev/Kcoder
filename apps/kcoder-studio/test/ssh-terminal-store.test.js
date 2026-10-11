import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSshConnectionStore, readBoundedRegularFile } from '../src/ssh-terminal-store.js';

const profile = { id: 'test', label: 'Development', host: 'localhost', port: 22, username: 'developer', authMethod: 'password' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-ssh-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'ssh_connections.jsonc');
  return { filePath, store: createSshConnectionStore({ filePath }) };
}

test('SSH profiles persist metadata only and reject unknown credential fields', async (t) => {
  const { store, filePath } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.upsert({ ...profile, passphrase: 'DO_NOT_PERSIST' }), /字段/);
  await store.upsert(profile);
  assert.deepEqual(await createSshConnectionStore({ filePath }).list(), [profile]);
  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw.includes('DO_NOT_PERSIST'), false);
  assert.equal(JSON.parse(raw).meta.config_version, 1);
});

test('saved passwords are encrypted, write-only, restart-safe and can be replaced or cleared', async (t) => {
  const { store, filePath } = await fixture(t);
  const password = 'SAVED_SECRET_你好';
  const saved = await store.upsert({ ...profile, password });
  assert.equal(saved.passwordSaved, true);
  assert.equal(saved.password, undefined);
  assert.equal(saved.credentials, undefined);
  assert.equal((await readFile(filePath, 'utf8')).includes(password), false);
  const restarted = createSshConnectionStore({ filePath });
  assert.equal(await restarted.resolvePassword(profile), password);
  await restarted.upsert({ ...profile, label: 'Renamed' });
  assert.equal(await restarted.resolvePassword(profile), password);
  await restarted.upsert({ ...profile, password: 'replacement' });
  assert.equal(await restarted.resolvePassword(profile), 'replacement');
  await restarted.upsert({ ...profile, password: null });
  assert.equal(await restarted.resolvePassword(profile), undefined);
  assert.equal((await restarted.list())[0].passwordSaved, undefined);
});

test('identity changes forget passwords and tampered ciphertext cannot target another host', async (t) => {
  const { store, filePath } = await fixture(t);
  await store.upsert({ ...profile, password: 'secret' });
  const doc = JSON.parse(await readFile(filePath, 'utf8'));
  doc.terminal.ssh.connections[0].host = 'attacker.example';
  await writeFile(filePath, JSON.stringify(doc));
  await assert.rejects(store.resolvePassword({ ...profile, host: 'attacker.example' }));
  await store.upsert({ ...profile, password: 'secret' });
  await store.upsert({ ...profile, username: 'other' });
  assert.equal((await store.list())[0].passwordSaved, undefined);
  await assert.rejects(store.resolvePassword(profile), /已变更/);
  await store.upsert({ ...profile, password: 'secret' });
  await store.upsert({ ...profile, authMethod: 'agent' });
  assert.equal((await store.list())[0].passwordSaved, undefined);
  await store.delete(profile.id);
  assert.equal((await readFile(filePath, 'utf8')).includes('credentials'), false);
});

test('saved credentials fail closed if the local key is missing or readable by other users', { skip: process.platform === 'win32' }, async (t) => {
  const { store, filePath } = await fixture(t);
  await store.upsert({ ...profile, password: 'private-secret' });
  const key = join(filePath, '..', 'ssh_credentials.key');
  assert.equal((await stat(key)).mode & 0o777, 0o600);
  await chmod(key, 0o644);
  await assert.rejects(store.resolvePassword(profile), error => !error.message.includes('private-secret'));
  await rm(key);
  await assert.rejects(store.resolvePassword(profile));
  assert.equal((await store.list())[0].passwordSaved, true);
});

test('SSH store serializes concurrent mutations, enforces 32 profiles and private permissions', async (t) => {
  const { store, filePath } = await fixture(t);
  await Promise.all(Array.from({ length: 32 }, (_, index) => store.upsert({ ...profile, id: `p${index}` })));
  assert.equal((await store.list()).length, 32);
  await assert.rejects(store.upsert(profile), /32/);
  await store.delete('p0');
  await store.upsert(profile);
  assert.equal((await store.list()).length, 32);
  if (process.platform !== 'win32') assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('SSH fingerprint is server-owned, bound to endpoint and protected against stale confirmation', async (t) => {
  const { store } = await fixture(t);
  const fingerprint = 'SHA256:' + 'A'.repeat(43);
  await store.upsert(profile);
  await store.pinFingerprint(profile, fingerprint);
  assert.equal((await store.upsert({ ...profile, label: 'Updated' })).hostFingerprint, fingerprint);
  await assert.rejects(store.upsert({ ...profile, hostFingerprint: fingerprint }), /字段/);
  const changed = { ...profile, host: 'other.example', port: 2222 };
  assert.equal((await store.upsert(changed)).hostFingerprint, undefined);
  await assert.rejects(store.pinFingerprint(profile, fingerprint), /已变更/);
  await store.pinFingerprint(changed, fingerprint);
  await assert.rejects(store.pinFingerprint(changed, 'SHA256:' + 'B'.repeat(43)), /指纹已变化/);
});

test('SSH profile rejects malformed network, authentication and path fields without echoing them', async (t) => {
  const { store } = await fixture(t);
  for (const patch of [
    { host: '-oProxyCommand=secret' }, { host: 'host name' }, { host: 'a..b' },
    { port: '22' }, { port: 0 }, { port: 65536 }, { username: 'a;secret' },
    { authMethod: 'unknown' }, { authMethod: 'key', privateKeyPath: '../secret' },
    { authMethod: 'key', privateKeyPath: '/secret\npath' }, { passphrase: 'secret' },
  ]) await assert.rejects(store.upsert({ ...profile, ...patch }), (error) => !error.message.includes('secret'));
});

test('SSH JSONC accepts comments and trailing commas but fails closed on invalid versions and unknown fields', async (t) => {
  const { store, filePath } = await fixture(t);
  await writeFile(filePath, '{ // keep this comment\n"meta":{"config_version":1},"terminal":{"ssh":{"connections":[],}},}\n');
  await store.upsert(profile);
  assert.match(await readFile(filePath, 'utf8'), /keep this comment/);
  for (const doc of [
    { meta: { config_version: 2 }, terminal: { ssh: { connections: [] } } },
    { meta: { config_version: 1 }, terminal: { ssh: { connections: [], password: 'secret' } } },
  ]) {
    await writeFile(filePath, JSON.stringify(doc));
    await assert.rejects(store.list());
    await assert.rejects(store.upsert(profile));
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), doc);
  }
});

test('SSH regular-file reader rejects directories, symlinks and oversized data', async (t) => {
  const { filePath } = await fixture(t);
  await writeFile(filePath, '12345');
  await assert.rejects(readBoundedRegularFile(filePath, 4), /大小限制/);
  await assert.rejects(readBoundedRegularFile(join(filePath, '..'), 4), /普通文件/);
  if (process.platform !== 'win32') {
    await symlink(filePath, filePath + '.link');
    await assert.rejects(readBoundedRegularFile(filePath + '.link', 10));
  }
});

test('two SSH store handles serialize against the same file without lost updates', async (t) => {
  const { store, filePath } = await fixture(t);
  const second = createSshConnectionStore({ filePath });
  await Promise.all([store.upsert(profile), second.upsert({ ...profile, id: 'second' })]);
  assert.deepEqual((await store.list()).map(({ id }) => id).sort(), ['second', 'test']);
});

test('SSH metadata edits preserve comments inside existing connection entries', async (t) => {
  const { store, filePath } = await fixture(t);
  await store.upsert(profile);
  const raw = (await readFile(filePath, 'utf8')).replace('"port": 22', '// trusted development port\n          "port": 22');
  await writeFile(filePath, raw);
  await store.upsert({ ...profile, label: 'Renamed' });
  assert.match(await readFile(filePath, 'utf8'), /trusted development port/);
});

test('SSH connection IDs use the Gateway 64-character identifier contract', async (t) => {
  const { store } = await fixture(t);
  await store.upsert({ ...profile, id: 'gateway.profile-1_2' });
  for (const id of ['_leading', '.leading', 'a'.repeat(65)]) {
    await assert.rejects(store.upsert({ ...profile, id }), /连接 ID/);
    await assert.rejects(store.delete(id), /连接 ID/);
  }
  assert.equal((await store.delete('gateway.profile-1_2')).deleted, true);
});
