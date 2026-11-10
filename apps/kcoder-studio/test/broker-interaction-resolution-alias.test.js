import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, kind, shared = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', [field]: 'original', appServerEpoch: 'epoch',
  } };
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}),
  } };
  const answer = client => broker.receive(client, JSON.stringify({ id: request.id,
    result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
  return { broker, upstream, emit, resume, request, receipt, answer };
}

const conflicts = [
  { thread_id: 'peer' }, { thread: { id: 'peer' } },
  { turn: { id: 'turn', threadId: 'peer' } }, { turn_id: 'other-turn' },
  { turn_id: false },
];

for (const kind of ['question', 'approval']) {
  for (const conflict of conflicts) {
    test(`${kind}: terminal alias ${JSON.stringify(conflict)} preserves the live original input`, t => {
      const f = fixture(t, kind), owner = f.resume(); owner.finish();
      const viewer = f.resume(); viewer.finish();
      f.emit(f.request);
      const counts = [owner.client.messages.length, viewer.client.messages.length];
      f.emit({ ...f.receipt, params: { ...f.receipt.params, ...conflict } });
      assert.equal(f.broker.serverRequests.get(f.request.id), owner.client,
        'an ambiguous terminal must not consume the original waiter');
      assert.deepEqual([owner.client.messages.length, viewer.client.messages.length], counts);
      const late = f.resume(); late.finish();
      assert.deepEqual(late.client.messages.at(-1), f.request, 'refresh restores the original card');
      const writes = f.upstream.length;
      f.answer(owner.client);
      assert.equal(f.upstream.length, writes + 1, 'the original owner can still answer once');
      f.emit(f.receipt);
      f.answer(owner.client);
      assert.equal(f.upstream.length, writes + 1, 'late answers read the authoritative receipt');
      assert.deepEqual(owner.client.messages.at(-1), f.receipt);
      assert.deepEqual(viewer.client.messages.at(-1), f.receipt);
    });

    test(`${kind}: early terminal alias ${JSON.stringify(conflict)} cannot retire a restored request`, t => {
      const f = fixture(t, kind), owner = f.resume(); owner.finish();
      f.emit({ ...f.receipt, params: { ...f.receipt.params, ...conflict } });
      f.emit(f.request);
      assert.equal(f.broker.serverRequests.get(f.request.id), owner.client);
      assert.deepEqual(owner.client.messages.at(-1), f.request);
      f.emit(f.receipt);
      assert.deepEqual(owner.client.messages.at(-1), f.receipt);
    });
  }

  for (const shared of [false, true]) {
    test(`${kind}: ambiguous terminals cannot exhaust ${shared ? 'shared' : 'exclusive'} refresh capacity`, t => {
      const f = fixture(t, kind, shared);
      const owner = shared ? f.resume() : null; owner?.finish();
      const recovering = f.resume();
      // Unique receipts exercise real queue capacity rather than duplicate coalescing.
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
        f.emit({ ...f.receipt, params: { ...f.receipt.params, requestId: 900 + index, thread_id: 'peer' } });
      f.emit(f.receipt);
      recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread,
        'invalid aliases must not cause a successful upstream resume to overflow');
      assert.deepEqual(recovering.client.messages.slice(1), [f.receipt]);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'refresh never manufactures or replays an answer');
    });
  }

  test(`${kind}: matching and nullable aliases preserve terminal compatibility`, t => {
    const f = fixture(t, kind), owner = f.resume(); owner.finish();
    f.emit(f.request);
    const receipt = { ...f.receipt, params: { ...f.receipt.params,
      thread_id: 'thread', thread: { id: 'thread', threadId: 'thread' },
      widget: { threadId: null }, turn_id: null, turn: { id: 'turn', turnId: 'turn', threadId: 'thread' },
    } };
    f.emit(receipt);
    assert.equal(f.broker.serverRequests.has(f.request.id), false);
    f.answer(owner.client);
    assert.deepEqual(owner.client.messages.at(-1), receipt);
  });
}
