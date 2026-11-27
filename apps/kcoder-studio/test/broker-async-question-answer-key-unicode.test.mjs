import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

// Legacy producers can omit prompts. Map keys must still be Rust strings;
// generated additionalProperties guards validate values, not these keys.
function changed(itemId, revision = 2) {
  return { method: 'asyncQuestion/changed', params: { threadId: 'thread', question: {
    threadId: 'thread', questionId: 'question', status: 'queued', revision,
    answer: { submissionId: 'submission', acceptedAtMs: 2,
      answers: { [itemId]: { text: 'original answer' } } },
  } } };
}

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
  return { broker, upstream, emit, join };
}

for (const itemId of ['\ud800', '\udc00', 'item\ud800key']) {
  for (const shared of [false, true]) {
    test(`invalid Unicode answer key ${JSON.stringify(itemId)} cannot exhaust recovery (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = shared ? f.join() : null;
      owner?.finish();
      const recovering = f.join();
      for (let revision = 1; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; revision++)
        f.emit(changed(itemId, revision));
      const valid = changed('item');
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); recovering.finish();
      assert.ok(recovering.client.messages[0]?.result?.thread, 'invalid map keys must not cause resume -32047');
      assert.deepEqual(recovering.client.messages.slice(1), [valid, progress]);
      if (owner) assert.deepEqual(owner.client.messages.slice(1), [valid, progress]);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never replays input');
    });
  }

  for (const accepted of [false, true]) for (const detached of [false, true]) {
    test(`invalid Unicode answer key ${JSON.stringify(itemId)} cannot certify a receipt (accepted=${accepted}, detached=${detached})`, t => {
      const f = fixture(t, true), owner = f.join(); owner.finish();
      const answerer = f.join(); answerer.finish();
      const question = changed(itemId).params.question;
      f.broker.receive(answerer.client, JSON.stringify({ id: 2, method: 'asyncQuestion/answer', params: {
        threadId: 'thread', questionId: 'question', expectedRevision: 1,
        submissionId: 'submission', answers: { item: { text: 'original answer' } },
      } }));
      const request = f.upstream.at(-1);
      assert.equal(request.method, 'asyncQuestion/answer');
      if (detached) { f.broker.expireRequest(request.id); f.broker.detach(answerer.client); }
      const deliveries = answerer.client.messages.length;
      f.emit({ id: request.id, result: { threadId: 'thread', question, accepted, duplicate: false,
        ...(accepted ? { startedTurn: { id: 'unconfirmed', status: 'running' } } : {}) } });
      assert.equal(f.broker.threadOwners.get('thread'), owner.client, 'invalid receipt cannot transfer control');
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      if (detached) assert.equal(answerer.client.messages.length, deliveries);
      else assert.equal(answerer.client.messages.at(-1).error?.code, -32001);
      const valid = changed('item').params.question;
      f.broker.receive(owner.client, JSON.stringify({ id: 3, method: 'asyncQuestion/list', params: { threadId: 'thread' } }));
      f.emit({ id: f.upstream.at(-1).id, result: { threadId: 'thread', questions: [valid] } });
      assert.deepEqual(owner.client.messages.at(-1).result.questions, [valid]);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}

test('legacy answer keys retain Unicode scalar values and exact bytes', () => {
  for (const itemId of ['中文', '😀', '\ufffd', '__proto__', ' exact key ']) {
    const message = changed(itemId), before = structuredClone(message);
    assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), true);
    assert.deepEqual(message, before);
  }
});

test('Office adoption rejects invalid answer keys before reserving handoff capacity', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
    params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
  for (let revision = 1; revision <= 65; revision++)
    assert.equal(handoff.capture(changed('\ud800', revision), [pending]), false);
  const valid = changed('item');
  const prompt = { id: 500, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: 'ordinary',
  } };
  assert.equal(handoff.capture(valid, [pending]), true);
  assert.equal(handoff.capture(prompt, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' },
    message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [valid, prompt]);
  assert.deepEqual(refused, []);
});
