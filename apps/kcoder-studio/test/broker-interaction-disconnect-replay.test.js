import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BrokerSharedInteractions } from '../src/broker-shared-interactions.js';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const serverMessage = message => {
    const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
  };
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    serverMessage({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = join();
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  // A resumed running task can emit interactions without this Gateway having
  // observed the original turn/start admission.
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'original-turn', [field]: 'original-interaction', appServerEpoch: 'epoch',
  } };
  serverMessage(request);
  const receipt = { method: `${kind}/resolved`, params: { ...request.params, requestId: request.id,
    reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  const reply = client => broker.receive(client, JSON.stringify({ id: request.id,
    result: kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' } }));
  return { broker, upstream, serverMessage, join, owner, viewer, request, receipt, reply, field };
}

for (const kind of ['question', 'approval']) {
  test(`${kind}: a late join cannot replay a card after its original input client disconnected`, t => {
    const f = fixture(t, kind);
    f.broker.detach(f.owner);
    const late = f.join();
    assert.equal(late.messages.some(message => message.method === f.request.method), false,
      'a new viewer must not receive an orphaned actionable prompt');
    const before = f.upstream.length;
    f.reply(f.viewer);
    assert.equal(f.upstream.length, before, 'the remaining viewer cannot answer for the disconnected owner');
    f.serverMessage(f.receipt);
    assert.deepEqual(f.viewer.messages.at(-1), f.receipt, 'disconnect does not fabricate or suppress the native receipt');
    assert.deepEqual(late.messages.at(-1), f.receipt);
    const next = { ...f.request, id: 501, params: { ...f.request.params, [f.field]: 'new-interaction' } };
    f.serverMessage(next);
    assert.equal(f.broker.serverRequests.get(next.id), f.viewer, 'new input retains the current client owner');
  });

  for (const submitted of [false, true]) {
    test(`${kind}: all recipients leaving before resolution cannot transfer a ${submitted ? 'submitted' : 'pending'} request on replay`, t => {
      const f = fixture(t, kind);
      if (submitted) f.reply(f.owner);
      f.broker.detach(f.owner);
      f.broker.detach(f.viewer);
      const late = f.join();
      const delivered = late.messages.length;
      f.serverMessage(structuredClone(f.request));
      assert.equal(late.messages.length, delivered, 'transport replay must not become a new client question');
      assert.equal(f.broker.serverRequests.has(f.request.id), false);
      f.serverMessage(f.receipt);
      assert.deepEqual(late.messages.at(-1), f.receipt, 'the first actual terminal receipt is still delivered');
      f.serverMessage({ ...f.receipt, params: { ...f.receipt.params, reason: 'cancelled' } });
      assert.deepEqual(late.messages.at(-1), f.receipt);
    });
  }
}

test('disconnected request identities are bounded independently from pending work and clear with the broker', () => {
  const owner = {};
  const broker = { activeTurns: new Map(), threadDrains: new Map(), clients: new Set([owner]),
    ownerFor: () => owner,
    sharedThreads: { members: () => [] } };
  const interactions = new BrokerSharedInteractions(broker);
  const request = id => ({ id, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: `question-${id}`,
  } });
  for (let id = 0; id <= 2048; id++) {
    interactions.request(request(id), owner);
    interactions.detach(owner);
  }
  assert.equal(interactions.rejectUnownedRequest(request(0)), false, 'oldest disconnected identities expire at capacity');
  assert.equal(interactions.rejectUnownedRequest(request(2048)), true, 'recent disconnected identities cannot change owner');
  interactions.clear();
  assert.equal(interactions.rejectUnownedRequest(request(2048)), false);
});
