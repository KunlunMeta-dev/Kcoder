import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

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

const saved = { submissionId: 'submission', acceptedAtMs: 2,
  answers: { item: { text: ' Original answer ', selectedOptionIds: [] } } };
const changed = (answer, revision = 1, status = answer == null ? 'pending' : 'queued') => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1,
    status, answer,
    questions: [{ id: 'item', header: 'Mode', question: 'Continue?', options: [], multiSelect: false }] },
} });
function invalidSnapshot(answer, status, index) {
  const frame = changed(answer, status === 'pending' ? 1 : 2, status);
  frame.params.question.questionId = `invalid-${index}`;
  return frame;
}
const invalidAnswers = [
  ['non-record', false], ['missing fields', {}],
  ['missing submission', { ...saved, submissionId: undefined }],
  ['blank submission', { ...saved, submissionId: ' \t' }],
  ['missing timestamp', { ...saved, acceptedAtMs: undefined }],
  ['negative timestamp', { ...saved, acceptedAtMs: -1 }],
  ['null answers', { ...saved, answers: null }],
  ['array answers', { ...saved, answers: [] }],
  ['null answer value', { ...saved, answers: { item: null } }],
  ['invalid selections', { ...saved, answers: { item: { selectedOptionIds: null } } }],
  ['invalid text', { ...saved, answers: { item: { text: false } } }],
  ['pending status with a saved answer', saved, 'pending'],
  ...['answer_saved', 'queued', 'context_applied', 'delivery_unknown', 'delivery_failed']
    .flatMap(status => [undefined, null].map(answer => [`${status} without a saved answer (${answer})`, answer, status])),
];

for (const shared of [false, true]) {
  for (const [name, answer, status] of invalidAnswers) {
    test(`${shared ? 'shared' : 'exclusive'}: ${name} saved answer cannot block original-task recovery`, t => {
      const f = fixture(t, shared);
      for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
        f.emit(invalidSnapshot(answer, status, i));
      const valid = changed(saved, 2);
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'unusable saved answers must not turn successful resume into -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'readback never answers, cancels or replays input');
    });
  }

  test(`${shared ? 'shared' : 'exclusive'}: omitted, null and saved answers preserve original recovery order`, t => {
    const f = fixture(t, shared);
    const messages = [changed(undefined), changed(null, 2, 'cancelled'), changed(saved, 2),
      changed({ ...saved, answers: { item: { text: 'Original answer' } } }, 2)];
    for (const [index, frame] of messages.entries()) {
      Object.assign(frame.params.question, {
        questionId: `question-${index}`, requestId: `request-${index}`, toolCallId: `tool-${index}`,
      });
      f.emit(frame);
    }
    f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread);
    assert.deepEqual(f.recovering.client.messages.slice(1), JSON.parse(JSON.stringify(messages)));
  });

  test(`${shared ? 'shared' : 'exclusive'}: valid saved, withdrawn and legacy states still recover in order`, t => {
    const f = fixture(t, shared);
    const states = [
      ['pending', undefined], ['cancelled', undefined], ['stale', null],
      ...['answer_saved', 'queued', 'context_applied', 'delivery_unknown', 'delivery_failed', 'cancelled', 'stale']
        .map(status => [status, saved]),
      [undefined, undefined], [undefined, saved],
    ];
    const messages = states.map(([status, answer], index) => {
      const retired = status === 'cancelled' || status === 'stale';
      const hasDeliveryError = status === 'delivery_failed' || status === 'delivery_unknown';
      const minimumRevision = (retired && answer) || hasDeliveryError || status === 'context_applied' ? 3 : 2;
      const revision = status === 'pending' || (status === undefined && answer === undefined) ? 1 : minimumRevision;
      const message = changed(answer, revision);
      if (hasDeliveryError) message.params.question.deliveryError = 'Original delivery error';
      message.params.question.questionId = `question-${index}`;
      message.params.question.status = status;
      // An omitted status is a legacy hint, not a complete prompt snapshot.
      if (status === undefined) delete message.params.question.questions;
      return message;
    });
    for (const [index, frame] of messages.entries()) {
      Object.assign(frame.params.question, {
        questionId: `question-${index}`, requestId: `request-${index}`, toolCallId: `tool-${index}`,
      });
      f.emit(frame);
    }
    f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread);
    assert.deepEqual(f.recovering.client.messages.slice(1), JSON.parse(JSON.stringify(messages)));
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), JSON.parse(JSON.stringify(messages)));
  });
}

test('Office: malformed saved answers cannot displace the original question waiter', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt',
    client: { channel: 'runtime', initialized: true }, params: {
      contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} },
    } };
  for (const [, answer, status] of invalidAnswers)
    for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
      assert.equal(handoff.capture(invalidSnapshot(answer, status, i), [pending]), false);
  const valid = changed(saved, 2);
  const request = { id: 500, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: 'ordinary', questions: [],
  } };
  assert.equal(handoff.capture(valid, [pending]), true);
  assert.equal(handoff.capture(request, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' },
    message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [valid, request]);
  assert.deepEqual(refused, []);
});
