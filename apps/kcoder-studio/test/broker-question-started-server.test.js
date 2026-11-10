import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'gateway-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current',
    capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  const question = { id: 500, method: 'question/request', params: {
    serverId: 'server-current', threadId: 'thread', turnId: 'turn',
    appServerEpoch: 'epoch', questionId: 'question', questions: [],
  } };
  const answer = client => broker.receive(client, JSON.stringify({ id: question.id, result: { answers: {} } }));
  return { broker, upstream, emit, resume, question, answer };
}

const started = (serverId, turnId = 'turn') => ({ method: 'turn/started', params: {
  ...(serverId === undefined ? {} : { serverId }), threadId: 'thread', turnId,
  turn: { id: turnId, threadId: 'thread', status: 'running' },
} });

for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  test(`${mode}: a foreign turn start cannot rebind the original question's clients`, t => {
    const f = fixture(t, shared), owner = f.resume(); owner.finish();
    const viewer = shared ? f.resume() : null; viewer?.finish();
    f.emit(f.question);
    const clients = [owner.client, ...(viewer ? [viewer.client] : [])];
    const counts = clients.map(client => client.messages.length);
    for (const serverId of ['server-previous', 'gateway-target', null])
      f.emit(started(serverId, 'foreign-turn'));
    assert.deepEqual(clients.map(client => client.messages.length), counts,
      'foreign starts must not replace the client turn used by the original question');
    assert.equal(f.broker.serverRequests.get(500), owner.client);

    for (const serverId of ['server-current', undefined]) {
      const current = started(serverId);
      f.emit(current);
      for (const client of clients) assert.deepEqual(client.messages.at(-1), current);
    }
    f.answer(owner.client);
    const receipt = { method: 'question/resolved', params: {
      ...f.question.params, requestId: 500, reason: 'client_response',
    } };
    f.emit(receipt);
    for (const client of clients) assert.deepEqual(client.messages.at(-1), receipt);
    assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1,
      'the original client still answers exactly once');
  });

  test(`${mode}: foreign turn starts cannot overflow original-task question recovery`, t => {
    const f = fixture(t, shared), owner = shared ? f.resume() : null; owner?.finish();
    const recovering = f.resume();
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
      f.emit(started('server-previous', `old-turn-${index}`));
    const current = started('server-current');
    const changed = { method: 'asyncQuestion/changed', params: { serverId: 'server-current',
      threadId: 'thread', question: { threadId: 'thread', questionId: 'async-question', revision: 1 },
    } };
    f.emit(current); f.emit(changed); recovering.finish();
    assert.ok(recovering.client.messages[0]?.result?.thread,
      'stale starts must not cause resume_notification_handoff_incomplete');
    assert.deepEqual(recovering.client.messages.slice(1), [current, changed]);
    if (owner) assert.deepEqual(owner.client.messages.slice(1), [current, changed]);
    f.emit(f.question);
    f.answer(owner?.client ?? recovering.client);
    assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
      'recovery never interrupts or replays task input');
  });
}
