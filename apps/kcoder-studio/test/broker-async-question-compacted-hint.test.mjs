import assert from 'node:assert/strict';
import test from 'node:test';
import { BrokerResumeNotificationBuffer, RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

for (const conflict of [false, true]) {
  test(`a newer readback hint can replace a compacted question without losing its digest (conflict=${conflict})`, () => {
    const buffer = new BrokerResumeNotificationBuffer(() => 'current');
    const pending = {};
    const locator = { threadId: 'thread', questionId: 'question', requestId: 'request',
      sourceTurnId: 'source', toolCallId: 'tool', revision: 1 };
    const update = (sequence, question) => ({
      method: 'asyncQuestion/changed', params: { threadId: 'thread', sequence, question },
    });
    const compacted = update(1, locator);
    const snapshot = update(1, { ...locator, status: 'pending', createdAtMs: 1,
      questions: [{ id: 'item', header: 'Details', question: 'Continue?', options: [], multiSelect: false }],
    });
    const newer = update(2, { ...locator, revision: 2 });
    const { perPendingFrames, perPendingBytes } = RESUME_NOTIFICATION_BUFFER_LIMITS;
    const progress = Array.from({ length: perPendingFrames - 1 }, (_, index) =>
      ({ method: 'item/delta', params: { threadId: 'thread', text: String(index) } }));
    const bytes = [...progress, compacted].reduce((total, frame) =>
      total + Buffer.byteLength(JSON.stringify(frame)), 0);
    progress[0].params.text += 'x'.repeat(perPendingBytes - bytes);

    for (const frame of [...progress, snapshot]) assert.equal(buffer.capture(pending, frame), true);
    assert.equal(buffer.capture(pending, newer), true, 'the superseded locator needs no separate frame');

    const replay = structuredClone(snapshot);
    replay.params.sequence = 3;
    if (conflict) replay.params.question.questions[0].question = 'Different prompt';
    assert.equal(buffer.capture(pending, replay), !conflict);
    assert.deepEqual(buffer.take(pending), { messages: [...progress, newer], overflowed: conflict });
  });
}

test('correcting a partial hint reclaims the older compact locator when the byte budget is full', () => {
  const buffer = new BrokerResumeNotificationBuffer();
  const pending = {};
  const binding = { threadId: 'thread', questionId: 'question', requestId: 'request',
    sourceTurnId: 'source', toolCallId: 'tool' };
  const update = (sequence, question) => ({
    method: 'asyncQuestion/changed', params: { threadId: 'thread', sequence, question },
  });
  const snapshot = revision => update(revision, { ...binding, revision, status: 'pending', createdAtMs: 1,
    questions: [{ id: 'item', header: 'Details', question: 'Continue?', options: [], multiSelect: false }],
  });
  const olderLocator = update(1, { ...binding, revision: 1 });
  const partial = update(2, { threadId: 'thread', questionId: 'question', revision: 2 });
  const corrected = update(2, { ...binding, revision: 2 });
  const padding = { method: 'item/delta', params: { text: '' } };
  const progress = { method: 'item/delta', params: { text: 'after the hint' } };
  const bytes = [olderLocator, partial, padding, progress].reduce((total, frame) =>
    total + Buffer.byteLength(JSON.stringify(frame)), 0);
  padding.params.text = 'x'.repeat(RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes - bytes);

  for (const frame of [padding, snapshot(1), partial, progress])
    assert.equal(buffer.capture(pending, frame), true);
  assert.equal(buffer.capture(pending, snapshot(2)), true, 'the older locator has room for the correction');
  assert.equal(buffer.capture(pending, snapshot(1)), true, 'the displaced snapshot can still be deduplicated');
  assert.deepEqual(buffer.take(pending), { messages: [padding, corrected, progress], overflowed: false });
});

for (const conflict of [false, true]) {
  test(`a newer compacted snapshot covers an older full frame at the frame limit (conflict=${conflict})`, () => {
    const buffer = new BrokerResumeNotificationBuffer();
    const pending = {};
    const locator = { threadId: 'thread', questionId: 'question', requestId: 'request',
      sourceTurnId: 'source', toolCallId: 'tool' };
    const update = (sequence, question) => ({
      method: 'asyncQuestion/changed', params: { threadId: 'thread', sequence, question },
    });
    const item = { id: 'item', header: 'Details', question: 'Continue?', options: [], multiSelect: false };
    const older = update(1, { ...locator, revision: 1, status: 'pending', createdAtMs: 1, questions: [item] });
    const newer = update(2, { ...locator, revision: 2, status: 'queued', createdAtMs: 1, questions: [item],
      answer: { submissionId: 'submission', acceptedAtMs: 2, answers: { item: { text: 'yes' } } } });
    const compacted = update(2, { ...locator, revision: 2 });
    const { perPendingFrames, perPendingBytes } = RESUME_NOTIFICATION_BUFFER_LIMITS;
    const progress = Array.from({ length: perPendingFrames - 2 }, (_, index) =>
      ({ method: 'item/delta', params: { threadId: 'thread', text: String(index) } }));
    const bytes = [older, ...progress, compacted].reduce((total, frame) =>
      total + Buffer.byteLength(JSON.stringify(frame)), 0);
    const finalProgress = { method: 'item/delta', params: { threadId: 'thread', text: 'after the answer' } };
    progress[0].params.text += 'x'.repeat(perPendingBytes - bytes);

    for (const frame of [older, ...progress, newer]) assert.equal(buffer.capture(pending, frame), true);
    assert.equal(buffer.capture(pending, finalProgress), true, 'the older full frame is covered');
    const replay = structuredClone(older);
    replay.params.sequence = 3;
    if (conflict) replay.params.question.questions[0].question = 'Different prompt';
    assert.equal(buffer.capture(pending, replay), !conflict);
    assert.deepEqual(buffer.take(pending), {
      messages: [...progress, compacted, finalProgress], overflowed: conflict,
    });
  });
}
