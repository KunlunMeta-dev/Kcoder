import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const client = () => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    return value;
  };
  const send = (peer, method, params = { threadId: 'thread' }) => {
    const before = upstream.length;
    broker.receive(peer, JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }));
    return upstream.length > before ? upstream.at(-1) : null;
  };
  const finishResume = (request, rejected = false) => child.stdout.write(`${JSON.stringify({ id: request.id,
    ...(rejected ? { error: { code: -32022, message: 'Resume rejected' } } : { result: { thread: { id: 'thread' } } }),
  })}\n`);
  return { broker, client, send, finishResume, upstream };
}

const operations = {
  'asyncQuestion/list': { threadId: 'thread', includeTerminal: true },
  'asyncQuestion/answer': { threadId: 'thread', questionId: 'question', submissionId: 'submission',
    expectedRevision: 1, answers: { item: { text: 'original answer' } } },
  'asyncQuestion/cancel': { threadId: 'thread', questionId: 'question', expectedRevision: 1 },
};

for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  for (const [method, params] of Object.entries(operations)) {
    for (const state of ['never resumed', 'owner disconnected', 'resume pending', 'resume rejected']) {
      test(`${mode}: ${method} requires a confirmed task binding after ${state}`, t => {
        const f = fixture(t, shared), peer = f.client();
        if (state === 'owner disconnected') {
          const original = f.client();
          f.finishResume(f.send(original, 'thread/resume'));
          f.broker.detach(original);
          assert.equal(f.broker.threadOwners.has('thread'), false);
        } else if (state.startsWith('resume ')) {
          const resume = f.send(peer, 'thread/resume');
          if (state === 'resume rejected') f.finishResume(resume, true);
        }
        const before = f.upstream.length;
        assert.equal(f.send(peer, method, params), null,
          'unbound question reads and mutations must never reach the shared backend');
        assert.equal(f.upstream.length, before);
        assert.equal(peer.messages.at(-1).error?.code, -32023);
        assert.match(peer.messages.at(-1).error.message, /resumed/);
        assert.equal(f.broker.activeTurns.size, 0);
        assert.equal(f.broker.threadDrains.size, 0);
      });
    }

    test(`${mode}: a confirmed original task binding admits ${method} after reconnect`, t => {
      const f = fixture(t, shared), original = f.client();
      f.finishResume(f.send(original, 'thread/resume'));
      f.broker.detach(original);
      const replacement = f.client();
      f.finishResume(f.send(replacement, 'thread/resume'));
      const request = f.send(replacement, method, params);
      assert.equal(request?.method, method);
      assert.equal(request.params.threadId, 'thread');
      assert.equal(f.broker.threadOwners.get('thread'), replacement);
    });
  }

  test(`${mode}: successful creation binds question operations without an extra resume`, t => {
    const f = fixture(t, shared), owner = f.client();
    const created = f.send(owner, 'thread/start', {});
    f.finishResume(created);
    for (const [method, params] of Object.entries(operations))
      assert.equal(f.send(owner, method, params)?.method, method);
    assert.equal(f.upstream.filter(message => message.method === 'thread/resume').length, 0);
  });

  test(`${mode}: owning one task does not bind an unclaimed second task`, t => {
    const f = fixture(t, shared), owner = f.client();
    f.finishResume(f.send(owner, 'thread/resume'));
    f.broker.activeTurns.set('thread', { turnId: 'original-turn', owner });
    const before = f.upstream.length;
    for (const [method, params] of Object.entries(operations)) {
      assert.equal(f.send(owner, method, { ...params, threadId: 'other-thread' }), null);
      assert.equal(owner.messages.at(-1).error?.code, -32023);
    }
    assert.equal(f.upstream.length, before);
    assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'original-turn', owner });
    assert.equal(f.broker.threadOwners.has('other-thread'), false);
  });

  if (shared) test('a confirmed shared viewer can read, answer and cancel without taking its peer turn', t => {
    const f = fixture(t, shared), owner = f.client(), viewer = f.client();
    f.finishResume(f.send(owner, 'thread/resume'));
    f.finishResume(f.send(viewer, 'thread/resume'));
    f.broker.activeTurns.set('thread', { turnId: 'peer-turn', owner });
    for (const [method, params] of Object.entries(operations))
      assert.equal(f.send(viewer, method, params)?.method, method);
    assert.equal(f.broker.activeTurns.get('thread').owner, owner);
    assert.equal(f.broker.threadOwners.get('thread'), owner);
  });
}

for (const delivery of ['backpressure', 'throw']) {
  for (const originalConnected of [false, true]) {
    test(`failed shared resume (${delivery}, original connected=${originalConnected}) cannot bind question operations`, t => {
      const f = fixture(t, true), original = f.client(), viewer = f.client();
      // Invoke routing directly: a throwing data listener would also corrupt
      // the fixture PassThrough's write state, obscuring recovery assertions.
      const finish = request => f.broker.routeServerMessage({ id: request.id,
        result: { thread: { id: 'thread' } } });
      finish(f.send(original, 'thread/resume'));
      const resume = f.send(viewer, 'thread/resume');
      if (!originalConnected) f.broker.detach(original);
      const send = viewer.send;
      viewer.send = () => {
        if (delivery === 'throw') throw new Error('resume transport closed');
        return false;
      };
      if (delivery === 'throw') assert.throws(() => finish(resume), /resume transport closed/);
      else finish(resume);
      viewer.send = send;
      assert.equal(f.broker.threadOwners.get('thread'), originalConnected ? original : undefined,
        'an undelivered resume cannot become the replacement task owner');
      assert.equal(f.broker.sharedThreads.has('thread', viewer), false,
        'an undelivered resume cannot leave a question reader or answerer attached');
      for (const [method, params] of Object.entries(operations)) {
        const before = f.upstream.length;
        assert.equal(f.send(viewer, method, params), null,
          'question operations require a successfully delivered resume');
        assert.equal(f.upstream.length, before);
        assert.equal(viewer.messages.at(-1).error?.code, -32023);
      }
      const notification = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
        question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
      const count = viewer.messages.length;
      f.broker.routeServerMessage(notification);
      assert.equal(viewer.messages.length, count, 'failed recovery must not receive live question content');
      if (originalConnected) assert.deepEqual(original.messages.at(-1), notification);
      finish(f.send(viewer, 'thread/resume'));
      for (const [method, params] of Object.entries(operations))
        assert.equal(f.send(viewer, method, params)?.method, method, 'explicit recovery restores question access');
      assert.equal(f.broker.threadOwners.get('thread'), originalConnected ? original : viewer);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
    });
  }
}
