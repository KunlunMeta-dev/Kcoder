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
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: true,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params = { threadId: 'thread' }) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const resume = () => {
    const client = { channel: 'runtime', messages: [], closes: 0,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {},
      close() { this.closes++; } };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  return { broker, upstream, emit, send, resume };
}

for (const failureAt of [1, 2]) {
  test(`question update replay stops after write ${failureAt} disconnects its client`, t => {
    const f = fixture(t), owner = f.resume();
    owner.finish();
    f.emit({ id: f.send(owner.client, 'turn/start').id,
      result: { turn: { id: 'turn', threadId: 'thread', status: 'running' } } });
    const prompts = [500, 501].map(id => ({ id, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: `question-${id}`,
      questions: [{ id: 'item', prompt: `Continue ${id}?`, options: [] }],
    } }));
    for (const prompt of prompts) f.emit(prompt);
    const recovering = f.resume();
    // Distinct hints survive the resume buffer's per-question coalescing.
    for (const questionId of ['async-1', 'async-2', 'async-3']) f.emit({ method: 'asyncQuestion/changed', params: {
      threadId: 'thread', question: { threadId: 'thread', questionId, revision: 1 },
    } });
    let attempts = 0;
    const originalSend = recovering.client.send;
    recovering.client.send = function (message) {
      if (message.method === 'asyncQuestion/changed' && ++attempts === failureAt)
        throw new Error('recovering socket closed');
      return originalSend.call(this, message);
    };
    recovering.finish();
    assert.equal(f.broker.closed, false);
    assert.equal(f.broker.clients.has(recovering.client), false);
    assert.equal(f.broker.sharedThreads.has('thread', recovering.client), false);
    for (const prompt of prompts) {
      assert.equal(f.broker.sharedInteractions.canRead(recovering.client,
        { threadId: 'thread', requestId: prompt.id }), false,
      'later replay entries cannot restore the detached client as a question recipient');
      assert.equal(f.broker.serverRequests.get(prompt.id), owner.client);
    }
    assert.equal(attempts, failureAt, 'stop writing replay frames once the client detaches');
    assert.equal(recovering.client.closes, 1);
    assert.equal(owner.client.closes, 0);
    assert.equal(f.broker.activeTurns.get('thread')?.owner, owner.client);
    const replacement = f.resume(); replacement.finish();
    assert.deepEqual(replacement.client.messages.filter(message => message.method === 'question/request'), prompts);
    f.broker.receive(owner.client, JSON.stringify({ id: prompts[1].id,
      result: { answers: { item: { answers: ['original answer'] } } } }));
    assert.equal(f.upstream.filter(message => message.id === prompts[1].id && message.result).length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
  });
}
