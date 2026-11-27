import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

const changed = (field, id, revision = 1) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision,
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1, status: 'pending',
    questions: [{ id: field === 'item' ? id : 'item', header: 'Mode', question: 'Continue?',
      options: [{ id: field === 'option' ? id : 'yes', label: 'Yes', description: '' }], multiSelect: false }] },
} });

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  const owner = shared ? join() : null;
  owner?.finish();
  return { broker, upstream, emit, owner, recovering: join() };
}

for (const field of ['item', 'option']) {
  for (const shared of [false, true]) {
    test(`${shared ? 'shared' : 'exclusive'}: oversized ${field} identity cannot block question recovery`, t => {
      const f = fixture(t, shared);
      // State rejects answer item/option IDs above 256 UTF-8 bytes. A prompt
      // with such an ID cannot be answered, even when its wire schema is valid.
      for (let revision = 1; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; revision++)
        f.emit(changed(field, '界'.repeat(86), revision));
      const valid = changed(field, 'original');
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'an unsavable answer identity must not turn successful resume into -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never submits input');
    });
  }

  test(`Office: oversized ${field} identity cannot reserve adoption capacity`, () => {
    const handoff = new BrokerOfficeTaskOwnerHandoff();
    const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
      params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
        scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
        payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
    for (let revision = 1; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; revision++)
      assert.equal(handoff.capture(changed(field, 'x'.repeat(257), revision), [pending]), false);
    const valid = changed(field, 'original');
    const request = { id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'source', questionId: 'ordinary', questions: [],
    } };
    assert.equal(handoff.capture(valid, [pending]), true);
    assert.equal(handoff.capture(request, [pending]), true);
    const delivered = [], refused = [];
    handoff.settle(pending, { threadId: 'thread', turnId: 'source' },
      message => delivered.push(message), message => refused.push(message));
    assert.deepEqual(delivered, [valid, request]);
    assert.deepEqual(refused, []);
  });

  test(`${field} identity uses State's UTF-8 byte boundary without rewriting valid IDs`, () => {
    for (const id of ['x'.repeat(256), '界'.repeat(85) + 'x', '😀'.repeat(64)])
      assert.equal(hasValidAsyncQuestionNotificationBinding(changed(field, id).params), true);
    for (const id of ['x'.repeat(257), '界'.repeat(86), '😀'.repeat(65)])
      assert.equal(hasValidAsyncQuestionNotificationBinding(changed(field, id).params), false);
    assert.equal(hasValidAsyncQuestionNotificationBinding({ threadId: 'thread', question: {
      threadId: 'thread', questionId: 'question', revision: 1,
    } }), true, 'legacy status-only notifications still trigger original-task reads');
  });
}
