import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { projectAsyncQuestionResponse, hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { isContract } from '../shared/generated/validator.mjs';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

const question = { threadId: 'thread', questionId: 'question', requestId: 'request',
  sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Note', question: 'Continue?', options: [], multiSelect: false }] };
const changed = record => ({ method: 'asyncQuestion/changed', params: { threadId: 'thread', question: record } });

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
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  const owner = shared ? resume() : null;
  owner?.finish();
  return { broker, upstream, emit, owner, recovering: resume() };
}

for (const field of ['requestId', 'sourceTurnId', 'toolCallId', 'createdAtMs', 'status']) {
  const incomplete = { ...question };
  delete incomplete[field];
  for (const shared of [false, true]) {
    test(`${shared ? 'shared' : 'exclusive'} recovery rejects full snapshots missing ${field}`, t => {
      const f = fixture(t, shared);
      assert.equal(isContract('AsyncQuestionRecord', incomplete), false, 'both clients reject this record');
      for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
        f.emit(changed({ ...incomplete, revision: i + 1 }));
      const valid = changed(question);
      f.emit(valid);
      f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'client-rejected full records cannot exhaust the original task handoff');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid]);
      assert.equal(f.broker.closed, false);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never replays input');
    });
  }
  test(`list read cannot confirm a full snapshot missing ${field}`, () => {
    const pending = { method: 'asyncQuestion/list', params: { threadId: 'thread' } };
    const reply = questions => ({ id: 1, result: { threadId: 'thread', questions } });
    assert.equal(projectAsyncQuestionResponse(reply([incomplete]), pending).error?.code, -32001);
    const valid = reply([question]);
    assert.equal(projectAsyncQuestionResponse(valid, pending), valid, 'original-task readback remains available');
  });
}

test('status-only legacy notifications and sparse list receipts retain their compatibility boundary', () => {
  const sparse = { threadId: 'thread', questionId: 'question', revision: 1, status: 'pending' };
  assert.equal(hasValidAsyncQuestionNotificationBinding(changed(sparse).params), true);
  const reply = { id: 1, result: { threadId: 'thread', questions: [sparse] } };
  assert.equal(projectAsyncQuestionResponse(reply, {
    method: 'asyncQuestion/list', params: { threadId: 'thread' },
  }), reply);
});

for (const shared of [false, true]) {
  test(`valid large questions can be refreshed after resume (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const records = Array.from({ length: 5 }, (_, index) => ({
      ...question, questionId: `question-${index}`, requestId: `request-${index}`, toolCallId: `tool-${index}`,
      questions: Array.from({ length: 4 }, (_, item) => ({
        ...question.questions[0], id: `item-${item}`, question: 'x'.repeat(15 * 1024),
      })),
    }));
    const updates = records.map((record, index) => {
      const update = changed(record);
      update.params.sequence = index + 1;
      return update;
    });
    assert.ok(updates.every(update => hasValidAsyncQuestionNotificationBinding(update.params)));
    assert.ok(Buffer.byteLength(JSON.stringify(updates.slice(0, 4))) < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes);
    assert.ok(Buffer.byteLength(JSON.stringify(updates)) > RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes);

    for (const update of updates) f.emit(update);
    f.recovering.finish();

    const client = f.recovering.client;
    assert.equal(client.messages[0]?.result?.thread?.id, 'thread', 'valid snapshots must allow the original task to resume');
    assert.deepEqual(client.messages.slice(1, 5), updates.slice(0, 4));
    const hint = client.messages[5];
    assert.equal(hint.method, 'asyncQuestion/changed');
    assert.equal(hint.params.sequence, 5);
    assert.equal(hint.params.question.questionId, records[4].questionId);
    assert.equal(hint.params.question.questions, undefined);
    assert.ok(hasValidAsyncQuestionNotificationBinding(hint.params));
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), updates);

    f.broker.receive(client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId: 'thread', includeTerminal: true } }));
    assert.equal(f.upstream.at(-1).method, 'asyncQuestion/list');
    const result = { threadId: 'thread', questions: records };
    f.emit({ id: f.upstream.at(-1).id, result });
    assert.deepEqual(client.messages.at(-1), { id: 2, result });
    assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
  });
}

for (const sparse of [false, true]) {
  test(`an impossible queued revision cannot reach peers or poison readback (sparse=${sparse})`, t => {
    const f = fixture(t, true);
    const queued = { ...question, status: 'queued', revision: 2,
      answer: { acceptedAtMs: 2, submissionId: 'saved', answers: { item: { text: 'Yes' } } } };
    const { questions, answer, ...hint } = queued;
    assert.equal(hasValidAsyncQuestionNotificationBinding(changed(hint).params), true);
    const invalid = { ...(sparse ? hint : queued), revision: 3 };
    f.emit(changed(invalid));
    f.emit(changed(queued));
    f.recovering.finish();

    const client = f.recovering.client;
    const read = (id, record) => {
      f.broker.receive(client, JSON.stringify({ id, method: 'asyncQuestion/list', params: { threadId: 'thread' } }));
      const request = f.upstream.at(-1);
      assert.equal(request.method, 'asyncQuestion/list');
      f.emit({ id: request.id, result: { threadId: 'thread', questions: [record] } });
      return client.messages.at(-1);
    };
    const recoveryUpdates = client.messages.slice(1);
    const rejected = read(2, invalid);
    const confirmed = read(3, queued);
    assert.deepEqual({
      liveUpdates: f.owner.client.messages.slice(1),
      recoveryUpdates,
      rejectedCode: rejected.error?.code,
      confirmedRecords: confirmed.result?.questions,
    }, {
      liveUpdates: [changed(queued)],
      recoveryUpdates: [changed(queued)],
      rejectedCode: -32001,
      confirmedRecords: [queued],
    });
    assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
  });
}
