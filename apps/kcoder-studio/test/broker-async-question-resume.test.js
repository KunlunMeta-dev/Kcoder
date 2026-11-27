import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared, clientCapability = true, serverCapability = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: serverCapability,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const serverMessage = message => {
    const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
  };
  const client = capability => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: capability });
    return value;
  };
  const resume = value => {
    const before = upstream.length;
    broker.receive(value, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
    assert.ok(upstream.length > before, 'resume must reach the original backend');
    const request = upstream.at(-1);
    return () => serverMessage({ id: request.id, result: { thread: { id: 'thread' } } });
  };
  const owner = shared ? client(true) : null;
  if (owner) resume(owner)();
  const viewer = client(clientCapability), finish = resume(viewer);
  return { broker, viewer, owner, finish, resume, upstream, serverMessage };
}

const changed = (questionThreadId = 'thread') => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: questionThreadId, questionId: 'question', revision: 2 },
} });
const progress = { method: 'item/delta', params: { threadId: 'thread', turnId: 'turn', delta: { text: 'progress' } } };

for (const shared of [false, true]) {
  for (const invalid of [
    { questionId: undefined }, { questionId: null }, { questionId: 7 },
    { questionId: '' }, { questionId: '   ' },
    { revision: undefined }, { revision: null }, { revision: '2' },
    { revision: 0 }, { revision: -1 }, { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { status: null }, { status: '' }, { status: 'unknown_status' },
    { status: 1 }, { status: false }, { status: {} }, { status: [] },
  ]) {
    test(`${shared ? 'shared' : 'exclusive'}: invalid question snapshot ${JSON.stringify(invalid)} cannot break recovery`, t => {
      const f = fixture(t, shared);
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++) {
        const notification = changed();
        Object.assign(notification.params.question, {
          requestId: 'request', sourceTurnId: 'source-turn', toolCallId: 'tool-call',
          createdAtMs: 1, status: 'pending',
          questions: [{ id: 'item', header: 'Question', question: 'Continue?', options: [], multiSelect: false }],
          revision: index + 1, deliveryError: `frame-${index}`,
        }, invalid);
        f.serverMessage(notification);
      }
      const valid = changed();
      f.serverMessage(valid);
      f.serverMessage(progress);
      f.finish();
      assert.ok(f.viewer.messages[0]?.result?.thread,
        'invalid question snapshots cannot exhaust task recovery');
      assert.deepEqual(f.viewer.messages.slice(1), [valid, progress]);
      if (shared) assert.deepEqual(f.owner.messages.filter(message => message.method === valid.method), [valid],
        'live peers must reject the same invalid updates as recovering peers');
      assert.equal(f.broker.threadOwners.get('thread'), shared ? f.owner : f.viewer);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.upstream.some(message => message.method !== 'thread/resume'), false,
        'recovery never answers, cancels or replays input');
    });
  }
}

for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  for (const gate of ['foreign question', 'missing question', 'old client', 'old backend']) {
    test(`${mode}: ${gate} updates cannot exhaust a pending resume or suppress progress`, t => {
      const f = fixture(t, shared, gate !== 'old client', gate !== 'old backend');
      const ignored = gate === 'foreign question' ? changed('foreign-thread') : changed();
      if (gate === 'missing question') delete ignored.params.question;
      for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
        f.serverMessage(ignored);
      f.serverMessage(progress);
      f.finish();
      assert.ok(f.viewer.messages[0]?.result?.thread,
        'ineligible question updates must not convert a successful resume into a handoff failure');
      assert.deepEqual(f.viewer.messages.filter(message => message.method === progress.method), [progress]);
      assert.equal(f.viewer.messages.some(message => message.method === ignored.method), false);
      assert.equal(f.broker.threadOwners.get('thread'), shared ? f.owner : f.viewer,
        'recovery must preserve the original controller');
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.upstream.some(message => message.method !== 'thread/resume'), false,
        'recovery must not answer, cancel, interrupt or replay input');
      if (shared && ['old client', 'old backend'].includes(gate)) {
        assert.equal(f.owner.messages.some(message => message.method === ignored.method), gate === 'old client',
          'filtering one viewer must preserve eligible peers');
      }
      // A later eligible viewer must retain the original task and question route.
      f.viewer.asyncUserQuestionsV1 = true;
      f.broker.initializeResponse.result.capabilities.experimental.asyncUserQuestionsV1 = true;
      const valid = changed();
      f.serverMessage(valid);
      assert.deepEqual(f.viewer.messages.at(-1), valid);
    });
  }

  for (const gate of ['foreign question', 'old client']) {
    test(`${mode}: ${gate} updates cannot consume the resume byte budget`, t => {
      const f = fixture(t, shared, gate !== 'old client');
      const ignored = changed(gate === 'foreign question' ? 'foreign-thread' : 'thread');
      ignored.params.question.questions = Array.from({ length: 4 }, (_, index) => ({
        id: `item-${index}`, header: 'Question', question: 'x'.repeat(15_000), options: [], multiSelect: false,
      }));
      const bytes = Buffer.byteLength(JSON.stringify(ignored));
      const count = Math.floor(RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes / bytes) + 1;
      assert.ok(bytes < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes);
      assert.ok(count < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames,
        'this case must hit the byte limit before the frame limit');
      for (let index = 0; index < count; index++) f.serverMessage(ignored);
      f.serverMessage(progress);
      f.finish();
      assert.ok(f.viewer.messages[0]?.result?.thread);
      assert.deepEqual(f.viewer.messages.slice(1), [progress]);
    });
  }

  for (const status of [undefined, 'pending', 'answer_saved', 'queued', 'context_applied',
    'delivery_failed', 'delivery_unknown', 'cancelled', 'stale']) {
    test(`${mode}: eligible question status ${status} remains ordered with progress during resume`, t => {
      const f = fixture(t, shared), notification = changed();
      if (status !== undefined) notification.params.question.status = status;
      if (status === 'pending') notification.params.question.revision = 1;
      if (['context_applied', 'delivery_failed', 'delivery_unknown'].includes(status))
        notification.params.question.revision = 3;
      f.serverMessage(notification);
      f.serverMessage(progress);
      assert.equal(f.viewer.messages.length, 0, 'handoff waits for the original resume receipt');
      f.finish();
      assert.ok(f.viewer.messages[0]?.result?.thread);
      assert.deepEqual(f.viewer.messages.slice(1), [notification, progress]);
      if (shared) assert.deepEqual(f.owner.messages.filter(message => message.method === notification.method),
        [notification], 'valid statuses remain deliverable to live peers');
    });
  }

  test(`${mode}: eligible question overflow remains an explicit recovery failure`, t => {
    const f = fixture(t, shared);
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++) {
      const notification = changed();
      notification.params.question.questionId = `question-${index}`;
      f.serverMessage(notification);
    }
    f.finish();
    assert.equal(f.viewer.messages[0]?.error?.code, -32047);
    assert.equal(f.viewer.messages[0]?.error?.data?.gatewayRecoveryV1?.upstreamOutcome, 'succeeded');
  });
}


for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  for (const limit of ['frames', 'bytes']) {
    test(`${mode}: duplicate async question ${limit} cannot break original task recovery`, t => {
      const f = fixture(t, shared), notification = changed();
      Object.assign(notification.params.question, {
        requestId: 'request', sourceTurnId: 'source-turn', toolCallId: 'tool-call',
        createdAtMs: 1, status: 'pending', revision: 1, questions: Array.from({ length: limit === 'bytes' ? 4 : 1 }, (_, index) => ({
          id: `item-${index}`, header: 'Question',
          question: limit === 'bytes' ? 'x'.repeat(15_000) : 'Continue?',
          options: [], multiSelect: false,
        })),
      });
      const repeats = limit === 'frames' ? RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1 : 6;
      for (let index = 0; index < repeats; index++) f.serverMessage(notification);
      f.serverMessage(progress);
      const answered = structuredClone(notification);
      answered.params.question.revision = 3;
      answered.params.question.status = 'context_applied';
      answered.params.question.answer = { submissionId: 'submission', acceptedAtMs: 2,
        answers: Object.fromEntries(answered.params.question.questions.map(item => [item.id, { text: 'Continue' }])) };
      f.serverMessage(answered);
      // This repeat crosses another revision and progress frame. It still
      // carries no new state and must not reopen the earlier pending card.
      f.serverMessage(notification);
      f.finish();
      assert.ok(f.viewer.messages[0]?.result?.thread,
        'duplicate delivery must not turn a confirmed resume into a handoff failure');
      assert.deepEqual(f.viewer.messages.slice(1), [notification, progress, answered]);
      assert.equal(f.broker.threadOwners.get('thread'), shared ? f.owner : f.viewer);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.upstream.some(message => message.method !== 'thread/resume'), false,
        'recovery cannot answer, cancel or replay any task input');
    });
  }
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: resume keeps distinct legacy question sources`, t => {
    const f = fixture(t, shared);
    const hint = (revision, source = {}) => {
      const message = changed();
      Object.assign(message.params.question, {
        requestId: 'request', sourceTurnId: 'source-turn', toolCallId: 'tool-call', revision, ...source,
      });
      return message;
    };
    const original = hint(1);
    // A stale high revision from a different source must never replace the
    // original source's readback hint. Each source compacts independently.
    const withoutTurn = hint(9);
    delete withoutTurn.params.question.sourceTurnId;
    const differentSources = [
      hint(9, { requestId: 'other-request' }),
      hint(9, { sourceTurnId: 'other-turn' }),
      hint(9, { toolCallId: 'other-tool' }),
      withoutTurn,
    ];
    f.serverMessage(original);
    for (const message of differentSources) f.serverMessage(message);
    f.serverMessage(progress);
    const latest = hint(3, { status: 'cancelled' });
    f.serverMessage(latest);
    f.serverMessage(hint(2));
    f.finish();

    assert.ok(f.viewer.messages[0]?.result?.thread);
    assert.deepEqual(f.viewer.messages.slice(1), [...differentSources, progress, latest]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}

for (const count of [1, RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1]) {
  test(`shared viewer refresh receives ${count} live question updates once`, t => {
    const f = fixture(t, true);
    f.finish();
    const finishRefresh = f.resume(f.viewer);
    const updates = Array.from({ length: count }, (_, index) => {
      const update = changed();
      update.params.question.questionId = `question-${index}`;
      return update;
    });
    for (const update of updates) f.serverMessage(update);

    const receivedUpdates = client => client.messages.filter(message => message.method === 'asyncQuestion/changed');
    assert.deepEqual(receivedUpdates(f.viewer), updates, 'the existing viewer already receives each update live');
    finishRefresh();
    const responses = f.viewer.messages.filter(message => message.id !== undefined);
    assert.equal(responses.length, 2);
    assert.equal(responses.at(-1).result?.thread.id, 'thread',
      'live question traffic must not exhaust the refresh handoff queue');
    assert.deepEqual(receivedUpdates(f.viewer), updates, 'refresh must not replay updates already delivered live');
    assert.deepEqual(receivedUpdates(f.owner), updates);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}
