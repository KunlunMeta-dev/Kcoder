import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind = 'question') {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const owner = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(owner);
  Object.assign(owner, { initialized: true, gatewaySharedThreadsV1: shared });
  broker.receive(owner, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
  const binding = { threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original', appServerEpoch: 'epoch' };
  emit({ id: 500, method: `${kind}/request`, params: { ...binding, ...(kind === 'question'
    ? { questions: [{ id: 'item', prompt: 'Which original choice?', options: [] }] }
    : { availableDecisions: ['accept', 'decline'] }) } });
  assert.equal(broker.serverRequests.get(500), owner);
  const reply = response => broker.receive(owner, JSON.stringify({ id: 500, ...response }));
  return { broker, upstream, owner, binding, reply, emit };
}

for (const shared of [false, true]) {
  for (const [name, override] of [
    ['another task', { threadId: 'peer-thread' }],
    ['another turn', { turnId: 'old-turn' }],
    ['another question', { questionId: 'old-question' }],
    ['another lifetime', { appServerEpoch: 'old-epoch' }],
    ['another interaction kind', { approvalId: 'other-card' }],
  ]) {
    test(`a cancellation bound to ${name} keeps the original question answerable (shared=${shared})`, t => {
      const f = fixture(t, shared), writes = f.upstream.length;
      f.reply({ error: { code: -32800, message: 'cancel old card',
        data: { interactionBinding: { ...f.binding, ...override } } } });
      assert.equal(f.upstream.length, writes, 'a foreign cancellation cannot consume the original waiter');
      assert.equal(f.broker.serverRequests.get(500), f.owner);
      assert.equal(f.owner.messages.at(-1).method, 'gateway/interaction/replyRejected');
      assert.equal(f.owner.messages.at(-1).params.reason, 'invalid_response');
      f.reply({ result: { ...f.binding, answers: { item: { answers: ['original answer'] } } } });
      assert.equal(f.upstream.length, writes + 1, 'the original answer is forwarded exactly once');
      assert.deepEqual(f.upstream.at(-1).result.answers, { item: { answers: ['original answer'] } });
      const receipt = { method: 'question/resolved', params: { ...f.binding,
        requestId: 500, reason: 'client_response' } };
      f.emit(receipt);
      assert.deepEqual(f.owner.messages.at(-1), receipt);
    });
  }

  for (const binding of [undefined, null, {}, { threadId: null },
    { threadId: 'thread', turnId: 'turn', questionId: 'original', appServerEpoch: 'epoch' }]) {
    test(`original and legacy cancellation bindings remain valid ${JSON.stringify(binding)} (shared=${shared})`, t => {
      const f = fixture(t, shared), writes = f.upstream.length;
      const error = { code: -32800, message: 'cancel original question',
        ...(binding === undefined ? {} : { data: { interactionBinding: binding } }) };
      f.reply({ error });
      assert.equal(f.upstream.length, writes + 1);
      assert.deepEqual(f.upstream.at(-1).error, error);
    });
  }

  test(`the shared cancellation guard also preserves an approval from a foreign task (shared=${shared})`, t => {
    const f = fixture(t, shared, 'approval'), writes = f.upstream.length;
    f.reply({ error: { code: -32800, message: 'cancel another task approval',
      data: { interactionBinding: { ...f.binding, threadId: 'peer-thread' } } } });
    assert.equal(f.upstream.length, writes);
    assert.equal(f.broker.serverRequests.get(500), f.owner);
    assert.equal(f.owner.messages.at(-1).params.reason, 'invalid_response');
    f.reply({ result: { ...f.binding, decision: 'accept' } });
    assert.equal(f.upstream.length, writes + 1);
    assert.equal(f.upstream.at(-1).result.decision, 'accept');
  });
}
