import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
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

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    test(`${kind} without a turn identity stays closed after task completion (shared=${shared})`, t => {
      const f = fixture(t, shared), owner = f.join();
      const request = { id: 500, method: `${kind}/request`, params: {
        threadId: 'thread', [`${kind}Id`]: 'original',
      } };
      f.emit(request);
      f.emit({ method: 'turn/completed', params: { threadId: 'thread' } });
      f.emit({ ...request, id: 501, params: { ...request.params, [`${kind}Id`]: 'delayed' } });
      assert.equal(f.broker.activeTurns.has('thread'), false);
      assert.equal(f.broker.serverRequests.has(501), false, 'missing identities cannot certify a new attempt');
      assert.equal(f.upstream.at(-1).id, 501);
      assert.equal(f.upstream.at(-1).error?.code, -32040);
      assert.equal(owner.messages.some(message => message.id === 501), false);
    });

    for (const status of ['failed', 'interrupted']) {
      test(`${kind} remains answerable on a fresh ${status} retry (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join(), retrying = shared ? f.join() : owner;
        const turn = { id: 'turn-1', threadId: 'thread', status: 'running' };
        f.reply(f.send(owner, 'turn/start', { threadId: 'thread' }), { turn });
        const questions = [{ id: 'item', header: 'Mode', prompt: 'Choose a mode',
          options: [{ label: 'Fast', value: 'fast' }], allowsFreeform: true, multiSelect: false }];
        const original = { id: 500, method: `${kind}/request`, params: {
          threadId: 'thread', turnId: turn.id, [`${kind}Id`]: 'original',
          ...(kind === 'question' ? { questions } : {}),
        } };
        f.emit(original);
        f.emit({ method: `turn/${status}`, params: { threadId: 'thread', turnId: turn.id } });
        const retry = f.send(retrying, 'turn/start', { threadId: 'thread',
          retryFromTurnId: turn.id, retryOperationId: 'fresh-retry' });
        // Reserving a retry cannot reopen an unseen prompt from the old attempt.
        const delayed = { ...original, id: 502, params: { ...original.params, [`${kind}Id`]: 'delayed' } };
        f.emit(delayed);
        assert.equal(f.upstream.at(-1).id, delayed.id);
        assert.equal(f.upstream.at(-1).error?.code, -32040);
        f.reply(retry, { turn: { ...turn, attemptId: 'turn-1-retry-fresh' } });
        assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: turn.id, owner: retrying, attemptId: 'turn-1-retry-fresh' });
        const fresh = { ...original, id: 501, params: { ...original.params, [`${kind}Id`]: 'retry' } };
        f.emit(fresh);
        assert.equal(f.broker.serverRequests.get(fresh.id), retrying,
          'the old attempt terminal must not refuse a confirmed running retry');
        for (const client of new Set([owner, retrying])) assert.deepEqual(client.messages.at(-1), fresh);
        const before = f.upstream.length;
        f.emit(original);
        f.emit(delayed);
        const result = kind === 'question' ? { answers: { item: { answers: ['fast'] } } } : { decision: 'accept' };
        f.broker.receive(owner, JSON.stringify({ id: original.id, result }));
        assert.equal(owner.messages.at(-1).params?.reason, 'turn_ended', 'old attempt input stays closed');
        assert.equal(f.upstream.length, before, 'old prompts and replies are never replayed upstream');
        f.broker.receive(retrying, JSON.stringify({ id: fresh.id, result }));
        assert.equal(f.upstream.at(-1).id, fresh.id, 'the retry input reaches its original waiter');
        assert.equal(f.upstream.filter(message => message.id === fresh.id && message.result).length, 1);
        assert.equal(f.upstream.some(message => message.id === fresh.id && message.error), false);
        f.emit({ method: `${kind}/resolved`, params: { ...fresh.params,
          requestId: fresh.id, reason: 'client_response' } });
        for (const client of new Set([owner, retrying]))
          assert.equal(client.messages.at(-1).params.requestId, fresh.id);
        f.emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: turn.id } });
        f.emit({ ...fresh, id: 503, params: { ...fresh.params, [`${kind}Id`]: 'after-retry' } });
        assert.equal(f.broker.serverRequests.has(503), false, 'retry completion closes new input again');
        assert.equal(f.upstream.at(-1).error?.code, -32040);
      });
    }
  }
}
