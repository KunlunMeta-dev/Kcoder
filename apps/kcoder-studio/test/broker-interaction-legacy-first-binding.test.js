import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind, locator) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current' } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: threadId } } });
    return client;
  };
  const owner = join('original'), peer = join('peer');
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    serverId: 'server-current', ...locator, turnId: 'turn', [field]: 'original-card', appServerEpoch: 'epoch',
  } };
  const receipt = { method: `${kind}/resolved`, params: {
    serverId: 'server-current', threadId: 'original', turnId: 'turn', [field]: 'original-card',
    appServerEpoch: 'epoch', requestId: request.id, reason: 'client_response',
    ...(kind === 'approval' ? { decision: 'accept' } : {}),
  } };
  const reply = () => broker.receive(owner, JSON.stringify({ id: request.id,
    result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
  return { broker, upstream, emit, join, owner, peer, request, receipt, reply };
}

const locators = {
  snake: { thread_id: 'original' },
  nestedThread: { thread: { threadId: 'original' } },
  nestedId: { thread: { id: 'original' } },
  widget: { widget: { threadId: 'original' } },
};

for (const [name, locator] of Object.entries(locators)) {
  for (const kind of ['question', 'approval']) {
    test(`${kind}: a late shared viewer recovers the first ${name} prompt without reply authority`, t => {
      const f = fixture(t, true, kind, locator);
      f.emit(f.request);
      const viewer = f.join('original');
      assert.deepEqual(viewer.messages.at(-1), f.request, 'recovery preserves the original wire prompt');
      assert.equal(f.broker.sharedInteractions.canRead(viewer, { threadId: 'original', requestId: 500 }), true);
      assert.equal(f.broker.sharedInteractions.canRead(f.peer, { threadId: 'original', requestId: 500 }), false);
      const writes = f.upstream.length;
      f.broker.receive(viewer, JSON.stringify({ id: 500,
        result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
      assert.equal(f.upstream.length, writes, 'a viewing device cannot answer for the original client');
      assert.equal(viewer.messages.at(-1).params.reason, 'not_original_client');
      f.reply();
      assert.equal(f.upstream.length, writes + 1);
      assert.equal(f.upstream.at(-1).result.threadId, 'original', 'shared forwarding binds the original task');
      f.emit(f.receipt);
      assert.deepEqual(viewer.messages.at(-1), f.receipt);
      assert.equal(f.broker.sharedInteractions.canRead(viewer, { threadId: 'original', requestId: 500 }), true);
    });
  }
}

for (const [name, locator] of Object.entries(locators)) {
  for (const shared of [false, true]) {
    for (const kind of ['question', 'approval']) {
      for (const state of ['pending', 'submitted', 'terminal', 'refused', 'detached']) {
        test(`${kind}: first ${name} binding survives ${state} replay (shared=${shared})`, t => {
          const f = fixture(t, shared, kind, locator);
          if (state === 'refused') f.broker.beginThreadDrain('original', 'turn');
          f.emit(f.request);
          if (state === 'refused') f.broker.finishThreadDrain('original');
          else assert.deepEqual(f.owner.messages.at(-1), f.request, 'first legacy delivery stays unchanged');
          if (state === 'submitted') f.reply();
          if (state === 'terminal') f.emit({ method: 'turn/completed', params: { threadId: 'original', turnId: 'turn' } });
          if (state === 'detached') f.broker.detach(f.owner);
          const counts = [f.owner.messages.length, f.peer.messages.length], writes = f.upstream.length;
          for (const address of [locator, { threadId: 'peer' }, { thread_id: 'peer' }]) {
            const { thread_id: _snake, thread: _nested, widget: _widget, ...params } = f.request.params;
            f.emit({ ...f.request, params: { ...params, ...address } });
          }
          assert.deepEqual([f.owner.messages.length, f.peer.messages.length], counts,
            'replay cannot reopen the original card or send it to another task');
          assert.equal(f.upstream.length, writes, 'replay cannot settle the original waiter');
          assert.equal(f.broker.serverRequests.get(500), state === 'pending' ? f.owner : undefined,
            'first binding retains exactly its original reply authority');
          if (state === 'pending') {
            f.reply();
            assert.equal(f.upstream.length, writes + 1, 'the original client can still answer once');
          }
          f.emit(f.receipt);
          assert.equal(f.peer.messages.length, counts[1], 'the real receipt stays on the original task');
          if (state !== 'detached') assert.deepEqual(f.owner.messages.at(-1), f.receipt);
        });
      }
    }
  }
}
