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
  const join = failMethod => {
    const client = { channel: 'runtime', messages: [], closes: 0,
      send(message) {
        if (failMethod && message.method === failMethod) throw new Error('viewer socket write failed');
        this.messages.push(message);
        return true;
      }, pause() {}, resume() {}, close() { this.closes++; } };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    emit({ id: send(client, 'thread/resume').id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, send, join };
}

function prompt(kind) {
  return { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original-input',
    ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
      : { availableDecisions: ['accept', 'decline'] }),
  } };
}

for (const kind of ['question', 'approval']) {
  test(`failed ${kind} viewer cannot suppress the original card or another viewer`, t => {
    const f = fixture(t), owner = f.join(), failed = f.join(`${kind}/request`), healthy = f.join();
    f.emit({ id: f.send(owner, 'turn/start').id,
      result: { turn: { id: 'turn', threadId: 'thread', status: 'running' } } });
    const request = prompt(kind);
    f.emit(request);
    assert.equal(f.broker.closed, false, 'a viewer write failure cannot fail shared stdout');
    assert.deepEqual(owner.messages.at(-1), request);
    assert.deepEqual(healthy.messages.at(-1), request);
    assert.equal(f.broker.clients.has(failed), false);
    assert.equal(f.broker.sharedThreads.has('thread', failed), false);
    assert.equal(failed.closes, 1);
    assert.equal(owner.closes + healthy.closes, 0);
    assert.equal(f.broker.serverRequests.get(request.id), owner);
    assert.equal(f.broker.activeTurns.get('thread')?.owner, owner);
    const answer = kind === 'question' ? { answers: { item: { answers: ['original answer'] } } }
      : { decision: 'accept' };
    f.broker.receive(healthy, JSON.stringify({ id: request.id, result: answer }));
    assert.equal(healthy.messages.at(-1).params.reason, 'not_original_client');
    assert.equal(f.upstream.some(message => message.id === request.id), false);
    f.broker.receive(owner, JSON.stringify({ id: request.id, result: answer }));
    assert.equal(f.upstream.filter(message => message.id === request.id && message.result).length, 1);
    f.emit({ method: `${kind}/resolved`, params: { ...request.params, requestId: request.id, reason: 'answered',
      ...(kind === 'approval' ? { decision: 'accept' } : {}) } });
    assert.equal(owner.messages.at(-1).method, `${kind}/resolved`);
    assert.equal(healthy.messages.at(-1).method, `${kind}/resolved`);
    assert.equal(f.broker.serverRequests.has(request.id), false);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });

  test(`failed ${kind} replay detaches only the recovering viewer`, t => {
    const f = fixture(t), owner = f.join(), healthy = f.join();
    const request = prompt(kind);
    f.emit(request);
    const failed = f.join(`${kind}/request`);
    assert.equal(f.broker.closed, false, 'replaying a card cannot fail the original task transport');
    assert.equal(failed.closes, 1);
    assert.equal(f.broker.clients.has(failed), false);
    assert.equal(f.broker.sharedThreads.has('thread', failed), false);
    assert.equal(f.broker.sharedInteractions.canRead(failed, { threadId: 'thread', requestId: request.id }), false);
    assert.equal(f.broker.serverRequests.get(request.id), owner);
    const recovered = f.join();
    assert.deepEqual(recovered.messages.at(-1), request, 'a healthy reconnect still receives the pending original card');
    assert.equal(owner.closes + healthy.closes + recovered.closes, 0);
  });

  test(`${kind} card backpressure preserves viewer membership for live delivery and replay`, t => {
    const f = fixture(t), owner = f.join(), viewer = f.join();
    viewer.send = function (message) { this.messages.push(message); return false; };
    const request = prompt(kind);
    f.emit(request);
    assert.deepEqual(viewer.messages.at(-1), request);
    // Only the card write is backpressured; the resume response was queued.
    const recovered = f.join();
    recovered.send = function (message) { this.messages.push(message); return false; };
    f.broker.sharedInteractions.replay('thread', recovered);
    assert.deepEqual(recovered.messages.at(-1), request);
    for (const client of [viewer, recovered]) {
      assert.equal(client.closes, 0);
      assert.equal(f.broker.sharedThreads.has('thread', client), true);
      assert.equal(f.broker.sharedInteractions.canRead(client, { threadId: 'thread', requestId: request.id }), true);
    }
    assert.equal(f.broker.serverRequests.get(request.id), owner);
    assert.equal(f.broker.closed, false);
  });
}
