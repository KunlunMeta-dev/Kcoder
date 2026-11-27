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
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = (...messages) => child.stdout.write(`${messages.map(JSON.stringify).join('\n')}\n`);
  const send = (client, method, threadId) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId } }));
    return upstream.at(-1);
  };
  const join = threadId => {
    const client = { channel: 'runtime', messages: [], closed: false,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {},
      close() { this.closed = true; } };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const resume = send(client, 'thread/resume', threadId);
    emit({ id: resume.id, result: { thread: { id: threadId } } });
    return client;
  };
  const owner = join('thread'), peer = join('peer');
  const start = send(owner, 'turn/start', 'thread');
  emit({ id: start.id, result: { turn: { id: 'turn', status: 'running' } } });
  const peerStart = send(peer, 'turn/start', 'peer');
  emit({ id: peerStart.id, result: { turn: { id: 'peer-turn', status: 'running' } } });
  const prompt = { id: 500, method: 'question/request', params: { threadId: 'thread', turnId: 'turn',
    questionId: 'question', questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } };
  emit(prompt);
  return { broker, upstream, emit, owner, peer, prompt };
}

for (const shared of [false, true]) {
  for (const method of ['turn/started', 'turn/completed', 'turn/failed', 'turn/interrupted']) {
    for (const params of [undefined, null]) {
      test(`${method} with ${params === null ? 'null' : 'missing'} params cannot fail question peers (shared=${shared})`, t => {
        const f = fixture(t, shared);
        const counts = [f.owner.messages.length, f.peer.messages.length];
        // Top-level locators enter the broker's legacy routing fallback. They
        // cannot turn a malformed notification into an authoritative lifecycle.
        f.emit({ method, threadId: 'thread', turnId: 'turn', ...(params === null ? { params } : {}) });
        assert.equal(f.broker.clients.has(f.owner), true, 'one malformed notification must not fail the shared stream');
        assert.equal(f.broker.clients.has(f.peer), true);
        assert.equal(f.owner.closed || f.peer.closed, false);
        assert.equal(f.broker.serverRequests.get(500), f.owner, 'the original question remains answerable');
        assert.equal(f.broker.activeTurns.get('thread')?.turnId, 'turn');
        assert.equal(f.broker.activeTurns.get('peer')?.turnId, 'peer-turn');
        assert.deepEqual([f.owner.messages.length, f.peer.messages.length], counts);
        f.broker.receive(f.owner, JSON.stringify({ id: 500,
          result: { answers: { item: { answers: ['Original answer'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);

        // The next frames in one actual JSONL chunk still reach their own
        // tasks. Valid legacy locators inside params remain supported.
        const terminal = { method: 'turn/completed', params: { thread_id: 'thread', turn_id: 'turn' } };
        const peerTerminal = { method: 'turn/completed', params: { threadId: 'peer', turnId: 'peer-turn' } };
        f.emit(terminal, peerTerminal);
        assert.equal(f.broker.activeTurns.size, 0);
        assert.deepEqual(f.owner.messages.at(-1), terminal);
        assert.deepEqual(f.peer.messages.at(-1), peerTerminal);
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      });
    }
  }
}
