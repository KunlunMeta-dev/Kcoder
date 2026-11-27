import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, lifetime, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    sessionLifetimeV1: lifetime, asyncUserQuestionsV1: true,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const join = threadId => {
    const client = { channel: 'runtime', messages: [], closes: 0,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {},
      close() { this.closes++; } };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    emit({ id: send(client, 'thread/resume', { threadId }).id, result: { thread: { id: threadId } } });
    return client;
  };
  const start = (client, threadId) => emit({ id: send(client, 'turn/start', { threadId }).id,
    result: { turn: { id: `${threadId}-turn`, threadId, status: 'running' } } });
  return { broker, upstream, emit, join, start };
}

for (const method of ['asyncQuestion/changed', 'question/resolved', 'approval/resolved', 'turn/completed']) {
  for (const lifetime of [false, true]) {
    for (const fails of [true, false]) {
      test(`owner notification ${method} ${fails ? 'write failure' : 'backpressure'} (lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime, true), owner = f.join('thread'), viewer = f.join('thread'), peer = f.join('peer');
        f.start(owner, 'thread'); f.start(peer, 'peer');
        const peerPrompt = prompt('question', 501, 'peer');
        f.emit(peerPrompt);
        const request = prompt(method.startsWith('approval/') ? 'approval' : 'question', 500, 'thread');
        f.emit(request);
        const notification = { method, params: method === 'asyncQuestion/changed'
          ? { threadId: 'thread', question: { threadId: 'thread', questionId: 'async-input', revision: 1 } }
          : { ...request.params, requestId: request.id, reason: 'answered',
            ...(method === 'approval/resolved' ? { decision: 'accept' } : {}) } };
        const originalSend = owner.send;
        owner.send = function (message) {
          if (message.method === method) {
            if (fails) throw new Error('original owner notification socket write failed');
            this.messages.push(message);
            return false;
          }
          return originalSend.call(this, message);
        };
        f.emit(notification);
        assert.equal(f.broker.closed, false, 'an owner notification failure cannot close the shared transport');
        assert.deepEqual(viewer.messages.at(-1), notification);
        assert.equal(f.broker.clients.has(owner), !fails);
        assert.equal(owner.closes, fails ? 1 : 0);
        assert.equal(viewer.closes + peer.closes, 0);
        assert.equal(f.broker.activeTurns.get('peer')?.owner, peer);
        assert.equal(f.broker.serverRequests.get(peerPrompt.id), peer);
        assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
          fails && !lifetime && method !== 'turn/completed' ? [{ threadId: 'thread', turnId: 'thread-turn' }] : []);
        f.broker.receive(peer, JSON.stringify({ id: peerPrompt.id,
          result: { answers: { item: { answers: ['peer answer'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === peerPrompt.id && message.result).length, 1);
        if (!fails) assert.deepEqual(owner.messages.at(-1), notification);
      });
    }
  }
}

function prompt(kind, id, threadId) {
  return { id, method: `${kind}/request`, params: {
    threadId, turnId: `${threadId}-turn`, [`${kind}Id`]: `${threadId}-input`,
    ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
      : { availableDecisions: ['accept', 'decline'] }),
  } };
}

for (const kind of ['question', 'approval']) {
  for (const lifetime of [false, true]) {
    for (const shared of [false, true]) {
      for (const fails of [true, false]) {
        test(`${kind} owner ${fails ? 'write failure' : 'backpressure'} (lifetime=${lifetime}, shared=${shared})`, t => {
          const f = fixture(t, lifetime, shared), owner = f.join('thread');
          const viewer = shared ? f.join('thread') : null, peer = f.join('peer');
          f.start(owner, 'thread'); f.start(peer, 'peer');
          const peerPrompt = prompt('question', 501, 'peer');
          f.emit(peerPrompt);
          const request = prompt(kind, 500, 'thread');
          owner.send = function (message) {
            if (message.method === request.method) {
              if (fails) throw new Error('original owner socket write failed');
              this.messages.push(message);
              return false;
            }
            this.messages.push(message);
            return true;
          };
          f.emit(request);

          assert.equal(f.broker.closed, false, 'a failed original answer socket must not fail shared stdout');
          assert.equal(owner.closes, fails ? 1 : 0);
          assert.equal(f.broker.clients.has(owner), !fails);
          assert.equal(peer.closes + (viewer?.closes ?? 0), 0);
          assert.equal(f.broker.threadOwners.get('peer'), peer);
          assert.equal(f.broker.activeTurns.get('peer')?.owner, peer);
          assert.equal(f.broker.serverRequests.get(peerPrompt.id), peer);
          assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
            fails && !lifetime ? [{ threadId: 'thread', turnId: 'thread-turn' }] : []);
          assert.equal(f.upstream.filter(message => message.id === request.id && message.error?.code === -32040).length,
            fails ? 1 : 0, 'only the failed owner settles its pending input as disconnected');
          if (viewer) assert.ok(viewer.messages.some(message => message.id === request.id));

          f.broker.receive(peer, JSON.stringify({ id: peerPrompt.id,
            result: { answers: { item: { answers: ['peer answer'] } } } }));
          assert.equal(f.upstream.filter(message => message.id === peerPrompt.id && message.result).length, 1);
          if (!fails) {
            assert.equal(f.broker.serverRequests.get(request.id), owner);
            assert.deepEqual(owner.messages.at(-1), request);
            f.broker.receive(owner, JSON.stringify({ id: request.id,
              result: kind === 'question' ? { answers: { item: { answers: ['original answer'] } } }
                : { decision: 'accept' } }));
            assert.equal(f.upstream.filter(message => message.id === request.id && message.result).length, 1);
            return;
          }

          // A delayed native receipt closes the original card; reconnect never reassigns its waiter.
          const receipt = { method: `${kind}/resolved`, params: { ...request.params,
            requestId: request.id, reason: 'client_disconnected' } };
          f.emit(receipt);
          if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
          if (!lifetime) {
            const interrupt = f.upstream.find(message => message.method === 'turn/interrupt');
            f.emit({ id: interrupt.id, result: {} });
            f.emit({ method: 'turn/interrupted', params: { threadId: 'thread', turnId: 'thread-turn' } });
          }
          const recovered = f.join('thread');
          const beforeReplay = recovered.messages.length;
          f.emit(request);
          assert.equal(recovered.messages.length, beforeReplay, 'the old input must not reopen after reconnect');
          assert.equal(f.upstream.filter(message => message.id === request.id).length, 1,
            'recovery does not replay the answer or duplicate its disconnect response');
          assert.equal(f.broker.closed, false);
        });
      }
    }
  }
}
