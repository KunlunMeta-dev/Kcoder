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
  const resume = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: threadId } } }) };
  };
  return { broker, upstream, emit, resume };
}

for (const shared of [false, true]) {
  for (const recovering of [false, true]) {
    test(`nested turn task routes its question lifecycle without peer broadcast (shared=${shared}, recovering=${recovering})`, t => {
      const f = fixture(t, shared), original = f.resume('original');
      if (!recovering) original.finish();
      const viewer = shared && !recovering ? f.resume('original') : null;
      viewer?.finish();
      const peer = f.resume('peer'); peer.finish();
      const clients = [original.client, ...(viewer ? [viewer.client] : [])];
      const counts = clients.map(client => client.messages.length), peerCount = peer.client.messages.length;
      // Turn IDs are task-local; only the nested task distinguishes this start.
      const started = { method: 'turn/started', params: { serverId: 'server-current', sequence: 1,
        turn: { id: 'turn-1', threadId: 'original', attemptId: 'attempt', status: 'running' } } };
      f.emit(started);
      assert.equal(peer.client.messages.length, peerCount, 'the other task cannot receive the start');
      if (recovering) {
        assert.equal(original.client.messages.length, counts[0], 'handoff retains the start until resume succeeds');
        original.finish();
      }
      const projected = { ...started, params: { ...started.params, threadId: 'original' } };
      for (const client of clients) assert.deepEqual(client.messages.at(-1), projected,
        'clients use the explicit original task when opening their turn and question state');
      const question = { id: 500, method: 'question/request', params: {
        threadId: 'original', turnId: 'turn-1', questionId: 'question', appServerEpoch: 'epoch',
        questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
      } };
      f.emit(question);
      for (const client of clients) assert.deepEqual(client.messages.at(-1), question);
      assert.equal(f.broker.serverRequests.get(500), original.client);
      assert.equal(peer.client.messages.length, peerCount, 'the original question stays in its task');
      f.broker.receive(original.client, JSON.stringify({ id: 500,
        result: { answers: { item: { answers: ['yes'] } } } }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1);
      f.emit({ method: 'turn/completed', params: { ...projected.params,
        turn: { ...started.params.turn, status: 'completed' } } });
      assert.equal(f.broker.serverRequests.has(500), false, 'the original terminal closes its question');
      assert.equal(peer.client.messages.length, peerCount);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    });
  }
}
