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
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const send = (client, method) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread' } }));
    return upstream.at(-1);
  };
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    emit({ id: send(client, 'thread/resume').id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, send, join };
}

const invalid = [
  ['conflict', { attemptId: 'old', turn: { attemptId: 'new' } }],
  ['blank outer', { attemptId: ' \u0085\t' }],
  ['invalid outer type', { attemptId: 7 }],
  ['surrogate nested', { turn: { attemptId: '\ud800' } }],
];
const prompt = kind => ({ id: 500, method: `${kind}/request`, params: {
  threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original',
  ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
    : { availableDecisions: ['accept', 'decline'] }),
} });

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const [name, binding] of invalid) {
      test(`${kind}: ${name} attempt cannot reserve the original request (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join();
        const valid = prompt(kind), before = owner.messages.length, writes = f.upstream.length;
        f.emit({ ...valid, params: { ...valid.params, ...binding } });
        assert.equal(f.broker.serverRequests.has(valid.id), false,
          'a request rejected by client identity guards must not retain its waiter');
        assert.equal(owner.messages.length, before);
        assert.equal(f.upstream.length, writes, 'ambiguous identity cannot authorize a refusal');
        f.emit(valid);
        assert.equal(f.broker.serverRequests.get(valid.id), owner, 'correct replay still opens the original card');
        const result = kind === 'question' ? { answers: { item: { answers: ['Continue'] } } } : { decision: 'accept' };
        f.broker.receive(owner, JSON.stringify({ id: valid.id, result }));
        assert.equal(f.upstream.filter(message => message.id === valid.id && message.result).length, 1);
      });

      test(`${kind}: ${name} attempt cannot retire the original card (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join(), valid = prompt(kind);
        f.emit(valid);
        const before = owner.messages.length;
        const resolved = { method: `${kind}/resolved`, params: { threadId: 'thread', turnId: 'turn',
          [`${kind}Id`]: 'original', requestId: valid.id, reason: 'cancelled', sequence: 10 } };
        f.emit({ ...resolved, params: { ...resolved.params, ...binding } });
        assert.equal(f.broker.serverRequests.get(valid.id), owner,
          'client-rejected terminal cannot consume the original waiter or replay identity');
        assert.equal(owner.messages.length, before);
        f.emit(resolved);
        assert.equal(f.broker.serverRequests.has(valid.id), false);
        assert.equal(owner.messages.at(-1).method, resolved.method, 'same sequence remains usable by real terminal');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      });
    }
    for (const binding of [{}, { attemptId: null }, { attemptId: 'new', turn: { attemptId: 'new' } },
      { turn: { attemptId: '\uFEFF' } }]) {
      test(`${kind}: compatible attempt ${JSON.stringify(binding)} remains answerable (shared=${shared})`, t => {
        const f = fixture(t, shared), owner = f.join(), valid = prompt(kind);
        f.emit({ ...valid, params: { ...valid.params, ...binding } });
        assert.equal(f.broker.serverRequests.get(valid.id), owner);
      });
    }
  }
}
