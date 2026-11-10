import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerSessionAttachments } from '../src/broker-session-attachments.js';

function fixture() {
  const sent = [], a = { initialized: true, channel: 'runtime' }, b = { initialized: true, channel: 'runtime' };
  const broker = { clients: new Set([a, b]), initializeResponse: {
    result: { capabilities: { experimental: { sessionLifetimeV1: true } } } },
    sendInternalRequest: (method, params) => sent.push({ method, params }) };
  return { a, b, broker, sent, attachments: new BrokerSessionAttachments(broker) };
}

test('each real page has an independent app-server handle and detach is exact', () => {
  const f = fixture();
  try {
    f.attachments.attach(f.a, 'task'); f.attachments.attach(f.b, 'task');
    assert.notEqual(f.sent[0].params.clientId, f.sent[1].params.clientId);
    f.attachments.detach(f.a);
    assert.equal(f.sent[2].method, 'thread/detach');
    assert.deepEqual(f.sent[2].params, f.sent[0].params);
    assert.equal(f.sent.some(x => x.method === 'turn/interrupt'), false);
    f.attachments.detach(f.b);
    assert.deepEqual(f.sent[3].params, f.sent[1].params);
  } finally { f.attachments.clear(); }
});

test('late view cleanup cannot remove a reopened view and reads do not attach', () => {
  const f = fixture();
  try {
    f.attachments.attach(f.a, 'task', 'old');
    f.attachments.attach(f.a, 'task', 'new');
    const count = f.sent.length;
    assert.equal(f.attachments.release(f.a, 'task', 'old'), false);
    assert.equal(f.sent.length, count);
    assert.equal(f.attachments.release(f.a, 'task', 'new'), true);
    const readOnly = { initialized: true, channel: 'integrations' };
    f.broker.clients.add(readOnly);
    assert.equal(f.attachments.attach(readOnly, 'task'), false);
  } finally { f.attachments.clear(); }
});
