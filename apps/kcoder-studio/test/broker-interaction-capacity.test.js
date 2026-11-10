import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared, initialRequests = 512) {
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
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    broker.routeServerMessage({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  const request = index => ({ id: 1000 + index, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
    [kind === 'question' ? 'questionId' : 'approvalId']: `interaction-${index}`,
  } });
  for (let index = 0; index < initialRequests; index++) broker.routeServerMessage(request(index));
  return { broker, upstream, owner, viewer, join, request };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [true, false]) {
    test(`${kind}: full ${shared ? 'shared' : 'exclusive'} registration rejects overflow before showing an untracked card`, t => {
      const f = fixture(t, kind, shared);
      const overflow = f.request(512);
      const before = f.upstream.length;
      f.broker.routeServerMessage(overflow);
      assert.equal(f.upstream.length, before + 1, 'the original native waiter must receive a definite rejection');
      assert.equal(f.upstream.at(-1).id, overflow.id);
      assert.equal(f.upstream.at(-1).error.code, -32040);
      assert.match(f.upstream.at(-1).error.message, /limit|capacity/);
      assert.equal(f.broker.serverRequests.has(overflow.id), false, 'overflow cannot leave unbounded pending transport work');
      assert.equal(f.broker.serverRequests.size, 512);
      for (const client of [f.owner, f.viewer].filter(Boolean)) {
        assert.equal(client.messages.some(message => message.id === overflow.id), false);
      }
      // A duplicate admitted request must still retain its owner at capacity.
      const delivered = f.owner.messages.length;
      f.broker.routeServerMessage(f.request(0));
      assert.equal(f.owner.messages.length, delivered);
      assert.equal(f.upstream.length, before + 1, 'do not reject or settle the existing request');
      assert.equal(f.broker.serverRequests.get(f.request(0).id), f.owner);
      // Settling one request frees exactly one slot without dropping live peers.
      const original = f.request(0);
      f.broker.routeServerMessage({ method: `${kind}/resolved`, params: {
        ...original.params, requestId: original.id, reason: 'client_response',
        ...(kind === 'approval' ? { decision: 'accept' } : {}),
      } });
      const next = f.request(513);
      f.broker.routeServerMessage(next);
      assert.deepEqual(f.owner.messages.at(-1), next);
      if (f.viewer) assert.deepEqual(f.viewer.messages.at(-1), next);
      assert.equal(f.broker.serverRequests.get(next.id), f.owner);
      assert.equal(f.broker.serverRequests.size, 512);
      const beforeReply = f.upstream.length;
      f.broker.receive(f.owner, JSON.stringify({ id: next.id,
        result: kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' } }));
      assert.equal(f.upstream.length, beforeReply + 1, 'the admitted replacement remains answerable');
    });

    test(`${kind}: a submitted ${shared ? 'shared' : 'exclusive'} epoch-bound request retains its receipt fence at capacity`, t => {
      const f = fixture(t, kind, shared);
      const original = f.request(0);
      f.broker.receive(f.owner, JSON.stringify({ id: original.id,
        result: kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' } }));
      const before = f.upstream.length;
      const overflow = f.request(512);
      f.broker.routeServerMessage(overflow);
      assert.equal(f.upstream.length, before + 1);
      assert.equal(f.upstream.at(-1).error.code, -32040);
      assert.equal(f.broker.serverRequests.has(overflow.id), false);
      const delivered = f.owner.messages.length;
      const receipt = { method: `${kind}/resolved`, params: {
        ...original.params, requestId: original.id, reason: 'client_response',
        ...(kind === 'approval' ? { decision: 'accept' } : {}),
      } };
      f.broker.routeServerMessage({ ...receipt, params: { ...receipt.params, appServerEpoch: 'wrong-epoch' } });
      assert.equal(f.owner.messages.length, delivered, 'sending an answer does not settle its native receipt or discard its epoch');
      f.broker.routeServerMessage(receipt);
      assert.deepEqual(f.owner.messages.at(-1), receipt);
    });
  }

  test(`${kind}: legacy exclusive replies without terminal notifications release binding capacity`, t => {
    const f = fixture(t, kind, false, 0);
    for (let index = 0; index < 513; index++) {
      const request = f.request(index);
      delete request.params.appServerEpoch;
      f.broker.routeServerMessage(request);
      assert.deepEqual(f.owner.messages.at(-1), request);
      const before = f.upstream.length;
      f.broker.receive(f.owner, JSON.stringify({ id: request.id,
        result: kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' } }));
      assert.equal(f.upstream.length, before + 1);
      assert.equal(f.upstream.at(-1).error, undefined);
    }
    assert.equal(f.broker.repliedServerRequests.size, 512);
    assert.equal(f.broker.serverRequests.size, 0);
  });

  test(`${kind}: a disconnected original owner cannot exhaust a remaining viewer's question capacity`, t => {
    const f = fixture(t, kind, true);
    const original = f.request(0);
    f.broker.detach(f.owner);
    assert.equal(f.broker.threadOwners.get('thread'), f.viewer);
    assert.equal(f.broker.serverRequests.size, 0);

    const next = f.request(512);
    next.params.turnId = 'next-turn';
    const before = f.upstream.length;
    // Use the actual bounded JSONL input, as on a shared app-server connection.
    const emit = message => f.broker.child.stdout.write(`${JSON.stringify(message)}\n`);
    emit(next);
    assert.equal(f.upstream.length, before, 'retired input authority must not consume live question capacity');
    assert.equal(f.broker.serverRequests.get(next.id), f.viewer);
    assert.deepEqual(f.viewer.messages.at(-1), next);

    const delivered = f.viewer.messages.length;
    emit(original);
    assert.equal(f.viewer.messages.length, delivered, 'eviction must not rebind the old question to the viewer');
    const receipt = { method: `${kind}/resolved`, params: {
      ...original.params, requestId: original.id, reason: 'cancelled',
      ...(kind === 'approval' ? { decision: 'decline' } : {}),
    } };
    emit({ ...receipt, params: { ...receipt.params, appServerEpoch: 'wrong-epoch' } });
    assert.equal(f.viewer.messages.length, delivered, 'retired bindings still reject foreign terminal receipts');
    emit(receipt);
    assert.deepEqual(f.viewer.messages.at(-1), receipt, 'the original Native outcome remains observable');

    f.broker.receive(f.viewer, JSON.stringify({ id: next.id,
      result: kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' } }));
    assert.equal(f.upstream.length, before + 1, 'the replacement question remains answerable exactly once');
    assert.equal(f.upstream.at(-1).id, next.id);
  });
}
