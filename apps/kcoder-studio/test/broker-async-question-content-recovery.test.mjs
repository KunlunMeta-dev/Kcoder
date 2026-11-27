import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { projectAsyncQuestionResponse } from '../src/broker-async-questions.js';
import { compactRequestParams } from '../src/broker-request-budget.js';

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
  return { broker, upstream, emit, owner, recovering: resume(), stdout: child.stdout };
}

const item = { id: 'item', header: ' Mode ', question: ' Continue? ', multiSelect: false,
  options: [{ id: 'yes', label: ' Yes ', description: '' }] };
const changed = (questions, revision = 1) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1,
    status: 'pending', questions },
} });

for (const shared of [false, true]) {
  for (const field of ['header', 'question', 'label']) {
    test(`${shared ? 'shared' : 'exclusive'}: blank ${field} cannot block original question recovery`, t => {
      const f = fixture(t, shared);
      const invalid = field !== 'label' ? { ...item, [field]: ' \t\n' }
        : { ...item, options: [{ ...item.options[0], label: ' \t\n' }] };
      for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
        f.emit(changed([invalid], i + 1));
      const valid = changed([item]);
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'unanswerable content must not turn a successful resume into -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress],
        'the real prompt and exact padded option label must survive recovery');
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress],
        'live peers enforce the same content boundary');
      assert.equal(f.broker.threadOwners.get('thread'), f.owner?.client ?? f.recovering.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'read recovery never answers, cancels or replays input');
    });
  }
}

for (const field of ['header', 'question', 'label']) {
  test(`Office: blank ${field} cannot displace a pending original interaction`, () => {
    const handoff = new BrokerOfficeTaskOwnerHandoff();
    const pending = { method: 'integrations/assistant/adopt',
      client: { channel: 'runtime', initialized: true }, params: {
        contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
        scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
        payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} },
      } };
    const invalid = field !== 'label' ? { ...item, [field]: ' \t\n' }
      : { ...item, options: [{ ...item.options[0], label: ' \t\n' }] };
    for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
      assert.equal(handoff.capture(changed([invalid], i + 1), [pending]), false);
    const valid = changed([item]);
    const request = { id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'ordinary-question', questions: [],
    } };
    assert.equal(handoff.capture(valid, [pending]), true);
    assert.equal(handoff.capture(request, [pending]), true);
    const delivered = [], refused = [];
    handoff.settle(pending, { threadId: 'thread', turnId: 'turn' },
      message => delivered.push(message), message => refused.push(message));
    assert.deepEqual(delivered, [valid, request]);
    assert.deepEqual(refused, []);
    assert.equal(handoff.hasRequest(500), false);
  });
}

for (const header of ['', ' \t\n', ' Mode ']) {
  test(`answer receipt cannot certify a blank header: ${JSON.stringify(header)}`, () => {
    const params = { threadId: 'thread', questionId: 'question', expectedRevision: 1,
      submissionId: 'submission', answers: { item: { selectedOptionIds: ['yes'] } } };
    const response = { id: 1, result: { threadId: 'thread', accepted: true, duplicate: false,
      question: { ...changed([{ ...item, header }]).params.question, revision: 2, status: 'queued',
        answer: { submissionId: 'submission', answers: params.answers, acceptedAtMs: 2 } },
      startedTurn: { id: 'answer-turn', threadId: 'thread', status: 'running' } } };
    for (const input of [params, compactRequestParams(compactRequestParams(params))]) {
      const projected = projectAsyncQuestionResponse(response, { method: 'asyncQuestion/answer', params: input });
      if (header.trim()) assert.equal(projected, response, 'valid header whitespace is preserved');
      else assert.equal(projected.error?.code, -32001, 'unsavable prompts cannot certify execution');
    }
  });
}

for (const [token, expected] of [
  ['-32602.000000000001', -32001],
  ['-3.2602e4', -32001],
  ['-32602', -32602],
]) {
  test(`answer refusal uses the original error code token (${token})`, t => {
    const f = fixture(t, true);
    f.recovering.finish();
    const { client } = f.owner;
    f.broker.receive(client, JSON.stringify({ id: 2, method: 'asyncQuestion/answer', params: {
      threadId: 'thread', questionId: 'question', expectedRevision: 1,
      submissionId: 'submission', answers: { item: { text: 'answer' } },
    } }));
    const request = f.upstream.at(-1);
    assert.equal(request.method, 'asyncQuestion/answer');
    f.stdout.write(`{"jsonrpc":"2.0","id":${request.id},"error":{"code":${token},"message":"Original refusal"}}\n`);
    const receipt = client.messages.at(-1);
    assert.equal(receipt.id, 2);
    assert.equal(receipt.error?.code, expected);
    if (expected === -32001) assert.match(receipt.error.message, /unknown/i);
    else assert.equal(receipt.error.message, 'Original refusal');
    assert.equal(f.broker.activeTurns.size, 0);

    f.broker.receive(client, JSON.stringify({ id: 3, method: 'asyncQuestion/list', params: { threadId: 'thread' } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    const question = changed([item]).params.question;
    f.emit({ id: read.id, result: { threadId: 'thread', questions: [question] } });
    assert.deepEqual(client.messages.at(-1).result.questions, [question]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}
