import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'gateway-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current' } };
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
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    emit({ id: request.id, result: { thread: { id: 'thread' } } });
    return client;
  };
  return { broker, upstream, emit, join };
}

const locators = {
  missing: {},
  null: { threadId: null },
  snake: { thread_id: 'thread' },
  nested: { thread: { id: 'thread' } },
  widget: { widget: { threadId: 'thread' } },
};

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) {
    for (const [name, locator] of Object.entries(locators)) {
      test(`${kind}: foreign producer with ${name} task locator cannot consume ${shared ? 'shared' : 'exclusive'} input`, t => {
        const f = fixture(t, shared), owner = f.join(), viewer = shared ? f.join() : null;
        const field = kind === 'question' ? 'questionId' : 'approvalId';
        const params = { serverId: 'server-current', turnId: 'turn', [field]: 'original' };
        const original = { id: 500, method: `${kind}/request`, params: { ...params, threadId: 'thread' } };
        const counts = [owner.messages.length, viewer?.messages.length], writes = f.upstream.length;
        // Some old frames use aliases; malformed stale frames may have no task
        // at all. Neither may answer a current waiter through refusal cleanup.
        f.emit({ ...original, params: { ...params, ...locator, serverId: 'server-previous' } });
        assert.equal(f.upstream.length, writes, 'a foreign frame must not send a rejection to the current waiter');
        assert.deepEqual([owner.messages.length, viewer?.messages.length], counts, 'a foreign prompt must not open a card');
        assert.equal(f.broker.serverRequests.has(original.id), false, 'a foreign prompt must not reserve the transport ID');

        f.emit(original);
        assert.deepEqual(owner.messages.at(-1), original);
        if (viewer) assert.deepEqual(viewer.messages.at(-1), original);
        f.broker.receive(owner, JSON.stringify({ id: original.id,
          result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
        assert.equal(f.upstream.length, writes + 1, 'the original prompt must remain answerable once');
        assert.equal(f.upstream.at(-1).id, original.id);
      });
    }
  }
}
