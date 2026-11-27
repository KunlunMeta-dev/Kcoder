import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

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

const changed = (revision = 1, size = 0) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'saved-question', revision,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1, status: 'pending',
    questions: Array.from({ length: size ? 4 : 1 }, (_, index) => ({ id: `item-${index}`, header: 'Mode',
      question: `Continue?${'x'.repeat(size / 4)}`, options: [], multiSelect: false })) },
} });
const question = { id: 500, method: 'question/request', params: {
  threadId: 'thread', turnId: 'turn', questionId: 'live-question', questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
} };
const progress = { method: 'item/delta', params: { threadId: 'thread', turnId: 'turn', delta: { text: 'progress' } } };

for (const shared of [false, true]) {
  for (const budget of ['frames', 'bytes']) {
    test(`early question snapshot replays cannot refuse the original question (${budget}, shared=${shared})`, t => {
      const f = fixture(t, shared), snapshot = changed(1, budget === 'bytes' ? 60_000 : 0);
      const repetitions = budget === 'frames' ? 65 : 6;
      for (let index = 0; index < repetitions; index++) f.emit(snapshot);
      f.emit(progress);
      f.emit(progress);
      const conflicting = structuredClone(snapshot);
      conflicting.params.question.createdAtMs += 1;
      f.emit(conflicting);
      const updated = changed(2, budget === 'bytes' ? 60_000 : 0);
      updated.params.question.status = 'cancelled';
      f.emit(updated);
      f.emit(snapshot);
      f.emit(question);
      assert.equal(f.upstream.length, 1, 'replayed state cannot fill the queue and refuse a real waiter');
      assert.equal(f.owner.messages.length + f.peer.messages.length, 0, 'acceptance still owns the handoff');
      f.accept();
      assert.deepEqual(f.owner.messages.slice(1), [snapshot, progress, progress, conflicting, updated, question],
        'only exact snapshots coalesce, retaining their first wire position');
      assert.equal(f.peer.messages.length, 0, 'replay cannot select another client');
      assert.equal(f.broker.serverRequests.get(500), f.owner);
      f.broker.receive(f.owner, JSON.stringify({ id: 500, result: { answers: { item: { answers: ['original answer'] } } } }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1,
        'the original question remains answerable exactly once');
      assert.equal(f.upstream.filter(message => message.method === 'integrations/assistant/adopt').length, 1,
        'handoff never replays the task operation');
    });
  }
}

for (const shared of [false, true]) {
  test(`large early snapshots retain a readback locator after adoption (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const snapshots = Array.from({ length: 5 }, (_, index) => {
      const message = changed(1, 60_000);
      message.params.sequence = index + 1;
      message.params.question.questionId = `saved-question-${index}`;
      message.params.question.requestId = `request-${index}`;
      message.params.question.toolCallId = `tool-${index}`;
      return message;
    });
    for (const snapshot of snapshots) f.emit(snapshot);
    f.emit(question);
    assert.equal(f.owner.messages.length + f.peer.messages.length, 0, 'acceptance still owns the handoff');
    f.accept();

    const last = snapshots.at(-1);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = last.params.question;
    const hint = { ...last, params: { ...last.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    assert.deepEqual(f.owner.messages.slice(1), [...snapshots.slice(0, -1), hint, question]);
    assert.equal(f.peer.messages.length, 0);
    assert.equal(f.broker.serverRequests.get(question.id), f.owner);

    f.broker.receive(f.owner, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId, includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    assert.equal(read.params.threadId, threadId);
    f.emit({ id: read.id, result: { threadId, questions: snapshots.map(frame => frame.params.question) } });
    assert.deepEqual(f.owner.messages.at(-1).result.questions, snapshots.map(frame => frame.params.question));
    assert.deepEqual(f.upstream.map(message => message.method), ['integrations/assistant/adopt', 'asyncQuestion/list']);
  });
}

function distinctSnapshot(index, size = 0) {
  const frame = changed(1, size);
  Object.assign(frame.params.question, {
    questionId: `saved-question-${index}`, requestId: `request-${index}`, toolCallId: `tool-${index}`,
  });
  return frame;
}

for (const shared of [false, true]) {
  test(`early cancellation replaces its older snapshot when the Office handoff is full (shared=${shared})`, t => {
    const f = fixture(t, shared);
    f.emit(changed());
    const unrelated = Array.from({ length: 63 }, (_, index) => distinctSnapshot(index));
    for (const frame of unrelated) f.emit(frame);
    const latest = changed(2);
    latest.params.sequence = 70;
    latest.params.question.status = 'cancelled';
    f.emit(latest);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = latest.params.question;
    const hint = { ...latest, params: { ...latest.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    f.emit({ ...hint, params: { ...hint.params, question: { ...hint.params.question, revision: revision + 1 } } });
    assert.equal(f.owner.messages.length + f.peer.messages.length, 0);
    f.accept();

    assert.deepEqual(f.owner.messages.slice(1), [...unrelated, hint],
      'a sparse replay of the same event cannot supersede the compacted full record');
    assert.deepEqual(f.peer.messages, []);

    f.broker.receive(f.owner, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId, includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    assert.deepEqual(read.params, { threadId, includeTerminal: true });
    f.emit({ id: read.id, result: { threadId, questions: [latest.params.question] } });
    assert.deepEqual(f.owner.messages.at(-1).result.questions, [latest.params.question]);
    assert.deepEqual(f.upstream.map(message => message.method), ['integrations/assistant/adopt', 'asyncQuestion/list']);
  });
}

for (const shared of [false, true]) {
  test(`a complete replay frees its stale Office readback slot (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const snapshot = changed(2);
    snapshot.params.sequence = 1;
    snapshot.params.question.status = 'cancelled';
    const { threadId, questionId, requestId, sourceTurnId, toolCallId } = snapshot.params.question;
    f.emit(snapshot);
    f.emit({ method: snapshot.method, params: { threadId, sequence: 2,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 3 } } });
    const unrelated = Array.from({ length: 62 }, (_, index) => distinctSnapshot(index));
    for (const frame of unrelated) f.emit(frame);
    f.emit({ ...snapshot, params: { ...snapshot.params, sequence: 2 } });
    f.emit(question);
    assert.equal(f.upstream.length, 1, 'the superseded locator cannot refuse the original waiter');
    f.accept();
    assert.deepEqual(f.owner.messages.slice(1), [snapshot, ...unrelated, question]);
    assert.deepEqual(f.peer.messages, []);
    assert.equal(f.broker.serverRequests.get(question.id), f.owner);
  });
}

test('distinct early snapshots retain the existing capacity bound and refusal semantics', t => {
  const f = fixture(t, false);
  const frames = Array.from({ length: 65 }, (_, index) => distinctSnapshot(index));
  for (const frame of frames) f.emit(frame);
  f.emit(question);
  assert.equal(f.upstream.filter(message => message.id === 500 && message.error?.code === -32040).length, 1);
  f.accept();
  assert.deepEqual(f.owner.messages.slice(1), frames.slice(0, 64));
  assert.equal(f.broker.serverRequests.has(500), false, 'real overflow cannot reopen a refused waiter');
});

for (const shared of [false, true]) {
  test(`invalid question notification versions cannot reserve Office handoff capacity (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const versions = ['1.0', null, 2, ''];
    for (let revision = 1; revision <= 65; revision++)
      f.emit({ ...changed(revision), jsonrpc: versions[revision % versions.length] });
    const current = { ...changed(), jsonrpc: '2.0' };
    f.emit(current); f.emit(question);
    assert.equal(f.upstream.length, 1, 'invalid notifications cannot refuse the real question waiter');
    f.accept();
    assert.deepEqual(f.owner.messages.slice(1), [current, question]);
    assert.equal(f.peer.messages.length, 0, 'handoff preserves the original task owner');
    assert.equal(f.broker.serverRequests.get(question.id), f.owner);
    f.broker.receive(f.owner, JSON.stringify({ id: question.id, result: { answers: { item: { answers: ['original answer'] } } } }));
    assert.equal(f.upstream.filter(message => message.id === question.id && message.result).length, 1,
      'the original question remains answerable exactly once');
  });
}

// Invalid snapshots must be rejected before they consume the adoption buffer.
for (const shared of [false, true]) {
  for (const [name, invalidate] of [
    ['mismatched task', message => { message.params.question.threadId = 'another-task'; }],
    ['missing question ID', message => { delete message.params.question.questionId; }],
    ['blank question ID', message => { message.params.question.questionId = ' '; }],
    ['oversized question ID', message => { message.params.question.questionId = '问'.repeat(86); }],
    ['invalid revision', message => { message.params.question.revision = 0; }],
    ['invalid status', message => { message.params.question.status = 'not-a-state'; }],
  ]) {
    test(`invalid early ${name} cannot refuse the original question (shared=${shared})`, t => {
      const f = fixture(t, shared);
      for (let index = 0; index < 65; index++) {
        const message = changed(index + 1);
        // Preserve distinct frames even when the invalidator replaces revision.
        message.params.question.createdAtMs = index + 1;
        invalidate(message);
        f.emit(message);
      }
      const current = changed();
      f.emit(current); f.emit(progress); f.emit(question);
      assert.equal(f.upstream.length, 1, 'unusable snapshots cannot refuse a real waiter');
      assert.equal(f.owner.messages.length + f.peer.messages.length, 0, 'acceptance fences early delivery');
      f.accept();
      assert.deepEqual(f.owner.messages.slice(1), [current, progress, question],
        'valid state, ordered progress and original input survive the handoff');
      assert.equal(f.peer.messages.length, 0, 'the original task keeps its requesting client');
      assert.equal(f.broker.serverRequests.get(question.id), f.owner);
      f.broker.receive(f.owner, JSON.stringify({ id: question.id, result: { answers: { item: { answers: ['original answer'] } } } }));
      assert.equal(f.upstream.filter(message => message.id === question.id && message.result).length, 1);
      assert.equal(f.upstream.filter(message => message.method === 'integrations/assistant/adopt').length, 1,
        'recovering input never replays task creation');
    });
  }
}

test('a larger legacy update keeps its newer readback revision at the Office byte limit', t => {
  const f = fixture(t, true);
  const hint = changed();
  delete hint.params.question.questions;
  f.emit(hint);
  const snapshots = [60_000, 60_000, 60_000, 60_000, 18_000].map((size, index) => distinctSnapshot(index, size));
  for (const frame of snapshots) f.emit(frame);

  const latest = structuredClone(hint);
  latest.params.sequence = 7;
  Object.assign(latest.params.question, { revision: 2, status: 'queued',
    answer: { submissionId: 'winner', acceptedAtMs: 2, answers: {
      'item-0': { text: 'a'.repeat(4000) },
      'item-1': { text: 'b'.repeat(4000) },
      'item-2': { text: 'c'.repeat(4000) },
    } } });
  f.emit(latest);
  f.accept();

  const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = latest.params.question;
  assert.deepEqual(f.owner.messages.slice(1).map(frame => [
    frame.params.sequence, frame.params.question.questionId, frame.params.question.revision,
  ]), [...snapshots.map(frame => [undefined, frame.params.question.questionId, 1]), [7, questionId, 2]]);
  assert.deepEqual(f.owner.messages.at(-1).params.question,
    { threadId, questionId, requestId, sourceTurnId, toolCallId, revision });
  assert.deepEqual(f.peer.messages, []);

  f.broker.receive(f.owner, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
    params: { threadId, includeTerminal: true } }));
  const read = f.upstream.at(-1);
  assert.deepEqual(read.params, { threadId, includeTerminal: true });
  const saved = { ...latest.params.question, questions: changed(1, 4).params.question.questions.slice(0, 3) };
  f.emit({ id: read.id, result: { threadId, questions: [saved] } });
  assert.deepEqual(f.owner.messages.at(-1).result, { threadId, questions: [saved] });
  assert.deepEqual(f.upstream.map(message => message.method), ['integrations/assistant/adopt', 'asyncQuestion/list']);
});

test('an oversized legacy update replaces an older full Office snapshot with a readback locator', t => {
  const f = fixture(t, true);
  const original = changed();
  f.emit(original);
  const snapshots = [60_000, 60_000, 60_000, 60_000, 18_000].map((size, index) => distinctSnapshot(index, size));
  for (const frame of snapshots) f.emit(frame);

  const { threadId, questionId, requestId, sourceTurnId, toolCallId } = original.params.question;
  const locator = { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 2 };
  const latest = { ...original, params: { threadId, sequence: 7, question: { ...locator, status: 'queued',
    answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { 'item-0': { text: 'a'.repeat(12_000) } } },
  } } };
  f.emit(latest);
  f.accept();

  assert.deepEqual(f.owner.messages.slice(1), [...snapshots,
    { ...latest, params: { ...latest.params, question: locator } }]);
  assert.deepEqual(f.peer.messages, []);
  assert.deepEqual(f.upstream.map(message => message.method), ['integrations/assistant/adopt']);
});
