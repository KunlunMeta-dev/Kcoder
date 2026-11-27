import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_MESSAGE_METHODS, validAgentMessageRequest, validAgentMessageReceipt } from '../shared/agentMessageMethods.mjs';
import { attestationSigningBytes, ROUTER_PURPOSE } from './agent-message-router-private.js';
const sourceAddress = { targetId: 'target-a', workspaceId: 'workspace-a', threadId: 'source' };
const targetAddress = { targetId: 'target-b', workspaceId: 'workspace-b', threadId: 'target' };
const message = { targetThreadId: 'target', targetAddress, clientMessageId: 'client-message', mode: 'enqueue_only', text: 'Owned reply' };
const receipt = { messageId: 'message', clientMessageId: message.clientMessageId, targetThreadId: 'target',
  sourceAddress, targetAddress, status: 'queued', revision: 1 };
const claims = { version: 1, purpose: ROUTER_PURPOSE, operationId: 'operation', sourceAddress, destination: targetAddress,
  sourceIdentityEpoch: 'epoch', clientMessageId: message.clientMessageId, mode: message.mode, bodySha256: 'a'.repeat(64) };

test('one-shot send and receipt preserve only a valid optional original reply message ID', () => {
  assert.equal(validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, { sourceThreadId: 'source', message: { ...message, replyToMessageId: 'received-original' } }), true);
  assert.equal(validAgentMessageReceipt({ ...receipt, replyToMessageId: 'received-original' }), true);
  for (const bad of ['', 'foreign/address', 'x'.repeat(129), 42, {}, '\n']) {
    assert.equal(validAgentMessageRequest(AGENT_MESSAGE_METHODS.send, { sourceThreadId: 'source', message: { ...message, replyToMessageId: bad } }), false);
    assert.equal(validAgentMessageReceipt({ ...receipt, replyToMessageId: bad }), false);
  }
});

test('reply signatures retain the old absent/null bytes and bind the original reply after bodySha256', () => {
  const old = attestationSigningBytes(claims);
  assert.deepEqual(attestationSigningBytes({ ...claims, replyToMessageId: null }), old);
  const reply = attestationSigningBytes({ ...claims, replyToMessageId: 'received-original' });
  assert.notDeepEqual(reply, old);
  assert.notDeepEqual(reply, attestationSigningBytes({ ...claims, replyToMessageId: 'different-original' }));
  assert.ok(reply.toString('utf8').endsWith('"bodySha256":"' + 'a'.repeat(64) + '","replyToMessageId":"received-original"}'));
});
