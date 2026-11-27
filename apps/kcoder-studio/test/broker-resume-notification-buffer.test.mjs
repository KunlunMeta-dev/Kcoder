import test from 'node:test';
import assert from 'node:assert/strict';
import { asyncQuestionReplayIdentity } from '../src/broker-async-question-answer.js';
import {
  BrokerResumeNotificationBuffer,
  makeResumeNotificationHandoffIncompleteResponse,
  RESUME_NOTIFICATION_HANDOFF_INCOMPLETE_CODE,
  RESUME_NOTIFICATION_BUFFER_LIMITS,
} from '../src/broker-resume-notification-buffer.js';

test('per-resume frame cap is sticky until the pending handoff is released', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const pending = {};
  const frames = Array.from({ length: RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1 }, (_, index) => ({
    jsonrpc: '2.0', method: 'item/event', params: { index },
  }));

  for (const frame of frames.slice(0, -1)) assert.equal(buffer.capture(pending, frame), true);
  assert.equal(buffer.capture(pending, frames.at(-1)), false);
  assert.equal(buffer.capture(pending, { jsonrpc: '2.0', method: 'turn/completed' }), false,
    'an overflowed handoff cannot silently resume buffering later events');

  const taken = buffer.take(pending);
  assert.equal(taken.overflowed, true);
  assert.equal(taken.messages.length, RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames);
  assert.equal(buffer.capture({}, frames[0]), true, 'taking a queue releases its frame and byte budget');
});

test('per-resume byte cap counts serialized UTF-8 bytes', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const pending = {};
  const oversizedUtf8 = { jsonrpc: '2.0', method: 'item/event', params: { text: 'é'.repeat(128 * 1024) } };

  assert.equal(buffer.capture(pending, oversizedUtf8), false,
    'two-byte UTF-8 characters exceed the byte cap even when their JavaScript string length does not');
  assert.equal(buffer.isOverflowed(pending), true);
  assert.equal(buffer.capture({}, { jsonrpc: '2.0', method: 'turn/completed' }), true);
});

test('large desktop screenshots do not block resume or change the live completion', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const pending = {};
  const item = {
    id: 'screenshot', name: 'mcp__kcoder_computer_use__Snapshot', status: 'completed',
    output: 'UI tree', outputImages: [{ mimeType: 'image/jpeg', data: 'A'.repeat(1536 * 1024) }],
  };
  const completion = { jsonrpc: '2.0', method: 'item/completed', params: { sequence: 4, item } };
  const terminal = { jsonrpc: '2.0', method: 'turn/completed', params: { sequence: 5 } };
  assert.equal(buffer.capture(pending, completion), true);
  assert.equal(buffer.capture(pending, terminal), true);
  assert.deepEqual(buffer.take(pending), { overflowed: false, messages: [
    { ...completion, params: { sequence: 4, item: { ...item, outputImages: [], outputImagesOmitted: true } } },
    terminal,
  ] });
  assert.equal(completion.params.item.outputImages[0].data.length, 1536 * 1024);
  const longItem = { ...item, output: '\0'.repeat(64 * 1024) };
  assert.equal(buffer.capture(pending, { ...completion, params: { item: longItem } }), true);
  const compact = buffer.take(pending).messages[0].params.item;
  assert.equal(compact.status, 'completed');
  assert.equal(compact.output, null);
  assert.equal(compact.outputTruncated, true);
  assert.equal(compact.outputImagesOmitted, true);
  assert.equal(longItem.output.length, 64 * 1024);
  assert.equal(buffer.capture({}, { ...completion, params: { item: { ...item, name: 'mcp__external__Snapshot' } } }), false);
});

test('replacing a legacy hint reuses exactly its frame and byte capacity', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  const { perPendingFrames, perPendingBytes } = RESUME_NOTIFICATION_BUFFER_LIMITS;
  const hint = revision => ({ method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'question', revision } } });
  const old = hint(1), latest = hint(2);
  const delta = { method: 'item/delta', params: { text: '' } };
  const bytes = frame => Buffer.byteLength(JSON.stringify(frame), 'utf8');
  const smallDeltas = Array.from({ length: perPendingFrames - 2 }, () => delta);
  const padding = { ...delta, params: { text: 'x'.repeat(perPendingBytes - bytes(old) -
    (smallDeltas.length + 1) * bytes(delta)) } };
  const stream = [...smallDeltas, padding];
  assert.equal(buffer.capture(pending, old), true);
  for (const frame of stream) assert.equal(buffer.capture(pending, frame), true);
  assert.equal(buffer.capture(pending, latest), true);
  // One additional digit needs one byte and cannot silently overfill the queue.
  assert.equal(buffer.capture(pending, hint(10)), false);
  assert.deepEqual(buffer.take(pending), { messages: [...stream, latest], overflowed: true });
});

test('global byte cap is shared by independent pending resumes and discard releases it', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const payload = 'x'.repeat(240 * 1024);
  const pending = Array.from({ length: 9 }, () => ({}));
  const eventFor = index => ({ jsonrpc: '2.0', method: 'item/event', params: {
    threadId: `global-${index}`, event: { type: 'message_delta', text: payload },
  } });

  for (let index = 0; index < 8; index += 1) assert.equal(buffer.capture(pending[index], eventFor(index)), true);
  assert.equal(buffer.capture(pending[8], eventFor(8)), false,
    'the ninth individually bounded event exceeds the shared two MiB limit');
  for (let index = 0; index < 8; index += 1) assert.equal(buffer.discard(pending[index]), true);
  assert.equal(buffer.capture({}, eventFor('after-release')), true,
    'discard returns aggregate byte capacity to future pending handoffs');
});

test('global frame cap is fixed and taking buffered events releases the shared count', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const pending = Array.from({ length: RESUME_NOTIFICATION_BUFFER_LIMITS.globalFrames + 1 }, () => ({}));
  const event = { jsonrpc: '2.0', method: 'turn/completed' };

  for (let index = 0; index < RESUME_NOTIFICATION_BUFFER_LIMITS.globalFrames; index += 1) {
    assert.equal(buffer.capture(pending[index], event), true);
  }
  assert.equal(buffer.capture(pending.at(-1), event), false);
  for (const candidate of pending.slice(0, -1)) buffer.take(candidate);
  assert.equal(buffer.capture({}, event), true);
});

test('typed handoff failure says upstream succeeded and scopes explicit retry to thread resume', () => {
  assert.deepEqual(makeResumeNotificationHandoffIncompleteResponse('client-id'), {
    jsonrpc: '2.0',
    id: 'client-id',
    error: {
      code: RESUME_NOTIFICATION_HANDOFF_INCOMPLETE_CODE,
      message: 'The app-server resumed this thread, but the Gateway could not safely deliver every notification received during handoff. Retry thread/resume to reconcile the thread before continuing.',
      data: { gatewayRecoveryV1: {
        kind: 'resume_notification_handoff_incomplete',
        upstreamOutcome: 'succeeded',
        retryScope: 'thread/resume',
      } },
    },
  });
});


const questionUpdate = () => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision: 1, status: 'pending',
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
    questions: [{ id: 'item', header: 'Choice', question: 'Continue?', options: [], multiSelect: false }],
  },
} });

test('a delivered readback hint cannot clear evidence of a compacted snapshot', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  const snapshot = questionUpdate();
  snapshot.params.sequence = 2;
  snapshot.params.question.questions[0].question = 'Continue? '.repeat(1000);
  const { status, createdAtMs, questions, ...locator } = snapshot.params.question;
  const hint = { ...snapshot, params: { ...snapshot.params, sequence: 3, question: locator } };
  const delta = { method: 'item/delta', params: { text: 'x'.repeat(250 * 1024) } };
  assert.equal(buffer.capture(pending, delta), true);
  assert.equal(buffer.capture(pending, snapshot), true);
  buffer.discardReplayedQuestion(pending, hint, asyncQuestionReplayIdentity(hint));

  const conflict = questionUpdate();
  conflict.params.sequence = 4;
  assert.equal(buffer.capture(pending, conflict), false,
    'a same-revision conflict must still be detected after a sparse live update');
  assert.equal(buffer.take(pending).overflowed, true);
});

for (const difference of ['task', 'question', 'content']) {
  test(`question ${difference} differences remain distinct and cannot bypass the frame cap`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {};
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++) {
      const frame = questionUpdate();
      if (difference === 'task') frame.params.threadId = frame.params.question.threadId = `thread-${index}`;
      if (difference === 'question') frame.params.question.questionId = `question-${index}`;
      if (difference === 'content') frame.params.question.questions[0].question = `Continue with option ${index}?`;
      assert.equal(buffer.capture(pending, frame), index < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames);
    }
    assert.equal(buffer.isOverflowed(pending), true);
    assert.equal(buffer.capture(pending, questionUpdate()), false, 'deduplication cannot clear overflow');
  });
}

for (const release of ['take', 'discard', 'clear']) {
  test(`${release} releases question deduplication together with the owned queue`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {}, frame = questionUpdate();
    assert.equal(buffer.capture(pending, frame), true);
    assert.equal(buffer.capture(pending, structuredClone(frame)), true);
    buffer[release](pending);
    assert.equal(buffer.capture(pending, structuredClone(frame)), true);
    assert.deepEqual(buffer.take(pending), { messages: [frame], overflowed: false });
  });
}

test('identical question frames count independently for separate recovering clients', () => {
  const buffer = new BrokerResumeNotificationBuffer(), first = {}, second = {}, frame = questionUpdate();
  for (const pending of [first, second]) {
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
      assert.equal(buffer.capture(pending, structuredClone(frame)), true);
    assert.deepEqual(buffer.take(pending), { messages: [frame], overflowed: false });
  }
});

test('duplicate stream deltas remain real events and retain overflow protection', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  const frame = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'a' } } };
  for (let index = 0; index < RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
    assert.equal(buffer.capture(pending, structuredClone(frame)), true);
  assert.equal(buffer.capture(pending, frame), false);
  assert.equal(buffer.take(pending).messages.length, RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames);
});

for (const kind of ['question', 'approval']) {
  test(`identical ${kind} receipts share capacity while distinct bindings and outcomes keep their order`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {};
    const field = kind === 'question' ? 'questionId' : 'approvalId';
    const receipt = { method: `${kind}/resolved`, params: { threadId: 'thread', turnId: 'turn',
      requestId: 500, [field]: 'interaction', appServerEpoch: 'epoch', reason: 'client_response',
      ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
      assert.equal(buffer.capture(pending, structuredClone(receipt)), true);
    assert.equal(buffer.capture(pending, { ...receipt, jsonrpc: '2.0' }), true);
    const distinct = ['threadId', 'turnId', 'requestId', field, 'appServerEpoch', 'reason',
      ...(kind === 'approval' ? ['decision'] : [])].map(key => ({ ...receipt,
        params: { ...receipt.params, [key]: key === 'requestId' ? 501 : `other-${key}` } }));
    for (const frame of distinct) assert.equal(buffer.capture(pending, frame), true);
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'a' } } };
    assert.equal(buffer.capture(pending, progress), true);
    assert.deepEqual(buffer.take(pending), { messages: [receipt, ...distinct, progress], overflowed: false });
    assert.equal(buffer.capture(pending, receipt), true, 'release forgets deduplication with the queue');
    assert.deepEqual(buffer.take(pending), { messages: [receipt], overflowed: false });
  });
}

test('async question replay does not renormalize retained saved answers', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  let retainedAnswerReads = 0;
  const frames = Array.from({ length: 32 }, (_, index) => {
    const frame = questionUpdate();
    const { question } = frame.params;
    question.questionId = `question-${index}`;
    question.status = 'queued';
    question.revision = 2;
    const body = 'x'.repeat(4 * 1024);
    question.answer = { submissionId: 'submission', acceptedAtMs: 2,
      answers: { item: { get text() { retainedAnswerReads++; return body; } } } };
    return frame;
  });
  for (const frame of frames) assert.equal(buffer.capture(pending, frame), true);
  const last = frames.at(-1);
  const replay = structuredClone(last);
  retainedAnswerReads = 0;
  for (let index = 0; index < 200; index++) {
    replay.params.sequence = index;
    assert.equal(buffer.capture(pending, replay), true);
  }
  assert.equal(retainedAnswerReads, 0, 'new replays should only normalize their own answers');
  assert.deepEqual(buffer.take(pending), { messages: frames, overflowed: false });
});

test('compacting another snapshot preserves the frame slot of a growing question hint', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  const { perPendingFrames, perPendingBytes } = RESUME_NOTIFICATION_BUFFER_LIMITS;
  const hint = revision => ({ method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'hint', revision } } });
  const full = questionUpdate();
  const delta = { method: 'item/delta', params: { text: '' } };
  const bytes = frame => Buffer.byteLength(JSON.stringify(frame), 'utf8');
  const old = hint(9), latest = hint(10);
  const deltas = Array.from({ length: perPendingFrames - 3 }, () => delta);
  const padding = { ...delta, params: { text: 'x'.repeat(perPendingBytes - bytes(old) -
    bytes(full) - (deltas.length + 1) * bytes(delta)) } };
  const stream = [...deltas, padding];

  for (const frame of [old, full, ...stream]) assert.equal(buffer.capture(pending, frame), true);
  assert.equal(buffer.capture(pending, latest), true);
  const { messages, overflowed } = buffer.take(pending);
  assert.equal(overflowed, false);
  assert.equal(messages.length, perPendingFrames);
  const { status, createdAtMs, questions, ...locator } = full.params.question;
  assert.deepEqual(messages, [{ ...full, params: { ...full.params, question: locator } }, ...stream, latest]);
});

test('a growing locator can reclaim an already covered locator without compacting conflicting snapshots', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const pending = {};
  const full = questionUpdate();
  const conflict = questionUpdate();
  conflict.params.question.questions[0].question = 'Try again?';
  const hint = (questionId, revision) => ({
    method: 'asyncQuestion/changed', params: { threadId: 'thread', question: {
      ...full.params.question, questions: undefined, status: undefined, createdAtMs: undefined,
      questionId, revision,
    } },
  });
  const older = hint('growing', 9);
  const latest = hint('growing', 10);
  const covered = hint('question', 1);
  const padding = { method: 'item/delta', params: { text: '' } };
  const initial = [older, covered, full, conflict, padding];
  const bytes = initial.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0);
  padding.params.text = 'x'.repeat(RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes - bytes);

  for (const frame of initial) assert.equal(buffer.capture(pending, frame), true);
  assert.equal(buffer.capture(pending, latest), true);
  assert.deepEqual(buffer.take(pending), { messages: [full, conflict, padding, latest], overflowed: false });
});

for (const conflicting of [false, true]) {
  test(`a replay of a reclaimed snapshot preserves recovery (conflicting=${conflicting})`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {};
    const full = questionUpdate();
    full.params.sequence = 1;
    const { status, createdAtMs, questions, ...locator } = full.params.question;
    const hint = { ...full, params: { ...full.params, sequence: 2, question: { ...locator, revision: 2 } } };
    const delta = { method: 'item/delta', params: { text: 'progress' } };
    const stream = Array.from({ length: RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames - 1 }, () => delta);

    for (const frame of [full, ...stream]) assert.equal(buffer.capture(pending, frame), true);
    assert.equal(buffer.capture(pending, hint), true, 'the newer locator reclaims the only full snapshot');
    const replay = structuredClone(full);
    replay.params.sequence = hint.params.sequence;
    if (conflicting) replay.params.question.questions[0].question = 'Conflicting prompt';

    assert.equal(buffer.capture(pending, replay), !conflicting);
    assert.deepEqual(buffer.take(pending), {
      messages: [...stream, conflicting ? hint : replay], overflowed: conflicting,
    });
  });
}

test('refusing a handoff at the question digest cap leaves its snapshots and global budget intact', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  const { perPendingFrames, perPendingBytes, globalFrames, globalBytes } = RESUME_NOTIFICATION_BUFFER_LIMITS;
  const bytes = frame => Buffer.byteLength(JSON.stringify(frame));
  const delta = text => ({ method: 'item/delta', params: { text } });
  const snapshot = revision => {
    const frame = questionUpdate();
    frame.params.sequence = revision;
    frame.params.question.revision = revision;
    return frame;
  };
  const hint = revision => {
    const frame = snapshot(revision);
    delete frame.params.question.questions;
    delete frame.params.question.createdAtMs;
    delete frame.params.question.status;
    return frame;
  };

  // Put this handoff at the shared frame cap so each new hint reclaims
  // its predecessor and the handoff retains the bounded conflict evidence.
  const peers = Array.from({ length: globalFrames - 1 }, () => ({}));
  for (const peer of peers) assert.equal(buffer.capture(peer, delta('')), true);
  for (let revision = 1; revision <= perPendingFrames; revision++) {
    assert.equal(buffer.capture(pending, snapshot(revision)), true);
    assert.equal(buffer.capture(pending, hint(revision + 1)), true);
  }
  for (const peer of peers) buffer.discard(peer);

  const older = snapshot(perPendingFrames + 1);
  const newer = snapshot(perPendingFrames + 2);
  const padding = delta('x'.repeat(perPendingBytes - bytes(older) - bytes(newer) - bytes(delta(''))));
  for (const frame of [older, newer, padding]) assert.equal(buffer.capture(pending, frame), true);
  // Admission would reclaim the older snapshot and compact the newer one,
  // but the older snapshot's digest cannot fit in the conflict evidence.
  assert.equal(buffer.capture(pending, delta('x'.repeat(bytes(older) - bytes(delta('')) + 1))), false);
  assert.deepEqual(buffer.take(pending), { messages: [older, newer, padding], overflowed: true });

  const fullBudgetFrame = delta('x'.repeat(perPendingBytes - bytes(delta(''))));
  for (let remaining = globalBytes; remaining > 0; remaining -= perPendingBytes)
    assert.equal(buffer.capture({}, fullBudgetFrame), true, 'taking a refused handoff returns all of its bytes');
});

test('a replay of a compacted question covers a late partial hint for the replay sequence', () => {
  const buffer = new BrokerResumeNotificationBuffer(), pending = {};
  const snapshot = questionUpdate();
  snapshot.params.sequence = 1;
  snapshot.params.question.questions[0].question = 'Continue? '.repeat(1000);
  const { threadId, questionId, revision } = snapshot.params.question;
  const progress = { method: 'item/delta', params: { text: 'progress' } };
  const padding = { method: 'item/delta', params: { text: 'x'.repeat(250 * 1024) } };
  const stream = [padding, ...Array.from(
    { length: RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames - 2 }, () => progress,
  )];
  for (const frame of [...stream, snapshot]) assert.equal(buffer.capture(pending, frame), true);
  const replay = { ...snapshot, params: { ...snapshot.params, sequence: 2 } };
  assert.equal(buffer.capture(pending, replay), true);
  const hint = { ...replay, params: { ...replay.params, question: { threadId, questionId, revision } } };

  assert.equal(buffer.capture(pending, hint), true, 'the replay already covers this partial locator');
  const { messages, overflowed } = buffer.take(pending);
  assert.equal(overflowed, false);
  assert.equal(messages.length, RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames);
  assert.deepEqual(messages.slice(0, -1), stream);
  assert.equal(messages.at(-1).params.sequence, 1);
  assert.equal(messages.at(-1).params.question.questions, undefined);
});

for (const replaySequence of [1, 3]) {
  test(`a reclaimed question covers a late partial hint (sequence=${replaySequence})`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {};
    const snapshot = questionUpdate();
    snapshot.params.sequence = 1;
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = snapshot.params.question;
    const newerHint = { ...snapshot, params: { ...snapshot.params, sequence: 2,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: revision + 1 } } };
    const delta = { method: 'item/delta', params: { text: 'progress' } };
    const stream = Array.from({ length: RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames - 1 }, () => delta);
    for (const frame of [snapshot, ...stream, newerHint]) assert.equal(buffer.capture(pending, frame), true);

    const replay = { ...snapshot, params: { ...snapshot.params, sequence: replaySequence } };
    if (replaySequence !== snapshot.params.sequence) assert.equal(buffer.capture(pending, replay), true);
    const hint = { ...replay, params: { ...replay.params, question: { threadId, questionId, revision } } };
    assert.equal(buffer.capture(pending, hint), true, 'the verified snapshot covers this partial locator');
    assert.deepEqual(buffer.take(pending), { messages: [...stream, newerHint], overflowed: false });
  });
}

for (const newerIsHint of [true, false]) {
  test(`an older compacted snapshot retains conflict evidence (newer is hint: ${newerIsHint})`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {};
    const snapshot = questionUpdate();
    snapshot.params.sequence = 1;
    snapshot.params.question.questions[0].question = 'Continue? '.repeat(1000);
    const { status, createdAtMs, questions, ...locator } = snapshot.params.question;
    const newerQuestion = { ...locator, revision: 2 };
    if (!newerIsHint) Object.assign(newerQuestion, {
      status: 'queued', createdAtMs, questions,
      answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'Yes' } } },
    });
    const newer = { ...snapshot, params: { ...snapshot.params, sequence: 2, question: newerQuestion } };
    const padding = { method: 'item/delta', params: { text: 'x'.repeat(newerIsHint ? 250 * 1024 : 240 * 1024 + 1024) } };

    for (const frame of [newer, padding, snapshot]) assert.equal(buffer.capture(pending, frame), true);
    const replay = structuredClone(snapshot);
    assert.equal(buffer.capture(pending, replay), true, 'an exact replay still fits');
    replay.params.question.questions[0].question = 'A conflicting prompt';
    assert.equal(buffer.capture(pending, replay), false, 'newer readback cannot hide an older snapshot conflict');
    assert.deepEqual(buffer.take(pending), { messages: [newer, padding], overflowed: true });
  });
}
