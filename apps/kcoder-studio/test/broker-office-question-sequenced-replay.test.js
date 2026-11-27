import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';

const params = { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
  scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
  payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } };
const changed = (sequence, large = false) => ({ method: 'asyncQuestion/changed', params: {
  sequence, threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision: 1,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1, status: 'pending',
    questions: Array.from({ length: large ? 4 : 1 }, (_, index) => ({ id: `item-${index}`, header: 'Details',
      question: large ? 'x'.repeat(15000) : 'Continue?', options: [], multiSelect: false })) },
} });

for (const shared of [false, true]) {
  for (const kind of ['snapshot', 'large snapshot', 'nullable snapshot', 'equivalent saved answer', 'equivalent JSON-RPC envelope', 'envelope extensions', 'legacy hint', 'legacy status change', 'legacy creation metadata']) {
    test(`early ${kind} replays leave capacity for the original question (shared=${shared})`, t => {
      const nullable = kind === 'nullable snapshot';
      const large = kind === 'large snapshot' || nullable;
      const legacy = kind.startsWith('legacy');
      const savedAnswer = kind === 'equivalent saved answer';
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
        maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
          fromUpstream: message => ({ upstream: [], client: [message] }) } });
      t.after(() => broker.clearTransientState());
      const caps = { integrationScopeV1: true, officeWorkspaceV1: true, asyncUserQuestionsV1: true };
      broker.initializeResponse = { result: { capabilities: { experimental: caps } } };
      const upstream = [];
      child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
      const join = () => {
        const client = { channel: 'runtime', ...caps, messages: [],
          send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
        broker.attach(client);
        Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
        return client;
      };
      const original = join(), peer = join();
      broker.receive(original, JSON.stringify({ id: 1, method: 'integrations/assistant/adopt', params }));
      const adoption = upstream.at(-1);
      const replay = sequence => {
        const frame = changed(sequence, large);
        if (kind === 'envelope extensions') frame.traceId = `delivery-${sequence}`;
        if (nullable) {
          if (sequence & 1) frame.params.question.answer = null;
          if (sequence & 2) frame.params.question.deliveryError = null;
        }
        if (savedAnswer) {
          const { question } = frame.params;
          question.questions = Array.from({ length: 7 }, (_, index) => ({
            ...question.questions[0], id: `item-${index}`,
          }));
          question.status = 'queued';
          question.revision = 2;
          question.answer = { acceptedAtMs: 2, submissionId: 'winner',
            answers: Object.fromEntries(question.questions.map(({ id }, index) =>
              [id, { text: 'Continue', ...(sequence & (1 << index) ? { selectedOptionIds: [] } : {}) }])) };
        }
        if (legacy) {
          delete frame.params.question.questions;
          delete frame.params.question.status;
          frame.params.question.revision = sequence;
          if (kind === 'legacy status change' && sequence === 65) frame.params.question.status = 'cancelled';
          if (kind === 'legacy creation metadata' && sequence === 65) delete frame.params.question.createdAtMs;
        }
        return frame;
      };
      const first = replay(1);
      const envelopeSnapshots = [];
      if (kind === 'equivalent JSON-RPC envelope') {
        for (let index = 0; index < 31; index++) {
          const snapshot = changed(100 + index * 2);
          snapshot.params.question.questionId = `question-${index}`;
          snapshot.params.question.toolCallId = `tool-${index}`;
          envelopeSnapshots.push(snapshot);
          broker.routeServerMessage(snapshot);
          broker.routeServerMessage({ ...snapshot, jsonrpc: '2.0',
            params: { ...snapshot.params, sequence: snapshot.params.sequence + 1 } });
        }
        broker.routeServerMessage({ ...first, jsonrpc: '2.0' });
        envelopeSnapshots.push({ ...first, jsonrpc: '2.0' });
      }
      const lastSequence = large ? 6 : 65;
      const lastBeforeCard = legacy ? lastSequence - 1 : lastSequence;
      for (let sequence = 1; sequence <= lastBeforeCard; sequence++)
        broker.routeServerMessage(replay(sequence));
      const question = { id: 500, method: 'question/request', params: {
        threadId: 'thread', turnId: 'turn', questionId: 'ordinary-question',
        questions: [{ id: 'item', prompt: large ? 'x'.repeat(24000) : 'Continue the original task?',
          options: [], allowsFreeform: true }],
      } };
      const unrelated = [];
      if (kind === 'legacy status change' || kind === 'legacy creation metadata') {
        // One hint, 62 unrelated updates and one ordinary waiter fill the handoff.
        for (let index = 0; index < 62; index++) {
          const frame = changed(100 + index);
          frame.params.question.questionId = `unrelated-${index}`;
          unrelated.push(frame);
          broker.routeServerMessage(frame);
        }
      }
      const distinct = nullable || savedAnswer ? replay(66) : null;
      if (distinct) {
        if (nullable) distinct.params.question.questionId = 'another-question';
        else distinct.params.question.answer.answers['item-1'].text = 'Different answer';
        broker.routeServerMessage(distinct);
      }
      broker.routeServerMessage(question);
      const latest = replay(lastSequence);
      if (legacy) {
        broker.routeServerMessage(latest);
        const delayed = replay(lastSequence + 1);
        delayed.params.question.revision = 2;
        broker.routeServerMessage(delayed);
      }
      assert.equal(upstream.length, 1, 'replays cannot force rejection of a real original waiter');
      assert.equal(original.messages.length + peer.messages.length, 0, 'wait for the original acceptance');
      broker.routeServerMessage({ id: adoption.id, result: { contractVersion: 'parallel-v1',
        requestId: params.requestId, operationId: params.operationId, status: 'completed', error: null,
        entityRevision: null, observedAt: '2026-11-16T01:00:00Z',
        result: { nativeTask: { threadId: 'thread', turnId: 'turn', state: 'running' } } } });
      assert.deepEqual(original.messages.slice(1), legacy ? [...unrelated, question, latest] :
        [...(envelopeSnapshots.length ? envelopeSnapshots : [first]), ...(distinct ? [distinct] : []), question],
        'retain the highest legacy revision or first exact snapshot at its actual arrival position');
      assert.equal(peer.messages.length, 0, 'another client cannot receive the original question');
      assert.equal(broker.serverRequests.get(question.id), original);
      broker.receive(original, JSON.stringify({ id: question.id, result: { answers: { item: { answers: ['Continue'] } } } }));
      assert.equal(upstream.filter(message => message.id === question.id && message.result).length, 1);
      assert.equal(upstream.some(message => message.method === 'asyncQuestion/answer'), false, 'never replay an answer');
    });
  }
}

test('early snapshot deduplication preserves bindings, content, candidates and real capacity', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const original = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
  const later = { ...original }, first = changed(1);
  assert.equal(handoff.capture(first, [original]), true);
  assert.equal(handoff.capture(changed(2), [original, later]), true);
  const delivered = [], refused = [];
  handoff.settle(original, null, message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(refused, [first], 'replays cannot add a new adoption candidate');
  handoff.settle(later, { threadId: 'thread', turnId: 'turn' }, message => delivered.push(message), () => {});
  assert.deepEqual(delivered, []);

  const frames = [first, ...[
    frame => { frame.params.serverId = 'another-server'; },
    frame => { frame.params.question.sourceTurnId = 'another-turn'; },
    frame => { Object.assign(frame.params.question, { revision: 2, status: 'cancelled' }); },
    frame => { frame.params.question.questions[0].question = 'Different question'; },
  ].map((mutate, index) => { const frame = changed(index + 2); mutate(frame); return frame; })];
  for (const [sequence, sourceTurnId] of [[7, 'turn'], [8, 'another-turn']]) {
    const hint = changed(sequence);
    delete hint.params.question.questions;
    delete hint.params.question.status;
    hint.params.question.sourceTurnId = sourceTurnId;
    hint.params.question.revision = 3;
    frames.push(hint);
  }
  for (const frame of frames) assert.equal(handoff.capture(frame, [original]), true);
  for (let index = frames.length; index < 64; index++) {
    const frame = changed(index + 10); frame.params.question.questionId = `distinct-${index}`;
    assert.equal(handoff.capture(frame, [original]), true); frames.push(frame);
  }
  assert.equal(handoff.capture(changed(1000), [original]), true, 'replays fit even at the real capacity');
  const overflow = changed(1001); overflow.params.question.questionId = 'overflow';
  assert.equal(handoff.capture(overflow, [original]), false, 'distinct snapshots still respect the bound');
  handoff.settle(original, { threadId: 'thread', turnId: 'turn' }, message => delivered.push(message), () => {});
  assert.deepEqual(delivered, frames, 'keep all real differences and the original wire order');
  assert.equal(first.params.sequence, 1, 'comparison cannot rewrite the original frame');
});

test('a newer legacy hint retains the first hint’s adoption candidates', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const original = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
  const later = { ...original };
  const first = changed(1), latest = changed(2);
  delete first.params.question.questions;
  delete latest.params.question.questions;
  delete first.params.question.status;
  delete latest.params.question.status;
  latest.params.question.revision = 2;
  assert.equal(handoff.capture(first, [original]), true);
  assert.equal(handoff.capture(latest, [original, later]), true);
  const task = { threadId: 'thread', turnId: 'turn' };
  const delivered = [], refused = [];
  handoff.settle(later, task, message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, []);
  handoff.settle(original, task, message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [latest]);
  assert.deepEqual(refused, []);
});

test('early adoption replays do not renormalize retained async answers', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
  let retainedAnswerReads = 0;
  const frames = Array.from({ length: 32 }, (_, index) => {
    const frame = changed(index);
    const { question } = frame.params;
    question.questionId = `queued-${index}`;
    question.status = 'queued';
    question.revision = 2;
    const body = 'x'.repeat(4096);
    question.answer = { submissionId: 'winner', acceptedAtMs: 2,
      answers: { 'item-0': { get text() { retainedAnswerReads++; return body; } } } };
    return frame;
  });
  for (const frame of frames) assert.equal(handoff.capture(frame, [pending]), true);
  const replay = structuredClone(frames.at(-1));
  retainedAnswerReads = 0;
  for (let index = 0; index < 200; index++) {
    replay.params.sequence = 100 + index;
    assert.equal(handoff.capture(replay, [pending]), true);
  }
  assert.equal(retainedAnswerReads, 0, 'replay must only normalize the incoming answer');

  const delivered = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' },
    frame => delivered.push(frame), () => assert.fail('the original acceptance matches'));
  assert.equal(delivered.length, frames.length);
  for (const [index, frame] of frames.entries()) assert.equal(delivered[index], frame);
});

test('a full Office handoff refreshes an existing hint without adding a frame or candidate', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const original = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
  const later = { ...original };
  const first = changed(1);
  delete first.params.question.questions;
  assert.equal(handoff.capture(first, [original]), true);
  const otherFrames = Array.from({ length: 63 }, (_, index) => {
    const frame = changed(index + 2);
    frame.params.question.questionId = `other-${index}`;
    return frame;
  });
  for (const frame of otherFrames) assert.equal(handoff.capture(frame, [original]), true);

  const latest = changed(65);
  latest.params.question.status = 'cancelled';
  latest.params.question.revision = 2;
  assert.equal(handoff.capture(latest, [original, later]), true);

  const delivered = [];
  const task = { threadId: 'thread', turnId: 'turn' };
  const refuse = () => assert.fail('the original acceptance matches');
  handoff.settle(later, task, frame => delivered.push(frame), refuse);
  assert.deepEqual(delivered, []);
  handoff.settle(original, task, frame => delivered.push(frame), refuse);
  const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = latest.params.question;
  assert.deepEqual(delivered, [...otherFrames, { ...latest, params: { ...latest.params,
    question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } }]);
});

test('a covered Office question locator leaves room for the original interactive waiter', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
  const full = changed(1);
  const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
  const locator = { ...full, params: { ...full.params, sequence: 2,
    question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
  const independent = { ...locator, params: { ...locator.params, sequence: 3,
    question: { ...locator.params.question, toolCallId: 'other-tool' } } };
  const progress = Array.from({ length: 61 }, (_, index) => ({
    method: 'item/delta', params: { threadId, turnId: sourceTurnId, sequence: index + 4 },
  }));
  const waiter = { id: 500, method: 'question/request', params: { threadId, turnId: sourceTurnId,
    questionId: 'interactive-question', questions: [
      { id: 'item', prompt: 'Continue?', options: [], allowsFreeform: true },
    ] } };

  for (const frame of [full, locator, independent, ...progress]) {
    assert.equal(handoff.capture(frame, [pending]), true);
  }
  assert.equal(handoff.capture(waiter, [pending]), true, 'the covered locator must not displace the waiter');

  const conflict = changed(66);
  conflict.params.question.questions[0].question = 'Different prompt';
  assert.equal(handoff.capture(conflict, [pending]), true, 'a conflict must leave a readback hint at capacity');
  const replay = changed(conflict.params.sequence);
  assert.equal(handoff.capture(replay, [pending]), true, 'a replay cannot erase the conflict');

  const delivered = [];
  handoff.settle(pending, { threadId, turnId: sourceTurnId },
    frame => delivered.push(frame), () => assert.fail('the original acceptance matches'));
  const readback = { ...conflict, params: { ...conflict.params, question: locator.params.question } };
  assert.deepEqual(delivered, [independent, ...progress, waiter, readback]);
});

for (const budget of ['frames', 'bytes']) {
  test(`a full Office question snapshot reuses its same-event locator slot (${budget})`, () => {
    const handoff = new BrokerOfficeTaskOwnerHandoff();
    const pending = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
    const later = { ...pending };
    const full = changed(1, budget === 'bytes');
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const locator = { ...full, params: { ...full.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision: revision + 1 } } };
    const progress = Array.from({ length: 62 }, (_, index) => ({
      method: 'item/delta', params: { threadId, turnId: sourceTurnId, sequence: index + 2,
        delta: { text: budget === 'bytes' ? 'x'.repeat(3_800) : 'progress' } },
    }));
    const waiter = { id: 500, method: 'question/request', params: {
      threadId, turnId: sourceTurnId, questionId: 'interactive', questions: [
        { id: 'item', prompt: 'Continue?', options: [], allowsFreeform: true },
      ],
    } };

    assert.equal(handoff.capture(locator, [pending]), true);
    for (const frame of progress) assert.equal(handoff.capture(frame, [pending]), true);
    assert.equal(handoff.capture(full, [pending, later]), true);
    assert.equal(handoff.capture(locator, [pending, later]), true, 'a late sparse replay cannot restore its revision');
    assert.equal(handoff.capture(waiter, [pending]), true, 'one durable event must use only one slot');

    const delivered = [];
    const task = { threadId, turnId: sourceTurnId };
    const refuse = () => assert.fail('the original acceptance matches');
    handoff.settle(later, task, frame => delivered.push(frame), refuse);
    assert.deepEqual(delivered, [], 'a replay cannot add an adoption candidate');
    handoff.settle(pending, task, frame => delivered.push(frame), refuse);
    const corrected = { ...locator, params: { ...locator.params,
      question: { ...locator.params.question, revision } } };
    assert.deepEqual(delivered[0], budget === 'bytes' ? corrected : full);
    assert.deepEqual(delivered.slice(1), [...progress, waiter]);
  });
}

test('a newer Office refresh hint preserves the compacted snapshot for its own sequence', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
  const full = changed(1, true);
  const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
  const locator = { threadId, questionId, requestId, sourceTurnId, toolCallId, revision };
  const hint = (sequence, revision) => ({ ...full, params: { ...full.params, sequence,
    question: { ...locator, revision } } });
  const progress = { method: 'item/delta', params: { threadId, turnId: sourceTurnId,
    delta: { text: 'x'.repeat(220_000) } } };
  const newer = hint(2, 2);
  for (const frame of [progress, full, newer, hint(1, 999)]) {
    assert.equal(handoff.capture(frame, [pending]), true);
  }

  const delivered = [];
  handoff.settle(pending, { threadId, turnId: sourceTurnId },
    frame => delivered.push(frame), () => assert.fail('the original acceptance matches'));
  assert.deepEqual(delivered.map(frame => frame.params.question?.revision), [undefined, 1, 2]);
  assert.deepEqual(delivered, [progress, hint(1, 1), newer]);
});

test('Office compaction associates the complete event with its own sequence when reusing a hint', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
  const full = changed(3, true);
  const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
  const locator = { threadId, questionId, requestId, sourceTurnId, toolCallId, revision };
  const hint = (sequence, revision) => ({ ...full, params: { ...full.params, sequence,
    question: { ...locator, revision } } });
  const first = hint(1, revision);
  const progress = { method: 'item/delta', params: { threadId, turnId: sourceTurnId, sequence: 2,
    delta: { text: 'x'.repeat(220_000) } } };
  const newer = hint(4, revision + 1);
  for (const frame of [first, progress, full, newer, hint(3, 999)]) {
    assert.equal(handoff.capture(frame, [pending]), true);
  }

  const delivered = [];
  handoff.settle(pending, { threadId, turnId: sourceTurnId },
    frame => delivered.push(frame), () => assert.fail('the original acceptance matches'));
  assert.deepEqual(delivered.map(frame => [frame.params.sequence, frame.params.question?.revision]),
    [[1, revision], [2, undefined], [4, revision + 1]]);
});

for (const replaySequence of [1, 2, undefined]) {
  test(`a compacted Office snapshot retains readback for a conflicting replay at sequence ${replaySequence}`, () => {
    const handoff = new BrokerOfficeTaskOwnerHandoff();
    const pending = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
    const full = changed(1, true);
    const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
    const locator = { ...full, params: { ...full.params,
      question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
    const progress = { method: 'item/delta', params: { threadId, turnId: sourceTurnId,
      delta: { text: 'x'.repeat(220_000) } } };
    for (const frame of [progress, full, changed(replaySequence)]) {
      assert.equal(handoff.capture(frame, [pending]), true);
    }

    const delivered = [];
    handoff.settle(pending, { threadId, turnId: sourceTurnId },
      frame => delivered.push(frame), () => assert.fail('the original acceptance matches'));
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0], progress);
    assert.deepEqual(delivered[1], locator);
  });
}

test('Office readback survives a conflicting source locator at the same durable revision', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', params, client: { channel: 'runtime', initialized: true } };
  const full = changed(1, true);
  const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = full.params.question;
  const locator = { ...full, params: { ...full.params,
    question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } };
  const progress = { method: 'item/delta', params: { threadId, turnId: sourceTurnId,
    delta: { text: 'x'.repeat(220_000) } } };
  const earlierHint = { ...full, params: { ...full.params, sequence: 2,
    question: { ...locator.params.question, requestId: 'other-source', revision: revision + 1 } } };
  const frames = [earlierHint, progress, full];
  for (const [index, field] of ['requestId', 'sourceTurnId', 'toolCallId'].entries()) {
    const conflicting = changed(index + 2);
    conflicting.params.question[field] = 'other-source';
    frames.push(conflicting);
  }
  const separateQuestion = changed(5);
  Object.assign(separateQuestion.params.question, { questionId: 'another-question', toolCallId: 'another-tool' });
  frames.push(separateQuestion);
  for (const frame of frames) assert.equal(handoff.capture(frame, [pending]), true);

  const delivered = [];
  handoff.settle(pending, { threadId, turnId: sourceTurnId },
    frame => delivered.push(frame), () => assert.fail('the original acceptance matches'));
  assert.deepEqual(delivered, [earlierHint, progress, locator, separateQuestion]);
});

for (const order of ['hint first', 'multiple hints first', 'snapshot first', 'snapshot replay']) {
  test(`Office same-sequence correction accepts a partial source locator (${order})`, () => {
    const handoff = new BrokerOfficeTaskOwnerHandoff();
    const pending = { method: 'integrations/assistant/adopt', params,
      client: { channel: 'runtime', initialized: true } };
    const snapshot = changed(2);
    const { threadId, questionId, sourceTurnId, toolCallId } = snapshot.params.question;
    const hint = { method: snapshot.method, params: { threadId, sequence: 2,
      question: { threadId, questionId, toolCallId, revision: 99 } } };
    const differentSource = { ...hint, params: { ...hint.params,
      question: { ...hint.params.question, toolCallId: 'other-tool' } } };
    const differentSequence = { ...hint, params: { ...hint.params, sequence: 3,
      question: { ...hint.params.question, requestId: snapshot.params.question.requestId } } };
    const first = order === 'snapshot replay' ? changed(1) : snapshot;
    const fillers = Array.from({ length: 60 }, (_, index) => ({
      method: 'item/delta', params: { threadId, turnId: sourceTurnId, sequence: index + 4 },
    }));
    const anotherHint = { ...hint, params: { ...hint.params,
      question: { threadId, questionId, sourceTurnId, revision: 99 } } };
    const frames = order === 'multiple hints first'
      ? [hint, anotherHint, differentSource, differentSequence, ...fillers, snapshot]
      : order === 'hint first'
        ? [hint, differentSource, differentSequence, ...fillers, snapshot]
        : [first, hint, differentSource, differentSequence, ...fillers];
    if (order === 'snapshot replay') frames.push(snapshot);
    const waiter = { id: 500, method: 'question/request', params: { threadId, turnId: sourceTurnId } };
    for (const frame of frames) assert.equal(handoff.capture(frame, [pending]), true);
    assert.equal(handoff.capture(waiter, [pending]), true,
      'the partial replay must leave capacity for the original synchronous question');

    const delivered = [];
    handoff.settle(pending, { threadId, turnId: sourceTurnId },
      frame => delivered.push(frame), () => assert.fail('the original acceptance matches'));
    assert.deepEqual(delivered, [first, differentSource, differentSequence, ...fillers, waiter]);
  });
}

test('Office retains the full snapshot when covered hints release enough bytes', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', params,
    client: { channel: 'runtime', initialized: true } };
  const snapshot = changed(2, true);
  const { threadId, questionId, sourceTurnId, toolCallId } = snapshot.params.question;
  const hints = [{ toolCallId }, { sourceTurnId }].map(source => ({
    method: snapshot.method, params: { threadId, sequence: 2,
      question: { threadId, questionId, revision: 99, ...source } },
  }));
  const progress = { method: 'item/delta', params: { threadId, turnId: sourceTurnId, delta: '' } };
  const size = frame => Buffer.byteLength(JSON.stringify(frame));
  progress.params.delta = 'x'.repeat(256 * 1024 - size(progress) - size(snapshot));

  for (const frame of [...hints, progress, snapshot]) {
    assert.equal(handoff.capture(frame, [pending]), true);
  }

  const delivered = [];
  handoff.settle(pending, { threadId, turnId: sourceTurnId },
    frame => delivered.push(frame), () => assert.fail('the original acceptance matches'));
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].params.question.questions?.length, 4,
    'the complete question must survive when it fits after reclaiming covered hints');
  assert.deepEqual(delivered, [snapshot, progress]);
});

test('late Office hints for interleaved snapshot replays leave room for the original waiter', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', params,
    client: { channel: 'runtime', initialized: true } };
  const original = changed(1);
  const { threadId, questionId, revision, toolCallId, sourceTurnId: turnId } = original.params.question;
  const hint = (sequence, fields = {}) => ({ method: original.method, params: { threadId, sequence,
    question: { threadId, questionId, revision, ...fields } } });
  const conflicting = hint(3, { toolCallId: 'other-tool' });
  const newer = hint(4, { revision: revision + 1, toolCallId });
  const fillers = Array.from({ length: 60 }, () => ({ method: 'item/delta', params: { threadId, turnId } }));
  const waiter = { id: 500, method: 'question/request', params: { threadId, turnId } };
  for (const frame of [original, changed(2), conflicting, changed(3), changed(4), newer, ...fillers]) {
    assert.equal(handoff.capture(frame, [pending]), true);
  }
  for (const sequence of [3, 2, 4]) assert.equal(handoff.capture(hint(sequence), [pending]), true);
  assert.equal(handoff.capture(waiter, [pending]), true, 'covered hints must leave the final buffer slot free');
  assert.equal(handoff.capture({ method: 'item/delta', params: { threadId, turnId } }, [pending]), false);

  const delivered = [];
  handoff.settle(pending, { threadId, turnId }, frame => delivered.push(frame),
    () => assert.fail('the original acceptance matches'));
  assert.deepEqual(delivered, [original, conflicting, newer, ...fillers, waiter]);
});

test('Office handoff falls back to original-task readback when a source conflict cannot fit', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', params,
    client: { channel: 'runtime', initialized: true } };
  const snapshot = changed(1);
  const { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } = snapshot.params.question;
  const progress = Array.from({ length: 63 }, () => ({
    method: 'item/delta', params: { threadId, turnId: sourceTurnId },
  }));
  const conflict = changed(2);
  conflict.params.question.toolCallId = 'different-tool';
  for (const frame of [snapshot, ...progress]) assert.equal(handoff.capture(frame, [pending]), true);
  assert.equal(handoff.capture(conflict, [pending]), true, 'the conflicting revision must trigger readback');

  const delivered = [];
  handoff.settle(pending, { threadId, turnId: sourceTurnId }, frame => delivered.push(frame),
    () => assert.fail('the original acceptance matches'));
  assert.deepEqual(delivered, [...progress, { ...conflict, params: { ...conflict.params,
    question: { threadId, questionId, requestId, sourceTurnId, toolCallId, revision } } }]);
});
