import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isContract } from '../shared/generated/validator.mjs';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

const fields = ['questionId', 'requestId', 'sourceTurnId', 'toolCallId', 'deliveryError'];
const changed = (overrides = {}, revision = overrides.deliveryError == null ? 1 : 3) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision,
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
    status: 'pending', questions: [{ id: 'item', header: 'Mode', question: 'Continue?',
      options: [], multiSelect: false }],
    ...(overrides.deliveryError == null ? {} : { status: 'delivery_failed',
      answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'original answer' } } } }),
    ...overrides },
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

for (const shared of [false, true]) for (const field of fields) {
  test(`${shared ? 'shared' : 'exclusive'}: invalid Unicode ${field} cannot exhaust recovery`, t => {
    const f = fixture(t, shared);
    assert.equal(isContract('AsyncQuestionRecord', changed({ [field]: '\ud800' }).params.question), false);
    for (let revision = 1; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; revision++)
      f.emit(changed({ [field]: '\ud800' }, revision));
    const valid = changed();
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(valid); f.emit(progress); f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread, 'invalid Unicode must not cause resume -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never replays input');
  });
}

test('metadata rejects isolated high/low surrogates and preserves Unicode scalar values and legacy omission', () => {
  for (const field of [...fields, 'threadId']) for (const value of ['\ud800', '\udc00', 'a\ud800b']) {
    const params = changed({ [field]: value }).params;
    if (field === 'threadId') params.threadId = value;
    assert.equal(hasValidAsyncQuestionNotificationBinding(params), false, field);
  }
  for (const value of ['中文', '😀', '\ufffd']) {
    const params = changed(Object.fromEntries(fields.map(field => [field, value]))).params;
    assert.equal(isContract('AsyncQuestionRecord', params.question), true);
    assert.equal(hasValidAsyncQuestionNotificationBinding(params), true);
  }
  assert.equal(hasValidAsyncQuestionNotificationBinding({ threadId: 'thread',
    question: { threadId: 'thread', questionId: 'question', revision: 1 } }), true);
});

test('Office invalid Unicode cannot displace a real question during adoption', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
    params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
  for (const field of fields) assert.equal(handoff.capture(changed({ [field]: '\udc00' }), [pending]), false, field);
  const valid = changed();
  const request = { id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'source',
    questionId: 'ordinary', questions: [] } };
  assert.equal(handoff.capture(valid, [pending]), true);
  assert.equal(handoff.capture(request, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'source' },
    message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [valid, request]);
  assert.deepEqual(refused, []);
});

for (const field of fields.filter(field => field !== 'questionId')) for (const detached of [false, true]) {
  test(`invalid Unicode ${field} cannot certify answer execution (detached=${detached})`, t => {
    const f = fixture(t, true);
    f.recovering.finish();
    const answerer = f.recovering.client;
    const answers = { item: { text: 'original answer' } };
    f.broker.receive(answerer, JSON.stringify({ id: 2, method: 'asyncQuestion/answer', params: {
      threadId: 'thread', questionId: 'question', submissionId: 'submission', expectedRevision: 1, answers,
    } }));
    const request = f.upstream.find(message => message.method === 'asyncQuestion/answer');
    assert.ok(request);
    if (detached) { f.broker.expireRequest(request.id); f.broker.detach(answerer); }
    const deliveries = answerer.messages.length;
    f.emit({ id: request.id, result: { threadId: 'thread', accepted: true, duplicate: false,
      question: changed({ [field]: '\ud800', status: field === 'deliveryError' ? 'delivery_failed' : 'queued',
        answer: { submissionId: 'submission', acceptedAtMs: 2, answers } }, 2).params.question,
      startedTurn: { id: 'unconfirmed', status: 'running' } } });
    assert.equal(f.broker.threadOwners.get('thread'), f.owner.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    if (detached) assert.equal(answerer.messages.length, deliveries);
    else assert.equal(answerer.messages.at(-1).error?.code, -32001);
  });
}
