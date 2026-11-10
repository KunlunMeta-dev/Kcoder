import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOriginalCarrierCleanup } from './native-systemd-carrier.mjs';

async function fixture(t, { linked = true, persistent = false, running = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-carrier-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: false }));
  const profile = join(root, 'profile'), runtime = join(root, 'runtime');
  await mkdir(profile, { mode: 0o700 });
  await mkdir(join(runtime, 'systemd/user'), { recursive: true });
  const uid = process.getuid(), digest = 'a'.repeat(64);
  const directory = join(profile, `native-channel-carrier-${digest}`);
  const unit = `kcoder-native-user-${uid}-${digest}.service`;
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, unit), alias = join(runtime, 'systemd/user', unit);
  await writeFile(path, '[Service]\nType=exec\n', { mode: 0o600 });
  if (linked) await symlink(path, alias);
  const persistentDirectory = join(root, 'home/.config/systemd/user');
  await mkdir(join(persistentDirectory, 'default.target.wants'), { recursive: true });
  const persistentAlias = join(persistentDirectory, unit), wanted = join(persistentDirectory, 'default.target.wants', unit);
  if (persistent) { await symlink(path, persistentAlias); await symlink(path, wanted); }
  const wasPersistent = persistent;
  const cleanups = [], calls = [];
  const context = { addCleanup(label, run) { cleanups.push({ label, run }); } };
  const value = { profile, uid, env: { XDG_RUNTIME_DIR: runtime }, activeManagers: new Set() };
  const unitCommand = async (_context, actual, carrier, action, _label, options) => {
    assert.equal(actual, value);
    assert.equal(carrier.path, path);
    assert.equal(options.cleanup, true);
    calls.push(action);
    if (action === 'stop') running = false;
    if (action === 'retire-persistent') { await unlink(persistentAlias); await unlink(wanted); persistent = false; }
    if (action === 'retire-runtime') await unlink(alias);
    if (action === 'show') return { MainPID: running ? '1234' : '0', ActiveState: running ? 'active' : 'inactive',
      ...(wasPersistent ? { UnitFileState: persistent ? 'enabled' : 'disabled', FragmentPath: persistentAlias } : {}) };
  };
  return { root, value, context, cleanups, calls, unitCommand, alias, path, persistentAlias, wanted };
}

test('registers ownership before effects and retires only the original stopped runtime alias', async t => {
  const f = await fixture(t);
  registerOriginalCarrierCleanup(f.context, f.value, 'owned-unit', { unitCommand: f.unitCommand });
  assert.ok(f.value.activeManagers.has('owned-unit'));
  assert.equal(f.cleanups.length, 1);
  await f.cleanups[0].run();
  assert.deepEqual(f.calls, ['stop', 'show', 'retire-runtime']);
  assert.equal(f.value.activeManagers.size, 0);
  await assert.rejects(lstat(f.alias), { code: 'ENOENT' });
});

test('an unknown stop keeps the manager owned so private-profile removal stays blocked', async t => {
  const f = await fixture(t);
  registerOriginalCarrierCleanup(f.context, f.value, 'owned-unit', {
    unitCommand: async () => { throw Error('CONTROLLED_OS_OUTCOME_UNKNOWN'); },
  });
  await assert.rejects(f.cleanups[0].run(), /CONTROLLED_OS_OUTCOME_UNKNOWN/);
  assert.ok(f.value.activeManagers.has('owned-unit'));
  assert.ok((await lstat(f.alias)).isSymbolicLink());
});

test('a foreign runtime fragment after inode reuse is never stopped or unlinked', async t => {
  const f = await fixture(t, { linked: false });
  const foreign = join(f.root, 'other-profile-unit');
  await writeFile(foreign, 'controlled other profile');
  await symlink(foreign, f.alias);
  registerOriginalCarrierCleanup(f.context, f.value, 'owned-unit', { unitCommand: f.unitCommand });
  await assert.rejects(f.cleanups[0].run(), /another profile after inode reuse/);
  assert.deepEqual(f.calls, []);
  assert.ok(f.value.activeManagers.has('owned-unit'));
});

test('an effect-free preparation failure releases ownership without issuing OS mutations', async t => {
  const f = await fixture(t, { linked: false });
  await rm(join(f.value.profile, 'native-channel-carrier-' + 'a'.repeat(64)), { recursive: true });
  registerOriginalCarrierCleanup(f.context, f.value, 'owned-unit', { unitCommand: f.unitCommand });
  await f.cleanups[0].run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.value.activeManagers.size, 0);
});

test('a persistent-only owned task host is stopped and disabled before its profile can disappear', async t => {
  const f = await fixture(t, { linked: false, persistent: true, running: true });
  registerOriginalCarrierCleanup(f.context, f.value, 'owned-persistent', { unitCommand: f.unitCommand });
  await f.cleanups[0].run();
  assert.deepEqual(f.calls, ['show','stop','show','retire-persistent','show']);
  assert.equal(f.value.activeManagers.size, 0);
  await assert.rejects(lstat(f.persistentAlias), { code: 'ENOENT' });
  await assert.rejects(lstat(f.wanted), { code: 'ENOENT' });
});

test('a foreign persistent fragment is not stopped or disabled', async t => {
  const f = await fixture(t, { linked: false, persistent: true, running: true });
  const foreign = join(f.root, 'another-owned-unit'); await writeFile(foreign, 'foreign');
  await unlink(f.persistentAlias); await symlink(foreign, f.persistentAlias);
  registerOriginalCarrierCleanup(f.context, f.value, 'owned-persistent', { unitCommand: f.unitCommand });
  await assert.rejects(f.cleanups[0].run(), /Never adopt another profile/);
  assert.deepEqual(f.calls, ['show']);
  assert.ok(f.value.activeManagers.has('owned-persistent'));
});
