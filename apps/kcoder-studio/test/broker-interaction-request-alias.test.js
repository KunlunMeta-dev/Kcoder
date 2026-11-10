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
  const join = threadId => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    emit({ id: upstream.at(-1).id, result: { thread: { id: threadId } } });
    return client;
  };
  return { broker, emit, upstream, join };
}

const conflicts = [
  { thread_id: 'peer' }, { thread: { threadId: 'peer' } },
  { thread: { id: 'peer' } }, { widget: { threadId: 'peer' } },
  { turn: { threadId: 'peer', id: 'turn' } },
  { turn_id: 'other-turn' }, { turn: { turnId: 'other-turn' } },
  { turn: { id: 'other-turn' } }, { thread_id: '' }, { turn_id: 7 },
];

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval']) {
    test(`${shared ? 'shared' : 'exclusive'} ${kind}: conflicting first-request aliases cannot open or reserve another card`, t => {
      const f = fixture(t, shared), owner = f.join('original'), peer = f.join('peer');
      const viewer = shared ? f.join('original') : null;
      const clients = [owner, peer, ...(viewer ? [viewer] : [])];
      const counts = clients.map(client => client.messages.length), writes = f.upstream.length;
      const params = { threadId: 'original', turnId: 'turn', [`${kind}Id`]: 'interaction',
        ...(kind === 'question' ? { questions: [] } : {}) };
      for (const extra of conflicts) f.emit({ id: 500, method: `${kind}/request`, params: { ...params, ...extra } });
      assert.deepEqual(clients.map(client => client.messages.length), counts,
        'ambiguous task/turn identities must not reach any card');
      assert.equal(f.broker.serverRequests.has(500), false, 'an ambiguous frame cannot reserve the waiter');
      assert.equal(f.upstream.length, writes, 'never refuse an ID whose task/turn binding is ambiguous');

      // Reuse the same ID to prove rejected aliases did not consume its original binding.
      const valid = { id: 500, method: `${kind}/request`, params: { ...params,
        thread_id: 'original', thread: { id: 'original', threadId: 'original' },
        widget: { threadId: 'original' }, turn_id: 'turn',
        turn: { id: 'turn', turnId: 'turn', threadId: 'original' } } };
      f.emit(valid);
      assert.deepEqual(owner.messages.at(-1), valid);
      if (viewer) assert.deepEqual(viewer.messages.at(-1), valid);
      assert.equal(peer.messages.length, counts[1]);
      assert.equal(f.broker.serverRequests.get(500), owner);
      const result = { threadId: 'original', turnId: 'turn', [`${kind}Id`]: 'interaction',
        ...(kind === 'question' ? { answers: {} } : { decision: 'accept' }) };
      f.broker.receive(owner, JSON.stringify({ id: 500, result }));
      assert.equal(f.upstream.filter(message => message.id === 500 && message.result).length, 1,
        'the correctly bound original interaction remains answerable exactly once');
      f.emit({ method: `${kind}/resolved`, params: { ...params, requestId: 500, reason: 'answered' } });
      assert.equal(owner.messages.at(-1).method, `${kind}/resolved`);
      if (viewer) assert.equal(viewer.messages.at(-1).method, `${kind}/resolved`);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
    });
  }
}
