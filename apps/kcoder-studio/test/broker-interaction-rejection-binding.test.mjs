import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerSharedInteractions } from '../src/broker-shared-interactions.js';

for (const kind of ['question', 'approval']) {
  for (const reason of ['invalid_response', 'not_original_client', 'turn_ended']) {
    test(`${kind} ${reason} rejection carries the original complete interaction binding`, () => {
      const owner = { messages: [], send(message) { this.messages.push(message); } };
      const viewer = { messages: [], send(message) { this.messages.push(message); } };
      const broker = { clients: new Set([owner, viewer]), serverRequests: new Map([[41, owner]]),
        sharedThreads: { has: () => true, members: () => [owner, viewer] },
        activeTurns: new Map(), threadDrains: new Map(), repliedServerRequests: new Map(),
        forwardClientRequest: () => assert.fail('a rejected reply cannot reach Native') };
      const interactions = new BrokerSharedInteractions(broker);
      const binding = { threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
        [kind === 'question' ? 'questionId' : 'approvalId']: 'original-item' };
      interactions.request({ id: 41, method: `${kind}/request`, params: { ...binding,
        ...(kind === 'question' ? { questions: [{ id: 'choice' }] } : { availableDecisions: ['accept'] }) } }, owner);
      owner.messages.length = 0; viewer.messages.length = 0;
      if (reason === 'turn_ended') interactions.resolved({ method: 'turn/completed',
        params: { threadId: 'thread', turnId: 'turn' } });
      const client = reason === 'not_original_client' ? viewer : owner;
      interactions.reply(client, { id: 41, result: {} });
      assert.deepEqual(client.messages.at(-1), { jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
        params: { ...binding, requestId: 41, reason } });
    });
  }

  if (kind === 'question') test('foreign question items use the same complete rejection binding', () => {
    const owner = { messages: [], send(message) { this.messages.push(message); } };
    const broker = { clients: new Set([owner]), serverRequests: new Map([[41, owner]]),
      sharedThreads: { has: () => false, members: () => [] } };
    const interactions = new BrokerSharedInteractions(broker);
    const binding = { threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch', questionId: 'question' };
    interactions.request({ id: 41, method: 'question/request', params: { ...binding,
      questions: [{ id: 'choice' }] } }, owner);
    interactions.reply(owner, { id: 41, result: { answers: { foreign: { answers: ['other card'] } } } });
    assert.deepEqual(owner.messages.at(-1).params, { ...binding, requestId: 41, reason: 'invalid_response' });
  });
}
