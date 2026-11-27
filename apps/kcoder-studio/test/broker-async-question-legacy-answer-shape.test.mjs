import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { BrokerOfficeTaskOwnerHandoff } from '../src/broker-office-task-owner.js';
import { hasValidAsyncQuestionNotificationBinding } from '../src/broker-async-questions.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';

const choices = count => Array.from({ length: count }, (_, index) => `option-${index}`);
const entries = count => Object.fromEntries(Array.from({ length: count }, (_, index) =>
  [`item-${index}`, { selectedOptionIds: choices(16), text: ' exact answer ' }]));
// Legacy snapshots omit prompts, but their saved answers must still satisfy
// State's item/selection limits and uniqueness before recovery or ownership.
const invalid = [
  ['empty answer map', {}],
  ['nine answered items', entries(9)],
  ['seventeen selections', { item: { selectedOptionIds: choices(17) } }],
  ['repeated selection', { item: { selectedOptionIds: ['yes', 'yes'] } }],
  ['unanswered item with omitted fields', { item: {} }],
  ['unanswered item with null text', { item: { selectedOptionIds: [], text: null } }],
  ['unanswered item with whitespace text', { item: { text: ' \t\n ' } }],
];
const changed = (answers, revision = 2) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision,
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1, status: 'queued',
    answer: { submissionId: 'submission', acceptedAtMs: 2, answers } },
} });

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
  let sequence = 0;
  const send = (client, method, params) => {
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    assert.equal(upstream.at(-1)?.method, method);
    return upstream.at(-1);
  };
  const join = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume', { threadId: 'thread' });
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  const owner = shared ? join() : null;
  owner?.finish();
  return { broker, upstream, emit, send, owner, recovering: join() };
}

for (const [name, answers] of invalid) {
  for (const shared of [false, true]) {
    test(`${shared ? 'shared' : 'exclusive'} recovery rejects legacy ${name}`, t => {
      const f = fixture(t, shared);
      for (let revision = 2; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 2; revision++)
        f.emit(changed(answers, revision));
      const valid = changed(entries(8));
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'an invalid saved answer must not turn successful resume into -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'));
    });
  }

  for (const detached of [false, true]) {
    test(`legacy ${name} cannot certify answer ownership (detached=${detached})`, t => {
      const f = fixture(t, true);
      f.recovering.finish();
      const client = f.recovering.client;
      const request = f.send(client, 'asyncQuestion/answer', { threadId: 'thread', questionId: 'question',
        expectedRevision: 1, submissionId: 'submission', answers });
      if (detached) { f.broker.expireRequest(request.id); f.broker.detach(client); }
      const deliveries = client.messages.length;
      f.emit({ id: request.id, result: { threadId: 'thread', accepted: true, duplicate: false,
        question: changed(answers).params.question, startedTurn: { id: 'unconfirmed', status: 'running' } } });
      assert.equal(f.broker.threadOwners.get('thread'), f.owner.client);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
      if (detached) assert.equal(client.messages.length, deliveries);
      else assert.equal(client.messages.at(-1).error?.code, -32001);
      const read = f.send(f.owner.client, 'asyncQuestion/list', { threadId: 'thread' });
      f.emit({ id: read.id, result: { threadId: 'thread', questions: [changed(entries(8)).params.question] } });
      assert.equal(f.owner.client.messages.at(-1).result.questions.length, 1);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    });
  }
}

test('Office adoption rejects invalid legacy answer shapes and retains the original question', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt', client: { channel: 'runtime', initialized: true },
    params: { contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} } } };
  for (const [name, answers] of invalid) assert.equal(handoff.capture(changed(answers), [pending]), false, name);
  const valid = changed(entries(8));
  assert.equal(handoff.capture(valid, [pending]), true);
  const delivered = [];
  handoff.settle(pending, { threadId: 'thread', turnId: 'source' },
    message => delivered.push(message), () => assert.fail('valid original snapshot must be delivered'));
  assert.deepEqual(delivered, [valid]);
});

test('legacy boundary answers retain all items, ordered selections, text and optional defaults', () => {
  for (const answers of [entries(8), { item: { text: ' exact answer ' } },
    { item: { selectedOptionIds: ['option-0'], text: null } }]) {
    const message = changed(answers), original = structuredClone(message);
    assert.equal(hasValidAsyncQuestionNotificationBinding(message.params), true);
    assert.deepEqual(message, original);
  }
});
