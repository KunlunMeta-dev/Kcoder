import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerSshPinStore } from './remotes/peer-ssh-pin-store.mjs';
import { assertPeerSshEnrollmentCurrent, revalidatePeerSshEnrollment } from './remotes/peer-ssh-auth.mjs';
import { writePrivateFile } from '../../kcoder-channel-host/src/jsonc-file.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-peer-ssh-pin-'));
  await chmod(root, 0o700);
  const store = createPeerSshPinStore({ directory: root, ...options });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store };
}
function enrollment(gateway) {
  return { version: 1, purpose: 'kcoder.peer-message.ssh-enrollment.v1', enrollmentId: 'owned-pin', generation: 1, gateway,
    target: { targetId: 'owned-server', targetRevision: 'a'.repeat(64), accountGeneration: 'account-1', sshHostKey: 'ssh-ed25519 SHA256:fixture', sshUser: 'owned-user' },
    native: { accountUid: 1001, profileIdentity: 'profile', targetId: 'native-target', workspaceId: 'workspace', identityEpoch: 'epoch', publicKey: Array(32).fill(7) } };
}
test('peer SSH pin storage is absent by default and initialization creates a separate private key', async t => {
  const { root, store } = await fixture(t);
  assert.equal(await store.read(), null);
  const gateway = await store.initialize();
  assert.equal(gateway.publicKey.length, 32);
  assert.deepEqual(await store.initialize(), gateway);
  const seed = await readFile(join(root, 'peer-ssh-enrollment-v1', '.key'), 'utf8');
  assert.match(seed, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(await store.read()).includes(seed));
});
test('only a current persisted pin produces a branded selection and revoke invalidates it', async t => {
  const { store } = await fixture(t);
  const gateway = await store.initialize();
  assert.equal(await store.selection('scope', () => {}), null);
  await store.update(data => data.pins.push({ scopeKey: 'scope', status: 'pinned', enrollment: enrollment(gateway) }));
  const selection = await store.selection('scope', () => {});
  assert.ok(selection); await revalidatePeerSshEnrollment(selection);
  await store.update(data => { data.pins[0].status = 'revoked'; });
  assert.throws(() => assertPeerSshEnrollmentCurrent(selection), /PIN_CHANGED/);
  await assert.rejects(revalidatePeerSshEnrollment(selection), /PIN_CHANGED/);
});
test('missing key or replaced namespace cannot regenerate signing authority', async t => {
  const { root, store } = await fixture(t);
  await store.initialize();
  await unlink(join(root, 'peer-ssh-enrollment-v1', '.key'));
  await assert.rejects(store.initialize(), /PRIVATE_KEY_UNAVAILABLE/);
  await assert.rejects(store.read(), /PRIVATE_KEY_UNAVAILABLE/);
});
test('an adopted Gateway root with a missing ledger cannot be treated as never configured', async t => {
  const { root, store } = await fixture(t);
  await store.initialize();
  const path = join(root, 'peer-ssh-enrollment-v1');
  const key = await readFile(join(path, '.key'));
  await unlink(join(path, 'devices.json'));
  await assert.rejects(store.read(), error => error.code === 'PEER_SSH_PRIVATE_LEDGER_MISSING' && error.externalOutcome === 'unknown');
  await assert.rejects(store.initialize(), /PRIVATE_LEDGER_MISSING/);
  assert.deepEqual(await readFile(join(path, '.key')), key);
});
test('a different store owner revoking the same private row invalidates the original selection', async t => {
  const { root, store } = await fixture(t);
  const gateway = await store.initialize();
  await store.update(data => data.pins.push({ scopeKey: 'scope', status: 'pinned', enrollment: enrollment(gateway) }));
  const selection = await store.selection('scope', () => {});
  const other = createPeerSshPinStore({ directory: root }); t.after(() => other.close());
  await other.update(data => { data.pins[0].status = 'revoked'; });
  assert.throws(() => assertPeerSshEnrollmentCurrent(selection), /REVALIDATION_REQUIRED/);
  assert.equal(await store.selection('scope', () => {}), null);
});
test('a private publication failure reports unknown without repeating the mutation', async t => {
  let fail = false, publications = 0, actions = 0;
  const { store } = await fixture(t, { async publish(path, bytes) {
    publications++; await writePrivateFile(path, bytes);
    if (fail) throw Object.assign(new Error('owned uncertain fsync'), { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED' });
  } });
  await store.initialize(); fail = true;
  await assert.rejects(store.update(data => { actions++; data.proposals.push({ id: 'owned-proposal', digest: 'a', operationId: 'owned-operation', phase: 'dispatching' }); }),
    error => error.externalOutcome === 'unknown');
  assert.equal(actions, 1); assert.equal(publications, 2);
  assert.equal((await store.read()).proposals[0].phase, 'dispatching');
  assert.equal(publications, 2, 'reconciliation is read-only');
});
