import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, link, lstat, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { createKeyringRecovery, openKeyringRecovery } from './windows-keyring-recovery.mjs';

const sid = 'S-1-5-21-100-200-300-1001';
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-recovery-unit-'));
  const contexts = [];
  const context = async () => {
    const value = await RunContext.create(import.meta.url, { testId: 'recovery-offline', retainSuccessLogs: true });
    contexts.push(value); return value;
  };
  t.after(async () => {
    for (const value of contexts) if (!value.finished) await value.finish('failed', { offline: true }).catch(() => {});
    // Only these synthetic local files exist here; there are no accounts or remote resources.
    await rm(directory, { recursive: true, force: true });
  });
  const first = await context(), owner = randomUUID();
  const binding = { owner, target: 'owned-win-test', runRoot: first.runRoot,
    root: `D:\\kcoder-package-${owner}`, username: 'kc_e2e_1234abcd' };
  const password = randomBytes(32).toString('base64url');
  const channel = await createKeyringRecovery(first, binding, password, { namespace: join(directory, 'private') });
  return { first, channel, binding, password, context, directory };
}
function complete(binding, selectedSid = sid) {
  return { owner: binding.owner, ownedSid: selectedSid, cleaned: true, accountAbsent: true, profileAbsent: true,
    rootAbsent: true, allJobsStopped: true, vault: { safeToRemoveRoot: true, systemEntryAbsenceVerified: true } };
}
async function textTree(path) {
  let result = '';
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    if (item.isDirectory()) result += await textTree(child);
    else if (item.isFile()) result += await readFile(child, 'utf8');
  }
  return result;
}

test('recovery is private, external, bounded, nonsecret in artifacts, and unused allocations clean normally', async t => {
  const { first, channel, password } = await setup(t), locator = channel.descriptor();
  assert.equal((await lstat(locator.base.path)).mode & 0o7777, 0o700);
  assert.equal((await lstat(locator.scratch.path)).mode & 0o7777, 0o700);
  for (const name of ['record.json', 'proof.json']) {
    const stat = await lstat(join(locator.scratch.path, name));
    assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
  }
  assert.equal(JSON.stringify(locator).includes(password), false);
  assert.equal((await textTree(first.artifactsDir)).includes(password), false);
  await first.finish('passed', { offline: true });
  await assert.rejects(access(locator.scratch.path), { code: 'ENOENT' });
  await assert.rejects(access(locator.slot.path), { code: 'ENOENT' });
});

test('unknown remote effects retain the original channel after state cleanup; a new controller can recover only the same SID', async t => {
  const { first, channel, context, binding, password } = await setup(t), locator = channel.descriptor();
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  await assert.rejects(first.finish('failed', { offline: true }), /retained_cleanup_unconfirmed/);
  await assert.rejects(access(first.stateDir), { code: 'ENOENT' });
  assert.equal((await lstat(locator.scratch.path)).isDirectory(), true);
  const second = await context(), resumed = await openKeyringRecovery(second, locator, binding);
  await resumed.bindSid(sid);
  let invoked = 0;
  const returned = await resumed.withPassword(binding, sid, value => { invoked++; assert.equal(value === password, true); return value; });
  assert.equal(returned, undefined); assert.equal(invoked, 1);
  await resumed.confirmRemoteCleanup(complete(binding));
  await second.finish('passed', { offline: true });
  await assert.rejects(access(locator.scratch.path), { code: 'ENOENT' });
  await assert.rejects(access(locator.slot.path), { code: 'ENOENT' });
  assert.equal((await textTree(second.runRoot)).includes(password), false);
});

test('original owner, target, run, remote root, SID and cleanup proof cannot be substituted', async t => {
  const { channel, context, binding } = await setup(t), locator = channel.descriptor();
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  const second = await context();
  for (const delta of [{ owner: randomUUID() }, { target: 'peer-win-test' }, { runRoot: second.runRoot },
    { username: 'kc_e2e_aaaaaaaa' }, { root: 'D:\\unrelated' }]) {
    await assert.rejects(openKeyringRecovery(second, locator, { ...binding, ...delta }), /keyring_recovery_owner_changed/);
  }
  await assert.rejects(channel.bindSid('S-1-5-21-100-200-300-1002'), /sid_changed/);
  let invoked = false;
  await assert.rejects(channel.withPassword(binding, 'S-1-5-21-100-200-300-1002', () => { invoked = true; }), /sid_changed/);
  assert.equal(invoked, false);
  for (const delta of [{ ownedSid: 'S-1-5-21-100-200-300-1002' }, { allJobsStopped: false }, { rootAbsent: false },
    { vault: { safeToRemoveRoot: true } }]) await assert.rejects(channel.confirmRemoteCleanup({ ...complete(binding), ...delta }), /keyring_recovery_/);
});

test('expiry forbids password delivery and cannot renew or remove an unknown channel', async t => {
  const { first, channel, context, binding } = await setup(t), locator = channel.descriptor();
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  let invoked = false;
  t.mock.method(Date, 'now', () => locator.expiresAt + 1);
  await assert.rejects(channel.withPassword(binding, sid, () => { invoked = true; }), /expired/);
  await assert.rejects(channel.confirmRemoteCleanup(complete(binding)), /expired/);
  assert.equal(invoked, false); t.mock.restoreAll();
  await assert.rejects(first.finish('failed', { offline: true }), /retained_cleanup_unconfirmed/);
  const second = await context(), resumed = await openKeyringRecovery(second, locator, binding);
  assert.equal(resumed.descriptor().expiresAt, locator.expiresAt);
  const changed = { ...locator, expiresAt: locator.expiresAt + 1 };
  await assert.rejects(openKeyringRecovery(second, changed, binding), /record_invalid/);
  await assert.rejects(second.finish('failed', { offline: true }), /retained_cleanup_unconfirmed/);
  assert.equal((await lstat(locator.scratch.path)).isDirectory(), true);
});

test('missing or replaced records never regenerate or deliver a password', async t => {
  const { channel, context, binding } = await setup(t), locator = channel.descriptor();
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  const path = join(locator.scratch.path, 'record.json'), held = path + '.original';
  await rename(path, held);
  const second = await context();
  await assert.rejects(openKeyringRecovery(second, locator, binding), /^Error: keyring_recovery_invalid$/);
  await assert.rejects(access(path), { code: 'ENOENT' });
  await writeFile(path, '{}', { mode: 0o600 });
  await assert.rejects(openKeyringRecovery(second, locator, binding), /file_changed/);
  await rm(path); await rename(held, path);
});

test('hard links, symlinks, relaxed permissions and mutated private contents fail closed without leaking', async t => {
  const { channel, binding, password } = await setup(t), locator = channel.descriptor();
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  const path = join(locator.scratch.path, 'record.json'), held = path + '.held';
  await link(path, held);
  await assert.rejects(channel.withPassword(binding, sid, () => assert.fail()), /file_changed/);
  await rm(held); await chmod(path, 0o644);
  await assert.rejects(channel.withPassword(binding, sid, () => assert.fail()), /file_changed/);
  await chmod(path, 0o600); await rename(path, held); await symlink(held, path);
  await assert.rejects(channel.withPassword(binding, sid, () => assert.fail()), /file_changed/);
  await rm(path); await rename(held, path);
  const original = await readFile(path);
  await writeFile(path, JSON.stringify({ password }));
  await assert.rejects(channel.withPassword(binding, sid, () => assert.fail()), error => {
    assert.match(error.message, /^keyring_recovery_[a-z_]+$/); assert.equal(error.message.includes(password), false); return true;
  });
  await writeFile(path, original); original.fill(0);
});

test('callback exceptions do not retain arbitrary secret text or return a value', async t => {
  const { channel, binding, password } = await setup(t);
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  await assert.rejects(channel.withPassword(binding, sid, value => { throw Error('backend ' + value); }), error => {
    assert.equal(error.message, 'keyring_recovery_invalid'); assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(password), false); return true;
  });
});

test('a full private namespace rejects the ninth reservation and keeps existing unknown owners', async t => {
  const { first, channel, binding, password, context } = await setup(t), locator = channel.descriptor();
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  const others = [];
  for (let index = 1; index < 8; index++) {
    const next = await context();
    others.push(await createKeyringRecovery(next, { ...binding, runRoot: next.runRoot }, password, { namespace: locator.base.path }));
  }
  await assert.rejects(createKeyringRecovery(first, binding, password, { namespace: locator.base.path }), /capacity/);
  assert.equal((await readdir(locator.base.path)).filter(name => /^slot-/.test(name)).length, 8);
  assert.equal(others.length, 7);
});

test('recovery cannot use a repository/target path and does not repair an existing namespace', async t => {
  const { first, binding, password, directory } = await setup(t);
  await assert.rejects(createKeyringRecovery(first, binding, password, { namespace: first.pathInState('recovery') }), /requires_external_private_temp/);
  const namespace = join(directory, 'replacement'); await writeFile(namespace, 'unowned');
  await assert.rejects(createKeyringRecovery(first, binding, password, { namespace }), /directory_changed/);
  assert.equal(await readFile(namespace, 'utf8'), 'unowned');
});


test('a failed local cleanup retains its capacity reservation after remote cleanup was confirmed', async t => {
  const { first, channel, binding } = await setup(t), locator = channel.descriptor();
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  await channel.confirmRemoteCleanup(complete(binding));
  await chmod(join(locator.scratch.path, 'record.json'), 0o644);
  await assert.rejects(first.finish('failed', { offline: true }), /file_changed/);
  assert.equal((await lstat(locator.scratch.path)).isDirectory(), true);
  assert.equal((await lstat(locator.slot.path)).isFile(), true);
});

test('only authoritative never-created cleanup can remove a channel without a SID birth', async t => {
  const { first, channel, binding } = await setup(t), locator = channel.descriptor();
  await channel.markRemoteMayExist();
  await assert.rejects(channel.confirmRemoteCleanup({ ...complete(binding), ownedSid: null }), /sid_changed/);
  await channel.confirmRemoteCleanup({ owner: binding.owner, ownedSid: null, disposition: 'never_created',
    cleaned: true, accountAbsent: true, profileAbsent: true, rootAbsent: true });
  await first.finish('passed', { offline: true });
  await assert.rejects(access(locator.scratch.path), { code: 'ENOENT' });
});


test('a born SID file cannot be deleted or replaced to bind another account, including a new controller', async t => {
  const { channel, binding, context } = await setup(t);
  await channel.markRemoteMayExist(); await channel.bindSid(sid);
  const locator = channel.descriptor(), path = join(locator.scratch.path, 'sid.json'), held = path + '.held';
  await rename(path, held);
  await assert.rejects(channel.bindSid(sid), /^Error: keyring_recovery_invalid$/);
  const second = await context(), resumed = await openKeyringRecovery(second, locator, binding);
  await assert.rejects(resumed.bindSid(sid), /^Error: keyring_recovery_invalid$/);
  await writeFile(path, JSON.stringify({ version: 1, owner: binding.owner, sid }), { mode: 0o600 });
  await assert.rejects(resumed.withPassword(binding, sid, () => assert.fail()), /file_changed/);
  await rm(path); await rename(held, path);
});
