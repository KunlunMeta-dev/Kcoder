import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
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
  return { broker, upstream, emit, owner, recovering: resume() };
}

const changed = (sequence, index = 0) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', sequence, question: { threadId: 'thread', questionId: `question-${index}`, revision: 1,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1,
    status: 'pending', questions: [{ id: 'item', header: 'Mode', question: 'Continue?',
      options: [], multiSelect: false }] },
} });
const invalidSequences = [null, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1, {}, []];

for (const shared of [false, true]) {
  for (const sequence of invalidSequences) {
    test(`${shared ? 'shared' : 'exclusive'}: invalid sequence ${JSON.stringify(sequence)} cannot exhaust question recovery`, t => {
      const f = fixture(t, shared);
      // Question IDs distinguish snapshots, so exact replay deduplication cannot
      // conceal invalid metadata consuming the original resume's capacity.
      for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
        f.emit(changed(sequence, i + 1));
      const valid = [changed(undefined), changed(0, 2), changed(1, 3), changed(Number.MAX_SAFE_INTEGER, 4)];
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      for (const message of valid) f.emit(message);
      f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'invalid transport metadata must not turn successful resume into -32047');
      const delivered = JSON.parse(JSON.stringify([...valid, progress]));
      assert.deepEqual(f.recovering.client.messages.slice(1), delivered);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), delivered,
        'live and recovering peers enforce the same sequence boundary');
      assert.equal(f.broker.threadOwners.get('thread'), f.owner?.client ?? f.recovering.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'read recovery must not answer, cancel, interrupt or replay input');
    });
  }
}

test('Office compatibility handoff rejects invalid question sequences without displacing original input', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt',
    client: { channel: 'runtime', initialized: true }, params: {
      contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} },
    } };
  for (const sequence of invalidSequences)
    assert.equal(handoff.capture(changed(sequence), [pending]), false);
  const valid = [changed(undefined), changed(0, 2), changed(Number.MAX_SAFE_INTEGER, 3)];
  for (const message of valid) assert.equal(handoff.capture(message, [pending]), true);
  const request = { id: 500, method: 'question/request', params: {
    threadId: 'thread', turnId: 'turn', questionId: 'ordinary', questions: [],
  } };
  assert.equal(handoff.capture(request, [pending]), true);
  const delivered = [], refused = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'turn' },
    message => delivered.push(message), message => refused.push(message));
  assert.deepEqual(delivered, [...valid, request]);
  assert.deepEqual(refused, []);
});
