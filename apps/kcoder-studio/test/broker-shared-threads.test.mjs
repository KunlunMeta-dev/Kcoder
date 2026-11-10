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
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const client = (shared = true) => {
    const value = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; },
      pause() {}, resume() {}, close() {} };
    broker.attach(value); value.initialized = true; value.gatewaySharedThreadsV1 = shared;
    return value;
  };
  const send = (client, method, params = { threadId: 'thread' }) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: client.messages.length + upstream.length + 1, method, params }));
    return upstream.length > before ? upstream.at(-1) : null;
  };
  const response = (request, result = { thread: { id: 'thread' } }, error) => broker.routeServerMessage({ id: request.id, ...(error ? { error } : { result }) });
  const resume = owner => { const request = send(owner, 'thread/resume'); assert.ok(request); response(request); };
  return { broker, upstream, client, send, response, resume };
}

test('two clients join, receive the same stream, and alternate sending without stealing active control', t => {
  const f = fixture(t), a = f.client(), b = f.client(), stranger = f.client();
  f.resume(a); f.resume(b);
  const request = f.send(b, 'turn/start', { threadId: 'thread', clientMessageId: 'b-message', input: [{ text: 'hello' }] });
  assert.ok(request);
  assert.equal(f.broker.threadOwners.get('thread'), b);
  assert.equal(f.send(a, 'turn/start'), null, 'in-flight admission must serialize before its ACK');
  assert.equal(a.messages.at(-1).error.code, -32044);
  f.response(request, { turn: { id: 'turn-b' } });
  const event = { method: 'item/delta', params: { threadId: 'thread', turnId: 'turn-b', delta: { text: 'answer' } } };
  f.broker.routeServerMessage(event);
  assert.deepEqual(a.messages.at(-1), event); assert.deepEqual(b.messages.at(-1), event);
  assert.equal(stranger.messages.length, 0, 'unsubscribed clients must not receive private output');
  assert.equal(f.send(a, 'turn/start'), null);
  f.broker.routeServerMessage({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn-b' } });
  assert.ok(f.send(a, 'turn/start'), 'next idle turn may come from the other device');
});

test('confirmed shared resumes can declare next-turn presentation without inheriting controller resources', t => {
  const f = fixture(t), owner = f.client(), viewer = f.client(), stranger = f.client();
  const experimental = { studioWorkModesV1: true, inlineWidgetsV1: true };
  for (const client of [owner, viewer, stranger])
    f.broker.studioPresentation.initialize(client, { params: { capabilities: { experimental } } });
  f.broker.initializeResponse = { result: { capabilities: { experimental } } };
  f.resume(owner);
  const params = { threadId: 'thread', clientPresentation: { version: 1, studioWorkMode: 'kcoder', inlineWidgets: true } };
  const pendingResume = f.send(viewer, 'thread/resume');
  assert.ok(pendingResume);
  assert.equal(f.send(viewer, 'turn/start', params), null);
  assert.match(viewer.messages.at(-1).error.message, /resumed/);
  f.response(pendingResume);
  assert.equal(f.broker.threadOwners.get('thread'), owner);
  assert.equal(f.send(stranger, 'turn/start', params), null);
  assert.match(stranger.messages.at(-1).error.message, /resumed/);
  assert.equal(f.send(viewer, 'widget/read', { threadId: 'thread', widget: { threadId: 'thread' } }), null);
  assert.match(viewer.messages.at(-1).error.message, /Widget access requires a thread resumed/);
  const turn = f.send(viewer, 'turn/start', params);
  assert.ok(turn);
  assert.deepEqual(turn.params.clientPresentation, params.clientPresentation);
  assert.equal(f.send(owner, 'turn/start', params), null);
  assert.equal(owner.messages.at(-1).error.code, -32044);
});

test('late join buffers events until its snapshot response without duplicating the owner stream', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a);
  const request = f.send(b, 'thread/resume');
  const event = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'during resume' } } };
  f.broker.routeServerMessage(event);
  assert.deepEqual(a.messages.at(-1), event); assert.equal(b.messages.length, 0);
  f.response(request);
  assert.ok(b.messages[0].result.thread); assert.deepEqual(b.messages[1], event);
  assert.equal(a.messages.filter(value => value.method === event.method).length, 1);
  assert.equal(f.broker.threadOwners.get('thread'), a);
});

test('simultaneous cold resumes share the resident thread after each authoritative response', t => {
  const f = fixture(t), a = f.client(), b = f.client();
  const first = f.send(a, 'thread/resume'), second = f.send(b, 'thread/resume'); assert.ok(second);
  f.response(first); f.response(second);
  assert.ok(f.broker.sharedThreads.has('thread', a)); assert.ok(f.broker.sharedThreads.has('thread', b));
});

test('failed join and observer disconnect do not interrupt or leak another client turn', t => {
  const f = fixture(t), a = f.client(), b = f.client(), c = f.client(); f.resume(a); f.resume(b);
  const failed = f.send(c, 'thread/resume'); f.response(failed, null, { code: -1, message: 'failed' });
  assert.equal(f.broker.sharedThreads.has('thread', c), false);
  const turn = f.send(a, 'turn/start'); f.response(turn, { turn: { id: 'turn-a' } });
  const count = f.upstream.length; f.broker.detach(b);
  assert.equal(f.upstream.slice(count).some(request => request.method === 'turn/interrupt'), false);
  assert.equal(f.broker.activeTurns.get('thread').owner, a);
  f.broker.routeServerMessage({ method: 'item/delta', params: { threadId: 'thread', delta: { text: 'private' } } });
  assert.equal(c.messages.some(value => value.method === 'item/delta'), false);
});

test('shared approval accepts only the original client while terminal resources stay private', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const request = f.send(b, 'turn/start'); f.response(request, { turn: { id: 'turn-b' } });
  f.broker.routeServerMessage({ id: 800, method: 'approval/request', params: { threadId: 'thread', turnId: 'turn-b', approvalId: 'approval-800' } });
  assert.equal(a.messages.at(-1).method, 'approval/request');
  assert.equal(b.messages.at(-1).method, 'approval/request');
  const count = f.upstream.length;
  f.broker.receive(b, JSON.stringify({ id: 800, result: { decision: 'unsupported' } }));
  assert.equal(f.upstream.length, count, 'invalid replies cannot consume the interaction');
  f.broker.receive(a, JSON.stringify({ id: 800, result: { decision: 'accept' } }));
  assert.equal(f.upstream.length, count, 'a viewer cannot approve the originating client turn');
  assert.equal(a.messages.at(-1).params.reason, 'not_original_client');
  f.broker.receive(b, JSON.stringify({ id: 800, result: { decision: 'accept' } }));
  assert.equal(f.upstream.length, count + 1, 'only one valid reply may reach app-server');
  assert.deepEqual(f.upstream.at(-1).result, { decision: 'accept', threadId: 'thread', turnId: 'turn-b', approvalId: 'approval-800' });
  const receipt = { method: 'approval/resolved', params: { requestId: 800, threadId: 'thread', turnId: 'turn-b', approvalId: 'approval-800', decision: 'accept', reason: 'client_response' } };
  f.broker.routeServerMessage(receipt);
  assert.deepEqual(a.messages.at(-1), receipt); assert.deepEqual(b.messages.at(-1), receipt);
  f.broker.receive(b, JSON.stringify({ id: 800, result: { decision: 'decline' } }));
  assert.deepEqual(b.messages.at(-1), receipt, 'late answers read back the original receipt');
  assert.equal(f.upstream.length, count + 1);
  f.broker.routeServerMessage({ method: 'terminal/output', params: { threadId: 'thread', data: 'private terminal' } });
  assert.equal(a.messages.some(value => value.method === 'terminal/output'), false);
});

test('a remaining viewer retains the task but cannot adopt a disconnected client turn or approval', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a);
  const start = f.send(a, 'turn/start'); f.response(start, { turn: { id: 'turn-a' } });
  f.broker.routeServerMessage({ id: 801, method: 'approval/request', params: { threadId: 'thread', turnId: 'turn-a', approvalId: 'approval-801' } });
  f.resume(b);
  assert.equal(b.messages.at(-1).method, 'approval/request');
  const count = f.upstream.length;
  f.broker.detach(a);
  assert.equal(f.broker.threadOwners.get('thread'), b, 'the surviving view remains usable');
  assert.equal(f.broker.activeTurns.has('thread'), false);
  assert.deepEqual(f.upstream.slice(count).filter(value => value.method === 'turn/interrupt').map(value => value.params),
    [{ threadId: 'thread', turnId: 'turn-a' }]);
  assert.equal(f.upstream.filter(value => value.id === 801 && value.error?.code === -32040).length, 1);
  const afterDisconnect = f.upstream.length;
  f.broker.receive(b, JSON.stringify({ id: 801, result: { decision: 'accept' } }));
  assert.equal(f.upstream.length, afterDisconnect, 'no replacement approval is sent');
  assert.equal(b.messages.at(-1).params.reason, 'not_original_client');
  assert.equal(f.send(b, 'turn/start'), null, 'the old turn must settle before the next input');
  f.broker.routeServerMessage({ method: 'turn/interrupted', params: { threadId: 'thread', turnId: 'turn-a' } });
  assert.ok(f.send(b, 'turn/start'), 'the next round can use the same task after original settlement');
});

test('shared questions keep the original client and deny a viewer or unrelated socket', t => {
  const f = fixture(t), a = f.client(), b = f.client(), stranger = f.client(); f.resume(a); f.resume(b);
  f.broker.routeServerMessage({ id: 802, method: 'question/request', params: { threadId: 'thread', turnId: 'turn-a', questionId: 'question-802' } });
  const count = f.upstream.length;
  assert.equal(stranger.messages.length, 0);
  assert.throws(() => f.broker.receive(stranger, JSON.stringify({ id: 802, result: { answers: {} } })), /another client/);
  f.broker.receive(b, JSON.stringify({ id: 802, result: { answers: { q: { answers: ['yes'] } }, threadId: 'wrong-thread' } }));
  assert.equal(f.upstream.length, count);
  f.broker.receive(b, JSON.stringify({ id: 802, result: { answers: { q: { answers: ['yes'] } } } }));
  assert.equal(f.upstream.length, count);
  assert.equal(b.messages.at(-1).params.reason, 'not_original_client');
  f.broker.receive(a, JSON.stringify({ id: 802, result: { answers: { q: { answers: ['yes'] } } } }));
  f.broker.receive(a, JSON.stringify({ id: 802, result: { answers: { q: { answers: ['no'] } } } }));
  assert.equal(f.upstream.length, count + 1);
  assert.deepEqual(f.upstream.at(-1).result.answers.q.answers, ['yes']);
});

test('disconnect cancels only its original active turn across independent tasks', t => {
  const f = fixture(t), a = f.client(), b = f.client();
  for (const [client, threadId, turnId] of [[a, 'task-a', 'turn-a'], [b, 'task-b', 'turn-b']]) {
    const resume = f.send(client, 'thread/resume', { threadId });
    f.response(resume, { thread: { id: threadId } });
    const start = f.send(client, 'turn/start', { threadId, input: [{ text: threadId }] });
    f.response(start, { turn: { id: turnId } });
  }
  const count = f.upstream.length;
  f.broker.detach(a);
  assert.deepEqual(f.upstream.slice(count).filter(value => value.method === 'turn/interrupt').map(value => value.params),
    [{ threadId: 'task-a', turnId: 'turn-a' }]);
  assert.equal(f.broker.activeTurns.get('task-b').owner, b);
  assert.equal(f.broker.activeTurns.get('task-b').turnId, 'turn-b');
});

test('late interactions cannot acquire a surviving viewer or the next round owner', t => {
  const f = fixture(t), a = f.client(), b = f.client();
  f.resume(a); f.resume(b);
  const start = f.send(a, 'turn/start'); f.response(start, { turn: { id: 'old-turn' } });
  f.broker.detach(a);
  const late = id => ({ id, method: 'approval/request', params: { threadId: 'thread', turnId: 'old-turn', approvalId: `approval-${id}` } });
  f.broker.routeServerMessage(late(810));
  assert.equal(f.upstream.at(-1).error.code, -32040);
  assert.equal(b.messages.some(message => message.id === 810), false);
  f.broker.routeServerMessage({ method: 'turn/interrupted', params: { threadId: 'thread', turnId: 'old-turn' } });
  const next = f.send(b, 'turn/start'); f.response(next, { turn: { id: 'next-turn' } });
  f.broker.routeServerMessage(late(811));
  assert.equal(f.upstream.at(-1).error.code, -32040);
  assert.equal(b.messages.some(message => message.id === 811), false);
  assert.equal(f.broker.activeTurns.get('thread').owner, b);
  assert.equal(f.broker.activeTurns.get('thread').turnId, 'next-turn');
});

test('rejected turn admission restores the previous controller; dispose cannot close peer views', t => {
  const f = fixture(t), a = f.client(), b = f.client(); f.resume(a); f.resume(b);
  const request = f.send(b, 'turn/start'); f.response(request, null, { code: -32602, message: 'bad input' });
  assert.equal(f.broker.threadOwners.get('thread'), a);
  assert.equal(f.send(a, 'thread/dispose'), null);
  assert.equal(a.messages.at(-1).error.code, -32044);
  assert.ok(f.send(a, 'turn/start'));
});

test('legacy exclusive clients retain their old ownership boundary until a shared client joins', t => {
  const f = fixture(t), a = f.client(false), b = f.client(false), shared = f.client(); f.resume(a);
  assert.equal(f.send(b, 'thread/resume'), null); assert.equal(b.messages.at(-1).error.code, -32023);
  f.resume(shared);
  assert.ok(f.send(a, 'turn/start'));
});

test('legacy exclusive replies use actual delivered Native bindings and retain original receipt replay', t => {
  const f = fixture(t), owner = f.client(false), stranger = f.client(false);
  f.broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  f.resume(owner);
  for (const [method, field, result] of [
    ['question/request', 'questionId', { answers: { choice: { answers: ['answer'] } } }],
    ['approval/request', 'approvalId', { decision: 'accept' }],
  ]) {
    const id = field === 'questionId' ? 901 : 902;
    const binding = { threadId: 'thread', turnId: 'original-turn', [field]: `original-${id}` };
    f.broker.routeServerMessage({ id, method, params: binding });
    const count = f.upstream.length;
    assert.throws(() => f.broker.receive(stranger, JSON.stringify({ id, result })), /another client/);
    assert.equal(f.upstream.length, count);
    f.broker.receive(owner, JSON.stringify({ id, result }));
    assert.deepEqual(f.upstream.at(-1).result, { ...result, ...binding });
    f.broker.routeServerMessage({ method: field === 'questionId' ? 'question/resolved' : 'approval/resolved', params: { ...binding, requestId: id } });
    f.broker.receive(owner, JSON.stringify({ id, result }));
    assert.deepEqual(f.upstream.at(-1).result, { ...result, ...binding });
  }
});

test('exclusive reply binding rejects an explicitly mismatched identity without consuming the question', t => {
  const f = fixture(t), owner = f.client(false);
  f.broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  f.resume(owner);
  f.broker.routeServerMessage({ id: 903, method: 'question/request', params: { threadId: 'thread', turnId: 'original-turn', questionId: 'original-question' } });
  const count = f.upstream.length;
  const answers = { choice: { answers: ['answer'] } };
  f.broker.receive(owner, JSON.stringify({ id: 903, result: { answers, threadId: 'another-thread' } }));
  assert.equal(f.upstream.length, count, 'misbound input must not reach the original Native waiter');
  assert.deepEqual(owner.messages.at(-1).params, { threadId: 'thread', turnId: 'original-turn',
    questionId: 'original-question', appServerEpoch: undefined, requestId: 903, reason: 'invalid_response' });
  assert.equal(f.broker.serverRequests.get(903), owner);
  f.broker.receive(owner, JSON.stringify({ id: 903, result: { answers } }));
  assert.deepEqual(f.upstream.at(-1).result, { answers, threadId: 'thread',
    turnId: 'original-turn', questionId: 'original-question' });
});


test('a subscribed UI can select next-turn expert while a peer runs, without adopting its turn', t => {
  const f = fixture(t), a = f.client(), b = f.client(), stranger = f.client();
  f.broker.initializeResponse = { result: { capabilities: { experimental: { agentTurnConfigurationV1: true } } } };
  for (const client of [a, b, stranger]) client.agentTurnConfigurationV1 = true;
  f.resume(a); f.resume(b);
  const turn = f.send(a, 'turn/start', { threadId: 'thread', input: [{ text: 'running' }] });
  f.response(turn, { turn: { id: 'running-turn' } });
  const before = f.broker.activeTurns.get('thread');
  const change = f.send(b, 'thread/expert', { threadId: 'thread', change: { expectedRevision: 0, expert: null } });
  assert.ok(change);
  f.response(change, { threadId: 'thread', revision: 1, expert: null, turns: [] });
  assert.equal(f.broker.activeTurns.get('thread'), before);
  assert.equal(f.broker.threadOwners.get('thread'), a);
  assert.equal(f.send(stranger, 'thread/expert', { threadId: 'thread', change: { expectedRevision: 0, expert: null } }), null);
  assert.equal(stranger.messages.at(-1).error.code, -32023);
});
