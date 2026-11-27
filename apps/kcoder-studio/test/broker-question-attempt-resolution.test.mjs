import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
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
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const start = (client, attemptId, retry = false) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'turn/start',
      params: { threadId: 'thread', ...(retry ? { retryFromTurnId: 'turn', retryOperationId: 'retry' } : {}) } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'turn/start');
    emit({ id: request.id, result: { turn: { id: 'turn', threadId: 'thread', status: 'running', attemptId } } });
  };
  return { broker, upstream, emit, join, start };
}

const attempt = (value, nested) => value === undefined ? {}
  : nested ? { turn: { attemptId: value } } : { attemptId: value };
const prompt = (kind, locator) => ({ id: 500, method: `${kind}/request`, params: {
  threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original', appServerEpoch: 'epoch',
  ...locator,
  ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
    : { availableDecisions: ['accept', 'decline'] }),
} });
const terminal = (kind, locator) => ({ method: `${kind}/resolved`, params: {
  threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original', appServerEpoch: 'epoch',
  requestId: 500, reason: 'client_response', ...locator,
} });

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const nestedRequest of [false, true]) {
      for (const detached of [false, true]) {
        test(`${kind}: a different attempt cannot settle original input (shared=${shared}, nested=${nestedRequest}, detached=${detached})`, t => {
          const f = fixture(t, shared), owner = f.join();
          const viewer = shared ? f.join() : owner;
          f.emit(prompt(kind, attempt('current-attempt', nestedRequest)));
          if (detached) f.broker.detach(owner);
          const deliveries = viewer.messages.length;
          const wrong = terminal(kind, attempt('old-attempt', !nestedRequest));
          f.emit(wrong);
          assert.equal(f.broker.sharedInteractions.acceptsResolution(
            terminal(kind, attempt('current-attempt', !nestedRequest))), true,
          'an old attempt cannot retire the current receipt identity, even after disconnect');
          assert.equal(viewer.messages.length, deliveries, 'a stale receipt cannot close a displayed card');
          if (!detached) {
            assert.equal(f.broker.serverRequests.get(500), owner, 'the original waiter remains answerable');
            const result = kind === 'question' ? { answers: { item: { answers: ['Continue'] } } } : { decision: 'accept' };
            f.broker.receive(owner, JSON.stringify({ id: 500, result }));
            assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
          }
          const valid = terminal(kind, attempt('current-attempt', !nestedRequest));
          f.emit(valid);
          assert.equal(f.broker.serverRequests.has(500), false);
          if (!detached || shared) assert.deepEqual(viewer.messages.at(-1), valid);
          assert.equal(f.broker.sharedInteractions.acceptsResolution(valid), false, 'the real terminal settles once');
          assert.equal(f.upstream.some(message => ['turn/start', 'asyncQuestion/answer'].includes(message.method)), false);
        });
      }
    }
  }
}

for (const [requestAttempt, receiptAttempt] of [[undefined, 'current'], ['current', undefined],
  [null, 'current'], ['current', null], ['current', 'current']]) {
  test(`legacy attempt omission stays compatible (${requestAttempt}, ${receiptAttempt})`, t => {
    const f = fixture(t, true), owner = f.join();
    f.emit(prompt('question', attempt(requestAttempt, false)));
    const receipt = terminal('question', attempt(receiptAttempt, true));
    f.emit(receipt);
    assert.equal(f.broker.serverRequests.has(500), false);
    assert.deepEqual(owner.messages.at(-1), receipt);
  });
}

for (const shared of [false, true]) {
  test(`a late unseen resolution cannot retire the retry's question ID (shared=${shared})`, t => {
    const f = fixture(t, shared), owner = f.join();
    f.start(owner, 'old-attempt');
    f.emit({ method: 'turn/failed', params: { threadId: 'thread', turnId: 'turn', attemptId: 'old-attempt' } });
    f.start(owner, 'current-attempt', true);
    assert.equal(f.broker.activeTurns.get('thread')?.attemptId, 'current-attempt');

    const stale = terminal('question', attempt('old-attempt', true));
    const before = owner.messages.length;
    f.emit(stale);
    const current = prompt('question', attempt('current-attempt', false));
    f.emit(current);
    assert.equal(f.broker.serverRequests.get(current.id), owner, 'the retry question remains answerable');
    assert.deepEqual(owner.messages.slice(before), [current]);

    f.broker.receive(owner, JSON.stringify({ id: current.id, result: { answers: { item: { answers: ['Continue'] } } } }));
    const resolved = terminal('question', attempt('current-attempt', true));
    f.emit(resolved);
    assert.deepEqual(owner.messages.at(-1), resolved);
    assert.equal(f.broker.serverRequests.has(current.id), false);
    assert.equal(f.upstream.filter(message => message.id === current.id && message.result).length, 1);
  });
}
