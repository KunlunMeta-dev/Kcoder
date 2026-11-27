import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  let request;
  const upstream = [];
  child.stdin.on('data', chunk => {
    upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse));
    request = upstream.at(-1);
  });
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
    assert.equal(request.method, 'thread/resume');
    const id = request.id;
    return { client, finish: () => emit({ id, result: { thread: { id: 'thread' } } }) };
  };
  const owner = shared ? resume() : null;
  owner?.finish();
  return { broker, owner, recovering: resume(), emit, upstream };
}

const changed = (questionId, revision) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId, revision },
} });

for (const shared of [false, true]) {
  test(`whitespace-only legacy question IDs cannot exhaust resume (shared=${shared})`, t => {
    const f = fixture(t, shared);
    for (let revision = 1; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; revision++)
      f.emit(changed(' \u0085\t', revision));
    const valid = changed('original', 100);
    f.emit(valid); f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread, 'invalid question IDs must not cause -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [valid]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid]);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never submits input');
  });

  for (const questionId of ['\ufeff', ' \u0085Original\u0085 ']) {
    test(`valid legacy question ID ${JSON.stringify(questionId)} is delivered exactly (shared=${shared})`, t => {
      const f = fixture(t, shared), valid = changed(questionId, 1);
      f.emit(valid); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread);
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid]);
    });
  }
}
