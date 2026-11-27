import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind) {
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
  const binding = { threadId: 'thread', turnId: 'turn', [`${kind}Id`]: kind };
  const request = { id: 500, method: `${kind}/request`, params: { ...binding, appServerEpoch: 'epoch',
    ...(kind === 'question'
      ? { questions: [{ id: 'choice', prompt: 'Choose', options: [], allowsFreeform: true }] }
      : { availableDecisions: ['accept', 'decline'] }) } };
  emit(request);
  const result = { ...binding, ...(kind === 'question'
    ? { answers: { choice: { answers: ['original answer'] } } } : { decision: 'accept' }) };
  const reply = response => broker.receive(owner, JSON.stringify({ id: request.id, ...response }));
  return { broker, upstream, owner, emit, binding, request, result, reply };
}

for (const kind of ['question', 'approval']) for (const shared of [false, true]) {
  for (const method of [null, ""]) {
    for (const cancellation of [false, true]) {
      test(`${shared ? 'shared' : 'exclusive'} ${kind} rejects method=${JSON.stringify(method)} on ${cancellation ? 'cancellation' : 'answer'} without losing its waiter`, t => {
        const f = fixture(t, shared, kind), before = f.upstream.length;
        f.reply({ method, ...(cancellation
          ? { error: { code: -32800, message: 'cancel' } }
          : { result: f.result }) });
        assert.equal(f.upstream.length, before, 'Native rejects any response with a method field');
        assert.equal(f.broker.serverRequests.get(f.request.id), f.owner);
        assert.equal(f.broker.repliedServerRequests.has(f.request.id), false);
        assert.equal(f.owner.messages.at(-1).params?.reason, 'invalid_response');

        f.reply({ result: f.result });
        assert.equal(f.upstream.length, before + 1, 'a corrected explicit answer still reaches Native');
        assert.deepEqual(f.upstream.at(-1).result, f.result);
        f.emit({ method: `${kind}/resolved`, params: { ...f.binding, appServerEpoch: 'epoch',
          requestId: f.request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } });
        assert.equal(f.owner.messages.at(-1).params.reason, 'client_response');
      });
    }
  }
}
