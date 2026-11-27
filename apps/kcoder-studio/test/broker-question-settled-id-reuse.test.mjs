import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

for (const shared of [false, true]) for (const kind of ['question', 'approval']) {
  test(`settled ${kind} ID can identify a verified new turn (shared=${shared})`, t => {
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
    let sequence = 0;
    const send = (client, method, params) => {
      broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
      const request = upstream.at(-1);
      assert.equal(request.method, method);
      return request;
    };
    const join = () => {
      const client = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; },
        pause() {}, resume() {}, close() {} };
      broker.attach(client);
      Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
      emit({ id: send(client, 'thread/resume', { threadId: 'thread' }).id, result: { thread: { id: 'thread' } } });
      return client;
    };
    const owner = join(), viewer = shared ? join() : null;
    const start = turnId => emit({ id: send(owner, 'turn/start', { threadId: 'thread' }).id,
      result: { turn: { id: turnId, threadId: 'thread', status: 'running' } } });
    const prompt = turnId => ({ id: 500, method: `${kind}/request`, params: {
      threadId: 'thread', turnId, [`${kind}Id`]: `${turnId}-input`, appServerEpoch: 'epoch',
      ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
        : { availableDecisions: ['accept', 'decline'] }),
    } });
    const receipt = request => ({ method: `${kind}/resolved`, params: {
      ...request.params, requestId: request.id, reason: 'client_response',
      ...(kind === 'approval' ? { decision: 'accept' } : {}),
    } });
    const answer = request => ({ ...request.params,
      ...(kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' }),
    });
    start('old-turn');
    const old = prompt('old-turn');
    emit(old);
    broker.receive(owner, JSON.stringify({ id: old.id, result: answer(old) }));
    emit(receipt(old));
    emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'old-turn' } });
    start('new-turn');
    const next = prompt('new-turn');
    const before = owner.messages.length;
    // Replays and unconfirmed task bindings must keep the original terminal fence.
    emit(old);
    emit({ ...next, params: { ...next.params, turnId: 'unconfirmed-turn' } });
    assert.equal(owner.messages.length, before);
    emit(next);
    assert.equal(broker.serverRequests.get(next.id), owner, 'the new original waiter must be registered');
    assert.deepEqual(owner.messages.at(-1), next);
    if (viewer) assert.deepEqual(viewer.messages.at(-1), next);
    const writes = upstream.length;
    broker.receive(owner, JSON.stringify({ id: old.id, result: answer(old) }));
    assert.equal(upstream.length, writes, 'the old answer cannot consume the new waiter');
    emit(receipt(old));
    assert.equal(broker.serverRequests.get(next.id), owner, 'the old receipt cannot settle the new waiter');
    broker.receive(owner, JSON.stringify({ id: next.id, result: answer(next) }));
    assert.equal(upstream.length, writes + 1);
    emit(receipt(next));
    // Shared late replies read the retained receipt. Exclusive transports keep
    // their existing Native receipt-reconciliation path outside this scenario.
    if (shared) broker.receive(owner, JSON.stringify({ id: next.id, result: answer(next) }));
    assert.equal(upstream.length, writes + 1, 'the new answer is forwarded once');
    assert.equal(broker.closed, false);
    assert.equal(upstream.some(message => message.method === 'turn/interrupt'), false);
  });
}
