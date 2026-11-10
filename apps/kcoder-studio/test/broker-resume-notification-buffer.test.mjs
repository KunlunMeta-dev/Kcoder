import test from 'node:test';
import assert from 'node:assert/strict';
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
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision: 1, status: 'pending' },
} });

for (const difference of ['task', 'question', 'revision', 'content']) {
  test(`question ${difference} differences remain distinct and cannot bypass the frame cap`, () => {
    const buffer = new BrokerResumeNotificationBuffer(), pending = {};
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++) {
      const frame = questionUpdate();
      if (difference === 'task') frame.params.threadId = frame.params.question.threadId = `thread-${index}`;
      if (difference === 'question') frame.params.question.questionId = `question-${index}`;
      if (difference === 'revision') frame.params.question.revision = index + 1;
      if (difference === 'content') frame.params.question.deliveryError = `detail-${index}`;
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
