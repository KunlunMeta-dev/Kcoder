import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const caps = { integrationScopeV1: true, officeWorkspaceV1: true };
  broker.initializeResponse = { result: { capabilities: { experimental: caps } } };
  const client = { channel: 'runtime', ...caps, messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client); client.initialized = true;
  const written = [];
  child.stdin.on('data', chunk => written.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const params = { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
    scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
    payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } };
  broker.receive(client, JSON.stringify({ id: 1, method: 'integrations/assistant/adopt', params }));
  const request = written.at(-1);
  assert.equal(request.method, 'integrations/assistant/adopt');
  const accept = task => emit({ id: request.id, result: { contractVersion: 'parallel-v1', requestId: 'request',
    operationId: 'operation', status: 'completed', error: null, entityRevision: null,
    observedAt: '2026-11-14T15:00:00Z', result: { nativeTask: task } } });
  return { broker, client, written, emit, accept };
}

for (const field of ['threadId', 'turnId']) {
  for (const value of [' ', '\t\n', '\u0085', ' \u0085\t']) {
    test(`blank acceptance ${field}=${JSON.stringify(value)} cannot own an original question`, t => {
      const f = fixture(t);
      const prompt = { id: 500, method: 'question/request', params: {
        threadId: 'original-thread', turnId: 'original-turn', questionId: 'original-question',
        questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
      } };
      f.emit(prompt);
      assert.equal(f.client.messages.length, 0, 'the question waits for its original acceptance');
      f.accept({ threadId: 'original-thread', turnId: 'original-turn', state: 'running', [field]: value });
      assert.equal(f.broker.threadOwners.size, 0, 'unusable acceptance cannot install a task owner');
      assert.equal(f.broker.activeTurns.size, 0, 'unusable acceptance cannot install an unfinishable turn');
      assert.equal(f.broker.serverRequests.has(prompt.id), false);
      assert.equal(f.client.messages.some(message => message.method === 'question/request'), false);
      assert.equal(f.written.filter(message => message.id === prompt.id && message.error?.code === -32040).length, 1);
      assert.equal(f.written.some(message => message.method === 'turn/interrupt'), false);
    });
  }
}

for (const turnId of [null, undefined]) test(`acceptance turnId=${String(turnId)} cannot install an incomplete active turn`, t => {
  const f = fixture(t);
  const prompt = { id: 501, method: 'question/request', params: {
    threadId: 'original-thread', turnId: 'original-turn', questionId: 'original-question',
    questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
  } };
  f.emit(prompt);
  assert.equal(f.client.messages.length, 0, 'the question waits for its original acceptance');
  f.accept({ threadId: 'original-thread', turnId, state: 'running' });
  assert.equal(f.broker.threadOwners.size, 0, 'missing turn identity cannot install a task owner');
  assert.equal(f.broker.activeTurns.size, 0, 'missing turn identity cannot install an incomplete active turn');
  assert.equal(f.broker.serverRequests.has(prompt.id), false);
  assert.equal(f.client.messages.some(message => message.method === 'question/request'), false);
  assert.equal(f.written.filter(message => message.id === prompt.id && message.error?.code === -32040).length, 1);
  assert.equal(f.written.some(message => message.method === 'turn/interrupt'), false);
});

for (const identity of [' 原任务🙂 ', '\uFEFF']) test(`valid acceptance preserves exact ${JSON.stringify(identity)} identities and releases the original question once`, t => {
  const f = fixture(t);
  const task = { threadId: identity, turnId: identity, state: 'running' };
  const prompt = { id: 'question-500', method: 'question/request', params: {
    threadId: task.threadId, turnId: task.turnId, questionId: 'original-question',
    questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
  } };
  f.emit(prompt); f.accept(task);
  assert.equal(f.broker.threadOwners.get(task.threadId), f.client);
  assert.equal(f.broker.activeTurns.get(task.threadId)?.turnId, task.turnId);
  assert.deepEqual(f.client.messages.filter(message => message.method === 'question/request'), [prompt]);
  f.broker.receive(f.client, JSON.stringify({ id: prompt.id, result: { answers: { item: { answers: ['original answer'] } } } }));
  assert.equal(f.written.filter(message => message.id === prompt.id && message.result).length, 1);
});
