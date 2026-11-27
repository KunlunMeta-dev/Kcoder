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
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const owner = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(owner);
  Object.assign(owner, { initialized: true, gatewaySharedThreadsV1: shared });
  broker.receive(owner, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  broker.routeServerMessage({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
  const binding = { threadId: 'thread', turnId: 'turn', [kind === 'question' ? 'questionId' : 'approvalId']: 'original' };
  broker.routeServerMessage({ id: 500, method: `${kind}/request`, params: { ...binding,
    appServerEpoch: 'epoch', ...(kind === 'question'
      ? { questions: [{ id: 'choice' }] } : { availableDecisions: ['accept'] }) } });
  const result = kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' };
  const reply = extra => broker.receive(owner, JSON.stringify({ id: 500, result: { ...result, ...binding, ...extra } }));
  return { broker, owner, upstream, binding, reply };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    const other = kind === 'question' ? 'approvalId' : 'questionId';
    test(`${shared ? 'shared' : 'exclusive'} ${kind}: a conflicting interaction kind cannot consume the original reply`, t => {
      const f = fixture(t, shared, kind), before = f.upstream.length;
      f.reply({ [other]: 'another-card' });
      assert.equal(f.upstream.length, before, 'mixed-card input must not reach the app-server');
      assert.equal(f.broker.serverRequests.get(500), f.owner, 'the original waiter must remain answerable');
      assert.deepEqual(f.owner.messages.at(-1), { jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
        params: { ...f.binding, appServerEpoch: 'epoch', requestId: 500, reason: 'invalid_response' } });
      f.reply({});
      assert.equal(f.upstream.length, before + 1, 'a corrected original reply is forwarded exactly once');
      assert.equal(f.upstream.at(-1).id, 500);
      assert.equal(f.upstream.at(-1).result[other], undefined);
    });

    test(`${shared ? 'shared' : 'exclusive'} ${kind}: a null optional identity preserves compatibility`, t => {
      const f = fixture(t, shared, kind), before = f.upstream.length;
      f.reply({ [other]: null });
      assert.equal(f.upstream.length, before + 1);
      assert.equal(f.upstream.at(-1).result[kind === 'question' ? 'questionId' : 'approvalId'], 'original');
    });
  }
}
