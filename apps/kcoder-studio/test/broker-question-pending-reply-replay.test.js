import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, binding, kind = 'question') {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: binding } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const owner = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(owner); owner.initialized = true;
  broker.receive(owner, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
  const identity = { threadId: 'thread', turnId: 'turn', [`${kind}Id`]: kind, appServerEpoch: 'epoch' };
  emit({ id: 500, method: `${kind}/request`, params: { ...identity, ...(kind === 'question'
    ? { questions: [{ id: 'item', prompt: 'Any details?', options: [], allowsFreeform: true }] }
    : { availableDecisions: ['accept', 'decline'] }) } });
  const result = { ...identity, ...(kind === 'question'
    ? { answers: { item: { answers: ['original answer'] } } } : { decision: 'accept' }) };
  const reply = response => broker.receive(owner, JSON.stringify({ id: 500, ...response }));
  reply({ result });
  assert.equal(broker.serverRequests.has(500), false);
  assert.equal(broker.repliedServerRequests.get(500), owner);
  return { broker, upstream, owner, identity, result, reply, emit };
}

for (const binding of [false, true]) {
  for (const [name, change] of [
    ['foreign question', result => ({ result: { ...result, questionId: 'other-question' } })],
    ['foreign task', result => ({ result: { ...result, threadId: 'other-thread' } })],
    ['foreign turn', result => ({ result: { ...result, turnId: 'other-turn' } })],
    ['old epoch', result => ({ result: { ...result, appServerEpoch: 'old-epoch' } })],
    ['foreign answer item', result => ({ result: { ...result, answers: { other: { answers: ['another card'] } } } })],
    ['malformed answer', result => ({ result: { ...result, answers: { item: { answers: [42] } } } })],
    ['invalid envelope', result => ({ jsonrpc: '1.0', result })],
  ]) test(`exclusive pending replay rejects ${name} (binding=${binding})`, t => {
    const f = fixture(t, binding), before = f.upstream.length;
    f.reply(change(f.result));
    assert.equal(f.upstream.length, before, 'a forwarded answer does not authorize malformed or misbound retries');
    assert.deepEqual(f.owner.messages.at(-1), { jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
      params: { ...f.identity, requestId: 500, reason: 'invalid_response' } });
    assert.equal(f.broker.repliedServerRequests.get(500), f.owner, 'retain original receipt reconciliation');
    // A later explicit exact retry still reaches the original Native waiter.
    f.reply({ result: f.result });
    assert.equal(f.upstream.length, before + 1);
    assert.deepEqual(f.upstream.at(-1).result, f.result);
    f.emit({ method: 'question/resolved', params: { ...f.identity, requestId: 500, reason: 'client_response' } });
    assert.equal(f.owner.messages.at(-1).params.reason, 'client_response');
  });

  test(`exclusive pending replay preserves omitted binding and explicit cancellation (binding=${binding})`, t => {
    const f = fixture(t, binding), before = f.upstream.length;
    f.reply({ result: { answers: f.result.answers } });
    assert.deepEqual(f.upstream.at(-1).result, binding
      ? { threadId: 'thread', turnId: 'turn', questionId: 'question', answers: f.result.answers }
      : { answers: f.result.answers });
    f.reply({ error: { code: -32800, message: 'cancel original question' } });
    assert.equal(f.upstream.length, before + 2);
    assert.equal(f.upstream.at(-1).error.code, -32800);
  });

  for (const [name, override] of [
    ['foreign approval', { approvalId: 'other-approval' }],
    ['old epoch', { appServerEpoch: 'old-epoch' }],
    ['unavailable decision', { decision: 'accept_for_session' }],
    ['malformed decision', { decision: 42 }],
  ]) test(`exclusive pending approval replay rejects ${name} (binding=${binding})`, t => {
    const f = fixture(t, binding, 'approval'), before = f.upstream.length;
    f.reply({ result: { ...f.result, ...override } });
    assert.equal(f.upstream.length, before, 'forwarding once cannot bypass approval reply validation');
    assert.equal(f.owner.messages.at(-1).params?.reason, 'invalid_response');
    assert.equal(f.broker.repliedServerRequests.get(500), f.owner);
    f.reply({ result: f.result });
    assert.equal(f.upstream.length, before + 1);
    f.emit({ method: 'approval/resolved', params: { ...f.identity, requestId: 500,
      reason: 'client_response', decision: 'accept' } });
    assert.equal(f.owner.messages.at(-1).params.reason, 'client_response');
  });
}
