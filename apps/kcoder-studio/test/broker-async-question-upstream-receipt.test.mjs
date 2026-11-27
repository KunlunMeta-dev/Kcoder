import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRuntimeTargetAdapter } from '../src/runtime-target-adapter.js';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';

const mixedFrames = [
  'question/request', 'asyncQuestion/changed', 'question/resolved', 'approval/resolved',
  'turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted',
].flatMap(method => [
  { result: null }, { error: { code: -32602, message: 'Invalid params' } },
].map(receipt => ({ method, receipt })));
for (const { method, receipt } of mixedFrames) {
  const isNotification = method !== 'question/request';
  const behavior = isNotification ? 'preserves the original answer waiter' : 'settles the malformed answer receipt';
  test(`mixed ${method} ${Object.keys(receipt)[0]} frame ${behavior} without opening a question`, t => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
      maxMessageBytes: 1024 * 1024, adapter: createRuntimeTargetAdapter('kcoder') });
    broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
    t.after(() => broker.clearTransientState());
    const upstream = [];
    child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
    const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    const messages = [];
    const client = { channel: 'runtime', send(message) { messages.push(message); return true; },
      pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    const send = (id, method, params) => {
      const before = upstream.length;
      broker.receive(client, JSON.stringify({ id, method, params: { threadId: 'thread', ...params } }));
      assert.equal(upstream.length, before + 1);
      return upstream.at(-1).id;
    };
    const resumeId = send(1, 'thread/resume');
    emit({ id: resumeId, result: { thread: { id: 'thread' } } });

    const answerId = send(2, 'asyncQuestion/answer', { questionId: 'async-question',
      expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'Answer' } } });
    const question = { jsonrpc: '2.0', id: answerId, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'prompt',
      questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
    } };
    const mixedFrame = { ...question, method, ...receipt };
    emit(mixedFrame);
    if (isNotification) {
      assert.equal(broker.pending.has(answerId), true, 'a notification cannot consume the original answer waiter');
      assert.equal(messages.length, 1);
      const question = answeredAsyncQuestion(upstream.at(-1).params);
      const result = { threadId: 'thread', accepted: true, duplicate: false, question };
      emit({ jsonrpc: '2.0', id: answerId, result });
      assert.deepEqual(messages.at(-1), { jsonrpc: '2.0', id: 2, result });
    } else {
      assert.equal(broker.pending.has(answerId), false, 'the original answer RPC must settle immediately');
      assert.equal(messages.at(-1).id, 2);
      assert.equal(messages.at(-1).error?.code, -32001);
    }

    emit(mixedFrame);
    assert.equal(broker.serverRequests.has(answerId), false);
    assert.equal(messages.some(message => message.method === method), false);

    emit(question);
    assert.equal(broker.serverRequests.get(answerId), client);
    assert.equal(messages.at(-1).method, question.method);
    const response = { answers: { item: { answers: ['Continue'] } } };
    broker.receive(client, JSON.stringify({ id: answerId, result: response }));
    assert.deepEqual(upstream.at(-1).result, {
      ...response, threadId: 'thread', turnId: 'turn', questionId: 'prompt',
    });

    const readId = send(3, 'asyncQuestion/list', { includeTerminal: true });
    emit({ id: readId, result: { threadId: 'thread', questions: [] } });
    assert.equal(messages.at(-1).id, 3);
    assert.deepEqual(messages.at(-1).result.questions, []);
    assert.equal(upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(broker.threadOwners.get('thread'), client);
    assert.equal(broker.activeTurns.size, 0);
  });
}

test('invalid question request envelopes stay off the shared app-server transport', t => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: createRuntimeTargetAdapter('kcoder') });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let id = 0;
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: ++id, method: 'thread/resume', params: { threadId } }));
    child.stdout.write(JSON.stringify({ id: upstream.at(-1).id, result: { thread: { id: threadId } } }) + '\n');
    return client;
  };
  const owner = join('original'), peer = join('peer');
  const reads = { threadId: 'original' };
  const mutation = { ...reads, questionId: 'card', expectedRevision: 1 };
  const failures = [];
  for (const [method, params] of [
    ['asyncQuestion/list', reads],
    ['asyncQuestion/answer', { ...mutation, submissionId: 'submission', answers: { item: { text: 'Answer' } } }],
    ['asyncQuestion/cancel', mutation],
  ]) {
    for (const envelope of [{ jsonrpc: '1.0' }, { jsonrpc: null },
      { jsonrpc: '2.0', result: null }, { jsonrpc: '2.0', error: null }]) {
      const before = upstream.length;
      broker.receive(owner, JSON.stringify({ id: ++id, method, params, ...envelope }));
      const response = owner.messages.at(-1);
      if (upstream.length !== before || response.id !== id || response.error?.code !== -32602)
        failures.push({ method, envelope, forwarded: upstream.length > before });
    }
  }
  assert.deepEqual(failures, [], 'invalid envelopes must be refused before forwarding');
  for (const [client, threadId, jsonrpc] of [[owner, 'original', undefined], [peer, 'peer', '2.0']]) {
    broker.receive(client, JSON.stringify({ jsonrpc, id: ++id, method: 'asyncQuestion/list', params: { threadId } }));
    const sent = upstream.at(-1);
    assert.equal(sent.method, 'asyncQuestion/list');
    assert.equal(sent.params.threadId, threadId);
    child.stdout.write(JSON.stringify({ id: sent.id, result: { threadId, questions: [] } }) + '\n');
    assert.deepEqual(client.messages.at(-1).result, { threadId, questions: [] });
  }
});
