import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { captureAcceptedPeerReceiptReader } from './accepted-peer-receipt.mjs';
import { routeProof, routerOperationId, messageBodySha256, attestationSigningBytes, ROUTER_PURPOSE } from '../../src/agent-message-router-private.js';

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const source = { targetId: 'source', workspaceId: 'source-workspace', identityEpoch: 'source-epoch',
    principal: { kind: 'localOs' }, publicKey: [...keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)] };
  const destination = { ...source, targetId: 'destination', workspaceId: 'destination-workspace', identityEpoch: 'destination-epoch' };
  const from = { targetId: source.targetId, workspaceId: source.workspaceId, threadId: 'original-source' };
  const to = { targetId: destination.targetId, workspaceId: destination.workspaceId, threadId: 'original-target' };
  const operationId = routerOperationId(from, 'original-client');
  const claims = { version: 1, purpose: ROUTER_PURPOSE, operationId, sourceAddress: from, destination: to,
    sourceIdentityEpoch: source.identityEpoch, clientMessageId: 'original-client', mode: 'enqueue_only', bodySha256: messageBodySha256('fixture body') };
  const queued = { messageId: 'original-message', clientMessageId: 'original-client', targetThreadId: to.threadId,
    status: 'queued', revision: 1, sourceAddress: from, targetAddress: to };
  const operation = { operationId, sourceAddress: from, destination: to, bodySha256: claims.bodySha256, stage: 'receipted',
    receipt: queued, attestation: { claims, signature: [...sign(null, attestationSigningBytes(claims), keys.privateKey)] } };
  const state = { revoked: false, source, destination, calls: 0, response: { ...queued, status: 'applied', revision: 2 } };
  const read = captureAcceptedPeerReceiptReader({ operation, proof: routeProof(source, destination, 'actual-fixture-subject'),
    verifyCurrent: () => assert.equal(state.revoked, false), sourceIdentity: async () => state.source,
    destinationIdentity: async () => state.destination,
    queryDestination: async params => {
      state.calls++; assert.deepEqual(params.query, { messageId: queued.messageId });
      assert.deepEqual(params.attestation, operation.attestation);
      return { result: { receipt: state.response } };
    } });
  return { state, read, queued };
}

test('accepted-op fixture reads only the original destination receipt without Source execution ownership', async () => {
  const f = fixture();
  const result = await f.read(f.queued);
  assert.equal(result.receipt.status, 'applied'); assert.equal(f.state.calls, 1);
});

test('revoked subject and changed actual Native identities fail before querying the destination', async () => {
  for (const change of [f => { f.state.revoked = true; }, f => { f.state.source = { ...f.state.source, identityEpoch: 'other' }; },
    f => { f.state.destination = { ...f.state.destination, workspaceId: 'other' }; }]) {
    const f = fixture(); change(f);
    await assert.rejects(f.read(f.queued)); assert.equal(f.state.calls, 0);
  }
});

test('receipt confusion cannot make another message or source/destination look Applied', async () => {
  for (const change of [receipt => ({ ...receipt, messageId: 'other' }), receipt => ({ ...receipt, clientMessageId: 'other' }),
    receipt => ({ ...receipt, sourceAddress: { ...receipt.sourceAddress, threadId: 'other' } }),
    receipt => ({ ...receipt, targetAddress: { ...receipt.targetAddress, workspaceId: 'other' } })]) {
    const f = fixture(); f.state.response = change(f.state.response);
    await assert.rejects(f.read(f.queued));
  }
});

test('revocation or identity changes during a destination read are checked before publishing its receipt', async () => {
  const f = fixture();
  const operationRead = f.state.response;
  Object.defineProperty(f.state, 'response', { get() { f.state.revoked = true; return operationRead; } });
  await assert.rejects(f.read(f.queued)); assert.equal(f.state.calls, 1);
});
