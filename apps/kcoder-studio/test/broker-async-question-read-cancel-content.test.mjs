import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';

const question = {
  threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'cancelled',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
};

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, threadRuntimeHandoffV1: true,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true,
    threadRuntimeHandoffV1: true });
  let sequence = 0;
  const send = (method, params = {}) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  reply(send('thread/resume'), { thread: { id: 'thread' } });
  return { broker, client, upstream, send, reply };
}

const invalid = [
  ['stale delivery error', { deliveryError: 'old failure' }],
  ['unknown record field', { obsoleteDelivery: 'old metadata' }],
  ['invalid source', { sourceTurnId: '\u0085' }],
  ['invalid creation time', { createdAtMs: -1 }],
  ['answer from another item', { answer: { submissionId: 'winner', acceptedAtMs: 2,
    answers: { other: { text: 'another question' } } } }],
];
const invalidSparse = [
  ['unknown record field', { retired: true }],
  ['invalid explicit creation time', { createdAtMs: -1 }],
  ['invalid explicit request identity', { requestId: '\u0085' }],
  ['stale delivery error', { status: 'cancelled', deliveryError: 'old failure' }],
  ['invalid explicit answer timestamp', { answer: { submissionId: 'winner', acceptedAtMs: -1,
    answers: { item: { text: 'legacy answer' } } } }],
];

for (const method of ['asyncQuestion/list', 'asyncQuestion/cancel']) {
  for (const [name, fields] of invalid) test(`${method}: ${name} cannot certify a successful receipt`, t => {
    const f = fixture(t), saved = { ...question, ...fields };
    assert.equal(hasValidAsyncQuestionNotificationBinding({ threadId: 'thread', question: saved }), false,
      'the same unusable snapshot is already rejected on the notification path');
    const request = f.send(method, method === 'asyncQuestion/cancel'
      ? { questionId: 'question', expectedRevision: 1 } : { includeTerminal: true });
    f.reply(request, { threadId: 'thread', ...(method === 'asyncQuestion/list'
      ? { questions: [{ ...question, questionId: 'peer' }, saved] } : { question: saved }) });
    assert.equal(f.client.messages.at(-1).error?.code, -32001,
      'a correct task and revision do not certify unusable saved content');
    assert.equal(f.client.messages.at(-1).result, undefined, 'no partial list or confirmed cancellation is exposed');
    // Explicit corrected readback remains usable; no cancel or answer is replayed.
    f.reply(f.send('asyncQuestion/list', { includeTerminal: true }), { threadId: 'thread', questions: [question] });
    assert.deepEqual(f.client.messages.at(-1).result.questions, [question]);
    assert.equal(f.upstream.filter(message => message.method === method).length,
      method === 'asyncQuestion/list' ? 2 : 1);
    assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'turn/start', 'turn/interrupt'].includes(message.method)), false);
    assert.equal(f.broker.threadOwners.get('thread'), f.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
  });

  for (const [name, fields] of invalidSparse) test(`${method}: sparse legacy record with ${name} is rejected without owner cleanup`, t => {
    const f = fixture(t);
    const turnRequest = f.send('turn/start');
    f.reply(turnRequest, { turn: { id: 'active-turn', status: 'running' } });
    const active = f.broker.activeTurns.get('thread');
    const saved = { threadId: 'thread', questionId: 'question', ...fields };
    const request = f.send(method, method === 'asyncQuestion/cancel'
      ? { questionId: 'question', expectedRevision: 1 } : { includeTerminal: true });
    f.reply(request, { threadId: 'thread', ...(method === 'asyncQuestion/list'
      ? { questions: [saved] } : { question: saved }) });
    assert.equal(f.client.messages.at(-1).error?.code, -32001);
    assert.equal(f.client.messages.at(-1).result, undefined);
    assert.equal(f.broker.threadOwners.get('thread'), f.client);
    assert.equal(f.broker.activeTurns.get('thread'), active);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });

  test(`${method}: full and legacy sparse records remain readable`, t => {
    const f = fixture(t);
    for (const saved of [question, { threadId: 'thread', questionId: 'question' },
      { threadId: 'thread', questionId: 'question', answer: {
        submissionId: 'winner', answers: { item: { text: 'legacy answer' } },
      } }]) {
      const request = f.send(method, method === 'asyncQuestion/cancel'
        ? { questionId: 'question', expectedRevision: 1 } : { includeTerminal: true });
      const result = { threadId: 'thread', ...(method === 'asyncQuestion/list'
        ? { questions: [saved] } : { question: saved }) };
      f.reply(request, result);
      assert.deepEqual(f.client.messages.at(-1).result, result);
    }
  });
}

for (const outcome of ['released', 'unknown']) {
  test(`runtime release (${outcome}) fences cancellation only when confirmed`, t => {
    const f = fixture(t);
    const cancel = f.send('asyncQuestion/cancel', { questionId: 'question', expectedRevision: 1 });
    const identity = { threadId: 'thread', serverId: 'native-server' };
    const release = f.send('thread/runtime/handoff/release', {
      operationId: 'release-once', expectedServerId: identity.serverId,
      expectedOwnerRef: 'original-owner', expectedClientTurnCount: 0,
    });
    f.reply(release, {
      snapshot: { ...identity, ownerRef: null, clientTurnCount: null, releasable: false },
      receipt: { ...identity, operationId: 'release-once', ownerRef: 'original-owner', status: outcome },
    });
    assert.equal(f.client.messages.at(-1).result?.receipt.status, outcome);
    assert.equal(f.broker.threadOwners.has('thread'), outcome === 'unknown');
    f.reply(f.send('thread/resume'), { thread: { id: 'thread' } });
    const current = { ...question, revision: 1, status: 'pending' };
    f.reply(f.send('asyncQuestion/list'), { threadId: 'thread', questions: [current] });
    assert.deepEqual(f.client.messages.at(-1).result?.questions, [current]);

    f.reply(cancel, { threadId: 'thread', question });
    assert.equal(f.client.messages.at(-1).error?.code, outcome === 'released' ? -32001 : undefined);
    assert.deepEqual(f.client.messages.at(-1).result?.question, outcome === 'released' ? undefined : question);
    assert.equal(f.broker.threadOwners.get('thread'), f.client);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/cancel').length, 1);
  });
}

for (const filter of [false, null, undefined]) {
  test(`an active-only lookup (includeTerminal=${filter}) cannot publish a terminal question`, t => {
    const f = fixture(t);
    const pending = { ...question, questionId: 'pending', requestId: 'pending-request',
      toolCallId: 'pending-tool', status: 'pending', revision: 1 };
    const answer = { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'saved answer' } } };
    const unknown = { ...question, questionId: 'unknown', requestId: 'unknown-request',
      toolCallId: 'unknown-tool', status: 'delivery_unknown', revision: 3, answer,
      deliveryError: 'Admission receipt lost' };

    for (const status of ['cancelled', 'stale', 'context_applied', 'delivery_failed']) {
      const terminal = status === 'context_applied' || status === 'delivery_failed'
        ? { ...question, status, revision: 3, answer,
          ...(status === 'delivery_failed' ? { deliveryError: 'Admission rejected' } : {}) }
        : { ...question, status };
      f.reply(f.send('asyncQuestion/list', { includeTerminal: filter }), {
        threadId: 'thread', questions: [pending, terminal],
      });
      assert.equal(f.client.messages.at(-1).error?.code, -32001, status);
      assert.equal(f.client.messages.at(-1).result, undefined);
    }

    for (const includeTerminal of [filter, true]) {
      const questions = includeTerminal ? [pending, unknown, question] : [pending, unknown];
      f.reply(f.send('asyncQuestion/list', { includeTerminal }), { threadId: 'thread', questions });
      assert.deepEqual(f.client.messages.at(-1).result.questions, questions);
    }
    assert.deepEqual(f.upstream.map(request => request.method),
      ['thread/resume', ...Array(6).fill('asyncQuestion/list')]);
  });
}

test('legacy list snapshots cannot certify a contradictory explicit lifecycle revision', t => {
  const f = fixture(t);
  const locator = { threadId: 'thread', questionId: 'question' };
  const answer = { submissionId: 'winner', answers: { item: { text: 'Saved' } } };
  const rows = [
    { status: 'pending', revision: 2, validRevision: 1 },
    { status: 'cancelled', revision: 1, validRevision: 2 },
    { status: 'context_applied', revision: 2, validRevision: 3, answer },
    { status: 'delivery_unknown', revision: 2, validRevision: 3, answer },
  ];

  for (const { validRevision, ...fields } of rows) {
    const result = { threadId: 'thread', questions: [{ ...locator, ...fields }] };
    f.reply(f.send('asyncQuestion/list', { includeTerminal: true }), result);
    assert.equal(f.client.messages.at(-1).error?.code, -32001, fields.status);
    assert.equal(f.client.messages.at(-1).result, undefined);
    result.questions[0].revision = validRevision;
    f.reply(f.send('asyncQuestion/list', { includeTerminal: true }), result);
    assert.deepEqual(f.client.messages.at(-1).result, result);
  }
});

test('legacy list snapshots require revisions consistent with saved answers and delivery errors even without status', t => {
  const f = fixture(t);
  const locator = { threadId: 'thread', questionId: 'question' };
  const answer = { submissionId: 'winner', answers: { item: { text: 'Saved' } } };
  for (const [fields, validRevision] of [[{ answer }, 2], [{ deliveryError: 'Receipt lost' }, 3]]) {
    f.reply(f.send('asyncQuestion/list', { includeTerminal: true }), {
      threadId: 'thread', questions: [{ ...locator, ...fields, revision: validRevision - 1 }],
    });
    assert.equal(f.client.messages.at(-1).error?.code, -32001);
    assert.equal(f.client.messages.at(-1).result, undefined);

    for (const revision of [validRevision, undefined]) {
      const result = { threadId: 'thread', questions: [{ ...locator, ...fields,
        ...(revision === undefined ? {} : { revision }) }] };
      f.reply(f.send('asyncQuestion/list', { includeTerminal: true }), result);
      assert.deepEqual(f.client.messages.at(-1).result, result);
    }
  }
});

test('sparse cancellation cannot confirm withdrawal while reporting a delivery error', t => {
  const f = fixture(t);
  const locator = { threadId: 'thread', questionId: 'question', revision: 3 };
  const saved = { ...locator, deliveryError: 'Delivery receipt lost' };
  f.reply(f.send('asyncQuestion/cancel', { questionId: 'question', expectedRevision: 2 }),
    { threadId: 'thread', question: saved });
  const refusal = f.client.messages.at(-1);

  f.reply(f.send('asyncQuestion/list', { includeTerminal: true }),
    { threadId: 'thread', questions: [saved] });
  assert.deepEqual(f.client.messages.at(-1).result.questions, [saved],
    'readback can still report delivery evidence without an explicit status');
  assert.deepEqual(f.upstream.map(request => request.method),
    ['thread/resume', 'asyncQuestion/cancel', 'asyncQuestion/list']);
  assert.equal(refusal.error?.code, -32001);
  assert.equal(refusal.result, undefined);

  for (const question of [locator, { ...locator, deliveryError: null }]) {
    f.reply(f.send('asyncQuestion/cancel', { questionId: 'question', expectedRevision: 2 }),
      { threadId: 'thread', question });
    assert.deepEqual(f.client.messages.at(-1).result.question, question);
  }
});
