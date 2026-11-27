import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerSshPinStore } from './remotes/peer-ssh-pin-store.mjs';
import { createPeerSshEnrollmentGateway } from './remotes/peer-ssh-enrollment-gateway.mjs';
import { peerSshFactsFixture } from './remotes/__fixtures__/peer-ssh-facts.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-peer-ssh-control-')); await chmod(root, 0o700);
  const store = createPeerSshPinStore({ directory: root });
  const target = { id: 'owned-ssh', runtime: 'kcoder', transport: 'ssh', host: 'owned.example', user: 'owned-peer', command: '/owned/kcoder', remoteCwd: '/owned/workspace' };
  const session = { browserAdmin: true, allowedServerIds: new Set([target.id]) };
  const state = { session, sameOrigin: true, calls: [], loseApply: false, nativeRevision: 0, hook: null, bodyHook: null, accountGeneration: 1 };
  const receipts = new Map(), native = peerSshFactsFixture().enrollment.native;
  const ssh = { sshHostKey: 'ssh-ed25519 SHA256:fixture', sshUser: target.user };
  const runner = { async run(options) {
    options.verifyCurrent(); await options.authorizeCurrent(); state.calls.push(options.action);
    if (state.hook) await state.hook(options);
    if (options.action === 'prepare' || options.action === 'observe') return { value: { version: 1, native, pinRevision: state.nativeRevision }, ssh };
    if (options.action === 'receipt') return { value: { version: 1, operationId: options.operationId, receipt: receipts.get(options.operationId) ?? null }, ssh };
    assert.equal(options.action, 'apply');
    const command = options.command;
    assert.equal(command.expectedRevision, state.nativeRevision);
    const revoke = command.action.kind === 'revoke';
    const receipt = { version: 1, operationId: command.operationId,
      enrollmentId: revoke ? command.action.enrollmentId : command.action.enrollment.enrollmentId,
      revision: ++state.nativeRevision, generation: revoke ? command.action.expectedGeneration + 1 : command.action.enrollment.generation,
      status: revoke ? 'revoked' : 'pinned' };
    receipts.set(command.operationId, receipt);
    if (state.loseApply) throw Object.assign(new Error('owned receipt lost'), { externalOutcome: 'unknown' });
    return { value: receipt, ssh };
  }, async close() {} };
  const gateway = createPeerSshEnrollmentGateway({ directory: root, getTarget: id => id === target.id ? target : null,
    targetSignature: JSON.stringify, loginContexts: { identity: () => null, generation: () => state.accountGeneration },
    authorize: async () => state.session, sameOrigin: () => state.sameOrigin, requestBody: async request => { await state.bodyHook?.(request); return JSON.stringify(request.body); },
    jsonResponse: (response, status, body) => Object.assign(response, { status, body }), store, runner });
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (action, body = {}, headers = {}) => {
    const response = {};
    assert.equal(await gateway.handle({ method: 'POST', headers, body: { workspacePath: target.remoteCwd, ...body } },
      response, `/api/servers/${target.id}/peer-ssh/${action}`), true);
    return response;
  };
  const resolvePin = () => gateway.resolve(target, target.remoteCwd, () => {});
  return { root, store, target, session, state, request, resolvePin, native, ssh };
}

test('only full browser authority and same-origin POST can prepare pins; JSON cannot provide keys', async t => {
  const f = await fixture(t);
  for (const mode of ['device', 'bearer', 'not-admin', 'no-session', 'other-origin']) {
    f.state.session = mode === 'no-session' ? null : { ...f.session,
      ...(mode === 'device' ? { deviceId: 'old-device-bearer' } : {}), ...(mode === 'not-admin' ? { browserAdmin: false } : {}) };
    f.state.sameOrigin = mode !== 'other-origin';
    const response = await f.request('prepare', {}, mode === 'bearer' ? { authorization: 'Bearer old-device' } : {});
    assert.equal(response.status, 403);
  }
  assert.deepEqual(f.state.calls, []); assert.equal(await f.store.read(), null);
  f.state.session = f.session; f.state.sameOrigin = true;
  assert.equal((await f.request('prepare', { enrollment: { gateway: { publicKey: [] } } })).status, 400);
  assert.deepEqual(f.state.calls, []);
});
test('prepare returns a persisted comparison proposal, apply pins it, and revoke cannot revive through old apply', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.resolvePin(), { configured: false, selection: null });
  const prepared = await f.request('prepare'); assert.equal(prepared.status, 200);
  assert.deepEqual(f.state.calls, ['prepare']);
  const { proposalId, digest } = prepared.body;
  assert.equal((await f.resolvePin()).selection, null, 'a proposal alone is not an enrollment');
  assert.equal((await f.request('apply', { proposalId, digest: 'bad' })).status, 409);
  assert.deepEqual(f.state.calls, ['prepare']);
  const applied = await f.request('apply', { proposalId, digest }); assert.equal(applied.status, 200);
  assert.ok((await f.resolvePin()).selection);
  assert.equal((await f.request('revoke')).status, 200);
  assert.equal((await f.resolvePin()).selection, null);
  const before = [...f.state.calls];
  const original = await f.request('apply', { proposalId, digest }); assert.equal(original.body.receipt.status, 'pinned');
  assert.deepEqual(f.state.calls, before, 'an old completed operation returns only its historical receipt');
  assert.equal((await f.resolvePin()).selection, null, 'the old receipt never revives current authority');
});
test('unknown native result reconciles the original receipt and never repeats apply', async t => {
  const f = await fixture(t);
  const prepared = (await f.request('prepare')).body; f.state.loseApply = true;
  const request = { proposalId: prepared.proposalId, digest: prepared.digest };
  const unknown = await f.request('apply', request); assert.equal(unknown.body.externalOutcome, 'unknown');
  assert.equal((await f.resolvePin()).selection, null);
  const recovered = await f.request('apply', request); assert.equal(recovered.status, 200);
  assert.deepEqual(f.state.calls, ['prepare', 'observe', 'apply', 'receipt']);
  assert.ok((await f.resolvePin()).selection);
});
test('catalog change or withdrawal after SSH observation prevents publishing a proposal', async t => {
  const f = await fixture(t);
  f.state.hook = async () => { f.target.host = 'changed.example'; };
  assert.equal((await f.request('prepare')).status, 409);
  assert.deepEqual((await f.store.read()).proposals, []);
  assert.deepEqual(f.state.calls, ['prepare']);
});

test('status observes stored pin state and reports stale proposals without inventing current authorization', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('status')).body.pinStatus, 'none');
  const proposed = (await f.request('prepare')).body;
  const before = await f.store.read();
  f.state.accountGeneration++;
  const changed = await f.request('status');
  assert.equal(changed.body.pinStatus, 'scope_changed');
  assert.equal(changed.body.proposals[0].proposalId, proposed.proposalId);
  assert.equal((await f.request('prepare')).body.externalOutcome, 'unknown');
  assert.equal((await f.store.read()).revision, before.revision);
  const discarded = await f.request('discard', { proposalId: proposed.proposalId, digest: proposed.digest });
  assert.equal(discarded.status, 200); assert.equal(discarded.body.phase, 'discarded');
  assert.deepEqual(f.state.calls, ['prepare'], 'Discard is only a Gateway journal transaction');
});

test('discarded preparation is durable, idempotent and cannot be dispatched or revived', async t => {
  const f = await fixture(t); const original = (await f.request('prepare')).body;
  const reference = { proposalId: original.proposalId, digest: original.digest };
  assert.equal((await f.request('discard', { ...reference, digest: 'wrong' })).status, 409);
  assert.equal((await f.request('discard', reference)).body.phase, 'discarded');
  const revision = (await f.store.read()).revision;
  assert.equal((await f.request('discard', reference)).body.phase, 'discarded');
  assert.equal((await f.store.read()).revision, revision);
  assert.equal((await f.request('reconcile', reference)).body.phase, 'discarded');
  assert.equal((await f.request('apply', reference)).body.error, 'PEER_SSH_PROPOSAL_DISCARDED');
  assert.deepEqual(f.state.calls, ['prepare']);
  assert.equal((await f.request('prepare')).status, 200, 'Only a terminal original preparation releases the scope barrier');
});

test('same-scope preparation races commit one proposal and never dispatch a second original identity', async t => {
  const f = await fixture(t); let arrived = 0, release;
  const observed = new Promise(done => { release = done; });
  f.state.hook = async options => { if (options.action === 'prepare') { if (++arrived === 2) release(); await observed; } };
  const results = await Promise.all([f.request('prepare'), f.request('prepare')]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  assert.equal((await f.store.read()).proposals.length, 1);
  assert.equal(f.state.calls.filter(action => action === 'apply').length, 0);
});

test('discard wins against an already-entered apply which has not dispatched', async t => {
  const f = await fixture(t); const proposed = (await f.request('prepare')).body;
  const reference = { proposalId: proposed.proposalId, digest: proposed.digest };
  let bodyEntered, releaseBody;
  const entered = new Promise(done => { bodyEntered = done; }); const released = new Promise(done => { releaseBody = done; });
  f.state.bodyHook = async request => { if (request.body.holdOwnedBody) { bodyEntered(); await released; delete request.body.holdOwnedBody; } };
  const originalApply = f.request('apply', { ...reference, holdOwnedBody: true });
  await entered;
  assert.equal((await f.request('status')).body.proposals[0].phase, 'proposed');
  assert.equal((await f.request('discard', reference)).body.phase, 'discarded');
  releaseBody();
  assert.equal((await originalApply).body.error, 'PEER_SSH_PROPOSAL_DISCARDED');
  assert.deepEqual(f.state.calls, ['prepare']);
});

test('dispatched writes reject discard and new proposals; reconciliation reads only the original receipt', async t => {
  const f = await fixture(t); const proposed = (await f.request('prepare')).body;
  const reference = { proposalId: proposed.proposalId, digest: proposed.digest };
  let nativeEntered, releaseNative;
  const entered = new Promise(done => { nativeEntered = done; }); const released = new Promise(done => { releaseNative = done; });
  f.state.hook = async options => { if (options.action === 'apply') { nativeEntered(); await released; } };
  const applying = f.request('apply', reference); await entered;
  assert.equal((await f.request('status')).body.pinStatus, 'setup_unconfirmed');
  assert.equal((await f.request('discard', reference)).body.externalOutcome, 'unknown');
  assert.equal((await f.request('prepare')).body.externalOutcome, 'unknown');
  releaseNative(); assert.equal((await applying).status, 200);
  assert.equal(f.state.calls.filter(action => action === 'apply').length, 1);
  assert.equal((await f.request('reconcile', reference)).status, 200);
  assert.equal(f.state.calls.filter(action => action === 'apply').length, 1);
});

test('reauthorization advances the same Native enrollment generation', async t => {
  const f = await fixture(t); const first = (await f.request('prepare')).body;
  const one = await f.request('apply', { proposalId: first.proposalId, digest: first.digest });
  assert.equal(one.status, 200); assert.equal((await f.request('status')).body.pinStatus, 'pinned');
  const second = (await f.request('prepare')).body;
  assert.equal(second.enrollment.enrollmentId, first.enrollment.enrollmentId);
  assert.equal(second.enrollment.generation, first.enrollment.generation + 1);
  assert.equal((await f.request('apply', { proposalId: second.proposalId, digest: second.digest })).status, 200);
  assert.equal((await f.request('revoke')).status, 200); assert.equal((await f.request('status')).body.pinStatus, 'revoked');
});

test('a live old pin rejects changed Native profile, key or SSH host before creating a proposal', async t => {
  for (const field of ['profile', 'key', 'host']) {
    const f = await fixture(t), first = (await f.request('prepare')).body;
    await f.request('apply', { proposalId: first.proposalId, digest: first.digest });
    const before = await f.store.read(); f.state.calls.length = 0;
    if (field === 'profile') f.native.profileIdentity = 'a-new-native-profile';
    else if (field === 'key') f.native.publicKey[0] ^= 1;
    else f.ssh.sshHostKey = 'ssh-ed25519 SHA256:new-host';
    const changed = await f.request('prepare');
    assert.equal(changed.status, 409); assert.equal(changed.body.error, 'PEER_SSH_PIN_IDENTITY_CHANGED');
    assert.deepEqual(f.state.calls, ['observe']);
    assert.deepEqual(await f.store.read(), before, 'No proposal or uncertain dispatch journal is produced');
  }
});

test('identity or revision drift after preparation fails before dispatch and remains discardable', async t => {
  for (const field of ['profile', 'revision']) {
    const f = await fixture(t), proposal = (await f.request('prepare')).body;
    if (field === 'profile') f.native.profileIdentity = 'another-profile-before-apply';
    else f.state.nativeRevision++;
    const reference = { proposalId: proposal.proposalId, digest: proposal.digest };
    const rejected = await f.request('apply', reference);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, field === 'profile' ? 'PEER_SSH_PIN_IDENTITY_CHANGED' : 'PEER_SSH_PIN_NATIVE_REVISION_CHANGED');
    assert.equal((await f.store.read()).proposals[0].phase, 'proposed');
    assert.equal(f.state.calls.filter(action => action === 'apply').length, 0);
    assert.equal((await f.request('discard', reference)).body.phase, 'discarded');
  }
});

test('only the original authoritative revocation permits a fresh profile with a new enrollment identity', async t => {
  const f = await fixture(t), first = (await f.request('prepare')).body;
  await f.request('apply', { proposalId: first.proposalId, digest: first.digest });
  const revoked = await f.request('revoke'); assert.equal(revoked.status, 200);
  assert.equal(revoked.body.receipt.status, 'revoked');
  f.native.profileIdentity = 'fresh-profile'; f.native.targetId = 'fresh-native-target'; f.native.publicKey[0] ^= 1;
  f.state.nativeRevision = 0;
  const next = await f.request('prepare'); assert.equal(next.status, 200);
  assert.notEqual(next.body.enrollment.enrollmentId, first.enrollment.enrollmentId);
  assert.equal(next.body.enrollment.generation, 1);
  assert.equal((await f.request('apply', { proposalId: next.body.proposalId, digest: next.body.digest })).status, 200);
  const calls = [...f.state.calls];
  const original = await f.request('apply', { proposalId: first.proposalId, digest: first.digest });
  assert.equal(original.body.receipt.enrollmentId, first.enrollment.enrollmentId);
  assert.deepEqual(f.state.calls, calls);
  const current = await f.store.read();
  assert.equal(current.pins[0].enrollment.enrollmentId, next.body.enrollment.enrollmentId);
  assert.ok(current.proposals.some(row => row.receipt?.enrollmentId === first.enrollment.enrollmentId && row.receipt.status === 'revoked'));
});

test('a missing or altered old revocation receipt never authorizes a replacement identity', async t => {
  const f = await fixture(t), first = (await f.request('prepare')).body;
  await f.request('apply', { proposalId: first.proposalId, digest: first.digest }); await f.request('revoke');
  await f.store.update(data => { data.pins[0].receipt.generation = 1; });
  f.native.profileIdentity = 'new-profile'; f.state.calls.length = 0;
  const rejected = await f.request('prepare'); assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, 'PEER_SSH_PIN_RECEIPT_UNAVAILABLE'); assert.deepEqual(f.state.calls, []);
});
