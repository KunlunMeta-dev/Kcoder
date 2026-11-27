import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    broker.routeServerMessage({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join();
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'original-turn', [field]: 'original-interaction', appServerEpoch: 'epoch',
  } };
  broker.routeServerMessage(request);
  const reply = () => broker.receive(owner, JSON.stringify({ id: request.id,
    result: kind === 'question' ? { answers: { choice: { answers: ['yes'] } } } : { decision: 'accept' } }));
  return { broker, child, upstream, owner, join, request, reply };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    test(`${kind}: a nested terminal turn closes input and fences delayed requests (shared=${shared})`, t => {
      const f = fixture(t, kind, shared);
      f.broker.activeTurns.set('thread', { turnId: 'original-turn', owner: f.owner });
      // EventContext.turnId is optional; the typed Turn still identifies the
      // completed turn. Interactions must use the same identity as routing.
      f.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: {
        serverId: 'owned', sequence: 1, threadId: 'thread',
        turn: { id: 'original-turn', threadId: 'thread', status: 'completed' },
      } })}\n`);
      assert.equal(f.broker.activeTurns.has('thread'), false);
      assert.equal(f.broker.serverRequests.has(f.request.id), false,
        'the terminal turn must close its question input even without a top-level turnId');
      if (shared) {
        const viewer = f.join();
        assert.equal(viewer.messages.some(message => message.method === f.request.method), false);
      }
      const before = f.upstream.length;
      f.reply();
      assert.equal(f.upstream.length, before, 'a reply cannot enter an already completed turn');
      assert.equal(f.owner.messages.at(-1).params?.reason, 'turn_ended');
      const receipt = { method: `${kind}/resolved`, params: { ...f.request.params,
        requestId: f.request.id, reason: 'cancelled' } };
      f.broker.routeServerMessage(receipt);
      f.reply();
      assert.deepEqual(f.owner.messages.at(-1), receipt, 'retain the authoritative delayed receipt');
      const delayed = { ...f.request, id: 900 };
      const count = f.owner.messages.length;
      f.broker.routeServerMessage(delayed);
      assert.equal(f.owner.messages.length, count, 'a delayed card cannot reopen terminal input');
      assert.equal(f.upstream.at(-1).id, delayed.id);
      assert.equal(f.upstream.at(-1).error?.code, -32040);
    });
  }

  for (const shared of [false, true]) {
    for (const terminal of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
      for (const [address, threadParams] of [
        ['threadId', { threadId: 'thread' }],
        ['thread_id', { thread_id: 'thread' }],
        ['thread.threadId', { thread: { threadId: 'thread' } }],
        ['thread.id', { thread: { id: 'thread' } }],
        ['widget.threadId', { widget: { threadId: 'thread' } }],
        ['turnId', { turnId: 'original-turn' }],
        ['turn_id', { turn_id: 'original-turn' }],
        ['turn.turnId', { turn: { turnId: 'original-turn' } }],
        ['turn.id', { turn: { id: 'original-turn' } }],
      ]) {
        test(`${kind}: a ${address}-only ${terminal} closes delivered cards without touching another task (shared=${shared})`, t => {
          const f = fixture(t, kind, shared);
          const other = { ...f.request, id: 600, params: { ...f.request.params,
            threadId: 'other-thread', turnId: address.startsWith('turn') ? 'other-turn' : 'original-turn' } };
          f.broker.threadOwners.set('other-thread', f.owner);
          f.broker.routeServerMessage(other);
          f.broker.activeTurns.set('thread', { turnId: 'original-turn', owner: f.owner });
          f.child.stdout.write(`${JSON.stringify({ method: terminal, params: threadParams })}\n`);
          assert.equal(f.broker.activeTurns.has('thread'), false);
          assert.equal(f.broker.serverRequests.has(f.request.id), false,
            'thread-level completion must retire input just as it retires active execution');
          assert.equal(f.broker.serverRequests.get(other.id), f.owner, 'another task stays answerable');
          if (shared) {
            const viewer = f.join();
            assert.equal(viewer.messages.some(message => message.method === f.request.method), false,
              'rejoining cannot reopen a card from the finished thread');
          }
          const before = f.upstream.length;
          f.reply();
          assert.equal(f.upstream.length, before, 'the ended card cannot submit an answer');
          assert.equal(f.owner.messages.at(-1).params?.reason, 'turn_ended');
          const delayed = { ...f.request, id: 900 };
          f.broker.routeServerMessage(delayed);
          assert.equal(f.upstream.at(-1).id, delayed.id);
          assert.equal(f.upstream.at(-1).error?.code, -32040, 'a new transport ID cannot reopen the known ended turn');
          const receipt = { method: `${kind}/resolved`, params: { ...f.request.params,
            requestId: f.request.id, reason: 'cancelled' } };
          f.broker.routeServerMessage(receipt);
          const settled = f.upstream.length;
          f.reply();
          assert.deepEqual(f.owner.messages.at(-1), receipt, 'the delayed Native outcome remains authoritative');
          assert.equal(f.upstream.length, settled);
          const next = { ...f.request, id: 901, params: { ...f.request.params, turnId: 'next-turn' } };
          f.broker.routeServerMessage(next);
          assert.equal(f.broker.serverRequests.get(next.id), f.owner, 'the next turn can ask normally');
        });
      }
    }
  }

  for (const terminal of ['turn/completed', 'turn/failed', 'turn/interrupted']) {
    test(`${kind}: ${terminal} prevents stale card replay and replies while retaining the delayed native receipt`, t => {
      const f = fixture(t, kind);
      f.broker.routeServerMessage({ method: terminal, params: { threadId: 'thread', turnId: 'original-turn' } });
      const late = f.join();
      assert.equal(late.messages.some(message => message.method === f.request.method), false,
        'reconnecting clients must not reopen an ended turn question');
      assert.equal(f.broker.serverRequests.has(f.request.id), false, 'an ended turn cannot keep pending transport work');
      const current = { turnId: 'new-turn', owner: late };
      f.broker.activeTurns.set('thread', current);
      const before = f.upstream.length;
      f.reply();
      assert.equal(f.upstream.length, before, 'a stale reply must not reach the runtime');
      assert.equal(f.owner.messages.at(-1).method, 'gateway/interaction/replyRejected');
      assert.equal(f.owner.messages.at(-1).params.reason, 'turn_ended');
      assert.equal(f.broker.activeTurns.get('thread'), current, 'a stale reply cannot disturb the next turn');
      const receipt = { method: `${kind}/resolved`, params: { ...f.request.params,
        requestId: f.request.id, reason: 'cancelled', ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
      f.broker.routeServerMessage(receipt);
      assert.deepEqual(f.owner.messages.at(-1), receipt, 'the eventual native receipt remains authoritative');
      f.reply();
      assert.deepEqual(f.owner.messages.at(-1), receipt, 'late replies read the native receipt once available');
      assert.equal(f.upstream.length, before);
    });
  }

  test(`${kind}: exclusive clients cannot forward a reply after their turn ended`, t => {
    const f = fixture(t, kind, false);
    f.broker.routeServerMessage({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'original-turn' } });
    const before = f.upstream.length;
    f.reply();
    assert.equal(f.upstream.length, before);
    assert.equal(f.owner.messages.at(-1).params.reason, 'turn_ended');
    const receipt = { method: `${kind}/resolved`, params: { ...f.request.params,
      requestId: f.request.id, reason: 'cancelled', ...(kind === 'approval' ? { decision: 'decline' } : {}) } };
    f.broker.routeServerMessage(receipt);
    f.reply();
    assert.deepEqual(f.owner.messages.at(-1), receipt);
    assert.equal(f.upstream.length, before);
  });

  test(`${kind}: ended requests without interaction receipts cannot exhaust the next turn's registration`, t => {
    const f = fixture(t, kind);
    for (let index = 1; index < 512; index++) {
      f.broker.routeServerMessage({ ...f.request, id: 500 + index,
        params: { ...f.request.params, [kind === 'question' ? 'questionId' : 'approvalId']: `interaction-${index}` } });
    }
    f.broker.routeServerMessage({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'original-turn' } });
    const viewer = f.join();
    const next = { ...f.request, id: 2000, params: { ...f.request.params, turnId: 'next-turn' } };
    f.broker.routeServerMessage(next);
    assert.deepEqual(viewer.messages.at(-1), next, 'the next question still has shared registration and delivery');
    assert.equal(f.broker.serverRequests.get(next.id), f.owner);
    assert.equal(f.broker.serverRequests.size, 1);
  });

  for (const other of [{ threadId: 'other-thread', turnId: 'original-turn' },
    { threadId: 'thread', turnId: 'other-turn' },
    { threadId: 'other-thread', turn: { id: 'original-turn' } },
    { threadId: 'thread', turnId: 'other-turn', turn: { id: 'original-turn' } },
    { turnId: 'other-turn' },
    { turn_id: 'other-turn' },
    { turn: { turnId: 'other-turn' } },
    { turn: { id: 'other-turn' } },
    { thread_id: 'thread', turnId: 'other-turn' },
    { thread: { threadId: 'thread' }, turnId: 'other-turn' },
    { thread: { id: 'thread' }, turnId: 'other-turn' },
    { widget: { threadId: 'thread' }, turnId: 'other-turn' },
    { threadId: 'other-thread', thread_id: 'thread', turnId: 'original-turn' },
    { thread_id: 'other-thread', thread: { id: 'thread' }, turnId: 'original-turn' },
    { thread: { threadId: 'other-thread', id: 'thread' }, turnId: 'original-turn' },
    { thread: { id: 'other-thread' }, widget: { threadId: 'thread' }, turnId: 'original-turn' }]) {
    test(`${kind}: another terminal binding ${JSON.stringify(other)} leaves the question answerable`, t => {
      const f = fixture(t, kind);
      f.broker.routeServerMessage({ method: 'turn/completed', params: other });
      const late = f.join();
      assert.deepEqual(late.messages.at(-1), f.request);
      const before = f.upstream.length;
      f.reply();
      assert.equal(f.upstream.length, before + 1);
    });
  }
}
