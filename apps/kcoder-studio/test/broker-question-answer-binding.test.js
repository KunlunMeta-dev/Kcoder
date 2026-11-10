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
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const serverMessage = message => {
    const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
  };
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    serverMessage({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  const request = { id: 500, method: 'question/request', params: {
    serverId: 'owned', threadId: 'thread', turnId: 'turn', questionId: 'original-question', appServerEpoch: 'epoch',
    questions: ['question-1', 'question-2'].map(id => ({ id, header: id, prompt: `Answer ${id}`,
      options: [{ label: 'Yes', value: 'yes' }], allowsFreeform: true, multiSelect: false })),
  } };
  serverMessage(request);
  const reply = (answers, client = owner) => broker.receive(client, JSON.stringify({ id: request.id, result: {
    threadId: 'thread', turnId: 'turn', questionId: 'original-question', answers,
  } }));
  return { broker, upstream, owner, viewer, request, reply, serverMessage };
}

for (const shared of [true, false]) {
  for (const [name, answers] of [
    ['only a foreign item', { 'question-99': { answers: ['from another card'] } }],
    ['a mixed foreign item', { 'question-1': { answers: ['yes'] }, 'question-99': { answers: ['other card'] } }],
    ['a prototype property name', { constructor: { answers: ['other card'] } }],
  ]) test(`${shared ? 'shared' : 'exclusive'} question rejects ${name} without consuming its original waiter`, t => {
    const f = fixture(t, shared), before = f.upstream.length;
    f.reply(answers);
    assert.equal(f.upstream.length, before, 'misbound items must not reach Native or settle its waiter');
    assert.equal(f.owner.messages.at(-1).params?.reason, 'invalid_response');
    assert.equal(f.broker.serverRequests.get(f.request.id), f.owner);
    const valid = { 'question-1': { answers: ['yes'] }, 'question-2': { answers: ['original freeform'] } };
    f.reply(valid);
    assert.equal(f.upstream.length, before + 1, 'the original question must still accept its correct answer');
    assert.deepEqual(f.upstream.at(-1).result, { answers: valid,
      threadId: 'thread', turnId: 'turn', questionId: 'original-question' });
    assert.equal(f.broker.serverRequests.has(f.request.id), false);
    f.serverMessage({ method: 'question/resolved', params: {
      requestId: f.request.id, threadId: 'thread', turnId: 'turn', questionId: 'original-question',
      appServerEpoch: 'epoch', reason: 'client_response',
    } });
    assert.equal(f.owner.messages.at(-1).params.reason, 'client_response');
    if (f.viewer) assert.equal(f.viewer.messages.at(-1).params.reason, 'client_response');
    f.reply(answers);
    assert.equal(f.upstream.length, before + (shared ? 1 : 2),
      'a terminal shared reply replays its receipt; an exclusive reply keeps its Native reconciliation path');
    if (shared) assert.equal(f.owner.messages.at(-1).params.reason, 'client_response');
  });

  for (const [name, answers] of [
    ['empty answer map', {}],
    ['partial answer and freeform', { 'question-2': { answers: ['Not an option, original freeform'] } }],
  ]) test(`${shared ? 'shared' : 'exclusive'} question preserves the existing ${name} contract`, t => {
    const f = fixture(t, shared), before = f.upstream.length;
    f.reply(answers);
    assert.equal(f.upstream.length, before + 1);
    assert.deepEqual(f.upstream.at(-1).result.answers, answers);
  });

  test(`${shared ? 'shared' : 'exclusive'} question still forwards explicit cancellation`, t => {
    const f = fixture(t, shared), before = f.upstream.length;
    f.broker.receive(f.owner, JSON.stringify({ id: f.request.id,
      error: { code: -32800, message: 'the user cancelled the question request' } }));
    assert.equal(f.upstream.length, before + 1);
    assert.equal(f.upstream.at(-1).error.code, -32800);
  });
}

test('a shared viewer cannot consume the question even with matching item IDs', t => {
  const f = fixture(t, true), before = f.upstream.length;
  f.reply({ 'question-1': { answers: ['viewer answer'] } }, f.viewer);
  assert.equal(f.upstream.length, before);
  assert.equal(f.viewer.messages.at(-1).params.reason, 'not_original_client');
  assert.equal(f.broker.serverRequests.get(f.request.id), f.owner);
  f.reply({ 'question-1': { answers: ['owner answer'] } });
  assert.equal(f.upstream.length, before + 1);
});
