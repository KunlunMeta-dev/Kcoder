import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';
import { isContract } from '../shared/generated/validator.mjs';

const question = {
  threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'turn',
  toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
};
const changed = (index = 0) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { ...question, questionId: `question-${index}` },
} });

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current',
    capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emitRaw = line => child.stdout.write(`${line}\n`);
  const emit = message => emitRaw(JSON.stringify(message));
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
  return { broker, upstream, emit, emitRaw, resume };
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: unknown notification fields cannot block original-task recovery`, t => {
    const f = fixture(t, shared), owner = shared ? f.resume() : null;
    owner?.finish();
    const recovering = f.resume();
    const invalid = changed();
    invalid.params.obsoleteDelivery = 'unsupported envelope metadata';
    assert.equal(isContract('AsyncQuestionRecord', invalid.params.question), true);
    assert.equal(isContract('AsyncQuestionChangedNotification', invalid.params), false,
      'the question is valid but the client cannot consume its notification envelope');
    for (let index = 1; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; index++)
      f.emit({ ...invalid, params: { ...invalid.params, question: { ...question, questionId: `question-${index}` } } });
    const valid = changed();
    const sequenced = changed(2);
    Object.assign(sequenced.params, { serverId: 'server-current', sequence: 2 });
    const legacy = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
      question: { threadId: 'thread', questionId: 'question', revision: 3 } } };
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(valid); f.emit(sequenced); f.emit(legacy); f.emit(progress); recovering.finish();
    assert.ok(recovering.client.messages[0]?.result?.thread,
      'client-rejected envelopes must not turn a successful resume into -32047');
    assert.deepEqual(recovering.client.messages.slice(1), [valid, sequenced, legacy, progress]);
    if (owner) assert.deepEqual(owner.client.messages.slice(1), [valid, sequenced, legacy, progress]);
    assert.equal(f.broker.threadOwners.get('thread'), owner?.client ?? recovering.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never replays input');
  });
}

test('Office compatibility: unknown notification fields cannot displace the original pending question', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt',
    client: { channel: 'runtime', initialized: true }, params: {
      contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} },
    } };
  for (let index = 1; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; index++) {
    const invalid = changed(index);
    invalid.params.obsoleteDelivery = 'unsupported envelope metadata';
    assert.equal(handoff.capture(invalid, [pending]), false);
  }
  const valid = changed();
  Object.assign(valid.params, { serverId: 'server-current', sequence: 1 });
  const request = { id: 500, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: 'ordinary-question',
    questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
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

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: a full event replaces all compatible same-sequence hints during resume`, t => {
    const f = fixture(t, shared);
    const recovering = f.resume();
    const snapshot = changed();
    Object.assign(snapshot.params, { serverId: 'server-current', sequence: 10 });
    const hint = (revision, locator) => ({ method: snapshot.method, params: {
      threadId: 'thread', serverId: 'server-current', sequence: 10,
      question: { threadId: 'thread', questionId: 'question-0', revision, ...locator },
    } });
    f.emit(hint(3, { requestId: 'request' }));
    f.emit(hint(4, { sourceTurnId: 'turn' }));
    const progress = Array.from({ length: RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames - 1 }, (_, index) =>
      ({ method: 'item/delta', params: { threadId: 'thread', delta: { text: String(index) } } }));
    for (const event of progress.slice(0, -1)) f.emit(event);
    f.emit(snapshot);
    f.emit(progress.at(-1));
    recovering.finish();
    const response = recovering.client.messages[0];
    assert.equal(response?.error?.code, undefined, 'covered hints cannot cause a handoff overflow');
    assert.equal(response?.result?.thread?.id, 'thread');
    assert.deepEqual(recovering.client.messages.slice(1), [snapshot, ...progress]);
  });
}

for (const shared of [false, true]) {
  for (const [kind, alter] of [
    ['duplicate source', line => line.replace('"requestId":"request"', '"requestId":"other","requestId":"request"')],
    ['rounded revision', line => line.replace('"revision":1', '"revision":1.00000000000000001')],
    ['rounded sequence', line => line.replace('"sequence":1', '"sequence":1.00000000000000001')],
    ['rounded timestamp', line => line.replace('"createdAtMs":1', '"createdAtMs":1.00000000000000001')],
  ]) {
    test(`${shared ? 'shared' : 'exclusive'}: ${kind} cannot block resume or reach the live owner`, t => {
      const f = fixture(t, shared), owner = shared ? f.resume() : null;
      owner?.finish();
      const recovering = f.resume();
      for (let index = 1; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; index++) {
        const frame = changed(index);
        Object.assign(frame.params, { serverId: 'server-current', sequence: 1 });
        f.emitRaw(alter(JSON.stringify(frame)));
      }
      const valid = changed();
      Object.assign(valid.params, { serverId: 'server-current', sequence: 1 });
      f.emit(valid);
      recovering.finish();

      assert.equal(recovering.client.messages[0]?.result?.thread?.id, 'thread',
        'invalid wire notifications cannot turn a successful resume into -32047');
      assert.deepEqual(recovering.client.messages.slice(1), [valid]);
      if (owner) assert.deepEqual(owner.client.messages.slice(1), [valid]);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
    });
  }
}
