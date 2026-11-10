import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
    const request = upstream.at(-1);
    assert.equal(request.method, 'thread/resume');
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  const owner = shared ? resume() : null;
  owner?.finish();
  const recovering = resume();
  return { broker, upstream, emit, owner, recovering };
}

const changed = (questionId, revision = 1) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId, revision },
} });

for (const shared of [false, true]) {
  const mode = shared ? 'shared' : 'exclusive';
  for (const [name, questionId, count] of [
    ['ASCII byte limit', 'q'.repeat(257), RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1],
    ['UTF-8 byte limit', '问'.repeat(86), RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1],
    ['single oversized identity', 'q'.repeat(RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingBytes), 1],
  ]) test(`${mode}: ${name} cannot exhaust question recovery`, t => {
    const f = fixture(t, shared);
    for (let index = 0; index < count; index++) f.emit(changed(questionId, index + 1));
    const valid = changed('original-question');
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(valid); f.emit(progress); f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread,
      'unusable question identities must not turn successful resume into -32047');
    assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress],
      'live peers must enforce the same identity bounds');
    assert.equal(f.broker.threadOwners.get('thread'), f.owner?.client ?? f.recovering.client);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
      'recovery must never answer, cancel, interrupt or replay input');
  });

  test(`${mode}: 256-byte identities remain deliverable without trimming or normalization`, t => {
    const f = fixture(t, shared);
    const valid = [changed('q'.repeat(256)), changed(`${'问'.repeat(85)}q`, 2)];
    for (const message of valid) {
      assert.equal(Buffer.byteLength(message.params.question.questionId, 'utf8'), 256);
      f.emit(message);
    }
    f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread);
    assert.deepEqual(f.recovering.client.messages.slice(1), valid);
    if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), valid);
  });
}
