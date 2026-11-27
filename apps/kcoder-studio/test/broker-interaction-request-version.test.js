import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, kind, adopting = false) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current', capabilities: { experimental: {
    interactionBindingV1: true, integrationScopeV1: true, officeWorkspaceV1: true,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared,
      integrationScopeV1: true, officeWorkspaceV1: true });
    if (adopting) return client;
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    emit({ id: request.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  const adoptionParams = { contractVersion: 'parallel-v1',
    scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
    requestId: 'adoption-request', operationId: 'operation', timeoutMs: 30000,
    payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: { request: 'Fixture document' } } };
  if (adopting) broker.receive(owner, JSON.stringify({ id: ++sequence,
    method: 'integrations/assistant/adopt', params: adoptionParams }));
  const adoption = upstream.at(-1);
  const accept = () => {
    assert.equal(adoption.method, 'integrations/assistant/adopt');
    emit({ id: adoption.id, result: { contractVersion: 'parallel-v1', requestId: adoptionParams.requestId,
      operationId: adoptionParams.operationId, status: 'completed', error: null, entityRevision: null,
      observedAt: '2026-11-11T00:00:00Z',
      result: { nativeTask: { threadId: 'thread', turnId: 'turn', state: 'running' } } } });
  };
  const binding = { serverId: 'server-current', threadId: 'thread', turnId: 'turn',
    [kind === 'question' ? 'questionId' : 'approvalId']: 'original', appServerEpoch: 'epoch' };
  const request = { jsonrpc: '2.0', id: 500, method: `${kind}/request`, params: { ...binding,
    ...(kind === 'question' ? { questions: [{ id: 'item' }] } : { availableDecisions: ['accept'] }) } };
  const answer = () => {
    const writes = upstream.length;
    broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id: 500, result: kind === 'question'
      ? { answers: { item: { answers: ['original answer'] } } } : { decision: 'accept' } }));
    assert.equal(upstream.length, writes + 1, 'valid original input is forwarded exactly once');
    const terminal = { jsonrpc: '2.0', method: `${kind}/resolved`, params: { ...binding, requestId: 500,
      reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
    emit(terminal);
    assert.deepEqual(owner.messages.at(-1), terminal);
    if (viewer && !adopting) assert.deepEqual(viewer.messages.at(-1), terminal);
    if (viewer && adopting) assert.equal(viewer.messages.length, 0, 'unattached peers cannot receive the adopted receipt');
  };
  return { broker, upstream, emit, owner, viewer, request, answer, accept };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const jsonrpc of ['1.0', null, 2, {}]) {
      test(`${kind} request version ${JSON.stringify(jsonrpc)} cannot reserve input (shared=${shared})`, t => {
        const f = fixture(t, shared, kind);
        const deliveries = f.owner.messages.length, views = f.viewer?.messages.length, writes = f.upstream.length;
        f.emit({ ...f.request, jsonrpc, params: { ...f.request.params,
          [kind === 'question' ? 'questionId' : 'approvalId']: 'wrong-card' } });
        assert.equal(f.broker.serverRequests.has(500), false, 'invalid envelope cannot reserve the real waiter');
        assert.equal(f.owner.messages.length, deliveries, 'invalid envelope cannot open a card');
        assert.equal(f.viewer?.messages.length, views, 'invalid envelope cannot reach a peer');
        assert.equal(f.upstream.length, writes, 'invalid envelope cannot settle an unconfirmed waiter');
        f.emit(f.request);
        assert.deepEqual(f.owner.messages.at(-1), f.request, 'the valid request keeps its original card identity');
        if (f.viewer) assert.deepEqual(f.viewer.messages.at(-1), f.request);
        f.answer();
      });
    }

    test(`${kind} invalid request versions cannot exhaust interaction capacity (shared=${shared})`, t => {
      const f = fixture(t, shared, kind);
      const deliveries = f.owner.messages.length, writes = f.upstream.length;
      for (let id = 1000; id < 1513; id++) f.emit({ ...f.request, id, jsonrpc: '1.0' });
      assert.equal(f.owner.messages.length, deliveries, 'invalid requests do not create blocking cards');
      assert.equal(f.broker.serverRequests.size, 0);
      assert.equal(f.upstream.length, writes, 'invalid requests do not produce capacity refusals');
      f.emit(f.request);
      assert.deepEqual(f.owner.messages.at(-1), f.request, 'capacity remains available for a real question');
      f.answer();
    });

    test(`${kind} invalid request versions cannot reserve Office handoff (shared=${shared})`, t => {
      const f = fixture(t, shared, kind, true);
      for (let id = 1000; id < 1065; id++) f.emit({ ...f.request, id, jsonrpc: '1.0' });
      f.emit({ ...f.request, jsonrpc: null, params: { ...f.request.params,
        [kind === 'question' ? 'questionId' : 'approvalId']: 'wrong-card' } });
      f.emit(f.request);
      assert.equal(f.upstream.length, 1, 'invalid envelopes cannot overflow handoff or answer the original waiter');
      assert.equal(f.owner.messages.length, 0, 'the original acceptance still gates delivery');
      f.accept();
      assert.deepEqual(f.owner.messages.slice(1), [f.request], 'only the valid original request follows acceptance');
      assert.equal(f.viewer?.messages.length ?? 0, 0, 'handoff cannot transfer the card to a peer');
      f.answer();
    });

    for (const jsonrpc of [undefined, '2.0']) {
      test(`${kind} valid request version ${JSON.stringify(jsonrpc)} stays answerable (shared=${shared})`, t => {
        const f = fixture(t, shared, kind);
        const request = { ...f.request, jsonrpc };
        f.emit(request);
        assert.equal(f.broker.serverRequests.get(500), f.owner);
        assert.deepEqual(f.owner.messages.at(-1), JSON.parse(JSON.stringify(request)));
        f.answer();
      });
    }
  }
}
