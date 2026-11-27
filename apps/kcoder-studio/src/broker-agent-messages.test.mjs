import test from 'node:test';
import assert from 'node:assert/strict';
import { claimAgentMessage, projectAgentMessageResponse, AgentMessageAdmissionError } from './broker-agent-messages.js';
import { AGENT_MESSAGE_METHODS } from '../shared/agentMessageMethods.mjs';

function fixture() {
  const experimental = { crossSessionMessagesV1: true, crossSessionDiscoveryV1: true, peerAgentMessagesV1: true };
  const client = { ...experimental, initialized: true, authorizationOwner: {} };
  const broker = { initializeResponse: { result: { capabilities: { experimental } } }, clients: new Set([client]),
    ephemeralThreadOwners: new Map(), threadOwners: new Map([['source', client]]), sharedThreads: { has: () => false } };
  const message = { id: 1, method: AGENT_MESSAGE_METHODS.policySave,
    params: { sourceThreadId: 'source', expectedRevision: 'observed-revision', enabled: true, wakeIdle: false } };
  return { broker, client, message };
}
test('policy mutations require a genuine string/integer request identity, including synthetic replay checks', () => {
  const { broker, client, message } = fixture();
  for (const id of [undefined, null, {}, [], 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => claimAgentMessage(broker, client, { ...message, id }), AgentMessageAdmissionError);
  assert.equal(claimAgentMessage(broker, client, message).source, 'source');
  assert.equal(claimAgentMessage(broker, client, { ...message, id: 'request' }).source, 'source');
});
test('a successful policy snapshot is projected as policy rather than a message receipt', () => {
  const { broker, client, message } = fixture();
  const agentMessageTicket = claimAgentMessage(broker, client, message);
  const policy = { enabled: true, wakeIdle: false, revision: 'new-revision' };
  assert.deepEqual(projectAgentMessageResponse(broker, { agentMessageTicket, clientId: message.id },
    { jsonrpc: '2.0', id: 8, result: policy }).result, policy);
  assert.ok(projectAgentMessageResponse(broker, { agentMessageTicket, clientId: message.id },
    { jsonrpc: '2.0', id: 8, result: { ...policy, enabled: 'true' } }).error);
});
test('account/source changes cannot turn a stale policy response into confirmed success', () => {
  const { broker, client, message } = fixture();
  const agentMessageTicket = claimAgentMessage(broker, client, message);
  client.authorizationOwner = {};
  const reply = projectAgentMessageResponse(broker, { agentMessageTicket, clientId: message.id },
    { jsonrpc: '2.0', id: 8, result: { enabled: true, wakeIdle: true, revision: 'new' } });
  assert.ok(reply.error); assert.equal(reply.result, undefined);
});
test('target projection preserves the actual current turn and canonical address while rejecting unsafe selectors', () => {
  const { broker, client } = fixture();
  const message = { id: 2, method: AGENT_MESSAGE_METHODS.targets, params: { sourceThreadId: 'source' } };
  const agentMessageTicket = claimAgentMessage(broker, client, message);
  const address = { targetId: 'actual-native', workspaceId: 'actual-workspace', threadId: 'peer' };
  const target = { threadId: 'peer', address, activeTurnId: 'original-current-turn', status: 'running', presence: 'resident', allowedModes: ['enqueue_only'] };
  const project = row => projectAgentMessageResponse(broker, { agentMessageTicket, clientId: 2 }, { jsonrpc: '2.0', id: 9,
    result: { coverage: 'workspace_history', completeness: 'complete', observedAtMs: 1, targets: [row] } });
  assert.deepEqual(project(target).result.targets[0], target);
  assert.ok(project({ ...target, activeTurnId: 'x'.repeat(257) }).error);
  assert.ok(project({ ...target, address: { ...address, threadId: 'other' } }).error);
  const { activeTurnId: _active, ...legacy } = target;
  assert.equal(project(legacy).result.targets[0].activeTurnId, undefined);
  assert.equal(project({ ...target, activeTurnId: '运行/turn:1' }).result.targets[0].activeTurnId, '运行/turn:1');
});

test('policy read keeps only reviewed Native failure reasons after its current-owner fence', () => {
  const { broker, client } = fixture();
  const message = { id: 1, method: AGENT_MESSAGE_METHODS.policyRead, params: { sourceThreadId: 'source' } };
  const ticket = claimAgentMessage(broker, client, message);
  const secret = 'PRIVATE_CREDENTIAL_C:/Users/fixture/thread';
  const project = reason => projectAgentMessageResponse(broker, { agentMessageTicket: ticket, clientId: 1 }, {
    jsonrpc: '2.0', id: 8, error: { code: -32034, message: secret, data: { reason, path: secret, credential: secret } },
  });
  for (const reason of ['peer_policy_lease_privacy_unverified', 'peer_policy_lease_identity_changed', 'peer_policy_source_unavailable', 'peer_policy_settings_invalid']) {
    const response = project(reason);
    assert.deepEqual(response.error, { code: -32034, message: 'AGENT_MESSAGES_REQUEST_UNCONFIRMED', data: { reason } });
    assert.ok(!JSON.stringify(response).includes(secret));
  }
  assert.deepEqual(project('unreviewed:'+secret).error.data, { reason: 'unknown' });
  client.authorizationOwner = {};
  const stale = project('peer_policy_lease_privacy_unverified');
  assert.equal(stale.error.message, 'AGENT_MESSAGES_SOURCE_CHANGED_OUTCOME_UNKNOWN');
  assert.equal(Object.hasOwn(stale.error, 'data'), false);
});

test('policy mutations still discard Native diagnostic payloads and remain unconfirmed', () => {
  const { broker, client, message } = fixture();
  const ticket = claimAgentMessage(broker, client, message);
  const response = projectAgentMessageResponse(broker, { agentMessageTicket: ticket, clientId: 1 }, {
    jsonrpc: '2.0', id: 8, error: { code: -32034, message: 'private fixture', data: { reason: 'peer_policy_settings_invalid', token: 'private fixture' } },
  });
  assert.deepEqual(response.error, { code: -32034, message: 'AGENT_MESSAGES_REQUEST_UNCONFIRMED' });
});
