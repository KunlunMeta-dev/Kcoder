import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
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
  const recovering = resume();
  return { broker, upstream, emit, owner, recovering };
}

const item = (id = 'item') => ({ id, header: 'Mode', question: 'Continue?',
  options: [{ id: 'yes', label: 'Yes', description: 'Continue the original task' }], multiSelect: false });
const changed = (questions, revision = 1) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'original-question', revision,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1,
    status: 'pending', questions },
} });
const invalidItems = [
  ['null items', null], ['non-array items', {}], ['empty items', []], ['null item', [null]],
  ['missing item identity', [{ ...item(), id: undefined }]],
  ['blank item identity', [item('   ')]], ['repeated item identity', [item(), item()]],
  ['too many items', Array.from({ length: 9 }, (_, i) => item(`item-${i}`))],
  ['invalid options', [{ ...item(), options: null }]],
  ['blank option identity', [{ ...item(), options: [{ ...item().options[0], id: ' ' }] }]],
  ['repeated option identity', [{ ...item(), options: [item().options[0], item().options[0]] }]],
  ['too many options', [{ ...item(), options: Array.from({ length: 17 }, (_, i) =>
    ({ ...item().options[0], id: `option-${i}` })) }]],
];

for (const shared of [false, true]) {
  for (const [name, questions] of invalidItems) {
    test(`${shared ? 'shared' : 'exclusive'}: ${name} cannot exhaust original question recovery`, t => {
      const f = fixture(t, shared);
      for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
        f.emit(changed(questions, i + 1));
      const valid = changed([item()]);
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'an unanswerable snapshot cannot change successful resume into -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress],
        'live peers reject the same ambiguous question items');
      assert.equal(f.broker.threadOwners.get('thread'), f.owner?.client ?? f.recovering.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'recovery must never answer, cancel, interrupt or replay input');
    });
  }

  test(`${shared ? 'shared' : 'exclusive'}: maximum valid items and omitted legacy items still recover`, t => {
    const f = fixture(t, shared);
    const questions = Array.from({ length: 8 }, (_, i) => ({ ...item(`item-${i}`),
      options: Array.from({ length: 16 }, (_, j) => ({ ...item().options[0], id: `option-${i}-${j}` })) }));
    const valid = [changed(questions), changed(undefined, 2)];
    delete valid[1].params.question.status;
    valid.forEach(f.emit);
    f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread);
    assert.deepEqual(f.recovering.client.messages.slice(1), JSON.parse(JSON.stringify(valid)));
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), JSON.parse(JSON.stringify(valid)));
  });
}

function officeFixture(t, shared) {
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
    payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: { request: 'Fixture document' } } };
  broker.receive(owner, JSON.stringify({ id: 1, method: 'integrations/assistant/adopt', params }));
  const adoption = upstream.at(-1);
  assert.equal(adoption.method, 'integrations/assistant/adopt');
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const accept = () => emit({ id: adoption.id, result: {
    contractVersion: 'parallel-v1', requestId: params.requestId, operationId: params.operationId,
    status: 'completed', error: null, entityRevision: null, observedAt: '2026-11-11T00:00:00Z',
    result: { nativeTask: { threadId: 'thread', turnId: 'turn', state: 'running' } },
  } });
  return { broker, owner, peer, upstream, emit, accept };
}

for (const shared of [false, true]) {
  for (const [name, questions] of invalidItems.filter(([name]) => name.startsWith('repeated'))) {
    test(`Office ${shared ? 'shared' : 'exclusive'}: ${name} cannot displace the original question waiter`, t => {
      const f = officeFixture(t, shared);
      for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
        f.emit(changed(questions, i + 1));
      const valid = changed([item()]);
      const request = { id: 500, method: 'question/request', params: {
        threadId: 'thread', turnId: 'turn', questionId: 'live-question',
        questions: [{ id: 'live-item', prompt: 'Continue the original task?', options: [], allowsFreeform: true }],
      } };
      f.emit(valid); f.emit(request);
      assert.equal(f.upstream.length, 1, 'invalid snapshots cannot fill the handoff and refuse the real waiter');
      f.accept();
      assert.deepEqual(f.owner.messages.slice(1), [valid, request]);
      assert.equal(f.peer.messages.length, 0, 'adoption keeps the original owner');
      assert.equal(f.broker.serverRequests.get(500), f.owner);
      const answers = { 'live-item': { answers: ['Continue'] } };
      f.broker.receive(f.owner, JSON.stringify({ id: 500, result: { answers } }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1,
        'the original owner can answer exactly once');
      assert.deepEqual(f.upstream.at(-1).result.answers, answers);
      assert.equal(f.upstream.filter(message => message.method === 'integrations/assistant/adopt').length, 1,
        'handoff never replays the original task operation');
    });
  }
}

for (const shared of [false, true]) {
  test(`initial-revision saved answers cannot exhaust question recovery (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const pending = changed([item()]);
    const queued = structuredClone(pending);
    Object.assign(queued.params.question, {
      status: 'queued',
      answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { selectedOptionIds: ['yes'] } } },
    });

    // Keep distinct locators so duplicate compaction cannot conceal the invalid records.
    for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++) {
      const frame = structuredClone(queued);
      frame.params.question.questionId = `question-${i}`;
      frame.params.question.requestId = `request-${i}`;
      frame.params.question.toolCallId = `tool-${i}`;
      f.emit(frame);
    }
    const saved = structuredClone(queued);
    Object.assign(saved.params.question, {
      questionId: 'saved-question', requestId: 'saved-request', toolCallId: 'saved-tool', revision: 2,
    });
    f.emit(pending);
    f.emit(saved);
    f.recovering.finish();

    const { client } = f.recovering;
    assert.equal(client.messages[0]?.result?.thread?.id, 'thread');
    assert.deepEqual(client.messages.slice(1), [pending, saved]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [pending, saved]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}

test('original-task list requires the revision to match the question status', t => {
  const f = fixture(t, true);
  f.recovering.finish();
  const { client } = f.recovering;
  const question = {
    ...changed([item()]).params.question, status: 'queued',
    answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { selectedOptionIds: ['yes'] } } },
  };
  const read = (id, record) => {
    f.broker.receive(client, JSON.stringify({ id, method: 'asyncQuestion/list',
      params: { threadId: 'thread', includeTerminal: true } }));
    const request = f.upstream.at(-1);
    assert.equal(request.method, 'asyncQuestion/list');
    const result = { threadId: 'thread', questions: [record] };
    f.emit({ id: request.id, result });
    return result;
  };

  read(2, question);
  assert.equal(client.messages.at(-1).error?.code, -32001);
  const pending = changed([item()]).params.question;
  read(3, { ...pending, revision: 9 });
  assert.equal(client.messages.at(-1).error?.code, -32001);
  const initial = read(4, pending);
  assert.deepEqual(client.messages.at(-1).result, initial);
  const saved = read(5, { ...question, revision: 2 });
  assert.deepEqual(client.messages.at(-1).result, saved);
  assert.deepEqual(f.upstream.map(message => message.method),
    ['thread/resume', 'thread/resume', ...Array(4).fill('asyncQuestion/list')]);
});

for (const shared of [false, true]) {
  test(`advanced pending snapshots cannot block original task recovery (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const pending = changed([item()]);
    f.emit(pending);
    for (let i = 0; i < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++) {
      const impossible = changed([item()], i + 2);
      Object.assign(impossible.params.question, {
        questionId: `other-question-${i}`, requestId: `other-request-${i}`, toolCallId: `other-tool-${i}`,
      });
      f.emit(impossible);
    }
    const cancelled = changed([item()], 2);
    cancelled.params.question.status = 'cancelled';
    f.emit(cancelled);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.result?.thread?.id, 'thread',
      JSON.stringify(f.recovering.client.messages[0]?.error));
    assert.deepEqual(f.recovering.client.messages.slice(1), [pending, cancelled]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [pending, cancelled]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}
