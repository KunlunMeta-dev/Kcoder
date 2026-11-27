import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, status) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current' } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const send = (client, method, params = { threadId: 'thread' }) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    return upstream.at(-1);
  };
  const reply = (request, result) => emit({ id: request.id, result });
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    reply(send(client, 'thread/resume'), { thread: { id: 'thread' } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : null;
  const turn = { id: 'turn', threadId: 'thread', attemptId: 'ended', status: 'running' };
  reply(send(owner, 'turn/start'), { turn });
  emit({ method: `turn/${status}`, params: { threadId: 'thread', turnId: turn.id,
    turn: { ...turn, status } } });
  assert.equal(broker.activeTurns.has('thread'), false, 'the original attempt has really ended');
  reply(send(owner, 'turn/start', { threadId: 'thread', retryFromTurnId: turn.id,
    retryOperationId: 'retry' }), { turn: { ...turn, attemptId: 'current' } });
  assert.equal(broker.sharedInteractions.isSupersededAttempt('thread', 'turn', 'ended'), false,
    'terminal cleanup removed the predecessor before retry admission could record it');
  return { broker, upstream, emit, send, reply, join, owner, viewer };
}

for (const shared of [false, true]) for (const status of ['completed', 'failed', 'interrupted']) {
  for (const kind of ['question', 'approval']) for (const nested of [false, true]) {
    test(`${kind}: ${status} attempt cannot reopen input on its retry (shared=${shared}, nested=${nested})`, t => {
      const f = fixture(t, shared, status);
      const prompt = attemptId => ({ id: 500, method: `${kind}/request`, params: {
        threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'card',
        ...(nested ? { turn: { attemptId } } : { attemptId }),
        ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
          : { availableDecisions: ['accept', 'decline'] }),
      } });
      const counts = [f.owner.messages.length, f.viewer?.messages.length, f.upstream.length];
      f.emit(prompt('ended'));
      assert.equal(f.broker.serverRequests.has(500), false, 'an ended attempt cannot reserve the request ID');
      assert.deepEqual([f.owner.messages.length, f.viewer?.messages.length, f.upstream.length], counts,
        'late input cannot open a card or answer a potentially reused transport ID');
      if (shared) {
        const recovering = f.join();
        assert.equal(recovering.messages.some(message => message.id === 500), false,
          'rejoining must not replay ended-attempt input');
      }
      f.emit(prompt('current'));
      assert.equal(f.broker.serverRequests.get(500), f.owner, 'the current attempt may use that ID');
      const result = kind === 'question' ? { answers: { item: { answers: ['Continue'] } } } : { decision: 'accept' };
      f.broker.receive(f.owner, JSON.stringify({ id: 500, result }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
      f.emit({ method: `${kind}/resolved`, params: { threadId: 'thread', turnId: 'turn',
        [`${kind}Id`]: 'card', requestId: 500, attemptId: 'current', reason: 'client_response' } });
      assert.equal(f.owner.messages.at(-1).method, `${kind}/resolved`);
      assert.equal(f.broker.activeTurns.get('thread').attemptId, 'current');
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    });
  }
}
