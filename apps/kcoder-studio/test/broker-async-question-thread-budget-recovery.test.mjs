import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';

const changed = (threadId, revision = 1) => ({ method: 'asyncQuestion/changed', params: {
  threadId, question: { threadId, questionId: 'saved-question', revision,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1, status: 'pending',
    questions: [{ id: 'item', header: 'Mode', question: 'Continue?', options: [], multiSelect: false }] },
} });

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const capabilities = { integrationScopeV1: true, officeWorkspaceV1: true, asyncUserQuestionsV1: true };
  broker.initializeResponse = { result: { capabilities: { experimental: capabilities } } };
  const client = () => {
    const value = { channel: 'runtime', ...capabilities, messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: shared });
    return value;
  };
  const owner = client(), peer = client();
  const params = { contractVersion: 'parallel-v1',
    scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
    requestId: 'request', operationId: 'operation', timeoutMs: 30000,
    payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } };
  broker.receive(owner, JSON.stringify({ id: 1, method: 'integrations/assistant/adopt', params }));
  const adoption = upstream.at(-1);
  assert.equal(adoption.method, 'integrations/assistant/adopt');
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const accept = () => emit({ id: adoption.id, result: {
    contractVersion: 'parallel-v1', requestId: params.requestId, operationId: params.operationId,
    status: 'completed', error: null, entityRevision: null, observedAt: '2026-11-14T00:00:00Z',
    result: { nativeTask: { threadId: 'thread', turnId: 'turn', state: 'running' } },
  } });
  return { broker, owner, peer, upstream, emit, accept };
}

for (const shared of [false, true]) {
  for (const [name, threadId] of [
    ['Rust whitespace', '\u0085'], ['mixed Rust whitespace', ' \u0085\t'],
    ['ASCII byte overflow', 'a'.repeat(257)], ['Unicode byte overflow', '问'.repeat(86)],
    ['embedded NUL', 'old\u0000task'], ['embedded DEL', 'old\u007ftask'],
  ]) {
    test(`${name} task snapshots cannot displace original questions (shared=${shared})`, t => {
      const f = fixture(t, shared);
      // Use individually valid pending snapshots with distinct question IDs.
      for (let index = 0; index < 65; index++) {
        const invalid = changed(threadId);
        invalid.params.question.questionId = `unreadable-${index}`;
        f.emit(invalid);
      }
      const current = changed('thread');
      const question = { id: 500, method: 'question/request', params: {
        threadId: 'thread', turnId: 'turn', questionId: 'live-question',
        questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
      } };
      f.emit(current); f.emit(question);
      assert.equal(f.upstream.length, 1, 'invalid task snapshots must not refuse the real waiter with -32040');
      assert.equal(f.owner.messages.length + f.peer.messages.length, 0);
      f.accept();
      assert.deepEqual(f.owner.messages.slice(1), [current, question]);
      assert.equal(f.peer.messages.length, 0, 'handoff preserves the original answer owner');
      assert.equal(f.broker.serverRequests.get(question.id), f.owner);
      f.broker.receive(f.owner, JSON.stringify({ id: question.id, result: {
        answers: { item: { answers: ['original answer'] } },
      } }));
      assert.equal(f.upstream.filter(message => message.id === question.id && message.result).length, 1);
      f.emit({ method: 'question/resolved', params: { ...question.params, requestId: question.id, reason: 'answered' } });
      assert.equal(f.broker.serverRequests.has(question.id), false, 'the real receipt still settles the question');
      assert.equal(f.upstream.filter(message => message.method === 'integrations/assistant/adopt').length, 1);
      assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'turn/interrupt'].includes(message.method)), false);
    });
  }
}

test('task identity byte boundaries preserve original Unicode and legacy snapshots', () => {
  for (const threadId of ['thread', 'a'.repeat(256), `${'问'.repeat(85)}a`, ' 原任务-😀 ', '\u0085原任务\u0085']) {
    const message = changed(threadId), original = structuredClone(message);
    assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), true);
    assert.deepEqual(message, original, 'validation cannot trim or rewrite the task binding');
    delete message.params.question.questions;
    assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), true, 'legacy refresh-only snapshots remain supported');
  }
});
