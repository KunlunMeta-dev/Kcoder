import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  return { broker, upstream, emit, owner, viewer };
}

const item = { id: 'item', prompt: 'Which file?', allowsFreeform: false };
for (const shared of [false, true]) for (const options of [
  [{ label: 'Keep', value: 'same' }, { label: 'Delete', value: 'same' }],
  [{ label: 'same' }, { label: 'Delete', value: 'same' }],
  [{ value: 'same' }, { label: 'same' }],
]) {
  test(`${shared ? 'shared' : 'exclusive'}: a malformed first question is settled and a new request remains usable ${JSON.stringify(options)}`, t => {
    const f = fixture(t, shared);
    f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
    const request = { id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'original', appServerEpoch: 'epoch',
      questions: [{ ...item, options }],
    } };
    f.emit(request);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.deepEqual(f.upstream.at(-1), { jsonrpc: '2.0', id: 500,
      error: { code: -32602, message: 'Invalid question/request payload' } });
    assert.equal(f.owner.messages.some(message => message.id === 500), false);
    const responseCount = f.upstream.length;
    f.emit(request);
    assert.equal(f.upstream.length, responseCount, 'a malformed replay must not settle the same ID twice');

    const valid = { ...request, id: 501, params: { ...request.params, questions: [{ ...item, options: [
      { label: 'Original', value: 'keep' }, { label: 'Original', value: 'delete' },
      { label: ' keep ' }, { value: 'other' },
    ] }] } };
    f.emit(valid);
    assert.equal(f.broker.serverRequests.get(501), f.owner);
    assert.deepEqual(f.owner.messages.at(-1), valid);
    if (f.viewer) assert.deepEqual(f.viewer.messages.at(-1), valid);
    f.broker.receive(f.owner, JSON.stringify({ id: 501, result: {
      questionId: 'original', threadId: 'thread', turnId: 'turn',
      answers: { item: { answers: ['delete'] } },
    } }));
    assert.deepEqual(f.upstream.at(-1).result.answers, { item: { answers: ['delete'] } });
    f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
      appServerEpoch: 'epoch', requestId: 501, questionId: 'original', reason: 'client_response' } });
    assert.equal(f.broker.serverRequests.has(501), false);
  });
}

test('a malformed reused ID cannot settle an existing valid interaction waiter', t => {
  const f = fixture(t, true);
  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  const valid = { id: 510, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'original', appServerEpoch: 'epoch', questions: [{ ...item, options: [{ label: 'Keep', value: 'keep' }] }] } };
  f.emit(valid);
  const ownerMessageCount = f.owner.messages.length;
  const upstreamCount = f.upstream.length;
  f.emit({ ...valid, params: { ...valid.params, questions: [{ ...item, options: [
    { label: 'Keep', value: 'same' }, { label: 'Delete', value: 'same' },
  ] }] } });
  assert.equal(f.upstream.length, upstreamCount, 'a bad replay cannot answer the existing waiter');
  assert.equal(f.owner.messages.length, ownerMessageCount, 'a bad replay cannot replace its card');
  assert.equal(f.broker.serverRequests.get(510), f.owner);
  f.broker.receive(f.owner, JSON.stringify({ id: 510, result: { questionId: 'original',
    threadId: 'thread', turnId: 'turn', answers: { item: { answers: ['keep'] } } } }));
  assert.equal(f.upstream.at(-1).result.answers.item.answers[0], 'keep');
});

test('a malformed question with conflicting owner identity is dropped without a response', t => {
  const f = fixture(t, false);
  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  const before = f.upstream.length;
  f.emit({ id: 520, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    turn_id: 'another-turn', questionId: 'bad', questions: [{ ...item, options: null }] } });
  assert.equal(f.upstream.length, before);
  assert.equal(f.broker.serverRequests.has(520), false);
  assert.equal(f.owner.messages.some(message => message.id === 520), false);
});

test('the settled transport ID can be reused by a distinct active turn', t => {
  const f = fixture(t, false);
  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  f.emit({ id: 530, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'bad', appServerEpoch: 'epoch-old', questions: [{ ...item, options: null }] } });
  assert.equal(f.upstream.at(-1).error?.code, -32602);
  f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'bad', appServerEpoch: 'epoch-old', requestId: 530, reason: 'cancelled' } });

  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'next-turn' });
  const next = { id: 530, method: 'question/request', params: { threadId: 'thread', turnId: 'next-turn',
    questionId: 'next-question', appServerEpoch: 'epoch-next',
    questions: [{ ...item, options: [{ label: 'Continue', value: 'continue' }] }] } };
  f.emit(next);
  assert.equal(f.broker.serverRequests.get(530), f.owner);
  assert.deepEqual(f.owner.messages.at(-1), next);
  const ownerMessageCount = f.owner.messages.length;
  f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'bad', appServerEpoch: 'epoch-old', requestId: 530, reason: 'cancelled' } });
  assert.equal(f.owner.messages.length, ownerMessageCount, 'a late old-turn receipt cannot retire the new waiter');
  assert.equal(f.broker.serverRequests.get(530), f.owner);
  f.broker.receive(f.owner, JSON.stringify({ id: 530, result: { questionId: 'next-question',
    appServerEpoch: 'epoch-next', threadId: 'thread', turnId: 'next-turn',
    answers: { item: { answers: ['continue'] } } } }));
  assert.equal(f.upstream.at(-1).result.answers.item.answers[0], 'continue');
});

test('a mismatched owner cannot clear a settled ID for another task', t => {
  const f = fixture(t, true);
  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  f.emit({ id: 540, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'bad', questions: [{ ...item, options: null }] } });
  f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'bad', requestId: 540, reason: 'cancelled' } });

  f.broker.threadOwners.set('foreign-thread', f.viewer);
  f.broker.activeTurns.set('foreign-thread', { owner: f.owner, turnId: 'foreign-turn' });
  const before = f.owner.messages.length + f.viewer.messages.length;
  f.emit({ id: 540, method: 'question/request', params: { threadId: 'foreign-thread', turnId: 'foreign-turn',
    questionId: 'foreign-question', questions: [{ ...item, options: [{ label: 'Yes', value: 'yes' }] }] } });
  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  f.emit({ id: 540, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'bad', questions: [{ ...item, options: [{ label: 'Yes', value: 'yes' }] }] } });
  assert.equal(f.owner.messages.length + f.viewer.messages.length, before,
    'a foreign owner cannot clear the original terminal binding');
  assert.equal(f.broker.serverRequests.has(540), false);
});

test('a receipt from another task owned by the same client cannot clear a settled ID', t => {
  const f = fixture(t, false);
  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  const rejected = { id: 550, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'bad', appServerEpoch: 'epoch-old', questions: [{ ...item, options: null }] } };
  f.emit(rejected);
  f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'bad', appServerEpoch: 'epoch-old', requestId: 550, reason: 'cancelled' } });
  const upstreamCount = f.upstream.length;
  const ownerMessageCount = f.owner.messages.length;

  f.broker.threadOwners.set('foreign-thread', f.owner);
  f.broker.activeTurns.set('foreign-thread', { owner: f.owner, turnId: 'foreign-turn' });
  f.emit({ method: 'question/resolved', params: { threadId: 'foreign-thread', turnId: 'foreign-turn',
    questionId: 'foreign-question', appServerEpoch: 'epoch-foreign', requestId: 550, reason: 'cancelled' } });
  assert.equal(f.owner.messages.length, ownerMessageCount, 'the foreign receipt is not delivered');

  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  f.emit(rejected);
  assert.equal(f.upstream.length, upstreamCount, 'the original terminal ID remains fenced');

  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'next-turn' });
  const next = { id: 550, method: 'question/request', params: { threadId: 'thread', turnId: 'next-turn',
    questionId: 'next-question', appServerEpoch: 'epoch-next',
    questions: [{ ...item, options: [{ label: 'Continue', value: 'continue' }] }] } };
  f.emit(next);
  assert.equal(f.broker.serverRequests.get(550), f.owner, 'a verified new-turn request can reuse the ID');
});

test('an old epoch receipt cannot consume a request reopened under a new epoch', t => {
  const f = fixture(t, false);
  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  const rejected = { id: 560, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'same-question', appServerEpoch: 'epoch-old', questions: [{ ...item, options: null }] } };
  f.emit(rejected);
  f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'same-question', appServerEpoch: 'epoch-old', requestId: 560, reason: 'cancelled' } });

  const reopened = { id: 560, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'same-question', appServerEpoch: 'epoch-new',
    questions: [{ ...item, options: [{ label: 'Continue', value: 'continue' }] }] } };
  f.emit(reopened);
  assert.equal(f.broker.serverRequests.get(560), f.owner);
  const ownerMessageCount = f.owner.messages.length;
  f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'same-question', appServerEpoch: 'epoch-old', requestId: 560, reason: 'cancelled' } });
  assert.equal(f.owner.messages.length, ownerMessageCount, 'the old epoch receipt cannot retire the reopened waiter');
  assert.equal(f.broker.serverRequests.get(560), f.owner);
  f.broker.receive(f.owner, JSON.stringify({ id: 560, result: { questionId: 'same-question',
    appServerEpoch: 'epoch-new', threadId: 'thread', turnId: 'turn',
    answers: { item: { answers: ['continue'] } } } }));
  assert.equal(f.upstream.at(-1).result.answers.item.answers[0], 'continue');
});

test('a terminal receipt from another epoch cannot clear a settled request without a new prompt', t => {
  const f = fixture(t, false);
  f.broker.activeTurns.set('thread', { owner: f.owner, turnId: 'turn' });
  const rejected = { id: 570, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'same-question', appServerEpoch: 'epoch-old', questions: [{ ...item, options: null }] } };
  f.emit(rejected);
  f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'same-question', appServerEpoch: 'epoch-old', requestId: 570, reason: 'cancelled' } });
  const upstreamCount = f.upstream.length;

  f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'same-question', appServerEpoch: 'epoch-new', requestId: 570, reason: 'cancelled' } });
  f.emit(rejected);
  assert.equal(f.upstream.length, upstreamCount, 'a new epoch receipt cannot replace the prior terminal binding');

  const reopened = { id: 570, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'same-question', appServerEpoch: 'epoch-new',
    questions: [{ ...item, options: [{ label: 'Continue', value: 'continue' }] }] } };
  f.emit(reopened);
  assert.equal(f.broker.serverRequests.get(570), f.owner, 'a verified prompt is the only way to open the new epoch');
});

test('terminal request IDs stay bounded and evict the oldest identity', t => {
  const f = fixture(t, false);
  const writes = f.upstream.length;
  const ownerMessages = f.owner.messages.length;
  const receipt = requestId => ({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
    questionId: `question-${requestId}`, appServerEpoch: 'epoch', requestId, reason: 'cancelled' } });
  for (let requestId = 0; requestId < 2049; requestId++) f.emit(receipt(requestId));
  assert.equal(f.owner.messages.length - ownerMessages, 2049, 'all overflow receipts are processed without hanging');
  assert.equal(f.upstream.length, writes, 'terminal notifications do not create new upstream requests');

  f.emit(receipt(2048));
  assert.equal(f.owner.messages.length - ownerMessages, 2049, 'the newest terminal identity remains retained');
  f.emit(receipt(0));
  assert.equal(f.owner.messages.length - ownerMessages, 2050, 'the oldest terminal identity was evicted');
  f.emit(receipt(0));
  assert.equal(f.owner.messages.length - ownerMessages, 2050, 'the reinserted identity is retained');
  assert.equal(f.upstream.length, writes, 'overflow and replays remain notification-only');
});
