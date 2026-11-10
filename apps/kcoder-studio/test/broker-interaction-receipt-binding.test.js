import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, appServerEpoch = 'current-epoch') {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let nextId = 1;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true });
    broker.receive(client, JSON.stringify({ id: nextId++, method: 'thread/resume', params: { threadId: 'thread' } }));
    broker.routeServerMessage({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = join();
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', [field]: 'original-interaction',
    ...(appServerEpoch == null ? {} : { appServerEpoch }),
  } };
  broker.routeServerMessage(request);
  const receipt = { method: `${kind}/resolved`, params: {
    ...request.params, requestId: request.id, reason: 'client_response',
    ...(kind === 'approval' ? { decision: 'accept' } : {}),
  } };
  const reply = () => broker.receive(owner, JSON.stringify({ id: request.id,
    result: kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' } }));
  return { broker, upstream, join, owner, viewer, field, request, receipt, reply };
}

for (const kind of ['question', 'approval']) {
  for (const mismatch of ['identity', 'missing identity', 'type', 'turn', 'thread', 'epoch', 'missing epoch',
    'missing reason', 'invalid reason', ...(kind === 'approval' ? ['invalid decision'] : [])]) {
    test(`${kind}: a ${mismatch} mismatch cannot settle or replay another interaction`, t => {
      const f = fixture(t, kind);
      const invalid = structuredClone(f.receipt);
      if (mismatch === 'identity') invalid.params[f.field] = 'another-interaction';
      if (mismatch === 'missing identity') delete invalid.params[f.field];
      if (mismatch === 'type') invalid.method = kind === 'question' ? 'approval/resolved' : 'question/resolved';
      if (mismatch === 'turn') invalid.params.turnId = 'previous-turn';
      if (mismatch === 'thread') invalid.params.threadId = 'another-thread';
      if (mismatch === 'epoch') invalid.params.appServerEpoch = 'previous-epoch';
      if (mismatch === 'missing epoch') delete invalid.params.appServerEpoch;
      if (mismatch === 'missing reason') delete invalid.params.reason;
      if (mismatch === 'invalid reason') invalid.params.reason = { status: 'client_response' };
      if (mismatch === 'invalid decision') invalid.params.decision = 'unknown';
      const delivered = [f.owner.messages.length, f.viewer.messages.length];
      f.broker.routeServerMessage(invalid);
      assert.equal(f.broker.serverRequests.get(f.request.id), f.owner, 'the original request must remain pending');
      assert.deepEqual([f.owner.messages.length, f.viewer.messages.length], delivered,
        'mismatched terminal notifications cannot close client cards');
      const lateViewer = f.join();
      assert.deepEqual(lateViewer.messages.at(-1), f.request, 'a late viewer must see the original pending question');
      const before = f.upstream.length;
      f.reply();
      assert.equal(f.upstream.length, before + 1, 'the original client can still answer exactly once');
      f.broker.routeServerMessage(f.receipt);
      f.reply();
      assert.equal(f.upstream.length, before + 1, 'late replies must read the terminal receipt without resending');
      assert.deepEqual(f.owner.messages.at(-1), f.receipt);
      assert.deepEqual(f.viewer.messages.at(-1), f.receipt);
    });
  }

  test(`${kind}: duplicate terminal delivery preserves the first bound receipt`, t => {
    const f = fixture(t, kind);
    f.reply();
    f.broker.routeServerMessage(f.receipt);
    const delivered = [f.owner.messages.length, f.viewer.messages.length];
    const repeated = { ...f.receipt, params: { ...f.receipt.params, reason: 'cancelled',
      ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
    f.broker.routeServerMessage(repeated);
    assert.deepEqual([f.owner.messages.length, f.viewer.messages.length], delivered,
      'a duplicate must not replace the original terminal event');
    const before = f.upstream.length;
    f.reply();
    assert.equal(f.upstream.length, before);
    assert.deepEqual(f.owner.messages.at(-1), f.receipt, 'late replies replay the original terminal authority');
  });

  test(`${kind}: original receipts without an epoch remain compatible`, t => {
    const f = fixture(t, kind, null);
    f.reply();
    f.broker.routeServerMessage(f.receipt);
    f.reply();
    assert.deepEqual(f.owner.messages.at(-1), f.receipt);
    assert.deepEqual(f.viewer.messages.at(-1), f.receipt);
  });
}

for (const kind of ['question', 'approval']) {
  test(`${kind}: malformed early receipt cannot suppress a later restored request`, t => {
    const f = fixture(t, kind);
    const request = { ...f.request, id: 900, params: { ...f.request.params, [f.field]: 'restored' } };
    const receipt = { ...f.receipt, params: { ...request.params, requestId: request.id,
      reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
    f.broker.routeServerMessage({ ...receipt, params: { ...receipt.params, reason: null } });
    f.broker.routeServerMessage(request);
    assert.deepEqual(f.owner.messages.at(-1), request, 'malformed receipt must not retire an unseen request ID');
    assert.equal(f.broker.serverRequests.get(request.id), f.owner);
    f.broker.routeServerMessage(receipt);
    assert.deepEqual(f.owner.messages.at(-1), receipt, 'the first valid original receipt still settles');
  });

  test(`${kind}: malformed restored receipts cannot fill a shared resume queue`, t => {
    const f = fixture(t, kind);
    const viewer = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    f.broker.attach(viewer);
    Object.assign(viewer, { initialized: true, gatewaySharedThreadsV1: true });
    f.broker.receive(viewer, JSON.stringify({ id: 42, method: 'thread/resume', params: { threadId: 'thread' } }));
    const resume = f.upstream.at(-1);
    const receipt = { ...f.receipt, params: { ...f.receipt.params, requestId: 900, [f.field]: 'restored' } };
    // No local pending request exists for this restored receipt. Distinct bad
    // frames must be rejected before they spend the 64-frame recovery budget.
    for (let index = 0; index < 66; index++)
      f.broker.routeServerMessage({ ...receipt, params: { ...receipt.params, reason: index } });
    f.broker.routeServerMessage(receipt);
    f.broker.routeServerMessage({ id: resume.id, result: { thread: { id: 'thread' } } });
    assert.ok(viewer.messages[0]?.result?.thread, 'invalid outcomes cannot turn resume into a handoff overflow');
    assert.deepEqual(viewer.messages.filter(message => message.method === `${kind}/resolved`), [receipt]);
    assert.equal(f.upstream.filter(message => message.method === 'turn/start').length, 0);
  });
}
