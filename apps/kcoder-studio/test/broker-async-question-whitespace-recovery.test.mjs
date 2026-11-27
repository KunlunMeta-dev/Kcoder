import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function snapshot(field, text, revision = field === 'answer' ? 2 : 1) {
  const question = { threadId: 'thread', questionId: 'question', revision, createdAtMs: 1,
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', status: 'pending',
    questions: [{ id: 'item', header: 'Mode', question: 'Continue?', multiSelect: false,
      options: [{ id: 'yes', label: 'Yes', description: '' }] }] };
  if (field === 'answer') {
    question.status = 'queued';
    question.answer = { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text } } };
  } else if (field === 'label') question.questions[0].options[0].label = text;
  else question.questions[0][field] = text;
  return { method: 'asyncQuestion/changed', params: { threadId: 'thread', question } };
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
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params = {}) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    const request = upstream.at(-1);
    assert.equal(request.method, method);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume');
    return { client, finish: () => reply(request, { thread: { id: 'thread' } }) };
  };
  const owner = shared ? resume() : null;
  owner?.finish();
  return { broker, upstream, emit, send, reply, owner, recovering: resume() };
}

for (const shared of [false, true]) {
  for (const field of ['header', 'question', 'label', 'answer']) {
    test(`Rust whitespace-only ${field} cannot block original-task recovery (shared=${shared})`, t => {
      const f = fixture(t, shared);
      // U+0085 is Unicode White_Space and Rust trims it, unlike JS String.trim.
      // Distinct questions prove validation even when replay deduplication is enabled.
      for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++) {
        const frame = snapshot(field, ' \u0085\t');
        frame.params.question.questionId = `invalid-${i}`;
        f.emit(frame);
      }
      const valid = snapshot(field, ' \u0085Original\u0085 ');
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'unsavable whitespace-only content must not make resume fail with -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress],
        'live peers reject the same invalid snapshots without altering valid text');
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery only reads the task');
    });
  }
}

for (const lifecycle of ['connected', 'expired-disconnected']) {
  test(`a whitespace-only saved answer cannot certify execution (${lifecycle})`, t => {
    const f = fixture(t, true); f.recovering.finish();
    const answerer = f.recovering.client, answers = { item: { text: '\u0085' } };
    const request = f.send(answerer, 'asyncQuestion/answer', { questionId: 'question', expectedRevision: 1,
      submissionId: 'submission', answers });
    if (lifecycle === 'expired-disconnected') {
      f.broker.expireRequest(request.id); f.broker.detach(answerer);
    }
    const deliveries = answerer.messages.length;
    f.reply(request, { threadId: 'thread', accepted: true, duplicate: false,
      question: snapshot('answer', '\u0085', 2).params.question,
      startedTurn: { id: 'answer-turn', status: 'running' } });
    assert.equal(f.broker.threadOwners.get('thread'), f.owner.client,
      'State cannot save this answer, so it cannot certify a new owner');
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    if (lifecycle === 'connected') assert.equal(answerer.messages.at(-1).error?.code, -32001);
    else assert.equal(answerer.messages.length, deliveries, 'late receipts are not redelivered');
    const saved = snapshot('answer', 'Original answer', 2).params.question;
    f.reply(f.send(f.owner.client, 'asyncQuestion/list'), { threadId: 'thread', questions: [saved] });
    assert.deepEqual(f.owner.client.messages.at(-1).result.questions, [saved]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
      'readback never resubmits an answer');
  });
}

// Rust preserves U+FEFF as content; testing this opposite boundary prevents
// broad control-character stripping from replacing the whitespace fix.
test('Unicode whitespace validation preserves valid original content and choices', () => {
  for (const field of ['header', 'question', 'label', 'answer']) {
    for (const text of ['\ufeff', ' \u0085Original\u0085 ', '中文 😀']) {
      const message = snapshot(field, text);
      const original = structuredClone(message);
      assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), true);
      assert.deepEqual(message, original, 'validation never rewrites the source or saved answer');
    }
  }
  const message = snapshot('answer', '\u0085');
  message.params.question.answer.answers.item.selectedOptionIds = ['yes'];
  assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), true,
    'a selected original option is a complete answer even when optional text is whitespace');
});
