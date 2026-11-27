import test from 'node:test';
import assert from 'node:assert/strict';
import { peerNotificationFacts, observeOwnedPeerBroker } from './peer-notification-facts.mjs';

const message = () => ({ method: 'item/completed', params: { threadId: 'original-thread', turnId: null, sequence: 7,
  item: { id: 'history-anchor', type: 'peerAgentMessage', origin: 'peer_agent', role: 'peer_agent', text: 'OWNED_TUI_PEER private raw body',
    agentMessage: { messageId: 'original-message', sourceAddress: { targetId: 'source', workspaceId: 'workspace', threadId: 'thread-a' },
      targetAddress: { targetId: 'dest', workspaceId: 'workspace', threadId: 'original-thread' } } } },
  credentials: 'private-do-not-record', sourceProof: 'private-do-not-record' });

test('peer observation contains only closed metadata and never body, credentials or source proofs', () => {
  const facts = peerNotificationFacts(message());
  assert.equal(facts.hasTurnId, false); assert.equal(facts.sequence, 7);
  assert.equal(facts.hasPeerTextMarker, true); assert.equal(facts.sourceAddress.threadId, 'thread-a');
  assert.equal(JSON.stringify(facts).includes('private'), false);
  assert.equal(peerNotificationFacts({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'peer_agent' } } }), null);
});

test('transparent observation preserves original parsing, send identity, result and delivery under observer errors', () => {
  const events = [], delivered = [];
  class Broker {
    processStdoutLine(line) { const value = JSON.parse(line); return this.sendServerNotification(this.client, value); }
    sendServerNotification(client, value) { return client.send(value); }
  }
  const send = value => { delivered.push(value); return 'original-result'; };
  const broker = new Broker(); broker.client = { initialized: true, peerAgentMessagesNegotiatedV1: true, send };
  const remove = observeOwnedPeerBroker(Broker, event => { events.push(event); if (event.lane === 'gateway-client-send') throw new Error('fixture-only sink error'); });
  try {
    assert.equal(broker.processStdoutLine(JSON.stringify(message())), 'original-result');
    assert.equal(broker.client.send, send);
    assert.deepEqual(events.map(row => row.lane), ['native-stdout', 'gateway-notification-attempt', 'gateway-client-send', 'native-route-completed']);
    assert.equal(delivered.length, 1); assert.deepEqual(delivered[0], message());
  } finally { remove(); }
});
