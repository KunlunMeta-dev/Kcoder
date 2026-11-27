import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerResumeNotificationBuffer, RESUME_NOTIFICATION_BUFFER_LIMITS as LIMITS } from '../src/broker-resume-notification-buffer.js';

const changed = (sequence, large = false) => ({ method: 'asyncQuestion/changed', params: {
  serverId: 'owned', sequence, threadId: 'thread', question: {
    threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
    toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
    questions: Array.from({ length: large ? 4 : 1 }, (_, index) => ({
      id: `item-${index}`, header: 'Details', question: large ? 'x'.repeat(15_000) : 'Continue?',
      options: [], multiSelect: false,
    })),
  },
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

for (const shared of [false, true]) {
  test(`a newer question can replace its full snapshot at the resume frame cap (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const first = changed(1);
    f.emit(first);
    const progress = Array.from({ length: LIMITS.perPendingFrames - 1 }, (_, index) => ({
      method: 'item/delta', params: { threadId: 'thread', sequence: index + 2, delta: { text: 'progress' } },
    }));
    for (const frame of progress) f.emit(frame);
    const latest = changed(LIMITS.perPendingFrames + 1);
    Object.assign(latest.params.question, { revision: 2, status: 'cancelled' });
    f.emit(latest);
    f.recovering.finish();

    const messages = f.recovering.client.messages;
    assert.equal(messages[0]?.result?.thread?.id, 'thread');
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = latest.params.question;
    assert.deepEqual(messages.slice(1), [...progress, { ...latest, params: { ...latest.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } }]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [first, ...progress, latest]);

    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId: 'thread', includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    assert.deepEqual(read.params, { threadId: 'thread', includeTerminal: true });
    f.emit({ id: read.id, result: { threadId: 'thread', questions: [latest.params.question] } });
    assert.deepEqual(messages.at(-1).result?.questions, [latest.params.question]);
    assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
  });
}

for (const shared of [false, true]) {
  test(`a delayed older snapshot cannot exhaust a full resume queue (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const latest = changed(1);
    Object.assign(latest.params.question, { revision: 2, status: 'cancelled' });
    f.emit(latest);
    const progress = Array.from({ length: LIMITS.perPendingFrames - 1 }, (_, index) => ({
      method: 'item/delta', params: { threadId: 'thread', sequence: index + 2, delta: { text: 'progress' } },
    }));
    for (const frame of progress) f.emit(frame);
    const delayed = changed(LIMITS.perPendingFrames + 1);
    f.emit(delayed);
    f.recovering.finish();

    const messages = f.recovering.client.messages;
    assert.equal(messages[0]?.error?.code, undefined, 'a stale replay must not cause -32047');
    assert.equal(messages[0]?.result?.thread?.id, 'thread');
    assert.deepEqual(messages.slice(1), [latest, ...progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [latest, ...progress, delayed]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });

  test(`a stale hint cannot overflow a byte-full resume queue with a newer snapshot (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const full = changed(2);
    Object.assign(full.params.question, { revision: 3, status: 'cancelled' });
    const { threadId, questionId, requestId, sourceTurnId, toolCallId } = full.params.question;
    const hint = { ...full, params: { ...full.params, sequence: 1,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 1 } } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 3, delta: { text: '' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(hint) - bytes(full) - bytes(progress));
    const delayed = { ...hint, params: { ...hint.params, sequence: 100,
      question: { ...hint.params.question, revision: 2 } } };

    for (const frame of [hint, full, progress, delayed]) f.emit(frame);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.error?.code, undefined,
      'the delayed hint adds no state beyond the queued terminal snapshot');
    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, threadId);
    assert.deepEqual(f.recovering.client.messages.slice(1), [hint, full, progress]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });

  test(`a locator for the queued revision cannot overflow a frame-full resume (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const full = changed(1);
    const progress = Array.from({ length: LIMITS.perPendingFrames - 1 }, (_, index) => ({
      method: 'item/delta', params: { threadId: 'thread', sequence: index + 2, delta: { text: 'progress' } },
    }));
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const hint = { ...full, params: { ...full.params, sequence: LIMITS.perPendingFrames + 1,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };

    for (const frame of [full, ...progress, hint]) f.emit(frame);
    f.recovering.finish();

    const messages = f.recovering.client.messages;
    assert.equal(messages[0]?.error?.code, undefined, 'a redundant locator must not cause -32047');
    assert.equal(messages[0]?.result?.thread?.id, threadId);
    assert.deepEqual(messages.slice(1), [full, ...progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [full, ...progress, hint]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });

  test(`a delayed older hint cannot crowd out subsequent turn progress (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const latest = changed(1);
    Object.assign(latest.params.question, { revision: 2, status: 'cancelled' });
    const { threadId, questionId, requestId, sourceTurnId, toolCallId } = latest.params.question;
    const delayed = { ...latest, params: { ...latest.params, sequence: 2,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 1 } } };
    const progress = Array.from({ length: LIMITS.perPendingFrames - 1 }, (_, index) => ({
      method: 'item/delta', params: { threadId, sequence: index + 3, delta: { text: 'progress' } },
    }));
    for (const frame of [latest, delayed, ...progress]) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.error?.code, undefined, 'obsolete read hints must not cause -32047');
    assert.equal(response.result?.thread.id, threadId);
    assert.deepEqual(replayed, [latest, ...progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [latest, delayed, ...progress]);
  });

  test(`turn progress can reclaim a hint superseded by a later snapshot (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const latest = changed(3);
    Object.assign(latest.params.question, { revision: 2, status: 'cancelled' });
    const { threadId, questionId, requestId, sourceTurnId, toolCallId } = latest.params.question;
    const hint = { ...latest, params: { ...latest.params, sequence: 1,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 1 } } };
    const other = { ...hint, params: { ...hint.params, sequence: 2,
      question: { ...hint.params.question, toolCallId: 'different-tool' } } };
    for (const frame of [hint, other, latest]) f.emit(frame);
    const progress = Array.from({ length: LIMITS.perPendingFrames - 2 }, (_, index) => ({
      method: 'item/delta', params: { threadId, sequence: index + 4, delta: { text: 'progress' } },
    }));
    for (const frame of progress) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.error?.code, undefined, 'the superseded hint must not cause -32047');
    assert.equal(response.result?.thread.id, threadId);
    assert.deepEqual(replayed, [other, latest, ...progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [hint, other, latest, ...progress]);
  });

  test(`turn completion can reclaim a superseded full question snapshot (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const first = changed(1);
    const latest = changed(2);
    Object.assign(latest.params.question, { revision: 2, status: 'cancelled' });
    const progress = Array.from({ length: LIMITS.perPendingFrames - 2 }, (_, index) => ({
      method: 'item/delta', params: { threadId: 'thread', sequence: index + 3, delta: { text: 'progress' } },
    }));
    const terminal = { method: 'turn/completed', params: {
      threadId: 'thread', turnId: 'source', sequence: LIMITS.perPendingFrames + 1,
    } };
    for (const frame of [first, latest, ...progress, terminal]) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.error?.code, undefined, 'a superseded snapshot must not cause -32047');
    assert.equal(response.result?.thread.id, 'thread');
    assert.deepEqual(replayed, [latest, ...progress, terminal]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [first, latest, ...progress, terminal]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));

    const replay = fixture(t, shared);
    const exactReplay = structuredClone(first);
    exactReplay.params.sequence = terminal.params.sequence + 1;
    for (const frame of [first, latest, ...progress, terminal, exactReplay]) replay.emit(frame);
    replay.recovering.finish();
    assert.equal(replay.recovering.client.messages[0]?.result?.thread?.id, 'thread');
    assert.deepEqual(replay.recovering.client.messages.slice(1), [latest, ...progress, terminal]);

    const conflicting = fixture(t, shared);
    const conflict = structuredClone(exactReplay);
    conflict.params.question.questions[0].question = 'Conflicting prompt';
    for (const frame of [first, latest, ...progress, terminal, conflict]) conflicting.emit(frame);
    conflicting.recovering.finish();
    assert.equal(conflicting.recovering.client.messages[0]?.error?.code, -32047);
    assert.equal(conflicting.recovering.client.messages.length, 1);
    if (conflicting.owner) {
      assert.deepEqual(conflicting.owner.client.messages.slice(1), [first, latest, ...progress, terminal, conflict]);
    }
  });

  test(`turn progress can reclaim multiple superseded hints at the byte cap (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const snapshots = [changed(4), changed(5)];
    Object.assign(snapshots[1].params.question, {
      questionId: 'second', requestId: 'second-request', toolCallId: 'second-tool',
    });
    const hints = snapshots.map((frame, index) => {
      const { threadId, questionId, requestId, sourceTurnId, toolCallId } = frame.params.question;
      Object.assign(frame.params.question, { revision: 2, status: 'cancelled' });
      return { ...frame, params: { ...frame.params, sequence: index + 1,
        question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 1 } } };
    });
    const conflicting = { ...hints[0], params: { ...hints[0].params, sequence: 3,
      question: { ...hints[0].params.question, toolCallId: 'different-tool', revision: 2 } } };
    const queued = [...hints, conflicting, ...snapshots];
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    const progress = sequence => ({ method: 'item/delta', params: {
      threadId: 'thread', sequence, delta: { text: '' },
    } });
    const filler = progress(6);
    filler.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(filler) -
      queued.reduce((total, frame) => total + bytes(frame), 0));
    const last = progress(7);
    last.params.delta.text = 'x'.repeat(bytes(hints[0]) + bytes(hints[1]) - bytes(last));
    for (const frame of [...queued, filler, last]) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.error?.code, undefined, 'both covered hints make space for the last event');
    assert.equal(response.result?.thread.id, 'thread');
    assert.deepEqual(replayed, [conflicting, ...snapshots, filler, last]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [...queued, filler, last]);
  });

  test(`a growing hint reclaims both older updates and leaves room for turn completion (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const full = changed(2);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId } = full.params.question;
    const hint = { ...full, params: { ...full.params, sequence: 1,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 1 } } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 3, delta: { text: '' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(hint) - bytes(full) - bytes(progress));
    const latest = { ...hint, params: { ...hint.params, sequence: 100,
      question: { ...hint.params.question, revision: 2 } } };
    const terminal = { method: 'turn/completed', params: { threadId, turnId: sourceTurnId,
      attemptId: 'attempt-'.padEnd(256, 'x'), sequence: 101 } };
    const spaceAfterSnapshotReplacement = bytes(full) - bytes(latest);
    assert.ok(bytes(terminal) > spaceAfterSnapshotReplacement);
    assert.ok(bytes(terminal) <= spaceAfterSnapshotReplacement + bytes(hint));

    for (const frame of [hint, full, progress, latest, terminal]) f.emit(frame);
    f.recovering.finish();

    const messages = f.recovering.client.messages;
    assert.equal(messages[0]?.error?.code, undefined, 'the two older updates make room for the latest hint and terminal');
    assert.equal(messages[0]?.result?.thread.id, threadId);
    assert.deepEqual(messages.slice(1), [progress, latest, terminal]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [hint, full, progress, latest, terminal]);

    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId, includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    const question = { ...full.params.question, revision: 2, status: 'cancelled' };
    f.emit({ id: read.id, result: { threadId, questions: [question] } });
    assert.deepEqual(messages.at(-1).result?.questions, [question]);
    assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
  });

  test(`a superseded snapshot leaves room for a different question at the resume cap (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const first = changed(1);
    const latest = changed(2);
    Object.assign(latest.params.question, { revision: 2, status: 'cancelled' });
    const progress = Array.from({ length: LIMITS.perPendingFrames - 2 }, (_, index) => ({
      method: 'item/delta', params: { threadId: 'thread', sequence: index + 3, delta: { text: 'progress' } },
    }));
    for (const frame of [first, latest, ...progress]) f.emit(frame);
    const next = changed(LIMITS.perPendingFrames + 1);
    Object.assign(next.params.question, { questionId: 'next-question', requestId: 'next-request', toolCallId: 'next-tool' });
    f.emit(next);
    f.recovering.finish();

    const messages = f.recovering.client.messages;
    assert.equal(messages[0]?.result?.thread.id, 'thread', 'durable question traffic must not fail resume');
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = next.params.question;
    assert.deepEqual(messages.slice(1), [latest, ...progress, { ...next, params: { ...next.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } }]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [first, latest, ...progress, next]);

    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId, includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    const questions = [latest.params.question, next.params.question];
    f.emit({ id: read.id, result: { threadId, questions } });
    assert.deepEqual(messages.at(-1).result?.questions, questions);
    assert.ok(f.upstream.every(message => ['thread/resume', 'asyncQuestion/list'].includes(message.method)));
  });

  test(`a full resume queue still reconciles an already compacted question (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const snapshots = Array.from({ length: 5 }, (_, index) => {
      const frame = changed(index + 1, true);
      frame.params.question.questionId = `question-${index}`;
      return frame;
    });
    for (const frame of snapshots) f.emit(frame);
    const progress = Array.from({ length: LIMITS.perPendingFrames - snapshots.length }, (_, index) => ({
      method: 'item/delta', params: { threadId: 'thread', sequence: index + 6, delta: { text: 'progress' } },
    }));
    for (const frame of progress) f.emit(frame);
    const latest = changed(LIMITS.perPendingFrames + 1, true);
    Object.assign(latest.params.question, { questionId: 'question-4', revision: 2, status: 'cancelled' });
    f.emit(latest);
    const replay = { ...latest, params: { ...latest.params, sequence: LIMITS.perPendingFrames + 2 } };
    f.emit(replay);
    f.recovering.finish();

    const messages = f.recovering.client.messages;
    assert.equal(messages[0]?.result?.thread?.id, 'thread',
      'replacing a compacted hint must not overflow the original task handoff');
    assert.deepEqual(messages.slice(1, -1), [...snapshots.slice(0, 4), ...progress]);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = latest.params.question;
    assert.deepEqual(messages.at(-1), { ...latest, params: { ...latest.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } });
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [...snapshots, ...progress, latest, replay]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: null and omitted question fields share the resume byte budget`, t => {
    const f = fixture(t, shared);
    const replays = Array.from({ length: 4 }, (_, index) => {
      const frame = changed(index + 1, true);
      if (!(index & 1)) frame.params.question.answer = null;
      if (index & 2) frame.params.question.deliveryError = null;
      return frame;
    });
    for (const frame of replays) f.emit(frame);
    const next = changed(5, true);
    next.params.question.questionId = 'next-question';
    f.emit(next);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, 'thread');
    assert.deepEqual(f.recovering.client.messages.slice(1), [replays[0], next]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });

  for (const large of [false, true]) {
    test(`${shared ? 'shared' : 'exclusive'}: resequenced question replays cannot exhaust resume ${large ? 'bytes' : 'frames'}`, t => {
      const f = fixture(t, shared), first = changed(1, large);
      const repeats = large ? 6 : LIMITS.perPendingFrames + 1;
      for (let sequence = 1; sequence <= repeats; sequence++) f.emit(changed(sequence, large));
      const progress = { method: 'item/delta', params: {
        threadId: 'thread', sequence: repeats + 1, delta: { text: 'progress' },
      } };
      f.emit(progress);
      const answered = changed(repeats + 2, large);
      Object.assign(answered.params.question, { revision: 3, status: 'context_applied',
        answer: { submissionId: 'winner', acceptedAtMs: 2,
          answers: Object.fromEntries(first.params.question.questions.map(item => [item.id, { text: 'Continue' }])) } });
      f.emit(answered);
      f.emit(changed(repeats + 3, large));
      f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'the original app-server succeeded; repeated snapshots must not cause -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [first, progress, answered],
        'keep the first wire frame and real state transitions in their original order');
      assert.equal(f.broker.threadOwners.get('thread'), f.owner?.client ?? f.recovering.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'recovery never resubmits answers, cancels or interrupts');
      if (f.owner) assert.equal(f.owner.client.messages.filter(message => message.method === 'asyncQuestion/changed').length,
        repeats + 2, 'live peers retain their normal deliveries');
    });
  }
}

test('at the resume byte cap, only a newer hint for the same original binding can replace a full snapshot', () => {
  const pending = {};
  for (const [mutate, expected] of [
    [() => {}, true],
    [frame => { frame.params.serverId = 'other-server'; }, false],
    [frame => { frame.params.question.sourceTurnId = 'another-turn'; }, false],
    [frame => { frame.params.question.revision = 1; }, false],
  ]) {
    const buffer = new BrokerResumeNotificationBuffer();
    const first = changed(1);
    assert.equal(buffer.capture(pending, first), true);
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: '' } };
    const remaining = LIMITS.perPendingBytes - Buffer.byteLength(JSON.stringify(first)) -
      Buffer.byteLength(JSON.stringify(progress));
    progress.params.delta = 'x'.repeat(remaining);
    assert.equal(buffer.capture(pending, progress), true);

    const latest = changed(3);
    Object.assign(latest.params.question, { revision: 2, status: 'cancelled' });
    mutate(latest);
    assert.equal(buffer.capture(pending, latest), expected);
    const result = buffer.take(pending);
    assert.equal(result.overflowed, !expected);
    if (expected) {
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0], progress);
      assert.equal(result.messages[1].params.question.revision, 2);
      assert.equal(result.messages[1].params.question.questions, undefined);
    } else {
      assert.deepEqual(result.messages, [first, progress]);
    }
  }
});

test('question replay identity preserves server, source, revision and content differences', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {}, first = changed(1);
  buffer.capture(pending, first);
  const distinct = [
    frame => { frame.params.serverId = 'other-server'; },
    frame => { frame.params.question.sourceTurnId = 'other-source'; },
    frame => { frame.params.question.revision = 2; },
    frame => { frame.params.question.questions[0].question = 'Different question'; },
  ].map((mutate, index) => {
    const frame = changed(index + 2); mutate(frame); return frame;
  });
  for (const frame of distinct) buffer.capture(pending, frame);
  const replay = changed(20);
  assert.equal(buffer.capture(pending, replay), true);
  assert.deepEqual(buffer.take(pending), { messages: [first, ...distinct], overflowed: false });
  assert.equal(first.params.sequence, 1, 'comparison must not rewrite queued wire frames');
  assert.equal(replay.params.sequence, 20, 'comparison must not rewrite incoming wire frames');
});

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: equivalent saved answers cannot exhaust resume frames`, t => {
    const f = fixture(t, shared);
    const answered = mask => {
      const frame = changed(mask + 1);
      const { question } = frame.params;
      question.questions = Array.from({ length: 7 }, (_, index) => ({
        ...question.questions[0], id: `item-${index}`,
      }));
      question.questions[0].options = [{ id: 'yes', label: 'Yes', description: '' }];
      Object.assign(question, {
        revision: 2, status: 'queued',
        answer: { submissionId: 'winner', acceptedAtMs: 2,
          answers: Object.fromEntries(question.questions.map(({ id }, index) =>
            [id, index === 0
              ? { selectedOptionIds: ['yes'], ...(mask & 1 ? { text: null } : {}) }
              : { text: 'Continue', ...(mask & (1 << index) ? { selectedOptionIds: [] } : {}) }])) },
      });
      return frame;
    };
    for (let mask = 0; mask <= LIMITS.perPendingFrames; mask++) f.emit(answered(mask));
    const conflicting = answered(80);
    conflicting.params.question.answer.answers['item-1'].text = 'Different answer';
    f.emit(conflicting);
    const applied = answered(100);
    Object.assign(applied.params.question, { revision: 3, status: 'context_applied' });
    f.emit(applied);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, 'thread',
      'wire defaults for the same saved answer must not cause -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [answered(0), conflicting, applied]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: legacy question hints cannot exhaust resume frames`, t => {
    const f = fixture(t, shared);
    const hint = (sequence, questionId = 'question') => ({
      method: 'asyncQuestion/changed', params: {
        serverId: 'owned', threadId: 'thread', sequence,
        question: { threadId: 'thread', questionId, revision: sequence },
      },
    });
    const repeats = LIMITS.perPendingFrames + 1;
    for (let sequence = 1; sequence <= repeats; sequence++) f.emit(hint(sequence));
    const otherQuestion = hint(repeats + 1, 'other-question');
    const full = changed(repeats + 2);
    Object.assign(full.params.question, { revision: repeats + 2, status: 'cancelled' });
    const latest = hint(repeats + 3);
    const delayed = hint(repeats + 4);
    delayed.params.question.revision = 2;
    f.emit(otherQuestion);
    f.emit(full);
    f.emit(latest);
    f.emit(delayed);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, 'thread',
      'legacy readback hints must not turn a successful upstream resume into -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [otherQuestion, full, latest],
      'keep the highest revision hint at its wire position and ignore a delayed older hint');
    assert.equal(f.broker.threadOwners.get('thread'), f.owner?.client ?? f.recovering.client);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: equivalent JSON-RPC envelopes share resume capacity`, t => {
    const f = fixture(t, shared);
    const original = [];
    for (let index = 0; index < LIMITS.perPendingFrames / 2; index++) {
      const snapshot = changed(index * 2);
      snapshot.params.question.questionId = `question-${index}`;
      snapshot.params.question.toolCallId = `tool-${index}`;
      // Preserve whichever accepted spelling arrived first.
      if (index % 2) snapshot.jsonrpc = '2.0';
      original.push(snapshot);
      f.emit(snapshot);
      const { jsonrpc, ...replay } = snapshot;
      if (jsonrpc === undefined) replay.jsonrpc = '2.0';
      f.emit({ ...replay, params: { ...replay.params, sequence: index * 2 + 1 } });
    }
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(progress);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, 'thread',
      'equivalent envelopes must not turn a successful resume into -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [...original, progress]);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`a terminal can fit by compacting a retained question at the byte cap (shared=${shared})`, t => {
    const f = fixture(t, shared), full = changed(1, true);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const hint = { ...full, params: { ...full.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(full) - bytes(progress));
    const terminal = { method: 'turn/completed', params: { threadId, turnId: sourceTurnId, sequence: 3 } };
    for (const frame of [full, progress, terminal]) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.error?.code, undefined, 'a compact question locator leaves room for the terminal');
    assert.equal(response.result?.thread.id, threadId);
    assert.deepEqual(replayed, [hint, progress, terminal]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [full, progress, terminal]);
    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId, includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    f.emit({ id: read.id, result: { threadId, questions: [full.params.question] } });
    assert.deepEqual(f.recovering.client.messages.at(-1).result?.questions, [full.params.question]);
    assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
  });
}

for (const shared of [false, true]) {
  test(`a new turn can start after a byte-full handoff of an earlier question (shared=${shared})`, t => {
    const f = fixture(t, shared), full = changed(1);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const hint = { ...full, params: { ...full.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const previous = { method: 'turn/completed', params: { threadId, turnId: sourceTurnId, sequence: 3 } };
    const started = { method: 'turn/started', params: { threadId, turnId: 'next', sequence: 4 } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes -
      bytes(full) - bytes(progress) - bytes(previous) - bytes(started) + 1);
    for (const frame of [full, progress, previous, started]) f.emit(frame);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, threadId,
      'compacting the earlier question leaves room for the new turn start');
    assert.deepEqual(f.recovering.client.messages.slice(1), [hint, progress, previous, started]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [full, progress, previous, started]);

    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId, includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    assert.deepEqual(read.params, { threadId, includeTerminal: true });
    f.emit({ id: read.id, result: { threadId, questions: [full.params.question] } });
    assert.deepEqual(f.recovering.client.messages.at(-1).result?.questions, [full.params.question]);
  });
}

for (const shared of [false, true]) {
  test(`resume capacity cannot hide an earlier conflicting question snapshot (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const conflict = changed(1);
    conflict.params.question.questions[0].question = 'Different prompt at the same revision';
    const original = changed(2);
    const cancelled = changed(3);
    Object.assign(cancelled.params.question, { revision: 2, status: 'cancelled' });
    const progress = Array.from({ length: LIMITS.perPendingFrames - 2 }, (_, index) => ({
      method: 'item/delta', params: { threadId: 'thread', sequence: index + 4, delta: { text: 'progress' } },
    }));
    const frames = [conflict, original, cancelled, ...progress];
    for (const frame of frames) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.error?.code, -32047,
      'a newer revision cannot establish which conflicting snapshot is authoritative');
    assert.deepEqual(replayed, []);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), frames);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

test('a newer locator cannot replace one of two conflicting snapshots at the resume frame cap', t => {
  const f = fixture(t, true);
  const conflict = changed(1);
  conflict.params.question.questions[0].question = 'Different prompt at the same revision';
  const original = changed(2);
  const progress = Array.from({ length: LIMITS.perPendingFrames - 2 }, (_, index) => ({
    method: 'item/delta', params: { threadId: 'thread', sequence: index + 3, delta: { text: 'progress' } },
  }));
  const { threadId, questionId, requestId, sourceTurnId, toolCallId } = original.params.question;
  const hint = { ...original, params: { ...original.params, sequence: LIMITS.perPendingFrames + 1,
    question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 2 } } };
  const frames = [conflict, original, ...progress, hint];
  for (const frame of frames) f.emit(frame);
  f.recovering.finish();

  assert.equal(f.recovering.client.messages[0]?.error?.code, -32047);
  assert.deepEqual(f.owner.client.messages.slice(1), frames);
  assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
});

test('terminal byte recovery does not compact conflicting full snapshots at the same revision', t => {
  const f = fixture(t, true), first = changed(1, true), conflict = changed(2, true);
  conflict.params.question.questions[0].question = 'Different prompt at the same revision';
  const progress = { method: 'item/delta', params: { threadId: 'thread', sequence: 3, delta: { text: '' } } };
  const terminal = { method: 'turn/completed', params: { threadId: 'thread', turnId: 'source', sequence: 4 } };
  const used = [first, conflict, progress].reduce((total, frame) =>
    total + Buffer.byteLength(JSON.stringify(frame)), 0);
  progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - used);
  for (const frame of [first, conflict, progress, terminal]) f.emit(frame);
  f.recovering.finish();

  assert.equal(f.recovering.client.messages[0]?.error?.code, -32047);
  assert.deepEqual(f.owner.client.messages.slice(1), [first, conflict, progress, terminal]);
});

for (const shared of [false, true]) {
  test(`a terminal can reclaim bytes from two distinct questions (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const snapshots = [changed(1), changed(2)];
    Object.assign(snapshots[1].params.question, {
      questionId: 'second-question', requestId: 'second-request', toolCallId: 'second-tool',
    });
    const hints = snapshots.map(frame => {
      const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = frame.params.question;
      return { ...frame, params: { ...frame.params,
        question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    });
    const progress = { method: 'item/delta', params: { threadId: 'thread', sequence: 3, delta: { text: '' } } };
    const terminal = { method: 'turn/failed', params: { threadId: 'thread', turnId: 'source', sequence: 4,
      turn: { threadId: 'thread', id: 'source', status: 'failed' },
      error: { code: -32001, message: 'Model request failed' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    const saved = snapshots.map((frame, index) => bytes(frame) - bytes(hints[index]));
    const deficit = Math.max(...saved) + 1;
    assert.ok(deficit <= bytes(terminal) && deficit <= saved[0] + saved[1]);
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(progress) -
      bytes(snapshots[0]) - bytes(snapshots[1]) - bytes(terminal) + deficit);
    for (const frame of [...snapshots, progress, terminal]) f.emit(frame);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, 'thread',
      'the combined savings must prevent a false -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [...hints, progress, terminal]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [...snapshots, progress, terminal]);
    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId: 'thread', includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    const questions = snapshots.map(frame => frame.params.question);
    f.emit({ id: read.id, result: { threadId: 'thread', questions } });
    assert.deepEqual(f.recovering.client.messages.at(-1).result?.questions, questions);
    assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
  });
}

for (const shared of [false, true]) {
  test(`a byte-full resume queue cannot silently compact an incoming same-revision conflict (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const first = changed(2);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = first.params.question;
    const hint = { ...first, params: { ...first.params, sequence: 1,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 3, delta: { text: '' } } };
    const conflict = changed(4);
    conflict.params.question.questions[0].question = 'Different prompt at the same revision';
    const queued = [hint, first, progress];
    const used = queued.reduce((total, frame) => total + Buffer.byteLength(JSON.stringify(frame)), 0);
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - used);
    for (const frame of [...queued, conflict]) f.emit(frame);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.error?.code, -32047,
      'the conflict cannot be delivered in full, so the handoff must request reconciliation');
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [...queued, conflict]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`a distinct question can reclaim bytes from a retained snapshot (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const first = changed(1);
    const next = changed(3);
    Object.assign(next.params.question, {
      questionId: 'next', requestId: 'next-request', toolCallId: 'next-tool',
    });
    const locator = frame => {
      const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = frame.params.question;
      return { ...frame, params: { ...frame.params,
        question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    };
    const firstHint = locator(first), nextHint = locator(next);
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    const progress = { method: 'item/delta', params: { threadId: 'thread', sequence: 2, delta: { text: '' } } };
    const available = bytes(nextHint) - 1;
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - available - bytes(first) - bytes(progress));
    for (const frame of [first, progress, next]) f.emit(frame);
    f.recovering.finish();

    const messages = f.recovering.client.messages;
    assert.equal(messages[0]?.result?.thread.id, 'thread',
      'compacting the first snapshot leaves room to reconcile both durable questions');
    assert.deepEqual(messages.slice(1), [firstHint, progress, nextHint]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [first, progress, next]);

    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId: 'thread', includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    const questions = [first.params.question, next.params.question];
    f.emit({ id: read.id, result: { threadId: 'thread', questions } });
    assert.deepEqual(messages.at(-1).result?.questions, questions);
    assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
  });
}

for (const shared of [false, true]) {
  test(`stream progress can follow a byte-full question handoff (shared=${shared})`, t => {
    const f = fixture(t, shared), full = changed(1, true);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const hint = { ...full, params: { ...full.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const next = { method: 'item/delta', params: { threadId, sequence: 3, delta: { text: 'next' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes -
      bytes(full) - bytes(progress) - bytes(next) + 1);
    for (const frame of [full, progress, next]) f.emit(frame);
    f.recovering.finish();

    assert.equal(f.recovering.client.messages[0]?.result?.thread.id, threadId,
      'the original question locator should leave room for stream progress');
    assert.deepEqual(f.recovering.client.messages.slice(1), [hint, progress, next]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [full, progress, next]);

    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId, includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    assert.deepEqual(read.params, { threadId, includeTerminal: true });
    f.emit({ id: read.id, result: { threadId, questions: [full.params.question] } });
    assert.deepEqual(f.recovering.client.messages.at(-1).result?.questions, [full.params.question]);
  });
}

for (const shared of [false, true]) {
  test(`transport extensions do not multiply a replayed question during resume (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const first = changed(1, true);
    for (let sequence = 1; sequence <= 8; sequence++) {
      const replay = { ...changed(sequence, true), traceId: `delivery-${sequence}` };
      f.emit(replay);
    }
    f.recovering.finish();

    const [response, ...notifications] = f.recovering.client.messages;
    assert.equal(response.result?.thread.id, 'thread');
    assert.deepEqual(notifications.map(frame => frame.params.question), [first.params.question],
      'an unchanged durable question should replay once as a full card');
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`turn completion can reclaim an earlier locator for the same saved revision (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const full = changed(3);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const hint = { ...full, params: { ...full.params, sequence: 1,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const other = { ...hint, params: { ...hint.params, sequence: 2,
      question: { ...hint.params.question, toolCallId: 'different-tool' } } };
    const progress = Array.from({ length: LIMITS.perPendingFrames - 3 }, (_, index) => ({
      method: 'item/delta', params: { threadId, sequence: index + 4, delta: { text: 'progress' } },
    }));
    const terminal = { method: 'turn/completed', params: {
      threadId, turnId: sourceTurnId, sequence: LIMITS.perPendingFrames + 1,
    } };

    for (const frame of [hint, other, full, ...progress, terminal]) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId, JSON.stringify(response.error));
    assert.deepEqual(replayed, [other, full, ...progress, terminal]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [hint, other, full, ...progress, terminal]);
  });
}

test('a complete update corrects a same-sequence sparse hint at the resume frame cap', t => {
  const f = fixture(t, true);
  const original = changed(1);
  f.emit(original);
  const progress = Array.from({ length: LIMITS.perPendingFrames - 1 }, (_, index) => ({
    method: 'item/delta', params: { threadId: 'thread', sequence: index + 2, delta: { text: 'progress' } },
  }));
  for (const frame of progress) f.emit(frame);
  const { threadId, questionId, requestId, sourceTurnId, toolCallId } = original.params.question;
  const terminal = changed(LIMITS.perPendingFrames + 1);
  Object.assign(terminal.params.question, { revision: 2, status: 'cancelled' });
  const hint = { ...terminal, params: { ...terminal.params,
    question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 3 } } };
  f.emit(hint);
  f.emit(terminal);
  f.recovering.finish();

  const messages = f.recovering.client.messages;
  assert.equal(messages[0]?.result?.thread?.id, threadId);
  assert.deepEqual(messages.slice(1), [...progress, terminal]);
  assert.deepEqual(f.owner.client.messages.slice(1), [original, ...progress, hint, terminal]);

  f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
    params: { threadId, includeTerminal: true } }));
  const read = f.upstream.at(-1);
  assert.equal(read.method, 'asyncQuestion/list');
  f.emit({ id: read.id, result: { threadId, questions: [terminal.params.question] } });
  assert.deepEqual(messages.at(-1).result?.questions, [terminal.params.question]);
  assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
});

for (const shared of [false, true]) {
  test(`a byte-full resume replays the corrected same-sequence question locator (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const terminal = changed(1);
    Object.assign(terminal.params.question, { revision: 2, status: 'cancelled' });
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = terminal.params.question;
    const corrected = { ...terminal, params: { ...terminal.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const stale = { ...corrected, params: { ...corrected.params,
      question: { ...corrected.params.question, revision: 3 } } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(stale) - bytes(progress));
    for (const frame of [stale, progress, terminal]) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId, JSON.stringify(response.error));
    assert.equal(replayed.length, 2);
    assert.deepEqual(replayed[0], corrected);
    assert.ok(isDeepStrictEqual(replayed[1], progress), 'subsequent progress must retain its position');
    if (f.owner) assert.ok(isDeepStrictEqual(f.owner.client.messages.slice(1), [stale, progress, terminal]));

    f.broker.receive(f.recovering.client, JSON.stringify({ id: 2, method: 'asyncQuestion/list',
      params: { threadId, includeTerminal: true } }));
    const read = f.upstream.at(-1);
    assert.equal(read.method, 'asyncQuestion/list');
    f.emit({ id: read.id, result: { threadId, questions: [terminal.params.question] } });
    assert.deepEqual(f.recovering.client.messages.at(-1).result?.questions, [terminal.params.question]);
    assert.ok(f.upstream.every(frame => ['thread/resume', 'asyncQuestion/list'].includes(frame.method)));
  });
}

for (const shared of [false, true]) {
  test(`a late sparse replay cannot displace a complete update for the same sequence (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const terminal = changed(1);
    Object.assign(terminal.params.question, { revision: 2, status: 'cancelled' });
    const { threadId, questionId, requestId, sourceTurnId, toolCallId } = terminal.params.question;
    const hint = { ...terminal, params: { ...terminal.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 3 } } };
    const progress = Array.from({ length: LIMITS.perPendingFrames - 1 }, (_, index) => ({
      method: 'item/delta', params: { threadId, sequence: index + 2, delta: { text: 'progress' } },
    }));
    for (const frame of [terminal, ...progress, hint]) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId, JSON.stringify(response.error));
    assert.deepEqual(replayed.map(frame => [frame.method, frame.params.sequence, frame.params.question?.status]),
      [[terminal.method, 1, 'cancelled'], ...progress.map(frame => [frame.method, frame.params.sequence, undefined])]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [terminal, ...progress, hint]);
  });
}

for (const shared of [false, true]) {
  test(`a complete replay clears its same-sequence sparse hint before more progress arrives (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const terminal = changed(1);
    Object.assign(terminal.params.question, { revision: 2, status: 'cancelled' });
    const replay = { ...terminal, params: { ...terminal.params, sequence: 2 } };
    const { threadId, questionId, requestId, sourceTurnId, toolCallId } = terminal.params.question;
    const hint = { ...replay, params: { ...replay.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: 3 } } };
    const progress = Array.from({ length: LIMITS.perPendingFrames - 1 }, (_, index) => ({
      method: 'item/delta', params: { threadId, sequence: index + 3, delta: { text: 'progress' } },
    }));

    for (const frame of [terminal, hint, replay, ...progress]) f.emit(frame);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId, JSON.stringify(response.error));
    assert.deepEqual(replayed, [terminal, ...progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [terminal, hint, replay, ...progress]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`resume cannot reclaim a snapshot with a conflicting source binding (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const original = changed(1), conflict = changed(2), cancelled = changed(3);
    conflict.params.question.sourceTurnId = 'different-turn';
    Object.assign(cancelled.params.question, { revision: 2, status: 'cancelled' });
    const progress = Array.from({ length: LIMITS.perPendingFrames - 2 }, (_, index) => ({
      method: 'item/delta', params: { threadId: 'thread', sequence: index + 4, delta: { text: 'progress' } },
    }));
    const frames = [original, conflict, cancelled, ...progress];
    frames.forEach(f.emit);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.error?.code, -32047,
      'a newer revision cannot hide a disagreement about the original source turn');
    assert.deepEqual(replayed, []);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), frames);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`same-revision conflict remains detectable after compacting a snapshot (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const first = changed(1, true);
    const { threadId } = first.params;
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const next = { method: 'item/delta', params: { threadId, sequence: 3, delta: { text: 'next' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes -
      bytes(first) - bytes(progress) - bytes(next) + 1);
    const replay = changed(4, true);
    // Object field order and transport sequence do not change the snapshot.
    replay.params.question = Object.fromEntries(Object.entries(replay.params.question).reverse());
    const conflict = changed(5, true);
    conflict.params.question.questions[0].question = 'y'.repeat(15_000);
    for (const frame of [first, progress, next, replay]) f.emit(frame);
    const healthy = fixture(t, shared);
    for (const frame of [first, progress, next, replay]) healthy.emit(frame);
    healthy.recovering.finish();
    assert.equal(healthy.recovering.client.messages[0]?.result?.thread.id, threadId);
    assert.equal(healthy.recovering.client.messages.length, 4);

    f.emit(conflict);
    f.recovering.finish();
    assert.equal(f.recovering.client.messages[0]?.error?.code, -32047);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [first, progress, next, replay, conflict]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

test('an existing legacy locator retains the digest of a full snapshot that cannot fit', t => {
  const f = fixture(t, true);
  const full = changed(2);
  const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
  const hint = { ...full, params: { ...full.params, sequence: 1,
    question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
  const progress = { method: 'item/delta', params: { threadId, sequence: 3, delta: { text: '' } } };
  const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
  progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(hint) - bytes(progress));
  const conflict = changed(4);
  conflict.params.question.questions[0].question = 'Conflicting prompt';
  for (const frame of [hint, progress, full, conflict]) f.emit(frame);
  f.recovering.finish();
  assert.equal(f.recovering.client.messages[0]?.error?.code, -32047);
  assert.deepEqual(f.owner.client.messages.slice(1), [hint, progress, full, conflict]);
  assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
});

for (const shared of [false, true]) {
  test(`a same-sequence sparse replay preserves the compacted snapshot revision and digest (shared=${shared})`, t => {
    const snapshot = changed(1, true);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = snapshot.params.question;
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const next = { method: 'item/delta', params: { threadId, sequence: 3, delta: { text: 'next' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes -
      bytes(snapshot) - bytes(progress) - bytes(next) + 1);
    const hint = { ...snapshot, params: { ...snapshot.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: revision + 1 } } };
    const frames = [snapshot, progress, next, hint];

    const conflict = changed(4, true);
    conflict.params.question.questions[0].question = 'Conflicting prompt';
    const conflicting = fixture(t, shared);
    [...frames, conflict].forEach(conflicting.emit);
    conflicting.recovering.finish();
    assert.equal(conflicting.recovering.client.messages[0]?.error?.code, -32047);
    assert.equal(conflicting.recovering.client.messages.length, 1);
    if (conflicting.owner) assert.deepEqual(conflicting.owner.client.messages.slice(1), [...frames, conflict]);

    const healthy = fixture(t, shared);
    frames.forEach(healthy.emit);
    healthy.recovering.finish();
    const [response, ...replayed] = healthy.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId);
    assert.deepEqual(replayed, [
      { ...hint, params: { ...hint.params, question: { ...hint.params.question, revision } } },
      progress,
      next,
    ]);
  });
}

for (const shared of [false, true]) {
  test(`a newer sparse hint keeps evidence of a compacted snapshot conflict (shared=${shared})`, t => {
    const snapshot = changed(1, true);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = snapshot.params.question;
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const next = { method: 'item/delta', params: { threadId, sequence: 3, delta: { text: 'next' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes -
      bytes(snapshot) - bytes(progress) - bytes(next) + 1);
    const compacted = { ...snapshot, params: { ...snapshot.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const hint = { ...compacted, params: { ...compacted.params, sequence: 4,
      question: { ...compacted.params.question, revision: revision + 1 } } };
    const frames = [snapshot, progress, next, hint];
    const conflict = changed(5, true);
    conflict.params.question.questions[0].question = 'Conflicting prompt';

    const conflicting = fixture(t, shared);
    [...frames, conflict].forEach(conflicting.emit);
    conflicting.recovering.finish();
    assert.equal(conflicting.recovering.client.messages[0]?.error?.code, -32047);
    assert.equal(conflicting.recovering.client.messages.length, 1);
    if (conflicting.owner) assert.deepEqual(conflicting.owner.client.messages.slice(1), [...frames, conflict]);
    assert.ok(conflicting.upstream.every(frame => frame.method === 'thread/resume'));

    const healthy = fixture(t, shared);
    frames.forEach(healthy.emit);
    healthy.recovering.finish();
    const [response, ...replayed] = healthy.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId);
    assert.deepEqual(replayed, [compacted, progress, next, hint]);
  });
}

for (const shared of [false, true]) {
  test(`reclaiming covered updates preserves compacted snapshot conflicts (shared=${shared})`, t => {
    const original = changed(1, true);
    Object.assign(original.params.question, {
      revision: 3,
      status: 'delivery_failed',
      deliveryError: 'x'.repeat(2000),
      answer: { submissionId: 'submission', acceptedAtMs: 2,
        answers: Object.fromEntries(original.params.question.questions.map(item => [item.id, { text: 'yes' }])) },
    });
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = original.params.question;
    const locator = { threadId, questionId, requestId, sourceTurnId, toolCallId };
    const hint = { ...original, params: { ...original.params, question: { ...locator, revision } } };
    const newer = structuredClone(original);
    newer.params.sequence = 3;
    Object.assign(newer.params.question, { revision: revision + 1, status: 'cancelled' });
    delete newer.params.question.deliveryError;
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const next = { method: 'item/delta', params: { threadId, sequence: 4, delta: { text: 'next' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(hint) - bytes(newer) - bytes(progress));
    // The newer snapshot exactly fills the queue after the original is compacted.
    const frames = [original, progress, newer, next];
    const conflict = structuredClone(original);
    conflict.params.sequence = 5;
    conflict.params.question.deliveryError = 'Conflicting delivery error';

    const conflicting = fixture(t, shared);
    [...frames, conflict].forEach(conflicting.emit);
    conflicting.recovering.finish();
    assert.equal(conflicting.recovering.client.messages[0]?.error?.code, -32047);
    assert.equal(conflicting.recovering.client.messages.length, 1);
    if (conflicting.owner) assert.deepEqual(conflicting.owner.client.messages.slice(1), [...frames, conflict]);

    const frameFull = fixture(t, shared);
    const fillers = Array.from({ length: LIMITS.perPendingFrames - 3 }, (_, index) => ({
      method: 'item/delta', params: { threadId, sequence: index + 3, delta: { text: 'progress' } },
    }));
    const frameCapSnapshot = structuredClone(newer);
    frameCapSnapshot.params.sequence = LIMITS.perPendingFrames + 1;
    const extraBytes = fillers.reduce((sum, frame) => sum + bytes(frame), bytes(frameCapSnapshot) - bytes(newer));
    const shorterProgress = structuredClone(progress);
    shorterProgress.params.delta.text = shorterProgress.params.delta.text.slice(extraBytes);
    const terminal = { method: 'turn/completed', params: {
      threadId, turnId: sourceTurnId, sequence: LIMITS.perPendingFrames + 2,
    } };
    [original, shorterProgress, ...fillers, frameCapSnapshot, terminal].forEach(frameFull.emit);
    frameFull.recovering.finish();
    assert.equal(frameFull.recovering.client.messages[0]?.error?.code, undefined,
      'a covered compressed snapshot must not block a terminal event at the frame cap');
    assert.deepEqual(frameFull.recovering.client.messages.slice(1),
      [shorterProgress, ...fillers, frameCapSnapshot, terminal]);

    const healthy = fixture(t, shared);
    [...frames, original].forEach(healthy.emit);
    healthy.recovering.finish();
    const [response, ...replayed] = healthy.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId);
    assert.deepEqual(replayed.map(frame => frame.params.sequence), [2, 3, 4]);
    assert.deepEqual(replayed, [progress, newer, next]);
    assert.ok(healthy.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`a newer compacted snapshot preserves evidence for the previous revision (shared=${shared})`, t => {
    const original = changed(1, true);
    const newer = changed(4, true);
    Object.assign(newer.params.question, { revision: 2, status: 'cancelled' });
    const hint = frame => {
      const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = frame.params.question;
      return { ...frame, params: { ...frame.params,
        question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    };
    const progress = { method: 'item/delta', params: { threadId: 'thread', sequence: 2, delta: { text: '' } } };
    const next = { method: 'item/delta', params: { threadId: 'thread', sequence: 3, delta: { text: 'x'.repeat(1000) } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes -
      bytes(hint(original)) - bytes(hint(newer)) - bytes(progress) - bytes(next));
    // Progress compacts the first snapshot and leaves room for only the newer locator.
    const frames = [original, progress, next, newer];
    const conflict = changed(5, true);
    conflict.params.question.questions[0].question = 'Conflicting prompt';

    const conflicting = fixture(t, shared);
    [...frames, conflict].forEach(conflicting.emit);
    conflicting.recovering.finish();
    assert.equal(conflicting.recovering.client.messages[0]?.error?.code, -32047);
    assert.equal(conflicting.recovering.client.messages.length, 1);
    if (conflicting.owner) assert.deepEqual(conflicting.owner.client.messages.slice(1), [...frames, conflict]);

    const healthy = fixture(t, shared);
    [...frames, original, newer].forEach(healthy.emit);
    healthy.recovering.finish();
    const [response, ...replayed] = healthy.recovering.client.messages;
    assert.equal(response.result?.thread.id, 'thread');
    assert.deepEqual(replayed, [progress, next, hint(newer)]);
    assert.ok(healthy.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

test('superseded compaction evidence is bounded and released with the handoff', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const pending = {};
  const fill = { method: 'item/delta', params: { threadId: 'thread', sequence: 0, delta: { text: '' } } };
  fill.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - 1024 - Buffer.byteLength(JSON.stringify(fill)));
  const captureRevision = revision => {
    const frame = changed(revision, true);
    frame.params.question.revision = revision;
    return buffer.capture(pending, frame);
  };

  assert.equal(buffer.capture(pending, fill), true);
  for (let revision = 1; revision <= LIMITS.perPendingFrames + 1; revision++) {
    assert.equal(captureRevision(revision), true);
  }
  assert.equal(captureRevision(LIMITS.perPendingFrames + 2), false);
  assert.equal(buffer.take(pending).overflowed, true);
  assert.equal(buffer.capture(pending, fill), true);
  assert.equal(captureRevision(1), true);
  assert.equal(buffer.take(pending).overflowed, false);
});

for (const shared of [false, true]) {
  test(`a same-sequence snapshot corrects a higher sparse revision at the byte cap (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const full = { ...changed(1), jsonrpc: '2.0' };
    Object.assign(full.params.question, { revision: 2, status: 'cancelled' });
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const corrected = { ...full, params: { ...full.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const hint = { method: full.method, params: { ...corrected.params,
      question: { ...corrected.params.question, revision: 999 } } };
    const other = changed(2, true);
    other.params.question.questionId = 'other-question';
    const terminal = { method: 'turn/completed', params: { threadId, turnId: sourceTurnId, sequence: 3 } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 4, delta: { text: '' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes -
      [hint, other, terminal, progress].reduce((size, frame) => size + bytes(frame), 0));
    assert.ok(bytes(corrected) > bytes(hint), 'the correction needs spare bytes even after compaction');

    for (const frame of [hint, other, terminal, progress, full]) f.emit(frame);
    f.recovering.finish();

    const [response, question, otherQuestion, ...rest] = f.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId);
    assert.equal(question?.params.question.revision, revision, 'the full snapshot owns this sequence');
    assert.deepEqual(question, corrected);
    assert.equal(otherQuestion.params.question.questionId, 'other-question');
    assert.equal(otherQuestion.params.question.questions, undefined);
    assert.deepEqual(rest, [terminal, progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [hint, other, terminal, progress, full]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`a compacted snapshot owns its sequence even after an earlier same-revision hint (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const full = changed(3);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const compact = { ...full, params: { ...full.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const early = { ...compact, params: { ...compact.params, sequence: 1 } };
    const progress = { method: 'item/delta', params: { threadId, sequence: 2, delta: { text: '' } } };
    const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
    progress.params.delta.text = 'x'.repeat(LIMITS.perPendingBytes - bytes(early) - bytes(progress));
    const delayed = { ...compact, params: { ...compact.params,
      question: { ...compact.params.question, revision: 999 } } };

    [early, progress, full, delayed].forEach(f.emit);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.error?.code, undefined, 'a stale hint must not cause -32047');
    assert.equal(response.result?.thread.id, threadId);
    assert.deepEqual(replayed, [early, progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [early, progress, full, delayed]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

for (const shared of [false, true]) {
  test(`a deduplicated full replay still covers its sequence's legacy hint (shared=${shared})`, t => {
    const f = fixture(t, shared);
    const first = changed(1);
    const replaySequence = LIMITS.perPendingFrames + 1;
    const replay = changed(replaySequence);
    const { threadId, questionId, revision } = first.params.question;
    const hint = { method: replay.method, params: { ...replay.params,
      question: { threadId, questionId, revision },
    } };
    const progress = Array.from({ length: LIMITS.perPendingFrames - 1 }, (_, index) => ({
      method: 'item/delta', params: { threadId, sequence: index + 2, delta: { text: 'progress' } },
    }));
    [first, ...progress, replay, hint].forEach(f.emit);
    f.recovering.finish();

    const [response, ...replayed] = f.recovering.client.messages;
    assert.equal(response.result?.thread.id, threadId, JSON.stringify(response.error));
    assert.deepEqual(replayed, [first, ...progress]);
    assert.ok(f.upstream.every(frame => frame.method === 'thread/resume'));
  });
}

test('a deduplicated replay does not cover a hint with a conflicting source', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const pending = {};
  const first = changed(1);
  const replay = changed(2);
  const { threadId, questionId, revision } = replay.params.question;
  const hint = { method: replay.method, params: { ...replay.params,
    question: { threadId, questionId, revision, toolCallId: 'other-tool' },
  } };
  for (const frame of [first, replay, hint]) assert.equal(buffer.capture(pending, frame), true);
  assert.deepEqual(buffer.take(pending), { overflowed: false, messages: [first, hint] });
});
