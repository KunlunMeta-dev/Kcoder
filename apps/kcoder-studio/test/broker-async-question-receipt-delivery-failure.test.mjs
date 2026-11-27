import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const saved = {
  threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
  answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'Saved answer' } } },
};

function fixture(t, lifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const send = (client, method, params = { threadId: 'thread' }) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const join = (threadId = 'thread') => {
    const client = { channel: 'runtime', messages: [], closes: 0,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {},
      close() { this.closes++; } };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    emit({ id: send(client, 'thread/resume', { threadId }).id, result: { thread: { id: threadId } } });
    return client;
  };
  return { broker, upstream, emit, send, join };
}

for (const lifetime of [false, true]) {
  for (const operation of ['list', 'answer', 'cancel']) {
    for (const delivery of ['write failure', 'write and close failure', 'socket not writable', 'backpressure', 'queued backpressure']) {
      const fails = !delivery.endsWith('backpressure');
      test(`${operation} receipt ${delivery} isolates its socket (lifetime=${lifetime})`, t => {
        const f = fixture(t, lifetime), original = f.join(), receiver = f.join(), peer = f.join('peer');
        f.emit({ id: f.send(peer, 'turn/start', { threadId: 'peer' }).id,
          result: { turn: { id: 'peer-turn', threadId: 'peer', status: 'running' } } });
        const prompt = { id: 500, method: 'question/request', params: {
          threadId: 'peer', turnId: 'peer-turn', questionId: 'peer-question',
          questions: [{ id: 'peer-item', prompt: 'Continue?', options: [] }],
        } };
        f.emit(prompt);
        const method = `asyncQuestion/${operation}`;
        const request = f.send(receiver, method, { threadId: 'thread', questionId: 'question',
          expectedRevision: 1, submissionId: 'submission', answers: saved.answer.answers });
        const result = operation === 'list' ? { threadId: 'thread', questions: [saved] }
          : operation === 'cancel' ? { threadId: 'thread', question: { ...saved, status: 'cancelled', revision: 3 } }
            : { threadId: 'thread', question: saved, accepted: true, duplicate: false,
              startedTurn: { id: 'answer-turn', threadId: 'thread', status: 'running' } };
        receiver.send = function (message) {
          if (fails) throw new Error('answer socket write failed');
          this.messages.push(message);
          return false;
        };
        if (delivery === 'socket not writable' || delivery === 'queued backpressure') {
          // Model the WebSocket bridge: both return false from send(), but only
          // one actually queued the response. Close may arrive later.
          const queued = delivery === 'queued backpressure';
          receiver.sendWithQueueStatus = function (message) {
            if (queued) this.messages.push(message);
            return { queued, writable: false };
          };
          receiver.send = message => receiver.sendWithQueueStatus(message).writable;
        }
        if (delivery === 'write and close failure') {
          receiver.close = function () {
            this.closes++;
            throw new Error('receipt socket close failed');
          };
        }
        f.emit({ id: request.id, result });

        assert.equal(f.broker.closed, false, 'receipt delivery must not fail the shared stdout transport');
        assert.equal(receiver.closes, fails ? 1 : 0);
        if (delivery === 'socket not writable' || delivery === 'queued backpressure') {
          assert.equal(receiver.messages.some(message => message.result?.threadId === 'thread'), !fails);
          assert.equal(f.broker.threadOwners.get('thread') === receiver, !fails && operation === 'answer');
        }
        assert.equal(f.broker.clients.has(receiver), !fails);
        assert.equal(original.closes + peer.closes, 0);
        assert.equal(f.broker.threadOwners.get('peer'), peer);
        assert.equal(f.broker.activeTurns.get('peer')?.owner, peer);
        assert.equal(f.broker.serverRequests.get(prompt.id), peer);
        assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
          fails && operation === 'answer' && !lifetime ? [{ threadId: 'thread', turnId: 'answer-turn' }] : []);
        f.broker.receive(peer, JSON.stringify({ id: prompt.id,
          result: { answers: { 'peer-item': { answers: ['Continue'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === prompt.id && message.result).length, 1);

        // Legacy disconnect cleanup must settle before the task can resume.
        if (fails && operation === 'answer' && !lifetime) {
          const interrupt = f.upstream.find(message => message.method === 'turn/interrupt');
          f.emit({ id: interrupt.id, result: {} });
          f.emit({ method: 'turn/interrupted', params: { threadId: 'thread', turnId: 'answer-turn' } });
        }
        const authoritative = fails && operation === 'answer' && !lifetime
          ? { ...saved, status: 'stale', revision: 3 } : result.question ?? saved;
        const recovered = f.join();
        f.emit({ id: f.send(recovered, 'asyncQuestion/list', { threadId: 'thread', includeTerminal: true }).id,
          result: { threadId: 'thread', questions: [authoritative] } });
        assert.deepEqual(recovered.messages.at(-1).result.questions, [authoritative]);
        assert.equal(f.upstream.filter(message => message.method === method).length, operation === 'list' ? 2 : 1,
          'recovery reads the original task without replaying answer or cancellation');
      });
    }
  }
}

for (const lifetime of [false, true]) {
  for (const method of ['asyncQuestion/list', 'asyncQuestion/answer']) {
    for (const unavailable of ['write failure', 'socket not writable']) {
      test(`${method} deadline handles ${unavailable} and preserves late receipts (lifetime=${lifetime})`, t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const f = fixture(t, lifetime), original = f.join(), receiver = f.join();
        const request = f.send(receiver, method, method === 'asyncQuestion/list' ? { threadId: 'thread' } : {
          threadId: 'thread', questionId: 'question', expectedRevision: 1,
          submissionId: 'submission', answers: saved.answer.answers,
        });
        const isAnswer = method === 'asyncQuestion/answer';
        if (unavailable === 'write failure') {
          receiver.send = () => { throw new Error('socket write failed during question deadline'); };
        } else {
          receiver.send = () => false;
          receiver.sendWithQueueStatus = () => ({ queued: false, writable: false });
        }

        t.mock.timers.tick(isAnswer ? 120_000 : 30_000);
        assert.equal(f.broker.clients.has(receiver), false);
        assert.equal(receiver.closes, 1);
        assert.equal(f.broker.closed, false);
        assert.equal(f.broker.threadOwners.get('thread'), original);
        assert.equal(f.broker.pending.has(request.id), isAnswer,
          'a late answer still needs reconciliation, while a late read cannot change ownership');

        const before = receiver.messages.length;
        f.emit({ id: request.id, result: isAnswer ? {
          threadId: 'thread', question: saved, accepted: true, duplicate: false,
          startedTurn: { id: 'answer-turn', threadId: 'thread', status: 'running' },
        } : { threadId: 'thread', questions: [saved] } });
        assert.equal(receiver.messages.length, before);
        assert.equal(f.broker.pending.has(request.id), false);
        assert.equal(f.broker.threadOwners.get('thread'), original);
        assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
          isAnswer && !lifetime ? [{ threadId: 'thread', turnId: 'answer-turn' }] : []);
        const read = f.send(original, 'asyncQuestion/list');
        f.emit({ id: read.id, result: { threadId: 'thread', questions: [saved] } });
        assert.deepEqual(original.messages.at(-1).result.questions, [saved]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, Number(isAnswer));
      });
    }
  }
}
