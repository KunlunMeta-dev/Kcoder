import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { peerSshFactsFixture } from './remotes/__fixtures__/peer-ssh-facts.mjs';
import { authenticateEnrolledPeerSsh, verifyEnrolledPeerSshIdentity, peerSshEnrollmentSelector } from './remotes/peer-ssh-auth.mjs';
import { createPeerSshPinStore } from './remotes/peer-ssh-pin-store.mjs';
import { PEER_SSH_AUTH, nativePeerSshSigningBytes } from './remotes/peer-ssh-facts.mjs';

async function fixture(t, mode = '') {
  const f = peerSshFactsFixture(); const calls = []; let current = true;
  const check = () => { if (!current) throw new Error('OWNED_PIN_REVOKED'); };
  const root = await mkdtemp(join(tmpdir(), 'kcoder-peer-ssh-auth-'));
  const store = createPeerSshPinStore({ directory: root });
  f.enrollment.gateway = await store.initialize();
  await store.update(data => data.pins.push({ scopeKey: 'owned', status: 'pinned', enrollment: f.enrollment }));
  const selection = await store.selection('owned', check);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const broker = { closed: false, initializeResponse: null, initializePending: null,
    sendInternalRequest(method, params, { onResponse }) {
      calls.push(method); let result;
      if (method === PEER_SSH_AUTH.offer) result = { version: 1, purpose: 'kcoder.peer-message.ssh-challenge.v1',
        enrollmentId: f.enrollment.enrollmentId, enrollmentGeneration: 1, nativeNonce: '1'.repeat(64), processInstance: '3'.repeat(64) };
      if (method === PEER_SSH_AUTH.nativeProof) {
        result = { claims: structuredClone(params.claims), signature: [...sign(null, nativePeerSshSigningBytes(params.claims), f.nativeKey)] };
        if (mode === 'wrong-signature') result.signature[0] ^= 1;
        if (mode === 'revoke-before-sign') current = false;
      }
      if (method === PEER_SSH_AUTH.complete) {
        result = { version: 1, enrollmentId: f.enrollment.enrollmentId, generation: 1, processInstance: '3'.repeat(64) };
        if (mode === 'foreign-process') result.processInstance = '4'.repeat(64);
      }
      queueMicrotask(() => onResponse({ result }));
    } };
  const authentication = { ready: Promise.resolve({ key: f.enrollment.target.sshHostKey, username: f.enrollment.target.sshUser }) };
  return { ...f, broker, authentication, selection, calls, check };
}
test('enrolled SSH performs all three correlated pre-initialize frames before exposing identity facts', async t => {
  const f = await fixture(t);
  const facts = await authenticateEnrolledPeerSsh({ selection: f.selection, broker: f.broker, authentication: f.authentication, assertTransport: f.check });
  assert.deepEqual(f.calls, Object.values(PEER_SSH_AUTH));
  assert.equal(peerSshEnrollmentSelector(f.selection), 'owned-pin');
  const native = f.enrollment.native;
  assert.equal(verifyEnrolledPeerSshIdentity(facts, { targetId: native.targetId, workspaceId: native.workspaceId,
    principal: { kind: 'localOs' }, publicKey: native.publicKey, identityEpoch: native.identityEpoch }).targetId, native.targetId);
  assert.throws(() => verifyEnrolledPeerSshIdentity({ ...facts }, {}), /AUTHORITY_REQUIRED/);
});
test('unbranded JSON, wrong signature, withdrawn pin and another process cannot complete SSH auth', async t => {
  assert.throws(() => peerSshEnrollmentSelector({ enrollmentId: 'owned-pin', allow: true }), /AUTHORITY_REQUIRED/);
  for (const mode of ['wrong-signature', 'revoke-before-sign', 'foreign-process']) {
    const f = await fixture(t, mode);
    await assert.rejects(authenticateEnrolledPeerSsh({ selection: f.selection, broker: f.broker, authentication: f.authentication, assertTransport: f.check }));
    if (mode !== 'foreign-process') assert.ok(!f.calls.includes(PEER_SSH_AUTH.complete));
  }
});
test('ordinary initialized brokers cannot consume the pre-initialize auth exchange', async t => {
  const f = await fixture(t); f.broker.initializeResponse = { result: {} };
  await assert.rejects(authenticateEnrolledPeerSsh({ selection: f.selection, broker: f.broker, authentication: f.authentication, assertTransport: f.check }), /PHASE_INVALID/);
  assert.deepEqual(f.calls, []);
});
