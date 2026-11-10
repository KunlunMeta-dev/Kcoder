import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    sessionLifetimeV1: true, asyncUserQuestionsV1: true,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join();
  // Admission can produce an interaction before its answer receipt establishes
  // an active turn. The original client has already left by then.
  broker.receive(owner, JSON.stringify({ id: ++sequence, method: 'asyncQuestion/answer', params: {
    threadId: 'thread', questionId: 'async-question', submissionId: 'submission', expectedRevision: 1,
    answers: { item: { text: 'original answer' } },
  } }));
  assert.equal(upstream.at(-1).method, 'asyncQuestion/answer');
  broker.detach(owner);
  assert.equal(broker.threadOwners.has('thread'), false);
  assert.equal(broker.activeTurns.size, 0);
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'answer-turn', appServerEpoch: 'epoch', [field]: 'original-interaction',
  } };
  emit(request);
  assert.equal(upstream.at(-1).id, request.id);
  assert.equal(upstream.at(-1).error.code, -32040);
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'cancelled', ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
  return { broker, upstream, emit, join, request, receipt, field };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [true, false]) {
    const label = `${kind}: ${shared ? 'shared' : 'exclusive'} ownerless refusal`;
    test(`${label} responds to duplicate transport frames only once`, t => {
      const f = fixture(t, kind, shared), sent = f.upstream.length;
      f.emit(f.request);
      assert.equal(f.upstream.length, sent, 'a refused waiter must not receive another response');
    });

    test(`${label} cannot reopen on a reconnected device`, t => {
      const f = fixture(t, kind, shared), late = f.join(), delivered = late.messages.length;
      f.emit(f.request);
      assert.equal(late.messages.length, delivered, 'a new client cannot inherit the refused question');
      assert.equal(f.broker.serverRequests.has(f.request.id), false);
      const fresh = { ...f.request, id: 501, params: { ...f.request.params, [f.field]: 'fresh-interaction' } };
      f.emit(fresh);
      assert.deepEqual(late.messages.at(-1), fresh, 'new interactions remain available');
    });

    test(`${label} retains its original terminal receipt binding`, t => {
      const f = fixture(t, kind, shared), late = f.join(), delivered = late.messages.length;
      for (const change of [{ [f.field]: 'wrong' }, { turnId: 'wrong' }, { appServerEpoch: 'wrong' }])
        f.emit({ ...f.receipt, params: { ...f.receipt.params, ...change } });
      assert.equal(late.messages.length, delivered, 'a mismatched terminal cannot settle the refused ID');
      f.emit(f.receipt);
      assert.deepEqual(late.messages.at(-1), f.receipt, 'the authoritative outcome stays observable');
    });
  }
}
