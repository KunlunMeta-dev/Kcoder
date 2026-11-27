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
  broker.initializeResponse = { result: { sessionId: 'session', capabilities: { experimental: {} } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
    return client;
  };
  const owner = join(), viewer = shared ? join() : owner;
  broker.receive(owner, JSON.stringify({ id: ++sequence, method: 'turn/start', params: { threadId: 'thread' } }));
  emit({ id: upstream.at(-1).id, result: { turn: { id: 'turn', status: 'running' } } });
  return { broker, upstream, emit, owner, viewer };
}

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    for (const turn of [[], ['turn'], 'turn', 7, false]) {
      for (const stage of ['request', 'early-terminal', 'pending-terminal']) {
        test(`${stage}: ${kind} malformed turn ${JSON.stringify(turn)} preserves input and its terminal (shared=${shared})`, t => {
          const f = fixture(t, shared);
          const binding = { threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original', appServerEpoch: 'epoch' };
          const request = { id: 500, method: `${kind}/request`, params: { ...binding,
            ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
              : { availableDecisions: ['accept', 'decline'] }) } };
          const terminal = { method: `${kind}/resolved`, params: { ...binding,
            requestId: 500, reason: 'client_response', sequence: 42 } };
          const count = f.viewer.messages.length, writes = f.upstream.length;
          if (stage === 'request') f.emit({ ...request, params: { ...request.params, turn } });
          assert.equal(f.broker.serverRequests.has(500), false, 'malformed snapshots cannot reserve the original request ID');
          assert.equal(f.viewer.messages.length, count);
          assert.equal(f.upstream.length, writes, 'do not answer an unconfirmed waiter');
          // Even a receipt restored before its prompt must not retire that ID.
          if (stage === 'early-terminal') f.emit({ ...terminal, params: { ...terminal.params, turn } });
          assert.equal(f.viewer.messages.length, count);
          f.emit(request);
          assert.equal(f.broker.serverRequests.get(500), f.owner, 'the corrected prompt can still open');
          const delivered = f.viewer.messages.length;
          if (stage === 'pending-terminal') f.emit({ ...terminal, params: { ...terminal.params, turn } });
          assert.equal(f.broker.serverRequests.get(500), f.owner, 'malformed receipts cannot close original input');
          assert.equal(f.viewer.messages.length, delivered);
          f.broker.receive(f.owner, JSON.stringify({ id: 500, result: kind === 'question'
            ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' } }));
          assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
          // Rejecting the malformed receipt must preserve its corrected replay.
          f.emit({ ...terminal, params: { ...terminal.params, turn: { id: 'turn', threadId: 'thread' } } });
          assert.equal(f.broker.serverRequests.has(500), false);
          assert.equal(f.viewer.messages.at(-1).method, terminal.method);
          assert.equal(f.viewer.messages.at(-1).params.sequence, 42);
          assert.equal(f.broker.closed, false);
        });
      }
    }
  }
}
