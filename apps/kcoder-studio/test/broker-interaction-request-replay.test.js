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
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    broker.routeServerMessage({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = join();
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', [field]: 'original-interaction', appServerEpoch: 'original-epoch',
  } };
  broker.routeServerMessage(request);
  const receipt = { method: `${kind}/resolved`, params: { ...request.params, requestId: request.id,
    reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  const reply = (client = owner) => broker.receive(client, JSON.stringify({ id: request.id,
    result: kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' } }));
  return { broker, upstream, join, owner, viewer, field, request, receipt, reply };
}

for (const kind of ['question', 'approval']) {
  test(`${kind}: duplicate pending requests do not redeliver cards or replace original ownership`, t => {
    const f = fixture(t, kind);
    const delivered = [f.owner.messages.length, f.viewer.messages.length];
    f.broker.threadOwners.set('thread', f.viewer);
    f.broker.routeServerMessage(structuredClone(f.request));
    assert.equal(f.broker.serverRequests.get(f.request.id), f.owner, 'a repeated request must retain its original client');
    assert.deepEqual([f.owner.messages.length, f.viewer.messages.length], delivered, 'replays must not reset pending card drafts');
    const before = f.upstream.length;
    f.reply(f.viewer);
    assert.equal(f.upstream.length, before, 'a viewer must not acquire the original question by replay');
    f.reply();
    assert.equal(f.upstream.length, before + 1);
  });

  test(`${kind}: repeated requests after submission cannot forward a second answer`, t => {
    const f = fixture(t, kind);
    const before = f.upstream.length;
    f.reply();
    assert.equal(f.upstream.length, before + 1);
    f.broker.routeServerMessage(structuredClone(f.request));
    f.reply();
    assert.equal(f.upstream.length, before + 1, 'a replay must not clear the submitted fence');
    assert.equal(f.broker.serverRequests.has(f.request.id), false, 'submitted requests must not become pending again');
    f.broker.routeServerMessage(f.receipt);
    assert.deepEqual(f.owner.messages.at(-1), f.receipt);
    assert.deepEqual(f.viewer.messages.at(-1), f.receipt);
  });

  test(`${kind}: repeated requests after resolution cannot reopen cards or discard the first receipt`, t => {
    const f = fixture(t, kind);
    f.reply();
    f.broker.routeServerMessage(f.receipt);
    const delivered = [f.owner.messages.length, f.viewer.messages.length];
    f.broker.routeServerMessage(structuredClone(f.request));
    assert.deepEqual([f.owner.messages.length, f.viewer.messages.length], delivered, 'terminal cards must not reopen');
    assert.equal(f.broker.serverRequests.has(f.request.id), false);
    const before = f.upstream.length;
    f.reply();
    assert.equal(f.upstream.length, before, 'late replies must read the retained receipt');
    assert.deepEqual(f.owner.messages.at(-1), f.receipt);
    const late = f.join();
    assert.equal(late.messages.some(message => message.method === f.request.method), false);
  });

  test(`${kind}: reused transport IDs cannot substitute another interaction binding`, t => {
    const f = fixture(t, kind);
    const collision = { ...f.request, params: { ...f.request.params,
      [f.field]: 'another-interaction', appServerEpoch: 'another-epoch' } };
    f.broker.routeServerMessage(collision);
    const late = f.join();
    assert.deepEqual(late.messages.at(-1), f.request, 'new viewers must read the original question identity');
    const before = f.upstream.length;
    f.reply();
    assert.equal(f.upstream.length, before + 1);
    assert.equal(f.upstream.at(-1).result[f.field], 'original-interaction');
    f.broker.routeServerMessage(f.receipt);
    assert.deepEqual(f.owner.messages.at(-1), f.receipt, 'the original bound receipt must still settle');
  });
}

for (const kind of ['question', 'approval']) {
  for (const epoch of ['restored-epoch', undefined]) {
    test(`${kind}: a recovery receipt before its request prevents stale cards (${epoch ?? 'legacy'})`, t => {
      const f = fixture(t, kind);
      const field = kind === 'question' ? 'questionId' : 'approvalId';
      const request = { id: 900, method: `${kind}/request`, params: {
        threadId: 'thread', turnId: 'restored-turn', [field]: 'restored-interaction',
        ...(epoch ? { appServerEpoch: epoch } : {}),
      } };
      const receipt = { method: `${kind}/resolved`, params: { ...request.params,
        requestId: request.id, reason: 'client_response',
        ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
      const serverMessage = message => {
        const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
        f.broker.child.stdout.write(line.slice(0, middle));
        f.broker.child.stdout.write(line.slice(middle));
      };
      serverMessage(receipt);
      assert.deepEqual(f.owner.messages.at(-1), receipt, 'restored terminal results remain visible');
      const delivered = [f.owner.messages.length, f.viewer.messages.length];
      serverMessage(request);
      assert.deepEqual([f.owner.messages.length, f.viewer.messages.length], delivered,
        'a terminal interaction cannot reopen after an out-of-order recovery request');
      assert.equal(f.broker.serverRequests.has(request.id), false);
      serverMessage({ ...receipt, params: { ...receipt.params, reason: 'cancelled' } });
      assert.deepEqual([f.owner.messages.length, f.viewer.messages.length], delivered,
        'a repeated recovery receipt cannot replace the first terminal result');
      const late = f.join();
      assert.equal(late.messages.some(message => message.id === request.id), false,
        'rejoining clients must not receive a stale pending card');
      const next = { ...request, id: 901, params: { ...request.params, [field]: 'next-interaction' } };
      serverMessage(next);
      assert.equal(f.broker.serverRequests.get(next.id), f.owner,
        'another interaction in the same turn is still answerable');
    });
  }
}

test('recovery terminal identities are bounded, do not refresh on duplicates, and clear with the broker', () => {
  const owner = {};
  const broker = { activeTurns: new Map(), threadDrains: new Map(), clients: new Set([owner]),
    ownerFor: () => owner };
  const interactions = new BrokerSharedInteractions(broker);
  const receipt = id => ({ method: 'question/resolved', params: {
    requestId: id, threadId: 'thread', turnId: 'turn', questionId: `question-${id}`, reason: 'client_response',
  } });
  const request = id => ({ id, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: `question-${id}`,
  } });
  for (let id = 0; id < 2048; id++) assert.equal(interactions.resolved(receipt(id)), true);
  assert.equal(interactions.resolved(receipt(0)), false, 'duplicate receipts cannot extend their retention');
  assert.equal(interactions.resolved(receipt(2048)), true);
  assert.equal(interactions.rejectUnownedRequest(request(0)), false, 'the oldest terminal identity is evicted at capacity');
  assert.equal(interactions.rejectUnownedRequest(request(2048)), true, 'recent terminal identities remain fenced');
  interactions.clear();
  assert.equal(interactions.rejectUnownedRequest(request(2048)), false, 'a new broker lifetime releases old transport identities');
});

for (const kind of ['question', 'approval']) {
  test(`${kind}: terminal request identities survive all original clients disconnecting`, t => {
    const f = fixture(t, kind);
    f.reply();
    f.broker.routeServerMessage(f.receipt);
    f.broker.detach(f.owner);
    f.broker.detach(f.viewer);
    const late = f.join();
    const delivered = late.messages.length;
    f.broker.routeServerMessage(structuredClone(f.request));
    assert.equal(late.messages.length, delivered, 'a removed terminal entry cannot become a new question on reconnect');
    assert.equal(f.broker.serverRequests.has(f.request.id), false);
  });
}
