import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, active) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  const owner = join(), answerer = join();
  const turn = { threadId: 'thread', id: 'turn', attemptId: 'original', status: 'running' };
  if (active) {
    reply(send(owner, 'turn/start', { threadId: 'thread' }), { turn });
    emit({ id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
      questionId: 'ordinary',
      questions: [{ id: 'ordinary-item', prompt: 'Continue the original task?', options: [], allowsFreeform: true }] } });
    assert.equal(broker.serverRequests.get(500), owner);
  }
  const answers = { item: { text: 'Original answer' } };
  const question = { threadId: 'thread', questionId: 'saved', revision: 2, status: 'queued',
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
    questions: [{ id: 'item', header: 'Mode', question: 'Continue?', options: [], multiSelect: false }],
    answer: { submissionId: 'submission', acceptedAtMs: 2, answers } };
  const answer = send(answerer, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'saved',
    submissionId: 'submission', expectedRevision: 1, answers });
  const receipt = startedTurn => reply(answer, { threadId: 'thread', question, accepted: true,
    duplicate: false, startedTurn });
  return { broker, upstream, emit, send, reply, owner, answerer, turn, question, answer, receipt };
}

for (const field of ['id', 'attemptId']) {
  for (const [name, value] of [['high surrogate', '\ud800'], ['low surrogate', '\udfff'], ['Rust whitespace', '\u0085'], ['mixed Rust whitespace', ' \u0085\t']]) {
    for (const lifecycle of ['connected', 'expired', 'disconnected']) {
      test(`${field} with ${name} cannot certify answer execution (${lifecycle})`, t => {
        const f = fixture(t, field === 'attemptId');
        if (lifecycle === 'expired') f.broker.expireRequest(f.answer.id);
        if (lifecycle === 'disconnected') f.broker.detach(f.answerer);
        const active = f.broker.activeTurns.get('thread'), deliveries = f.answerer.messages.length;
        f.receipt({ ...f.turn, [field]: value });
        assert.equal(f.broker.threadOwners.get('thread'), f.owner,
          'invalid Unicode cannot certify a new task controller');
        assert.equal(f.broker.activeTurns.get('thread'), active,
          'invalid Unicode cannot replace or register execution');
        assert.equal(f.broker.threadDrains.size, 0);
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
          'a disconnected answerer cannot authorize cleanup using an unusable execution identity');
        if (lifecycle === 'connected') assert.equal(f.answerer.messages.at(-1).error?.code, -32001);
        else assert.equal(f.answerer.messages.length, deliveries, 'late receipts are not redelivered');
        if (active) {
          f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
            turn: { ...f.turn, status: 'completed' } } });
          assert.equal(f.broker.activeTurns.has('thread'), false, 'the real terminal still settles execution');
          assert.equal(f.broker.serverRequests.has(500), false, 'the original question closes on completion');
          assert.equal(f.owner.messages.at(-1).method, 'turn/completed');
        }
        f.reply(f.send(f.owner, 'asyncQuestion/list', { threadId: 'thread' }), {
          threadId: 'thread', questions: [f.question],
        });
        assert.deepEqual(f.owner.messages.at(-1).result.questions, [f.question]);
        assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1,
          'recovery reads the saved answer without resubmitting it');
      });
    }
  }
}

test('an isolated surrogate attempt cannot strand the original question after completion', t => {
  const f = fixture(t, true);
  f.receipt({ ...f.turn, attemptId: '\ud800' });
  f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn',
    turn: { ...f.turn, status: 'completed' } } });
  assert.equal(f.broker.activeTurns.has('thread'), false, 'the original completion cannot be suppressed');
  assert.equal(f.broker.serverRequests.has(500), false, 'the original input must not remain blocked');
  assert.equal(f.owner.messages.at(-1).method, 'turn/completed');
});

for (const attemptId of [undefined, null, '新尝试-😀', '\uFEFF']) {
  test(`valid Unicode turn and optional attempt ${JSON.stringify(attemptId)} retain exact execution identity`, t => {
    const f = fixture(t, false);
    f.receipt({ ...f.turn, id: '新轮次-😀', attemptId });
    assert.equal(f.broker.threadOwners.get('thread'), f.answerer);
    assert.equal(f.broker.activeTurns.get('thread')?.turnId, '新轮次-😀');
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, attemptId ?? undefined);
    assert.equal(f.answerer.messages.at(-1).result.accepted, true);
    f.broker.detach(f.answerer);
    assert.deepEqual(f.upstream.filter(message => message.method === 'turn/interrupt').map(message => message.params),
      [{ threadId: 'thread', turnId: '新轮次-😀' }], 'valid Unicode cleanup preserves the original turn');
  });
}
