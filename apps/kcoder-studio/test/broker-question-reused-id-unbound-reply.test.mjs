import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const owner = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(owner);
  Object.assign(owner, { initialized: true, gatewaySharedThreadsV1: shared });
  let sequence = 0;
  const rpc = (method, params, result) => {
    broker.receive(owner, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.at(-1);
    assert.equal(request.method, method);
    emit({ id: request.id, result });
  };
  rpc('thread/resume', { threadId: 'thread' }, { thread: { id: 'thread' } });
  const start = turnId => rpc('turn/start', { threadId: 'thread' }, {
    turn: { id: turnId, threadId: 'thread', status: 'running' },
  });
  const reply = response => broker.receive(owner, JSON.stringify({ id: 500, ...response }));
  return { broker, upstream, owner, emit, start, reply };
}

for (const shared of [false, true]) for (const kind of ['question', 'approval']) {
  for (const retired of [false, true]) for (const cancel of [false, true]) for (const sameTurn of [false, true]) {
    test(`reused ${kind} ID rejects unbound old input (shared=${shared}, retired=${retired}, cancel=${cancel}, sameTurn=${sameTurn})`, t => {
      const f = fixture(t, shared);
      const prompt = (turnId, epoch = 'epoch') => ({ id: 500, method: `${kind}/request`, params: {
        threadId: 'thread', turnId, [`${kind}Id`]: `${turnId}-input`, appServerEpoch: epoch,
        ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
          : { availableDecisions: ['accept', 'decline'] }),
      } });
      const value = kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' };
      f.start('old-turn');
      const oldEpoch = sameTurn ? 'old-epoch' : 'epoch';
      const old = prompt('old-turn', oldEpoch);
      if (retired) {
        // A late request from a completed turn is refused and retained without a card.
        f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'old-turn' } });
        f.emit(old);
      } else {
        f.emit(old);
        f.reply({ result: value });
        assert.deepEqual(f.upstream.at(-1).result, { ...value, threadId: 'thread', turnId: 'old-turn',
          [`${kind}Id`]: 'old-turn-input' }, 'first-use legacy replies remain compatible');
        f.emit({ method: `${kind}/resolved`, params: { ...old.params, requestId: old.id, reason: 'client_response' } });
        f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'old-turn' } });
      }
      const nextTurn = sameTurn ? 'old-turn' : 'new-turn';
      const nextEpoch = sameTurn ? 'new-epoch' : 'epoch';
      f.start(nextTurn);
      const next = prompt(nextTurn, nextEpoch);
      f.emit(next);
      assert.equal(f.broker.serverRequests.get(next.id), f.owner);
      const writes = f.upstream.length;
      for (const response of [
        { result: value },
        { result: { ...value, threadId: 'thread' } },
        { result: { ...value, threadId: 'thread', turnId: nextTurn,
          [`${kind}Id`]: `${nextTurn}-input`, appServerEpoch: 'foreign-epoch' } },
        { error: { code: -32800, message: 'cancel old input' } },
        ...(sameTurn ? [
          { result: { ...value, threadId: 'thread', turnId: nextTurn, [`${kind}Id`]: `${nextTurn}-input` } },
          { result: { ...value, threadId: 'thread', turnId: nextTurn,
            [`${kind}Id`]: `${nextTurn}-input`, appServerEpoch: oldEpoch } },
          { error: { code: -32800, message: 'cancel old input', data: { interactionBinding: {
            threadId: 'thread', turnId: nextTurn, [`${kind}Id`]: `${nextTurn}-input`, appServerEpoch: oldEpoch,
          } } } },
        ] : []),
      ]) {
        f.reply(response);
        assert.equal(f.upstream.length, writes, 'a transport ID alone cannot select the new card');
        assert.equal(f.owner.messages.at(-1).params?.reason, 'invalid_response');
        assert.equal(f.broker.serverRequests.get(next.id), f.owner, 'the new question remains answerable');
      }
      const binding = { threadId: 'thread', turnId: nextTurn, [`${kind}Id`]: `${nextTurn}-input`,
        ...(sameTurn ? { appServerEpoch: nextEpoch } : {}) };
      const result = { ...value, ...binding };
      const response = cancel ? { error: { code: -32800, message: 'cancel current input',
        data: { interactionBinding: binding } } } : { result };
      f.reply(response);
      assert.equal(f.upstream.length, writes + 1, 'the exactly bound answer reaches the original waiter once');
      assert.deepEqual(cancel ? f.upstream.at(-1).error : f.upstream.at(-1).result, cancel ? response.error : result);
      assert.equal(f.broker.closed, false);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    });
  }
}
