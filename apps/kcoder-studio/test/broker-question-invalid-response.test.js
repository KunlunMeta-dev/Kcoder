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
  t.after(() => broker.clearTransientState());
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const owner = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(owner);
  Object.assign(owner, { initialized: true, gatewaySharedThreadsV1: shared });
  broker.receive(owner, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
  const binding = { threadId: 'thread', turnId: 'turn', questionId: 'question' };
  const request = { id: 500, method: 'question/request', params: { ...binding, appServerEpoch: 'epoch',
    questions: [{ id: 'choice', prompt: 'Choose', options: [], allowsFreeform: true }] } };
  emit(request);
  const result = { ...binding, answers: { choice: { answers: ['original answer'] } } };
  const reply = response => broker.receive(owner, JSON.stringify({ id: request.id, ...response }));
  return { broker, upstream, owner, emit, binding, request, result, reply };
}

const invalidReplies = [
  ['missing answer map', result => ({ result: { ...result, answers: undefined } })],
  ['non-string answer', result => ({ result: { ...result, answers: { choice: { answers: [42] } } } })],
  ['null answer', result => ({ result: { ...result, answers: { choice: null } } })],
  ['foreign task', result => ({ result: { ...result, threadId: 'other-thread' } })],
  ['foreign turn', result => ({ result: { ...result, turnId: 'other-turn' } })],
  ['foreign question', result => ({ result: { ...result, questionId: 'other-question' } })],
  ['invalid JSON-RPC version', result => ({ jsonrpc: '1.0', result })],
  ['result and error together', result => ({ result, error: { code: -32800, message: 'cancel' } })],
  ['malformed cancellation', () => ({ error: { code: 'cancel', message: 'cancel' } })],
];

for (const shared of [false, true]) {
  for (const [name, makeResponse] of invalidReplies) {
    test(`${shared ? 'shared' : 'exclusive'} question: ${name} releases the card without consuming the waiter`, t => {
      const f = fixture(t, shared), before = f.upstream.length;
      f.reply(makeResponse(f.result));
      assert.equal(f.upstream.length, before, 'invalid input must not reach the original Native waiter');
      assert.equal(f.broker.serverRequests.get(f.request.id), f.owner, 'the original question stays pending');
      assert.equal(f.broker.repliedServerRequests.has(f.request.id), false);
      assert.deepEqual(f.owner.messages.at(-1), { jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
        params: { ...f.binding, appServerEpoch: 'epoch', requestId: f.request.id, reason: 'invalid_response' } });
      // Only a later explicit corrected answer may consume this waiter.
      f.reply({ result: f.result });
      assert.equal(f.upstream.length, before + 1);
      assert.deepEqual(f.upstream.at(-1), { id: f.request.id, result: f.result });
      assert.equal(f.broker.serverRequests.has(f.request.id), false);
      f.emit({ method: 'question/resolved', params: { ...f.binding, appServerEpoch: 'epoch',
        requestId: f.request.id, reason: 'client_response' } });
      assert.equal(f.owner.messages.at(-1).params.reason, 'client_response');
    });
  }
}
