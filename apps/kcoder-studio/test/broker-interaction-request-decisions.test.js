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
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    emit({ id: request.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, join };
}

for (const shared of [false, true]) {
  for (const availableDecisions of [[], {}, "accept", false, 1, ["unknown"], [null]]) {
    test(`invalid approval decisions cannot occupy the original waiter: ${JSON.stringify(availableDecisions)} (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : null;
      const prompt = { id: 500, method: 'approval/request', params: {
        threadId: 'thread', turnId: 'turn', approvalId: 'original', appServerEpoch: 'epoch',
        action: { type: 'command', command: 'echo fixture' }, reason: 'Controlled approval',
      } };
      const counts = [owner.messages.length, viewer?.messages.length], writes = f.upstream.length;
      f.emit({ ...prompt, params: { ...prompt.params, availableDecisions } });
      assert.deepEqual([owner.messages.length, viewer?.messages.length], counts,
        'an unusable decision list cannot open a card or reserve its transport ID');
      assert.equal(f.broker.serverRequests.has(prompt.id), false);
      assert.equal(f.upstream.length, writes, 'do not reply to an unconfirmed waiter');
      // The corrected original request must remain answerable with the same ID.
      const original = { ...prompt, params: { ...prompt.params, availableDecisions: ['accept', 'decline'] } };
      f.emit(original);
      assert.deepEqual(owner.messages.at(-1), original);
      if (viewer) assert.deepEqual(viewer.messages.at(-1), original);
      f.broker.receive(owner, JSON.stringify({ id: prompt.id, result: { decision: 'accept' } }));
      assert.equal(f.upstream.at(-1).id, prompt.id);
      assert.equal(f.upstream.at(-1).result.decision, 'accept');
      const receipt = { method: 'approval/resolved', params: { ...prompt.params,
        requestId: prompt.id, reason: 'client_response', decision: 'accept' } };
      f.emit(receipt);
      assert.deepEqual(owner.messages.at(-1), receipt);
      if (viewer) assert.deepEqual(viewer.messages.at(-1), receipt);
      assert.equal(f.upstream.length, writes + 1, 'exactly one original reply is forwarded');
    });
  }
}

for (const shared of [false, true]) {
  for (const availableDecisions of [undefined, null, ['accept', 'accept_for_session', 'decline', 'cancel']]) {
    test(`compatible approval decisions still allow the original reply: ${JSON.stringify(availableDecisions)} (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join();
      const prompt = { id: 500, method: 'approval/request', params: {
        threadId: 'thread', turnId: 'turn', approvalId: 'original', availableDecisions,
      } };
      f.emit(prompt);
      assert.equal(owner.messages.at(-1).id, prompt.id);
      f.broker.receive(owner, JSON.stringify({ id: prompt.id, result: { decision: 'accept' } }));
      assert.equal(f.upstream.at(-1).id, prompt.id);
      assert.equal(f.upstream.at(-1).result.decision, 'accept');
    });
  }
}

for (const availableDecisions of [{}, []])
test(`invalid approval decisions ${JSON.stringify(availableDecisions)} cannot reserve an early Office adoption slot`, t => {
  const f = fixture(t, false);
  f.broker.initializeResponse = { result: { capabilities: { experimental: {
    integrationScopeV1: true, officeWorkspaceV1: true,
  } } } };
  const client = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; },
    pause() {}, resume() {}, close() {} };
  f.broker.attach(client);
  Object.assign(client, { initialized: true, integrationScopeV1: true, officeWorkspaceV1: true });
  const params = { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
    scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
    payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } };
  f.broker.receive(client, JSON.stringify({ id: 1, method: 'integrations/assistant/adopt', params }));
  const adoption = f.upstream.at(-1);
  assert.equal(adoption.method, 'integrations/assistant/adopt');
  const original = { id: 500, method: 'approval/request', params: { threadId: 'thread', turnId: 'turn',
    approvalId: 'original', availableDecisions: ['accept', 'decline'] } };
  f.emit({ ...original, params: { ...original.params, availableDecisions } });
  f.emit(original);
  assert.equal(f.upstream.length, 1, 'neither an invalid frame nor a held original request is answered early');
  f.emit({ id: adoption.id, result: { contractVersion: 'parallel-v1', requestId: params.requestId,
    operationId: params.operationId, status: 'completed', error: null, entityRevision: null,
    observedAt: '2026-11-12T17:00:00Z', result: { nativeTask: { threadId: 'thread', turnId: 'turn', state: 'running' } } } });
  assert.deepEqual(client.messages.at(-1), original, 'only the valid original choices survive adoption');
  f.broker.receive(client, JSON.stringify({ id: original.id, result: { decision: 'accept' } }));
  assert.equal(f.upstream.at(-1).id, original.id);
  assert.equal(f.upstream.at(-1).result.decision, 'accept');
  assert.equal(f.upstream.length, 2, 'the original adoption and one answer are the only upstream operations');
});
