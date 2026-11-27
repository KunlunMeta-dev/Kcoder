import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emitRaw = frame => child.stdout.write(`${frame}\n`);
  const emit = message => emitRaw(JSON.stringify(message));
  let sequence = 0;
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
  const send = (method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const resume = send('thread/resume', { threadId: 'thread' });
  emit({ id: resume.id, result: { thread: { id: 'thread' } } });
  return { broker, upstream, emit, emitRaw, send, client };
}

for (const [name, idFields] of [
  ['rounded ID', id => `"id":${id}.00000000000000001`],
  ['duplicate ID', id => `"id":${id + 1},"id":${id}`],
]) {
  test(`mixed reply with ${name} leaves the original answer receipt pending`, t => {
    const f = fixture(t);
    const answers = { item: { text: 'Keep this answer' } };
    const request = f.send('asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
      expectedRevision: 1, submissionId: 'submission', answers });
    const received = f.client.messages.length;
    f.emitRaw(`{"jsonrpc":"2.0",${idFields(request.id)},"method":"unrelated","error":{"code":-32602,"message":"Invalid params"}}`);
    assert.equal(f.client.messages.length, received, 'an ambiguous ID cannot settle the pending answer');
    assert.equal(f.broker.activeTurns.size, 0);
    const result = { threadId: 'thread', accepted: true, duplicate: false,
      question: { threadId: 'thread', questionId: 'question', requestId: 'request',
        sourceTurnId: 'source', toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
        questions: [{ id: 'item', header: 'Answer', question: 'Any details?', options: [], multiSelect: false }],
        answer: { acceptedAtMs: 2, submissionId: 'submission', answers } },
      startedTurn: { threadId: 'thread', id: 'answer-turn', status: 'running' } };
    f.emit({ id: request.id, result });
    assert.deepEqual(f.client.messages.at(-1).result, result);
    assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'answer-turn');
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}

for (const method of ['asyncQuestion/answer', 'asyncQuestion/cancel', 'asyncQuestion/list']) {
  for (const [name, envelope] of [
    ['invalid protocol version', { jsonrpc: '1.0' }],
    ['result and error together', { jsonrpc: '2.0', result: { threadId: 'thread', accepted: true } }],
    ['request params and error together', { jsonrpc: '2.0', params: { threadId: 'other-thread' } }],
  ]) {
    test(`${method}: ${name} cannot certify a refusal`, t => {
      const f = fixture(t);
      const request = f.send(method, { threadId: 'thread', questionId: 'question',
        expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'Keep this answer' } } });
      f.emit({ id: request.id, ...envelope, error: { code: -32602, message: 'Invalid params' } });
      assert.equal(f.client.messages.at(-1).error?.code, -32001,
        'an ambiguous upstream frame must keep the mutation outcome unknown, rather than authorize retry');
      assert.equal(f.broker.threadOwners.get('thread'), f.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      const read = f.send('asyncQuestion/list', { threadId: 'thread', includeTerminal: true });
      f.emit({ id: read.id, result: { threadId: 'thread', questions: [] } });
      assert.deepEqual(f.client.messages.at(-1).result.questions, []);
      assert.equal(f.upstream.filter(message => message.method === method).length,
        method === 'asyncQuestion/list' ? 2 : 1, 'only explicit original-task readback follows the unknown outcome');
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    });
  }

  for (const jsonrpc of [undefined, '2.0']) {
    test(`${method}: a valid ${JSON.stringify(jsonrpc)} refusal retains its meaning`, t => {
      const f = fixture(t);
      const request = f.send(method, { threadId: 'thread', questionId: 'question', expectedRevision: 1,
        submissionId: 'submission', answers: { item: { text: 'Keep this answer' } } });
      const error = { code: -32602, message: 'Original refusal 原拒绝', data: { detail: ['合法正文', null, 1, 1e308, -0.5] } };
      f.emit({ id: request.id, jsonrpc, error });
      assert.deepEqual(f.client.messages.at(-1).error, error);
    });
  }
}

for (const method of ['asyncQuestion/answer', 'asyncQuestion/cancel', 'asyncQuestion/list']) {
  for (const [name, error] of [
    ['scalar error', 'rejected'],
    ['array error', []],
    ['missing error code', { message: 'Rejected' }],
    ['fractional error code', { code: -32602.5, message: 'Rejected' }],
    ['unsafe error code', { code: -9007199254740992, message: 'Rejected' }],
    ['missing error message', { code: -32602 }],
    ['non-string error message', { code: -32602, message: false }],
    ['non-scalar error message', { code: -32602, message: '\ud800' }],
    ['non-scalar error data', { code: -32602, message: 'Rejected', data: { detail: '\udfff' } }],
    ['non-scalar data key', { code: -32602, message: 'Rejected', data: { ['\ud800']: 'detail' } }],
  ]) {
    test(`${method}: ${name} cannot certify a refusal`, t => {
      const f = fixture(t);
      const request = f.send(method, { threadId: 'thread', questionId: 'question',
        expectedRevision: 1, submissionId: 'submission', answers: { item: { text: 'Keep this answer' } } });
      f.emit({ jsonrpc: '2.0', id: request.id, error });
      assert.equal(f.client.messages.at(-1).error?.code, -32001,
        'an invalid error cannot certify rejection or authorize retry');
      assert.equal(f.broker.threadOwners.get('thread'), f.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      const read = f.send('asyncQuestion/list', { threadId: 'thread', includeTerminal: true });
      f.emit({ id: read.id, result: { threadId: 'thread', questions: [] } });
      assert.deepEqual(f.client.messages.at(-1).result.questions, []);
      assert.equal(f.upstream.filter(message => message.method === method).length,
        method === 'asyncQuestion/list' ? 2 : 1);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    });
  }
}

for (const method of ['asyncQuestion/answer', 'asyncQuestion/cancel', 'asyncQuestion/list']) {
  test(`${method}: overflowing error data cannot certify a refusal`, t => {
    const f = fixture(t);
    const params = { threadId: 'thread', questionId: 'question', expectedRevision: 1,
      submissionId: 'submission', answers: { item: { text: 'Keep this answer' } } };
    const request = f.send(method, params);
    f.emitRaw(`{"id":${request.id},"error":{"code":-32602,"message":"Invalid params","data":{"details":[1e999]}}}`);
    assert.equal(f.client.messages.at(-1).error?.code, -32001);
    assert.equal(f.broker.threadOwners.get('thread'), f.client);
    assert.equal(f.broker.activeTurns.size, 0);
    const read = f.send('asyncQuestion/list', { threadId: 'thread', includeTerminal: true });
    f.emit({ id: read.id, result: { threadId: 'thread', questions: [] } });
    assert.deepEqual(f.client.messages.at(-1).result?.questions, []);
    assert.deepEqual(f.upstream.map(message => message.method), ['thread/resume', method, 'asyncQuestion/list']);
  });
}
