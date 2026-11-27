import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params = {}) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = (resume = true) => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    if (resume) reply(send(client, 'thread/resume'), { thread: { id: 'thread' } });
    return client;
  };
  return { broker, upstream, emit, send, reply, join };
}

for (const shared of [false, true]) {
  for (const method of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
    for (const jsonrpc of ['1.0', null, 2]) {
      test(`${method} version ${JSON.stringify(jsonrpc)} preserves the original question (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
        f.reply(f.send(owner, 'turn/start'), { turn: { id: 'turn', status: 'running' } });
        f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
          questionId: 'question', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } });
        const counts = [owner.messages.length, viewer.messages.length];
        const terminal = { method, params: { threadId: 'thread', turnId: 'turn', sequence: 42 } };
        f.emit({ ...terminal, jsonrpc });
        assert.equal(f.broker.serverRequests.get(500), owner, 'an invalid envelope cannot close original input');
        assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'turn');
        assert.deepEqual([owner.messages.length, viewer.messages.length], counts);
        f.broker.receive(owner, JSON.stringify({ id: 500, result: { answers: { item: { answers: ['yes'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
        // The invalid frame must not reserve this sequence in terminal replay state.
        f.emit({ ...terminal, jsonrpc: '2.0' });
        assert.equal(f.broker.activeTurns.has('thread'), false);
        assert.equal(f.broker.serverRequests.has(500), false);
        assert.equal(viewer.messages.at(-1).method, method);
      });
    }
  }

  for (const method of ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted']) {
    test(`invalid ${method} envelopes cannot exhaust question refresh capacity (shared=${shared})`, t => {
      const f = fixture(t, shared);
      if (shared) f.join();
      const viewer = f.join(false);
      const refresh = f.send(viewer, 'thread/resume');
      for (let sequence = 0; sequence < 513; sequence++) f.emit({ jsonrpc: '1.0', method,
        params: { threadId: 'thread', turnId: 'turn', sequence } });
      const valid = { jsonrpc: '2.0', method: 'asyncQuestion/changed', params: { threadId: 'thread',
        question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
      f.emit(valid);
      f.reply(refresh, { thread: { id: 'thread' } });
      assert.equal(viewer.messages.some(message => message.error?.code === -32047), false);
      assert.equal(viewer.messages.filter(message => message.method === method).length, 0);
      assert.deepEqual(viewer.messages.at(-1), valid, 'the original question still refreshes after recovery');
    });
  }
}

for (const lifecycle of ['connected', 'expired', 'disconnected']) {
  for (const [jsonrpc, turn] of [['1.0', undefined],
    ...[[], ['answer-turn'], 'answer-turn', 7, false].map(turn => ['2.0', turn])]) {
    test(`an invalid early terminal ${JSON.stringify({ jsonrpc, turn })} cannot suppress the answer admission (${lifecycle})`, t => {
      const f = fixture(t, true), owner = f.join(), answerer = f.join();
      const answer = f.send(answerer, 'asyncQuestion/answer', { questionId: 'question', expectedRevision: 1,
        submissionId: 'submission', answers: { item: { text: 'original answer' } } });
      if (lifecycle === 'expired') f.broker.expireRequest(answer.id);
      if (lifecycle === 'disconnected') f.broker.detach(answerer);
      f.emit({ jsonrpc, method: 'turn/completed',
        params: { threadId: 'thread', turnId: 'answer-turn', sequence: 42, turn } });
      f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
        question: answeredAsyncQuestion(answer.params),
        startedTurn: { id: 'answer-turn', status: 'running' } });
      if (lifecycle === 'disconnected') {
        assert.equal(f.broker.threadOwners.get('thread'), owner);
        assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
          [{ threadId: 'thread', turnId: 'answer-turn' }], 'legacy cleanup still cancels the exact admitted turn');
      } else {
        assert.equal(f.broker.threadOwners.get('thread'), answerer);
        assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'answer-turn');
      }
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}

for (const shared of [false, true]) {
  for (const method of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
    for (const turn of [...['running', 'unknown', null, 7].map(status => ({ id: 'turn', status })), [], ['turn'], 'turn', 7, false]) {
      test(`${method} snapshot ${JSON.stringify(turn)} cannot retire original input (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
        f.reply(f.send(owner, 'turn/start'), { turn: { id: 'turn', status: 'running' } });
        f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
          questionId: 'question', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } });
        const terminal = { method, params: { threadId: 'thread', turnId: 'turn', sequence: 42,
          turn } };
        const counts = [owner.messages.length, viewer.messages.length];
        f.emit(terminal);
        assert.equal(f.broker.serverRequests.get(500), owner, 'an invalid snapshot cannot close the original question');
        assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'turn');
        assert.deepEqual([owner.messages.length, viewer.messages.length], counts);
        f.broker.receive(owner, JSON.stringify({ id: 500,
          result: { answers: { item: { answers: ['yes'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
        const valid = { ...terminal, params: { ...terminal.params, turn: { id: 'turn', status: 'completed' } } };
        f.emit(valid);
        assert.equal(f.broker.activeTurns.has('thread'), false, 'the true terminal retains its sequence');
        assert.deepEqual(viewer.messages.at(-1), valid);
      });
    }

    test(`${method} invalid turn snapshots cannot exhaust question recovery (shared=${shared})`, t => {
      const f = fixture(t, shared);
      if (shared) f.join();
      const viewer = f.join(false);
      const refresh = f.send(viewer, 'thread/resume');
      for (let sequence = 0; sequence < 513; sequence++) f.emit({ method,
        params: { threadId: 'thread', turnId: 'turn', sequence, ...[{ turn: [] }, { turn: { id: 'turn', status: 'running' } },
          { thread: [] }, { widget: 'thread' }][sequence % 4] } });
      const valid = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
        question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
      f.emit(valid);
      f.reply(refresh, { thread: { id: 'thread' } });
      assert.equal(viewer.messages.some(message => message.error?.code === -32047), false);
      assert.equal(viewer.messages.some(message => message.method === method), false);
      assert.deepEqual(viewer.messages.at(-1), valid);
    });
  }
}

for (const shared of [false, true]) {
  for (const method of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
    for (const field of ['thread', 'widget']) {
      for (const value of [[], 'malformed-task']) {
        test(`${method} malformed ${field} ${JSON.stringify(value)} preserves original input (shared=${shared})`, t => {
          const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
          f.reply(f.send(owner, 'turn/start'), { turn: { id: 'turn', status: 'running' } });
          f.emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
            questionId: 'question', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } });
          const terminal = { method, params: { threadId: 'thread', turnId: 'turn', sequence: 42 } };
          const count = viewer.messages.length;
          f.emit({ ...terminal, params: { ...terminal.params, [field]: value } });
          assert.equal(f.broker.serverRequests.get(500), owner, 'malformed task snapshots cannot retire original input');
          assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'turn');
          assert.equal(viewer.messages.length, count);
          f.broker.receive(owner, JSON.stringify({ id: 500,
            result: { answers: { item: { answers: ['yes'] } } } }));
          assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
          f.emit(terminal);
          assert.equal(f.broker.activeTurns.has('thread'), false, 'the true terminal retains its sequence');
          assert.deepEqual(viewer.messages.at(-1), terminal);
        });
      }
    }
  }
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const field of ['thread', 'widget']) {
      test(`${kind} malformed ${field} cannot reserve or settle original input (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : owner;
        f.reply(f.send(owner, 'turn/start'), { turn: { id: 'turn', status: 'running' } });
        const binding = { threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original' };
        const request = { id: 500, method: `${kind}/request`, params: { ...binding,
          ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
            : { action: { type: 'command', command: 'echo fixture' } }) } };
        const writes = f.upstream.length, count = viewer.messages.length;
        for (const value of [[], 'malformed-task']) {
          f.emit({ ...request, params: { ...request.params, [field]: value } });
          assert.equal(f.broker.serverRequests.has(500), false);
          assert.equal(viewer.messages.length, count);
          assert.equal(f.upstream.length, writes, 'malformed requests cannot write to the original waiter');
        }
        f.emit(request);
        assert.equal(f.broker.serverRequests.get(500), owner);
        const terminal = { method: `${kind}/resolved`, params: { ...binding,
          requestId: 500, reason: 'client_response', sequence: 42 } };
        const delivered = viewer.messages.length;
        for (const value of [[], 'malformed-task']) {
          f.emit({ ...terminal, params: { ...terminal.params, [field]: value } });
          assert.equal(f.broker.serverRequests.get(500), owner);
          assert.equal(viewer.messages.length, delivered);
        }
        f.broker.receive(owner, JSON.stringify({ id: 500, result: kind === 'question'
          ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' } }));
        assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
        // Matching object locators still settle the original card at this sequence.
        const valid = { ...terminal, params: { ...terminal.params,
          [field]: field === 'thread' ? { id: 'thread' } : { threadId: 'thread' } } };
        f.emit(valid);
        assert.equal(f.broker.serverRequests.has(500), false);
        assert.deepEqual(viewer.messages.at(-1), valid);
      });
    }
  }
}

for (const method of ['turn/completed', 'question/resolved', 'approval/resolved', 'question/request', 'approval/request']) {
  const lifecycles = method.endsWith('/request') ? ['null-id'] : ['connected', 'disconnected', 'null-id'];
  for (const lifecycle of lifecycles) {
    test(`a mixed ${method} envelope cannot consume the real answer receipt (${lifecycle})`, t => {
      const f = fixture(t, true), owner = f.join(), answerer = f.join();
      const answer = f.send(answerer, 'asyncQuestion/answer', { questionId: 'question', expectedRevision: 1,
        submissionId: 'submission', answers: { item: { text: 'original answer' } } });
      if (lifecycle === 'disconnected') f.broker.detach(answerer);
      const received = answerer.messages.length;
      const terminal = { jsonrpc: '2.0', id: lifecycle === 'null-id' ? null : answer.id,
        method, params: { threadId: 'thread', turnId: 'answer-turn', sequence: 42 },
        error: { code: -32600, message: 'Invalid request' } };
      f.emit(terminal);
      assert.equal(f.broker.closed, false, 'a method-bearing frame cannot signal an unattributed upstream parse failure');
      assert.equal(f.broker.pending.has(answer.id), true, 'only the real RPC response may settle the answer');
      assert.equal(answerer.messages.length, received);

      f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
        question: answeredAsyncQuestion(answer.params), startedTurn: { id: 'answer-turn', status: 'running' } });
      if (lifecycle === 'disconnected') {
        assert.equal(f.broker.threadOwners.get('thread'), owner);
        assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
          [{ threadId: 'thread', turnId: 'answer-turn' }]);
      } else {
        assert.equal(answerer.messages.at(-1).result?.accepted, true);
        assert.equal(f.broker.activeTurns.get('thread')?.owner, answerer);
      }
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}
