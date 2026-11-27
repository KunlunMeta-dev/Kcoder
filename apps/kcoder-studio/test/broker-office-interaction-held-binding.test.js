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
  t.after(() => broker.clearTransientState());
  const capabilities = { integrationScopeV1: true, officeWorkspaceV1: true, interactionBindingV1: true };
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: capabilities } } };
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const client = () => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: shared, ...capabilities });
    return value;
  };
  const original = client(), peer = client();
  broker.receive(peer, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'peer-task' } }));
  emit({ id: upstream.at(-1).id, result: { thread: { id: 'peer-task' } } });
  const params = { contractVersion: 'parallel-v1',
    scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
    requestId: 'original-request', operationId: 'original-operation', timeoutMs: 30000,
    payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: { request: 'Fixture document' } } };
  broker.receive(original, JSON.stringify({ id: 2, method: 'integrations/assistant/adopt', params }));
  const adoption = upstream.at(-1);
  const settle = accepted => emit({ id: adoption.id, result: { contractVersion: 'parallel-v1',
    requestId: params.requestId, operationId: accepted ? params.operationId : 'wrong-operation',
    status: 'completed', error: null, entityRevision: null, observedAt: '2026-11-09T00:00:00Z',
    result: { nativeTask: { threadId: 'original-task', turnId: 'original-turn', state: 'running' } } } });
  return { broker, upstream, emit, original, peer, settle };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    for (const accepted of [false, true]) {
      test(`${kind}: held first binding survives an owned-task collision (shared=${shared}, accepted=${accepted})`, t => {
        const f = fixture(t, shared), field = kind === 'question' ? 'questionId' : 'approvalId';
        const request = { id: 500, method: `${kind}/request`, params: {
          serverId: 'server-current', threadId: 'original-task', turnId: 'original-turn',
          [field]: 'original-card', appServerEpoch: 'original-epoch',
        } };
        f.emit(request);
        const counts = [f.original.messages.length, f.peer.messages.length], writes = f.upstream.length;
        for (const method of ['question/request', 'approval/request']) {
          f.emit({ ...request, method, params: { serverId: 'server-current', threadId: 'peer-task',
            turnId: 'peer-turn', appServerEpoch: 'peer-epoch',
            [method === 'question/request' ? 'questionId' : 'approvalId']: 'foreign-card' } });
        }
        assert.deepEqual([f.original.messages.length, f.peer.messages.length], counts,
          'a held transport ID cannot deliver a card to an already-owned peer task');
        assert.equal(f.upstream.length, writes, 'collisions cannot answer the held waiter');
        assert.equal(f.broker.serverRequests.has(500), false, 'the held request has no reply owner yet');
        f.settle(accepted);
        assert.equal(f.broker.threadOwners.get('peer-task'), f.peer);
        assert.equal(f.peer.messages.length, counts[1], 'adoption cannot publish the held card to a peer');
        if (accepted) {
          assert.deepEqual(f.original.messages.at(-1), request, 'the first wire prompt is delivered unchanged');
          assert.equal(f.broker.serverRequests.get(500), f.original);
          f.broker.receive(f.original, JSON.stringify({ id: 500, result: {
            threadId: 'original-task', turnId: 'original-turn', [field]: 'original-card',
            ...(kind === 'question' ? { answers: {} } : { decision: 'decline' }),
          } }));
          assert.equal(f.upstream.length, writes + 1, 'the original owner can answer exactly once');
          assert.equal(f.upstream.at(-1).result[field], 'original-card');
        } else {
          assert.equal(f.upstream.length, writes + 1, 'only the original adoption failure refuses the waiter');
          assert.equal(f.upstream.at(-1).error?.code, -32040);
          const delivered = f.original.messages.length;
          f.emit(request);
          assert.equal(f.original.messages.length, delivered, 'refused held input cannot reopen');
        }
        const receipt = { method: `${kind}/resolved`, params: { ...request.params,
          requestId: 500, reason: accepted ? 'client_response' : 'cancelled',
          ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
        if (accepted) {
          f.emit(receipt);
          assert.deepEqual(f.original.messages.at(-1), receipt, 'the original Native receipt still settles');
        }
        const fresh = { ...request, id: 501, params: { ...request.params,
          threadId: 'peer-task', turnId: 'peer-turn', [field]: 'fresh-card' } };
        f.emit(fresh);
        assert.deepEqual(f.peer.messages.at(-1), fresh, 'a distinct peer request remains usable');
      });
    }
  }
}

for (const kind of ['question', 'approval']) {
  test(`${kind}: a draining peer cannot refuse an unrelated held waiter`, t => {
    const f = fixture(t, true), field = kind === 'question' ? 'questionId' : 'approvalId';
    const request = { id: 500, method: `${kind}/request`, params: {
      threadId: 'original-task', turnId: 'original-turn', [field]: 'original-card', appServerEpoch: 'epoch',
    } };
    f.emit(request);
    f.broker.beginThreadDrain('peer-task', 'peer-turn');
    const writes = f.upstream.length, delivered = f.peer.messages.length;
    f.emit({ ...request, params: { ...request.params, threadId: 'peer-task', turnId: 'peer-turn' } });
    assert.equal(f.upstream.length, writes, 'the peer lifecycle cannot settle the original waiter');
    assert.equal(f.peer.messages.length, delivered);
    f.settle(true);
    assert.deepEqual(f.original.messages.at(-1), request, 'original acceptance still delivers the held prompt');
    f.broker.receive(f.original, JSON.stringify({ id: 500, result: {
      threadId: 'original-task', turnId: 'original-turn', [field]: 'original-card',
      ...(kind === 'question' ? { answers: {} } : { decision: 'decline' }),
    } }));
    assert.equal(f.upstream.length, writes + 1, 'only the original answer settles the waiter');
    assert.equal(f.upstream.at(-1).error, undefined);
  });
}
