import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AGENT_MESSAGE_METHODS, validAgentTurnId, validAgentMessageRequest } from '../shared/agentMessageMethods.mjs';
import { attestationSigningBytes, requireRouterOperation, routerOperationId } from './agent-message-router-private.js';

test('expected and observed turn selectors preserve the actual nonblank UTF-8 component domain', () => {
  const input = expectedTurnId => ({ sourceThreadId: 'source', message: { targetThreadId: 'target', clientMessageId: 'original', mode: 'enqueue_only', text: 'reference', expectedTurnId } });
  for (const value of ['运行/turn:1', '界'.repeat(85) + 'x', '\ufeff']) {
    assert.equal(validAgentTurnId(value), true); assert.equal(validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, input(value)), true);
  }
  for (const value of ['', ' \t\n\u0085\u3000', 'x'.repeat(257), '界'.repeat(86), '\ud800', 1]) {
    assert.equal(validAgentTurnId(value), false); assert.equal(validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, input(value)), false);
  }
  const wake = input('运行/turn:1'); wake.message.mode = 'wake_if_idle';
  assert.equal(validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, wake), false);
});

test('the immutable signature binds every original Unicode turn-selector byte', () => {
  const pair = generateKeyPairSync('ed25519');
  const sourceAddress = { targetId: 'native-source', workspaceId: 'workspace-source', threadId: 'source' };
  const destination = { targetId: 'native-target', workspaceId: 'workspace-target', threadId: 'target' };
  const identity = { ...sourceAddress, principal: { kind: 'localOs' }, publicKey: [...pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)], identityEpoch: 'original-epoch' };
  delete identity.threadId;
  const operationId = routerOperationId(sourceAddress, 'original');
  const claims = { version: 1, purpose: 'kcoder.peer-message.route.v1', operationId, sourceAddress, destination,
    sourceIdentityEpoch: identity.identityEpoch, clientMessageId: 'original', mode: 'enqueue_only', expectedTurnId: '运行/turn:1', bodySha256: 'a'.repeat(64) };
  const operation = { operationId, sourceAddress, destination, bodySha256: claims.bodySha256, stage: 'prepared',
    attestation: { claims, signature: [...sign(null, attestationSigningBytes(claims), pair.privateKey)] } };
  assert.equal(requireRouterOperation(operation, identity, sourceAddress), operation);
  const changed = structuredClone(operation); changed.attestation.claims.expectedTurnId = '运行/turn:2';
  assert.throws(() => requireRouterOperation(changed, identity, sourceAddress), /ATTESTATION_INVALID/);
});
