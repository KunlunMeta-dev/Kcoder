import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: {
    experimental: { interactionBindingV1: true },
  } } };
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
  return { broker, upstream, emit, owner };
}

const aliases = {
  snake: { turn_id: 'original-turn' },
  nestedTurn: { turn: { turnId: 'original-turn' } },
  nestedId: { turn: { id: 'original-turn' } },
};

for (const [alias, locator] of Object.entries(aliases)) {
  for (const shared of [false, true]) {
    for (const kind of ['question', 'approval']) {
      const field = kind === 'question' ? 'questionId' : 'approvalId';
      const binding = { threadId: 'thread', turnId: 'original-turn', [field]: 'card' };
      const request = { id: 500, method: `${kind}/request`, params: {
        threadId: 'thread', ...locator, [field]: 'card', appServerEpoch: 'epoch',
      } };
      const response = { id: 500, result: { ...binding,
        ...(kind === 'question' ? { answers: {} } : { decision: 'accept' }),
      } };
      const receipt = { method: `${kind}/resolved`, params: { ...binding,
        requestId: 500, appServerEpoch: 'epoch', reason: 'client_response',
        ...(kind === 'approval' ? { decision: 'accept' } : {}),
      } };

      test(`${kind}: first ${alias} turn accepts its bound reply and receipt (shared=${shared})`, t => {
        const f = fixture(t, shared);
        f.broker.activeTurns.set('thread', { turnId: 'original-turn', owner: f.owner });
        f.emit(request);
        assert.deepEqual(f.owner.messages.at(-1), request, 'the delivered compatibility frame stays unchanged');
        const writes = f.upstream.length;
        f.broker.receive(f.owner, JSON.stringify(response));
        assert.equal(f.upstream.length, writes + 1, 'the original reply reaches its waiter once');
        assert.deepEqual(f.upstream.at(-1).result, response.result);
        f.emit(receipt);
        assert.deepEqual(f.owner.messages.at(-1), receipt, 'the authoritative receipt settles the original card');
        const delivered = f.owner.messages.length;
        f.emit(request);
        assert.equal(f.owner.messages.length, delivered, 'the resolved request cannot reopen');
      });

      for (const state of ['completed', 'newer-active']) {
        test(`${kind}: first ${alias} request cannot reopen ${state} input (shared=${shared})`, t => {
          const f = fixture(t, shared);
          if (state === 'completed') f.emit({ method: 'turn/completed', params: binding });
          else f.broker.activeTurns.set('thread', { turnId: 'new-turn', owner: f.owner });
          const delivered = f.owner.messages.length, writes = f.upstream.length;
          f.emit(request);
          assert.equal(f.owner.messages.length, delivered, 'stale input cannot become a current card');
          assert.equal(f.upstream.length, writes + 1);
          assert.equal(f.upstream.at(-1).error?.code, -32040);
          assert.equal(f.broker.serverRequests.has(500), false);
          f.emit(receipt);
          assert.deepEqual(f.owner.messages.at(-1), receipt, 'the refused original input still reconciles');
          assert.equal(f.broker.activeTurns.get('thread')?.turnId,
            state === 'newer-active' ? 'new-turn' : undefined, 'reconciliation preserves newer execution');
        });
      }
    }
  }
}
