import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

function fixture(t, shared = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
  broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  const resume = upstream.find(message => message.method === 'thread/resume');
  assert.ok(resume);
  return { broker, client, upstream, emit,
    finish: () => emit({ id: resume.id, result: { thread: { id: 'thread' } } }) };
}

for (const kind of ['question', 'approval']) {
  for (const field of ['id', `${kind}Id`, 'appServerEpoch']) {
    test(`${kind} request rejects an isolated surrogate in ${field} before reserving input`, t => {
      const f = fixture(t); f.finish();
      const original = { id: '原请求-😀', method: `${kind}/request`, params: {
        threadId: 'thread', turnId: 'turn', [`${kind}Id`]: '原卡片-😀', appServerEpoch: '实例-😀',
        ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] } : {}) } };
      const invalid = field === 'id' ? { ...original, id: '\ud800' }
        : { ...original, params: { ...original.params, [field]: '\udfff' } };
      const deliveries = f.client.messages.length, writes = f.upstream.length;
      f.emit(invalid);
      assert.equal(f.client.messages.length, deliveries, 'invalid identities must not display a card');
      assert.equal(f.broker.serverRequests.size, 0, 'invalid identities must not reserve a waiter');
      assert.equal(f.upstream.length, writes, 'unconfirmed transport identities must not receive a refusal');
      f.emit(original);
      assert.equal(f.broker.serverRequests.get(original.id), f.client, 'the real original card remains answerable');
      assert.deepEqual(f.client.messages.at(-1), original);
      const answer = kind === 'question' ? { answers: {} } : { decision: 'accept' };
      f.broker.receive(f.client, JSON.stringify({ id: original.id, result: answer }));
      assert.equal(f.upstream.length, writes + 1, 'only the valid original answer reaches its waiter');
      assert.equal(f.upstream.at(-1).id, original.id);
      const terminal = { method: `${kind}/resolved`, params: { ...original.params,
        requestId: original.id, reason: 'answered' } };
      f.emit(terminal);
      assert.equal(f.broker.serverRequests.has(original.id), false, 'the real receipt still settles original input');
      assert.deepEqual(f.client.messages.at(-1), terminal);
    });
  }
}

for (const shared of [false, true]) {
  for (const field of ['questionId', 'appServerEpoch', 'requestId']) {
    test(`${shared ? 'shared' : 'exclusive'}: invalid terminal ${field} cannot exhaust original-task recovery`, t => {
      const f = fixture(t, shared);
      for (let sequence = 0; sequence <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; sequence++) {
        f.emit({ method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
          questionId: 'question', appServerEpoch: 'epoch', requestId: sequence + 10,
          reason: 'answered', [field]: '\ud800' } });
      }
      const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread', question: {
        threadId: 'thread', questionId: 'saved', revision: 1 } } };
      const terminal = { method: 'question/resolved', params: { threadId: 'thread', turnId: 'turn',
        questionId: '原问题-😀', requestId: '原请求-😀', appServerEpoch: '实例-😀', reason: 'answered' } };
      f.emit(changed); f.emit(terminal); f.finish();
      assert.ok(f.client.messages[0]?.result?.thread,
        'unusable terminal identities must not replace resume with -32047');
      assert.deepEqual(f.client.messages.slice(1), [changed, terminal]);
      assert.ok(f.upstream.every(message => ['thread/resume', 'thread/attach'].includes(message.method)),
        'recovery must not replay answers or interrupt execution');
    });
  }
}
