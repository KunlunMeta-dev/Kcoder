import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNativeRemoteSourceClient, requireCapturedNativeRemoteSourceClient, nativeRemoteSourceClientForAttempt } from './source-client-owner.mjs';
import { workspaceCwdObservationTargetIdentity } from '../workspace-cwd-observation.js';

function fixture() {
  const source = { id: 'source', runtime: 'kcoder', transport: 'local' };
  const target = { id: 'target', runtime: 'kcoder', transport: 'ssh', security: {} };
  const targets = new Map([[source.id, source], [target.id, target]]);
  const client = { initialized: true, authorizationOwner: 'actual-login-owner' };
  const broker = { closed: false, clients: new Set([client]) };
  const session = { allowedServerIds: new Set(['source', 'target']) };
  const generations = new Map([['source', 1], ['target', 1]]);
  const principals = new Map([['target', { principalId: 'actual-target-member' }]]);
  let active = true;
  const targetSignature = value => JSON.stringify(value);
  const owner = captureNativeRemoteSourceClient({ client, broker, sourceTarget: source,
    authorizationOwner: client.authorizationOwner, session, verifySession: () => active,
    getTarget: id => targets.get(id), targetSignature,
    accountIdentity: (_login, id) => principals.get(id),
    accountGeneration: (_login, id) => generations.get(id) });
  const reference = { targetId: 'target', targetRevision: workspaceCwdObservationTargetIdentity(targetSignature(target)) };
  return { owner, reference, client, broker, session, generations, principals, targets, target,
    revokeSession() { active = false; } };
}

test('a JSON owner claim cannot replace the captured authenticated client', () => {
  assert.throws(() => requireCapturedNativeRemoteSourceClient({ verify() {} }));
  const f = fixture();
  assert.equal(requireCapturedNativeRemoteSourceClient(f.owner), f.owner);
});

test('target configuration is passed only to the internal consumer after current access checks', async () => {
  const f = fixture();
  const result = await f.owner.withAuthorizedTarget(f.reference, async ({ target, authorizationOwner, verify }) => {
    assert.equal(target, f.target);
    assert.equal(authorizationOwner, 'actual-login-owner');
    verify();
    return 'internal-result';
  });
  assert.equal(result, 'internal-result');
});

test('session revocation and source detachment reject before target effects', async () => {
  for (const revoke of [f => f.revokeSession(), f => f.broker.clients.delete(f.client),
    f => { f.broker.closed = true; }, f => f.session.allowedServerIds.delete('source')]) {
    const f = fixture(); revoke(f);
    let called = false;
    await assert.rejects(f.owner.withAuthorizedTarget(f.reference, () => { called = true; }));
    assert.equal(called, false);
  }
});

test('an old or unapproved target cannot be selected by changing JSON fields', async () => {
  for (const change of [f => f.session.allowedServerIds.delete('target'),
    f => { f.reference.targetRevision = 'old-revision'; }, f => f.principals.delete('target'),
    f => f.targets.set('target', { ...f.target, transport: 'local' })]) {
    const f = fixture(); change(f);
    await assert.rejects(f.owner.withAuthorizedTarget(f.reference, () => assert.fail('must not execute')));
  }
});

test('target account and access changes during an await do not publish a stale owner result', async () => {
  for (const change of [f => f.generations.set('target', 2),
    f => f.principals.set('target', { principalId: 'different-member' }),
    f => f.session.allowedServerIds.delete('target')]) {
    const f = fixture();
    await assert.rejects(f.owner.withAuthorizedTarget(f.reference, async () => {
      change(f);
      return 'already-acted-result';
    }));
  }
});

test('source configuration or login-owner changes invalidate the captured client', () => {
  const f = fixture();
  f.targets.set('source', { ...f.targets.get('source'), command: 'changed-image' });
  assert.throws(() => f.owner.verify());
  const other = fixture(); other.client.authorizationOwner = 'replacement-login';
  assert.throws(() => other.owner.verify());
});

test('an active Native turn resolves its original socket owner rather than a JSON login claim', () => {
  const f = fixture();
  f.client.nativeRemoteSourceOwner = f.owner;
  f.broker.activeTurns = new Map([['actual-thread', { turnId: 'actual-turn' }]]);
  f.broker.ownerFor = message => message.params.threadId === 'actual-thread' ? f.client : null;
  const attempt = { threadId: 'actual-thread', turnId: 'actual-turn', attemptId: 'native-attempt' };
  assert.equal(nativeRemoteSourceClientForAttempt(f.broker, attempt), f.owner);
  assert.throws(() => nativeRemoteSourceClientForAttempt(f.broker, { ...attempt, threadId: 'peer-thread' }));
  assert.throws(() => nativeRemoteSourceClientForAttempt(f.broker, { ...attempt, turnId: 'old-turn' }));
  f.broker.activeTurns.clear();
  assert.throws(() => nativeRemoteSourceClientForAttempt(f.broker, attempt));
});

test('current pending management request resolves without a live execution turn and expires with its exact owner', async () => {
  const { nativeRemoteSourceClientForManagement } = await import('./source-client-owner.mjs');
  const f = fixture();
  f.client.nativeRemoteSourceOwner = f.owner;
  f.broker.activeTurns = new Map();
  const scope = { accountId: 'original-native-owner', targetId: 'original-native-source' };
  const original = { requestId: 'read-original', operationId: 'original-operation', sourceScope: scope };
  const pending = { client: f.client, method: 'integrations/remotes/readOperation', params: { requestId: original.requestId,
    operationId: original.operationId, scope: { targetId: scope.targetId, accountId: scope.accountId } } };
  f.broker.pending = new Map([[317, pending]]);
  const captured = nativeRemoteSourceClientForManagement(f.broker, { managementRpcId: 317, original });
  assert.equal(await captured.withAuthorizedTarget(f.reference, async () => 'original-read'), 'original-read');
  for (const change of [() => f.broker.pending.delete(317),
    () => f.broker.pending.set(317, { ...pending }),
    () => { pending.method = 'turn/start'; },
    () => { pending.params.operationId = 'other-operation'; }]) {
    f.broker.pending.set(317, pending); pending.method = 'integrations/remotes/readOperation';
    pending.params.operationId = original.operationId;
    change();
    assert.throws(() => captured.verify());
  }
});

test('management request and current target revocation around an await cannot publish original facts', async () => {
  const { nativeRemoteSourceClientForManagement } = await import('./source-client-owner.mjs');
  for (const revoke of [f => f.broker.pending.clear(), f => f.session.allowedServerIds.delete('target'),
    f => f.generations.set('target', 2), f => f.revokeSession()]) {
    const f = fixture(); f.client.nativeRemoteSourceOwner = f.owner;
    const original = { requestId: 'read-original', operationId: 'original-operation', sourceScope: {} };
    f.broker.pending = new Map([[19, { client: f.client, method: 'integrations/remotes/readOperation',
      params: { requestId: original.requestId, operationId: original.operationId, scope: {} } }]]);
    const captured = nativeRemoteSourceClientForManagement(f.broker, { managementRpcId: 19, original });
    await assert.rejects(captured.withAuthorizedTarget(f.reference, async () => { revoke(f); return 'stale-result'; }));
  }
});

test('a changed Provider selector cannot reuse the original stored target revision for recovery', async () => {
  const f = fixture();
  f.targets.set('target', { ...f.target, profile: 'ReplacementProvider' });
  await assert.rejects(f.owner.withAuthorizedTarget(f.reference, () => assert.fail('changed Provider selector must not reach SSH')));
});
