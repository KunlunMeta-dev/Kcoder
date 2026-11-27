import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind, epoch = 'current-epoch', bindingCapability = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: bindingCapability } } } };
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
    appServerEpoch: epoch, ...(kind === 'question'
      ? { questions: [{ id: 'choice' }] } : { availableDecisions: ['accept'] }) } });
  const result = kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' };
  const reply = (appServerEpoch, extra = {}) => broker.receive(owner, JSON.stringify({ id: 500,
    result: { ...result, ...binding, appServerEpoch, ...extra } }));
  return { broker, owner, upstream, binding, reply };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const epoch of ['previous-epoch', '', 7]) {
      test(`${shared ? 'shared' : 'exclusive'} ${kind}: explicit wrong epoch ${JSON.stringify(epoch)} keeps the original waiter`, t => {
        const f = fixture(t, shared, kind), before = f.upstream.length;
        f.reply(epoch);
        assert.equal(f.upstream.length, before, 'a stale reply must not reach the current app-server');
        assert.equal(f.broker.serverRequests.get(500), f.owner, 'current input remains answerable');
        assert.deepEqual(f.owner.messages.at(-1), { jsonrpc: '2.0', method: 'gateway/interaction/replyRejected',
          params: { ...f.binding, appServerEpoch: 'current-epoch', requestId: 500, reason: 'invalid_response' } });
        f.reply('current-epoch');
        assert.equal(f.upstream.length, before + 1, 'only the current answer is forwarded');
        assert.equal(f.upstream.at(-1).id, 500);
        f.broker.routeServerMessage({ method: `${kind}/resolved`, params: { ...f.binding,
          appServerEpoch: 'current-epoch', requestId: 500, reason: 'answered',
          ...(kind === 'approval' ? { decision: 'accept' } : {}) } });
        assert.equal(f.owner.messages.at(-1).method, `${kind}/resolved`, 'the real terminal receipt still settles');
      });
    }

    for (const epoch of [undefined, null, 'current-epoch']) {
      test(`${shared ? 'shared' : 'exclusive'} ${kind}: compatible reply epoch ${JSON.stringify(epoch)} is forwarded`, t => {
        const f = fixture(t, shared, kind), before = f.upstream.length;
        f.reply(epoch);
        assert.equal(f.upstream.length, before + 1);
        assert.equal(f.upstream.at(-1).result.turnId, 'turn');
      });
    }

    test(`${shared ? 'shared' : 'exclusive'} ${kind}: a legacy prompt cannot certify an explicit foreign epoch`, t => {
      const f = fixture(t, shared, kind, null), before = f.upstream.length;
      f.reply('previous-epoch');
      assert.equal(f.upstream.length, before);
      assert.equal(f.broker.serverRequests.get(500), f.owner);
      f.reply(undefined);
      assert.equal(f.upstream.length, before + 1);
    });

    for (const bindingCapability of [false, true]) {
      test(`${shared ? 'shared' : 'exclusive'} ${kind}: nullable original bindings retain Rust Option semantics (binding=${bindingCapability})`, t => {
        const f = fixture(t, shared, kind, 'current-epoch', bindingCapability), before = f.upstream.length;
        const omitted = Object.fromEntries(Object.keys(f.binding).map(key => [key, null]));
        // Null means omission, but any explicit conflicting identity still
        // fences the whole reply before the original waiter can be consumed.
        for (const field of Object.keys(f.binding)) {
          f.reply('current-epoch', { ...omitted, [field]: 'another-input' });
          assert.equal(f.upstream.length, before);
          assert.equal(f.broker.serverRequests.get(500), f.owner);
          assert.equal(f.owner.messages.at(-1).params.reason, 'invalid_response');
        }
        f.reply('current-epoch', omitted);
        assert.equal(f.upstream.length, before + 1,
          'a valid nullable reply must leave the card and reach its original waiter');
        assert.equal(f.upstream.at(-1).id, 500);
        for (const [field, value] of Object.entries(f.binding)) {
          assert.equal(f.upstream.at(-1).result[field], shared || bindingCapability ? value : null,
            'negotiated forwarding fills only the original delivered binding');
        }
        f.broker.routeServerMessage({ method: `${kind}/resolved`, params: { ...f.binding,
          appServerEpoch: 'current-epoch', requestId: 500, reason: 'answered',
          ...(kind === 'approval' ? { decision: 'accept' } : {}) } });
        assert.equal(f.owner.messages.at(-1).method, `${kind}/resolved`);
        assert.equal(f.broker.serverRequests.has(500), false);
        assert.equal(f.upstream.length, before + 1, 'terminal delivery never repeats the answer');
      });
    }
  }
}
