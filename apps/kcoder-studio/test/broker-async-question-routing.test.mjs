import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const client = (async = true) => {
    const value = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value); Object.assign(value, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: async }); return value;
  };
  const send = (client, method, params = { threadId: 'thread' }) => {
    if (['asyncQuestion/answer', 'asyncQuestion/cancel'].includes(method))
      params = { questionId: 'q', submissionId: 'submission', expectedRevision: 1, answers: {}, ...params };
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    return upstream.length > before ? upstream.at(-1) : null;
  };
  const response = (request, result = { thread: { id: 'thread' } }) => {
    if (request.method === 'asyncQuestion/answer') result = {
      question: { threadId: request.params.threadId, questionId: request.params.questionId,
        answer: { submissionId: request.params.submissionId, answers: request.params.answers } }, ...result };
    broker.routeServerMessage({ id: request.id, result });
  };
  const resume = client => { const request = send(client, 'thread/resume'); assert.ok(request); response(request); };
  return { broker, client, send, response, resume, upstream };
}

test('a joined device may read and answer a question during a peer turn without stealing turn ownership', t => {
  const f = fixture(t), a = f.client(), b = f.client(), stranger = f.client(); f.resume(a); f.resume(b);
  const start = f.send(a, 'turn/start'); f.response(start, { turn: { id: 'turn' } });
  assert.ok(f.send(b, 'asyncQuestion/list'));
  assert.ok(f.send(b, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'q', submissionId: 'submission', expectedRevision: 1, answers: {} }));
  assert.equal(f.broker.activeTurns.get('thread').owner, a);
  assert.equal(f.send(stranger, 'asyncQuestion/answer'), null);
  assert.equal(stranger.messages.at(-1).error.code, -32023);
});

test('question change notifications fan out only to subscribed, capable devices', t => {
  const f = fixture(t), a = f.client(), b = f.client(), old = f.client(false), stranger = f.client();
  f.resume(a); f.resume(b); f.resume(old);
  const event = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'q', revision: 2 } } };
  f.broker.routeServerMessage(event);
  assert.deepEqual(a.messages.at(-1), event); assert.deepEqual(b.messages.at(-1), event);
  assert.equal(old.messages.some(item => item.method === event.method), false);
  assert.equal(stranger.messages.some(item => item.method === event.method), false);
  assert.equal(f.send(old, 'asyncQuestion/list'), null);
  assert.match(old.messages.at(-1).error.message, /negotiation/);
});

test('per-client async question negotiation overrides forged turn and tool catalog flags', t => {
  const f = fixture(t), old = f.client(false); f.resume(old);
  const turn = f.send(old, 'turn/start', { threadId: 'thread', asyncUserQuestions: true });
  assert.equal(turn.params.asyncUserQuestions, false);
  const catalog = f.send(old, 'tools/catalog', { threadId: 'thread', asyncUserQuestions: true });
  assert.equal(catalog.params.asyncUserQuestions, false);
});

test('a newly admitted answer turn belongs to the answering device and disconnect interrupts that exact turn', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const answer = f.send(b, 'asyncQuestion/answer');
  f.response(answer, { threadId: 'thread', accepted: true, duplicate: false, startedTurn: { id: 'answer-turn', status: 'running' } });
  assert.equal(f.broker.threadOwners.get('thread'), b);
  assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'answer-turn', owner: b });
  f.broker.sharedThreads.leave('thread', a);
  f.broker.detach(b);
  assert.ok(f.upstream.some(message => message.method === 'turn/interrupt' && message.params.turnId === 'answer-turn'));
});

test('disconnect before the answer receipt never interrupts a peer turn; a late new-turn receipt is cancelled', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const start = f.send(a, 'turn/start'); f.response(start, { turn: { id: 'peer-turn' } });
  const answer = f.send(b, 'asyncQuestion/answer');
  const before = f.upstream.length;
  f.broker.detach(b);
  assert.equal(f.upstream.slice(before).some(message => message.method === 'turn/interrupt'), false);
  f.response(answer, { threadId: 'thread', accepted: true, duplicate: false, startedTurn: { id: 'late-answer-turn', status: 'running' } });
  assert.ok(f.upstream.some(message => message.method === 'turn/interrupt' && message.params.turnId === 'late-answer-turn'));
  assert.equal(f.broker.activeTurns.get('thread').owner, a);
});

test('a replayed answer receipt cannot recreate a completed turn or steal control', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const answer = f.send(b, 'asyncQuestion/answer');
  f.response(answer, { threadId: 'thread', accepted: true, duplicate: true, startedTurn: { id: 'old-turn', status: 'completed' } });
  assert.equal(f.broker.activeTurns.has('thread'), false);
  assert.equal(f.broker.threadOwners.get('thread'), a);
});

test('a terminal notification preceding an answer receipt cannot resurrect that turn', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const answer = f.send(b, 'asyncQuestion/answer');
  f.broker.routeServerMessage({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'already-done' } });
  f.response(answer, { threadId: 'thread', accepted: true, duplicate: false, startedTurn: { id: 'already-done', status: 'running' } });
  assert.equal(f.broker.activeTurns.has('thread'), false);
  assert.equal(f.broker.threadOwners.get('thread'), a);
});


test('retrying a saved unclaimed answer can own a newly admitted recovery turn', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const answer = f.send(b, 'asyncQuestion/answer');
  f.response(answer, { threadId: 'thread', accepted: true, duplicate: true, startedTurn: { id: 'recovery-turn', status: 'running' } });
  assert.equal(f.broker.threadOwners.get('thread'), b);
  assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'recovery-turn', owner: b });
});

for (const [name, override] of [
  ['result task', { threadId: 'other-thread' }],
  ['question task', { question: { threadId: 'other-thread', questionId: 'q', answer: { submissionId: 'submission' } } }],
  ['question identity', { question: { threadId: 'thread', questionId: 'other-question', answer: { submissionId: 'submission' } } }],
  ['submission identity', { question: { threadId: 'thread', questionId: 'q', answer: { submissionId: 'other-submission' } } }],
  ['missing question', { question: null }],
]) test(`a mismatched ${name} receipt cannot acquire task control or interrupt a peer`, t => {
  const f = fixture(t), a = f.client(), b = f.client(), c = f.client(); f.resume(a); f.resume(b);
  f.response(f.send(c, 'thread/resume', { threadId: 'other-thread' }), { thread: { id: 'other-thread' } });
  const answer = f.send(b, 'asyncQuestion/answer');
  f.response(answer, { threadId: 'thread', accepted: true, duplicate: false,
    startedTurn: { id: 'wrong-answer-turn', status: 'running' }, ...override });
  assert.equal(f.broker.threadOwners.get('thread'), a);
  assert.equal(f.broker.threadOwners.get('other-thread'), c);
  assert.equal(f.broker.activeTurns.size, 0);
  assert.equal(b.messages.at(-1).error?.code, -32001);
  assert.match(b.messages.at(-1).error.message, /unknown/i);
  f.broker.detach(b);
  assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
});

test('a late mismatched answer receipt after disconnect cannot cancel another task', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const answer = f.send(b, 'asyncQuestion/answer');
  f.broker.detach(b);
  f.response(answer, { threadId: 'other-thread', accepted: true, duplicate: false,
    startedTurn: { id: 'peer-turn', status: 'running' } });
  assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  assert.equal(f.broker.threadDrains.size, 0);
  assert.equal(f.broker.threadOwners.get('thread'), a);
});

for (const mismatch of [false, true]) test(`expired answer retains binding for a ${mismatch ? 'mismatched' : 'valid'} late receipt`, t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const answer = f.send(b, 'asyncQuestion/answer', { threadId: 'thread', answers: { item: { text: 'private answer' } } });
  f.broker.expireRequest(answer.id);
  const pending = f.broker.pending.get(answer.id);
  assert.deepEqual(JSON.parse(JSON.stringify(pending.params)), { threadId: 'thread', questionId: 'q', submissionId: 'submission' });
  assert.equal(pending.params.answers, undefined, 'compaction releases answer content');
  const delivered = b.messages.length;
  f.response(answer, { threadId: 'thread', accepted: true, duplicate: false,
    question: { threadId: 'thread', questionId: 'q', answer: { submissionId: mismatch ? 'other' : 'submission', answers: answer.params.answers } },
    startedTurn: { id: 'late-turn', status: 'running' } });
  assert.equal(b.messages.length, delivered, 'expiration already delivered the unknown outcome');
  assert.equal(f.broker.threadOwners.get('thread'), mismatch ? a : b);
  assert.equal(f.broker.activeTurns.has('thread'), !mismatch);
  f.broker.sharedThreads.leave('thread', a);
  f.broker.detach(b);
  assert.equal(f.upstream.some(message => message.method === 'turn/interrupt' && message.params.turnId === 'late-turn'), !mismatch);
});

for (const shared of [true, false]) {
  for (const [name, params] of [
    ['mismatched task', { threadId: 'thread', question: { threadId: 'other-thread', questionId: 'private-q', revision: 2 } }],
    ['missing routing task', { question: { threadId: 'other-thread', questionId: 'private-q', revision: 2 } }],
    ['empty routing task', { threadId: '', question: { threadId: 'other-thread', questionId: 'private-q', revision: 2 } }],
  ]) test(`${shared ? 'shared' : 'exclusive'} async ${name} never delivers a foreign question`, t => {
    const f = fixture(t), owner = f.client(), viewer = f.client(), stranger = f.client();
    owner.gatewaySharedThreadsV1 = shared;
    f.resume(owner);
    if (shared) f.resume(viewer);
    const peers = [owner, viewer, stranger];
    const delivered = peers.map(peer => peer.messages.length);
    f.broker.routeServerMessage({ method: 'asyncQuestion/changed', params });
    assert.deepEqual(peers.map(peer => peer.messages.length), delivered,
      'task binding must be checked before delivering content, including a threadless broadcast');
    const valid = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
      question: { threadId: 'thread', questionId: 'own-q', revision: 3 } } };
    f.broker.routeServerMessage(valid);
    assert.deepEqual(owner.messages.at(-1), valid, 'a later valid update must still reach its owner');
    if (shared) {
      assert.deepEqual(viewer.messages.at(-1), valid);
      f.broker.detach(owner);
      f.broker.routeServerMessage({ method: 'asyncQuestion/changed', params });
      assert.deepEqual(viewer.messages.at(-1), valid, 'handoff does not weaken the task binding');
      const rejoined = f.client();
      f.resume(rejoined);
      const before = rejoined.messages.length;
      f.broker.routeServerMessage({ method: 'asyncQuestion/changed', params });
      assert.equal(rejoined.messages.length, before, 'reconnection does not admit a foreign update');
      f.broker.routeServerMessage(valid);
      assert.deepEqual(rejoined.messages.at(-1), valid);
    }
    assert.equal(stranger.messages.length, delivered[2], 'unsubscribed clients see no question');
  });
}

for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
  for (const duplicate of [false, true]) test(`a ${lifecycle} answer receipt with mismatched content cannot change control (duplicate=${duplicate})`, t => {
    const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
    const answer = f.send(b, 'asyncQuestion/answer', {
      threadId: 'thread', answers: { item: { selectedOptionIds: ['option-1'], text: 'original answer' } },
    });
    if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
    if (lifecycle.includes('disconnected')) f.broker.detach(b);
    const before = b.messages.length;
    f.response(answer, { threadId: 'thread', accepted: true, duplicate,
      question: { threadId: 'thread', questionId: 'q', answer: {
        submissionId: 'submission', answers: { item: { selectedOptionIds: ['option-2'], text: 'foreign answer' } },
      } }, startedTurn: { id: 'foreign-answer-turn', status: 'running' } });
    assert.equal(f.broker.threadOwners.get('thread'), a, 'the receipt must not transfer task control');
    assert.equal(f.broker.activeTurns.size, 0, 'the receipt must not create an owned turn');
    assert.equal(f.broker.threadDrains.size, 0, 'the receipt must not start a drain');
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
      'a disconnected answerer must not cancel the turn described by a mismatched receipt');
    if (lifecycle === 'connected') assert.equal(b.messages.at(-1).error?.code, -32001);
    else assert.equal(b.messages.length, before, 'late responses are not delivered again');
  });
}

for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
  for (const overflow of [false, true]) test(`${lifecycle}: replayed terminal frames at the answer completion limit do not hide a new turn (overflow=${overflow})`, t => {
    const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
    const answer = f.send(b, 'asyncQuestion/answer');
    if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
    if (lifecycle.includes('disconnected')) f.broker.detach(b);
    for (let index = 0; index < 64; index++)
      f.broker.routeServerMessage({ method: 'turn/completed', params: { threadId: 'thread', turnId: `completed-${index}` } });
    // Duplicate lifecycle frames carry no additional completion identity. A
    // genuinely new 65th completion must still trigger conservative overflow.
    for (let index = 0; index < 4; index++)
      f.broker.routeServerMessage({ method: 'turn/completed', params: {
        threadId: 'thread', turnId: overflow ? 'completed-64' : 'completed-0',
      } });
    f.response(answer, { threadId: 'thread', accepted: true, duplicate: false,
      startedTurn: { id: 'new-answer-turn', status: 'running' } });
    if (lifecycle.includes('disconnected')) {
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt' &&
        message.params.turnId === 'new-answer-turn'), !overflow,
      'a confirmed new admission must still be cancelled for its disconnected answerer');
      assert.equal(f.broker.threadOwners.get('thread'), a);
    } else {
      assert.equal(f.broker.activeTurns.get('thread')?.turnId, overflow ? undefined : 'new-answer-turn');
      assert.equal(f.broker.threadOwners.get('thread'), overflow ? a : b);
      if (!overflow) {
        f.broker.sharedThreads.leave('thread', a);
        f.broker.detach(b);
        assert.ok(f.upstream.some(message => message.method === 'turn/interrupt' &&
          message.params.turnId === 'new-answer-turn'));
      }
    }
  });
}

for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
  for (const terminal of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
    for (const params of [
      { turnId: 'already-done' }, { turn_id: 'already-done' },
      { turn: { turnId: 'already-done' } }, { turn: { id: 'already-done' } },
    ]) test(`${lifecycle}: ${terminal} ${JSON.stringify(params)} fences a late async answer admission`, t => {
      const f = fixture(t), owner = f.client(), answerer = f.client(); f.resume(owner); f.resume(answerer);
      const answer = f.send(answerer, 'asyncQuestion/answer');
      if (lifecycle.includes('expired')) f.broker.expireRequest(answer.id);
      if (lifecycle.includes('disconnected')) f.broker.detach(answerer);
      f.broker.routeServerMessage({ method: terminal, params });
      f.response(answer, { threadId: 'thread', accepted: true, duplicate: false,
        startedTurn: { id: 'already-done', status: 'running' } });
      assert.equal(f.broker.activeTurns.has('thread'), false, 'a completed answer turn cannot be resurrected');
      assert.equal(f.broker.threadOwners.get('thread'), owner, 'a stale admission cannot transfer task ownership');
      assert.equal(f.broker.threadDrains.size, 0);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
        'disconnect cannot interrupt an already terminal answer admission');
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}

for (const params of [
  { turnId: 'other-turn' }, { turn_id: 'other-turn' },
  { turn: { turnId: 'other-turn' } }, { turn: { id: 'other-turn' } },
]) test(`a turn-only terminal ${JSON.stringify(params)} preserves a different answer admission`, t => {
  const f = fixture(t), owner = f.client(), answerer = f.client(); f.resume(owner); f.resume(answerer);
  const answer = f.send(answerer, 'asyncQuestion/answer');
  f.broker.routeServerMessage({ method: 'turn/completed', params });
  f.response(answer, { threadId: 'thread', accepted: true, duplicate: false,
    startedTurn: { id: 'new-answer-turn', status: 'running' } });
  assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'new-answer-turn', owner: answerer });
  assert.equal(f.broker.threadOwners.get('thread'), answerer);
});

for (const shared of [false, true]) {
  for (const conflict of [false, true]) {
    test(`${shared ? 'shared' : 'exclusive'}: duplicate question identities reject the list without choosing a card (conflict=${conflict})`, t => {
      const f = fixture(t), owner = f.client(), viewer = shared ? f.client() : owner;
      owner.gatewaySharedThreadsV1 = shared;
      f.resume(owner);
      if (shared) f.resume(viewer);
      const question = { threadId: 'thread', questionId: 'question', requestId: 'request',
        sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1, revision: 1, status: 'pending',
        questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', options: [], multiSelect: false }] };
      const second = conflict ? { ...question, revision: 2, status: 'queued',
        answer: { submissionId: 'other-device', acceptedAtMs: 2,
          answers: { item: { selectedOptionIds: [], text: 'saved answer' } } } } : structuredClone(question);
      const request = f.send(viewer, 'asyncQuestion/list');
      f.response(request, { threadId: 'thread', questions: [question, second] });
      assert.equal(viewer.messages.at(-1).error?.code, -32001,
        'one list cannot bind two cards or saved answers to the same question ID');
      assert.equal(f.broker.threadOwners.get('thread'), owner);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/list').length, 1,
        'invalid snapshots must not cause an automatic retry');
      assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'asyncQuestion/cancel', 'turn/interrupt'].includes(message.method)), false);
      // A new explicit read may recover the original task with unique records.
      const recovered = { threadId: 'thread', questions: [second, { ...question, questionId: 'another-question' }] };
      f.response(f.send(viewer, 'asyncQuestion/list'), recovered);
      assert.deepEqual(viewer.messages.at(-1).result, recovered);
      assert.equal(f.broker.threadOwners.get('thread'), owner);
    });
  }
}
