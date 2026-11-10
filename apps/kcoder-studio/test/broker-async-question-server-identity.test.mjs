import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'gateway-target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { sessionId: 'current',
    capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  let sequence = 0;
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  return { broker, upstream, emit, resume };
}

const changed = (serverId, revision = 1) => ({ method: 'asyncQuestion/changed', params: {
  ...(serverId === undefined ? {} : { serverId }), threadId: 'thread',
  question: { threadId: 'thread', questionId: 'question', revision },
} });

for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  test(`${mode}: a foreign async question producer cannot break original-task recovery`, t => {
    const f = fixture(t, shared);
    const owner = shared ? f.resume() : null;
    owner?.finish();
    const recovering = f.resume();
    for (let index = 0; index <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; index++)
      f.emit(changed('server-previous', index + 1));
    const current = changed('server-current', 2), legacy = changed(undefined, 3);
    f.emit(current);
    f.emit(legacy);
    recovering.finish();
    assert.ok(recovering.client.messages[0]?.result?.thread,
      'foreign producer frames must not exhaust the original resume handoff');
    assert.deepEqual(recovering.client.messages.slice(1), [current, legacy]);
    if (owner) assert.deepEqual(owner.client.messages.slice(1), [current, legacy],
      'live peers and recovering peers must enforce the same producer identity');
    assert.equal(f.broker.threadOwners.get('thread'), owner?.client ?? recovering.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
      'recovery must not answer, cancel or replay task input');
  });

  test(`${mode}: live async questions use the Native producer identity, preserving legacy omission`, t => {
    const f = fixture(t, shared), owner = f.resume();
    owner.finish();
    for (const serverId of ['server-previous', 'gateway-target', null]) f.emit(changed(serverId));
    assert.equal(owner.client.messages.length, 1, 'a foreign producer cannot refresh the original card');
    const current = changed('server-current'), legacy = changed(undefined, 2);
    f.emit(current);
    f.emit(legacy);
    assert.deepEqual(owner.client.messages.slice(1), [current, legacy]);
  });
}
