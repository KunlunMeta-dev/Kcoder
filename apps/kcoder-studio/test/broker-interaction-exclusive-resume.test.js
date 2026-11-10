import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, kind, resolved = false) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => {
    const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
  };
  const client = () => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value); value.initialized = true;
    return value;
  };
  const resume = value => {
    const before = upstream.length;
    broker.receive(value, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
    assert.equal(upstream.length, before + 1);
    const request = upstream.at(-1);
    return () => emit({ id: request.id, result: { thread: { id: 'thread' } } });
  };
  const owner = client(); resume(owner)();
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'original-turn', [field]: 'interaction', appServerEpoch: 'epoch',
  } };
  emit(request);
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  if (resolved) emit(receipt);
  broker.detach(owner);
  const viewer = client(), finish = resume(viewer);
  return { broker, upstream, emit, viewer, finish, field, receipt };
}

for (const kind of ['question', 'approval']) {
  test(`exclusive ${kind} resume preserves recovery receipts without a local request`, t => {
    const f = fixture(t, kind);
    const restored = { ...f.receipt, params: { ...f.receipt.params,
      requestId: 900, [f.field]: 'restored-interaction' } };
    f.emit(restored);
    f.finish();
    assert.ok(f.viewer.messages[0]?.result?.thread);
    assert.deepEqual(f.viewer.messages.slice(1), [restored]);
  });

  for (const mismatch of ['identity', 'turn', 'epoch', 'missing epoch', 'type', 'already resolved']) {
    test(`exclusive ${kind} resume: ${mismatch} receipts cannot block recovery`, t => {
      const f = fixture(t, kind, mismatch === 'already resolved');
      const invalid = structuredClone(f.receipt);
      if (mismatch === 'identity') invalid.params[f.field] = 'foreign-interaction';
      if (mismatch === 'turn') invalid.params.turnId = 'foreign-turn';
      if (mismatch === 'epoch') invalid.params.appServerEpoch = 'foreign-epoch';
      if (mismatch === 'missing epoch') delete invalid.params.appServerEpoch;
      if (mismatch === 'type') invalid.method = kind === 'question' ? 'approval/resolved' : 'question/resolved';
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++) f.emit(invalid);
      const progress = { method: 'item/delta', params: { threadId: 'thread', turnId: 'original-turn', delta: { text: 'progress' } } };
      f.emit(progress);
      if (mismatch !== 'already resolved') f.emit(f.receipt);
      assert.equal(f.viewer.messages.length, 0, 'the new connection must wait for its resume receipt');
      f.finish();
      assert.ok(f.viewer.messages[0]?.result?.thread,
        'ineligible receipts must not turn a successful backend resume into -32047');
      assert.deepEqual(f.viewer.messages.slice(1), mismatch === 'already resolved' ? [progress] : [progress, f.receipt]);
      assert.equal(f.broker.threadOwners.get('thread'), f.viewer);
      assert.equal(f.viewer.messages.some(message => message.method === `${kind}/request`), false,
        'recovery cannot transfer the disconnected owner\'s input authority');
      assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'asyncQuestion/cancel', 'turn/start'].includes(message.method)), false);
    });
  }
}

for (const kind of ['question', 'approval']) {
  for (const restored of [false, true]) {
    test(`exclusive ${kind} resume: repeated valid ${restored ? 'restored' : 'retired'} receipts leave room for progress`, t => {
      const f = fixture(t, kind);
      const receipt = restored ? { ...f.receipt, params: { ...f.receipt.params,
        requestId: 900, [f.field]: 'restored-interaction' } } : f.receipt;
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
        f.emit(structuredClone(receipt));
      const progress = { method: 'item/delta', params: {
        threadId: 'thread', turnId: 'original-turn', delta: { text: 'progress' } } };
      f.emit(progress);
      assert.equal(f.viewer.messages.length, 0, 'delivery waits for the original resume receipt');
      f.finish();
      assert.ok(f.viewer.messages[0]?.result?.thread,
        'duplicate terminal receipts must not turn a successful resume into -32047');
      assert.deepEqual(f.viewer.messages.slice(1), [receipt, progress]);
      assert.equal(f.broker.threadOwners.get('thread'), f.viewer);
      assert.equal(f.viewer.messages.some(message => message.method === `${kind}/request`), false,
        'deduplication does not transfer the disconnected owner input authority');
      assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'asyncQuestion/cancel', 'turn/start'].includes(message.method)), false);
    });
  }
}

for (const kind of ['question', 'approval']) {
  for (const restored of [false, true]) {
    test(`exclusive ${kind} resume: the first ${restored ? 'restored' : 'retired'} terminal outcome fences conflicting replays`, t => {
      const f = fixture(t, kind);
      const writes = f.upstream.length;
      const receipt = restored ? { ...f.receipt, params: { ...f.receipt.params,
        requestId: 900, [f.field]: 'restored-interaction' } } : f.receipt;
      f.emit(receipt);
      // Each replay has a different valid outcome. The first authoritative
      // receipt must settle before these frames reserve recovery capacity.
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
        f.emit({ ...receipt, params: { ...receipt.params, reason: `replayed-${index}`,
          ...(kind === 'approval' ? { decision: 'decline' } : {}) } });
      const progress = { method: 'item/delta', params: {
        threadId: 'thread', turnId: 'original-turn', delta: { text: 'progress' } } };
      f.emit(progress);
      assert.equal(f.viewer.messages.length, 0, 'delivery waits for the original resume receipt');
      f.finish();
      assert.ok(f.viewer.messages[0]?.result?.thread,
        'conflicting terminal replays cannot exhaust recovery and fail the task refresh');
      assert.deepEqual(f.viewer.messages.slice(1), [receipt, progress],
        'the first outcome reaches the restored client exactly once before progress');
      const delivered = f.viewer.messages.length;
      f.emit({ id: receipt.params.requestId, method: `${kind}/request`, params: {
        threadId: 'thread', turnId: 'original-turn', [f.field]: receipt.params[f.field], appServerEpoch: 'epoch',
      } });
      f.emit({ ...receipt, params: { ...receipt.params, reason: 'cancelled' } });
      assert.equal(f.viewer.messages.length, delivered, 'the original card stays terminal after handoff');
      assert.equal(f.broker.serverRequests.has(receipt.params.requestId), false);
      assert.equal(f.upstream.length, writes,
        'recovery never submits answers, cancels questions or replays task input');
    });
  }
}
