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
  const capabilities = { integrationScopeV1: true, officeWorkspaceV1: true, asyncUserQuestionsV1: true };
  broker.initializeResponse = { result: { capabilities: { experimental: capabilities } } };
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const join = () => {
    const client = { channel: 'runtime', messages: [], ...capabilities,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    return client;
  };
  const owner = join(), peer = join();
  const params = { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
    scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
    payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } };
  broker.receive(owner, JSON.stringify({ id: 1, method: 'integrations/assistant/adopt', params }));
  const request = upstream.at(-1);
  assert.equal(request.method, 'integrations/assistant/adopt');
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'async-question', revision: 1 } } };
  const question = { id: 500, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: 'original-question' } };
  emit(changed); emit(question);
  assert.equal(owner.messages.length + peer.messages.length, 0, 'questions wait for the original acceptance');
  const receipt = { id: request.id, result: { contractVersion: 'parallel-v1',
    requestId: params.requestId, operationId: params.operationId, status: 'completed', error: null,
    entityRevision: null, observedAt: '2026-11-12T23:00:00Z',
    result: { nativeTask: { threadId: 'thread', turnId: 'turn', state: 'running' } } } };
  return { broker, owner, peer, upstream, emit, receipt, changed, question };
}

for (const shared of [false, true]) {
  for (const [name, envelope] of [
    ['old version', { jsonrpc: '1.0' }], ['null version', { jsonrpc: null }],
    ['numeric version', { jsonrpc: 2 }], ['empty version', { jsonrpc: '' }],
    ['null error', { error: null }], ['false error', { error: false }],
    ['zero error', { error: 0 }], ['empty error', { error: '' }],
    ['null method', { method: null }], ['empty method', { method: '' }],
    ['false method', { method: false }], ['zero method', { method: 0 }],
    ['request params', { params: { threadId: 'different-thread' } }],
    ['null params', { params: null }],
    ['question method', { method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'mixed-envelope' } }],
  ]) {
    test(`invalid Office ${name} cannot bind held questions (shared=${shared})`, t => {
      const f = fixture(t, shared);
      f.emit({ ...f.receipt, ...envelope });
      if (Object.hasOwn(envelope, 'method') || Object.hasOwn(envelope, 'params')) {
        assert.equal(f.broker.pending.has(f.receipt.id), false, 'the original adoption RPC must settle');
        assert.equal(f.owner.messages.at(-1)?.id, 1);
        assert.equal(f.owner.messages.at(-1)?.error?.code, -32001, 'the adoption outcome remains unknown');
        f.emit({ ...f.receipt, ...envelope });
        assert.equal(f.owner.messages.length, 1, 'a replay cannot redeliver the outcome or open a card');
      }
      assert.equal(f.broker.threadOwners.has('thread'), false, 'invalid acceptance cannot assign task ownership');
      assert.equal(f.broker.activeTurns.has('thread'), false, 'invalid acceptance cannot certify execution');
      assert.equal(f.broker.serverRequests.has(f.question.id), false);
      assert.equal(f.owner.messages.some(message => message.method), false, 'held cards cannot be delivered as accepted');
      assert.equal(f.peer.messages.length, 0, 'another client never inherits the original questions');
      assert.equal(f.upstream.filter(message => message.id === f.question.id && message.error?.code === -32040).length, 1);
      assert.equal(f.upstream.filter(message => message.method).length, 1, 'no input, adoption or answer is replayed');
    });
  }

  for (const jsonrpc of [undefined, '2.0']) {
    test(`valid Office acceptance delivers original questions once (jsonrpc=${jsonrpc}, shared=${shared})`, t => {
      const f = fixture(t, shared);
      f.emit({ ...f.receipt, jsonrpc });
      assert.equal(f.broker.threadOwners.get('thread'), f.owner);
      assert.deepEqual(f.owner.messages.slice(1), [f.changed, f.question]);
      assert.equal(f.broker.serverRequests.get(f.question.id), f.owner);
      assert.equal(f.peer.messages.length, 0);
      f.broker.receive(f.owner, JSON.stringify({ id: f.question.id, result: { answers: {} } }));
      assert.equal(f.upstream.filter(message => message.id === f.question.id && message.result).length, 1);
      assert.equal(f.upstream.filter(message => message.method).length, 1);
    });
  }
}
