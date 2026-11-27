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

const changed = (overrides = {}, index = 0) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: `question-${index}`, revision: 1,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1,
    status: 'pending', questions: [{ id: 'item', header: 'Mode', question: 'Continue?',
      options: [], multiSelect: false }], ...overrides },
} });
const fields = ['requestId', 'sourceTurnId', 'toolCallId'];
const invalidValues = [['blank', ' \t\n'], ['null', null], ['number', 7],
  ['ASCII byte overflow', 'a'.repeat(257)], ['UTF-8 byte overflow', '问'.repeat(86)]];

for (const shared of [false, true]) {
  for (const field of fields) {
    for (const [name, value] of invalidValues) {
      test(`${shared ? 'shared' : 'exclusive'}: ${field} ${name} cannot block original-task recovery`, t => {
        const f = fixture(t, shared);
        for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
          f.emit(changed({ [field]: value }, i + 1));
        const valid = changed();
        const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
        f.emit(valid); f.emit(progress); f.recovering.finish();
        assert.ok(f.recovering.client.messages[0]?.result?.thread,
          'unusable source identities must not change successful resume into -32047');
        assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
        if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
        assert.equal(f.broker.activeTurns.size, 0);
        assert.equal(f.broker.threadDrains.size, 0);
        assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
          'readback never answers, cancels or replays input');
      });
    }
  }

  test(`${shared ? 'shared' : 'exclusive'}: omitted legacy and exact byte-boundary source identities recover`, t => {
    const f = fixture(t, shared);
    const legacy = changed(Object.fromEntries(fields.map(field => [field, undefined])));
    // Clients accept omitted source metadata only on status-only refresh hints.
    delete legacy.params.question.questions;
    const boundary = changed(Object.fromEntries(fields.map(field => [field, '问'.repeat(85) + 'a'])), 2);
    f.emit(legacy); f.emit(boundary); f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread);
    assert.deepEqual(f.recovering.client.messages.slice(1), JSON.parse(JSON.stringify([legacy, boundary])));
  });
}

for (const field of fields) {
  test(`Office: invalid ${field} cannot displace the original pending question`, () => {
    const handoff = new BrokerOfficeTaskOwnerHandoff();
    const pending = { method: 'integrations/assistant/adopt',
      client: { channel: 'runtime', initialized: true }, params: {
        contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
        scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
        payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} },
      } };
    for (let i = 0; i <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames; i++)
      for (const [, value] of invalidValues)
        assert.equal(handoff.capture(changed({ [field]: value }, i + 1), [pending]), false);
    const valid = changed();
    const request = { id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'ordinary', questions: [],
    } };
    assert.equal(handoff.capture(valid, [pending]), true);
    assert.equal(handoff.capture(request, [pending]), true);
    const delivered = [], refused = [];
    handoff.settle(pending, { threadId: 'thread', turnId: 'turn' },
      message => delivered.push(message), message => refused.push(message));
    assert.deepEqual(delivered, [valid, request]);
    assert.deepEqual(refused, []);
  });
}
