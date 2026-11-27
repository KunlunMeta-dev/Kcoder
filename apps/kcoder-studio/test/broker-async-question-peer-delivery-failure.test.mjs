import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const send = (client, method, params = { threadId: 'thread' }) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    assert.equal(upstream.at(-1).method, method);
    return upstream.at(-1);
  };
  const join = () => {
    const client = { channel: 'runtime', messages: [], closes: 0,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {},
      close() { this.closes++; } };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    emit({ id: send(client, 'thread/resume').id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, send, join };
}

const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
  question: { threadId: 'thread', questionId: 'async-question', revision: 1 } } };

function assertViewerFailureIsolated(t, closeFails) {
  const f = fixture(t), owner = f.join(), failed = f.join(), healthy = f.join();
  f.emit({ id: f.send(owner, 'turn/start').id,
    result: { turn: { id: 'turn', threadId: 'thread', status: 'running' } } });
  const prompt = { id: 500, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: 'original-question',
    questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
  } };
  f.emit(prompt);
  const originalSend = failed.send;
  failed.send = function (message) {
    if (message.method === 'asyncQuestion/changed') throw new Error('viewer socket write failed');
    return originalSend.call(this, message);
  };
  if (closeFails) failed.close = function () {
    this.closes++;
    throw new Error('viewer socket close failed');
  };

  f.emit(changed);
  assert.equal(f.broker.closed, false, 'one socket failure must not fail the shared app-server transport');
  assert.deepEqual(owner.messages.at(-1), changed, 'the original owner must receive the question update');
  assert.deepEqual(healthy.messages.at(-1), changed, 'later viewers must still receive the same update');
  assert.equal(failed.closes, 1);
  assert.equal(f.broker.clients.has(failed), false);
  assert.equal(f.broker.sharedThreads.has('thread', failed), false);
  assert.equal(f.broker.threadOwners.get('thread'), owner);
  assert.equal(f.broker.activeTurns.get('thread')?.owner, owner);
  assert.equal(f.broker.serverRequests.get(prompt.id), owner);
  assert.equal(owner.closes + healthy.closes, 0);
  f.broker.receive(owner, JSON.stringify({ id: prompt.id,
    result: { answers: { item: { answers: ['original answer'] } } } }));
  assert.equal(f.upstream.filter(message => message.id === prompt.id && message.result).length, 1);
  assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  f.emit({ ...changed, params: { ...changed.params, question: { ...changed.params.question, revision: 2 } } });
  assert.equal(owner.messages.at(-1).params.question.revision, 2);
  assert.equal(healthy.messages.at(-1).params.question.revision, 2);
  const recovered = f.join();
  const read = f.send(recovered, 'asyncQuestion/list');
  f.emit({ id: read.id, result: { threadId: 'thread', questions: [changed.params.question] } });
  assert.deepEqual(recovered.messages.at(-1).result.questions, [changed.params.question]);
  assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false,
    'the failed viewer recovers by reading the original task, never by replaying an answer');
}

test('a failed viewer cannot disconnect the original question owner or suppress another viewer',
  t => assertViewerFailureIsolated(t, false));
test('a failed viewer whose close throws cannot abort shared question delivery',
  t => assertViewerFailureIsolated(t, true));

test('a queued question update under viewer backpressure keeps its membership and answer authority', t => {
  const f = fixture(t), owner = f.join(), viewer = f.join();
  viewer.sendWithQueueStatus = function (message) {
    this.messages.push(message);
    return { queued: true, writable: false };
  };
  f.emit(changed);
  assert.deepEqual(viewer.messages.at(-1), changed);
  assert.deepEqual(owner.messages.at(-1), changed);
  assert.equal(f.broker.closed, false);
  assert.equal(f.broker.sharedThreads.has('thread', viewer), true);
  assert.equal(viewer.closes, 0);
  assert.equal(f.send(viewer, 'asyncQuestion/list').method, 'asyncQuestion/list');
});

for (const role of ['owner', 'viewer']) {
  test(`an unqueued question update releases only the failed ${role} socket`, t => {
    const f = fixture(t), owner = f.join(), viewer = f.join();
    const [failed, healthy] = role === 'owner' ? [owner, viewer] : [viewer, owner];
    failed.sendWithQueueStatus = () => ({ queued: false, writable: false });

    f.emit(changed);
    assert.deepEqual(healthy.messages.at(-1), changed);
    assert.equal(f.broker.closed, false);
    assert.equal(f.broker.clients.has(failed), false);
    assert.equal(f.broker.sharedThreads.has('thread', failed), false);
    assert.equal(failed.closes, 1);
    assert.equal(f.broker.threadOwners.get('thread'), healthy);

    const recovered = f.join();
    const list = f.send(recovered, 'asyncQuestion/list');
    f.emit({ id: list.id, result: { threadId: 'thread', questions: [changed.params.question] } });
    assert.deepEqual(recovered.messages.at(-1).result?.questions, [changed.params.question]);
    assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
  });
}

test('a failed question owner whose close throws leaves the original task readable by a peer', t => {
  const f = fixture(t), owner = f.join(), viewer = f.join();
  owner.send = function (message) {
    if (message.method === 'asyncQuestion/changed') throw new Error('owner socket write failed');
    this.messages.push(message);
    return true;
  };
  owner.close = function () {
    this.closes++;
    throw new Error('owner socket close failed');
  };

  f.emit(changed);
  assert.equal(f.broker.closed, false, 'closing one failed socket must not close shared stdout');
  assert.equal(owner.closes, 1);
  assert.equal(f.broker.clients.has(owner), false);
  assert.equal(f.broker.clients.has(viewer), true);
  assert.equal(f.broker.threadOwners.get('thread'), viewer);
  assert.deepEqual(viewer.messages.at(-1), changed);

  const list = f.send(viewer, 'asyncQuestion/list');
  f.emit({ id: list.id, result: { threadId: 'thread', questions: [changed.params.question] } });
  assert.deepEqual(viewer.messages.at(-1).result?.questions, [changed.params.question]);
  assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
});
