import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerSharedInteractions } from '../src/broker-shared-interactions.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current' } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
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
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    reply(send(client, 'thread/resume', { threadId: 'thread' }), { thread: { id: 'thread' } });
    return client;
  };
  return { broker, upstream, emit, send, reply, join };
}

test('terminal replay tracking preserves held frames, distinct attempts, legacy frames and bounded lifetime', () => {
  const interactions = new BrokerSharedInteractions({});
  const terminal = { method: 'turn/failed', params: { threadId: 'thread', turnId: 'turn', sequence: 0,
    turn: { id: 'turn', attemptId: 'first', status: 'failed' } } };
  assert.equal(interactions.rejectReplayedTurnTerminal(terminal), false);
  assert.equal(interactions.rejectReplayedTurnTerminal(terminal), false, 'owned buffers may deliver their original frame');
  assert.equal(interactions.rejectReplayedTurnTerminal(structuredClone(terminal)), true);
  assert.equal(interactions.rejectReplayedTurnTerminal({ ...terminal,
    params: { ...terminal.params, turn: { ...terminal.params.turn, attemptId: 'retry' } } }), false);
  assert.equal(interactions.rejectReplayedTurnTerminal({ ...terminal,
    params: { ...terminal.params, sequence: 1 } }), true, 'a new sequence cannot reopen an ended attempt');
  assert.equal(interactions.rejectReplayedTurnTerminal({ ...terminal,
    params: { ...terminal.params, sequence: undefined } }), true, 'omitting sequence cannot reopen an ended attempt');
  const legacy = { ...terminal, params: { ...terminal.params, sequence: undefined,
    turn: { id: 'turn', status: 'failed' } } };
  assert.equal(interactions.rejectReplayedTurnTerminal(legacy), false);
  assert.equal(interactions.rejectReplayedTurnTerminal(structuredClone(legacy)), false);
  const sequencedLegacy = { ...legacy, params: { ...legacy.params, sequence: 5 } };
  assert.equal(interactions.rejectReplayedTurnTerminal(sequencedLegacy), false);
  assert.equal(interactions.rejectReplayedTurnTerminal(structuredClone(sequencedLegacy)), true);
  for (let sequence = 1; sequence <= 2048; sequence++)
    assert.equal(interactions.rejectReplayedTurnTerminal({ ...terminal, params: { ...terminal.params, sequence,
      turn: { ...terminal.params.turn, attemptId: `attempt-${sequence}` } } }), false);
  assert.equal(interactions.rejectReplayedTurnTerminal(structuredClone(terminal)), false,
    'the oldest identity leaves the bounded replay window');
  assert.equal(interactions.rejectReplayedTurnTerminal(structuredClone(terminal)), true);
  interactions.clear();
  assert.equal(interactions.rejectReplayedTurnTerminal(structuredClone(terminal)), false,
    'a cleared broker retains no prior-lifetime replay identities');
});

for (const shared of [false, true]) {
  for (const status of ['failed', 'interrupted']) {
    for (const replayAt of ['admission', 'question']) {
      test(`replayed ${status} cannot close a retry's question (${replayAt}, shared=${shared})`, t => {
        const f = fixture(t, shared), original = f.join(), retrying = shared ? f.join() : original;
        const turn = { id: 'turn', threadId: 'thread', attemptId: 'first', status: 'running' };
        f.reply(f.send(original, 'turn/start', { threadId: 'thread' }), { turn });
        const terminal = { method: `turn/${status}`, params: { serverId: 'server-current',
          threadId: 'thread', turnId: turn.id, sequence: 10, turn: { ...turn, status } } };
        f.emit(terminal);
        const retry = f.send(retrying, 'turn/start', { threadId: 'thread',
          retryFromTurnId: turn.id, retryOperationId: 'retry' });
        if (replayAt === 'admission') f.emit(terminal);
        f.reply(retry, { turn: { ...turn, attemptId: 'retry' } });
        const question = { id: 500, method: 'question/request', params: {
          serverId: 'server-current', threadId: 'thread', turnId: turn.id, questionId: 'retry-question',
          questions: [{ id: 'choice', prompt: 'Retry choice?', options: [], allowsFreeform: true }],
        } };
        f.emit(question);
        const deliveries = retrying.messages.length;
        if (replayAt === 'question') f.emit(terminal);
        assert.equal(f.broker.activeTurns.get('thread')?.owner, retrying,
          'an earlier attempt cannot settle the confirmed retry');
        assert.equal(f.broker.serverRequests.get(question.id), retrying,
          'the fresh question retains its original waiter');
        assert.equal(retrying.messages.length, deliveries, 'old terminal replays cannot close the displayed card');
        f.broker.receive(retrying, JSON.stringify({ id: question.id,
          result: { answers: { choice: { answers: ['retry answer'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === question.id && message.result).length, 1,
          'the retry answer is delivered exactly once');
        // The retry has its own terminal identity even though its turn ID is reused.
        f.emit({ ...terminal, method: 'turn/completed', params: { ...terminal.params, sequence: 20,
          turn: { ...turn, attemptId: 'retry', status: 'completed' } } });
        assert.equal(f.broker.activeTurns.has('thread'), false);
        assert.equal(f.broker.serverRequests.has(question.id), false);
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      });
    }
  }
}
