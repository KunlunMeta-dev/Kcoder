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

const item = { id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false,
  options: [{ id: 'yes', label: 'Yes', description: '' }, { id: 'no', label: 'No', description: '' }] };
const saved = answers => ({ submissionId: 'submission', acceptedAtMs: 2, answers });
const changed = (answers, revision = 2, questions = [item]) => ({ method: 'asyncQuestion/changed', params: {
  threadId: 'thread', question: { threadId: 'thread', questionId: 'question', revision,
    requestId: 'request', sourceTurnId: 'turn', toolCallId: 'tool', createdAtMs: 1,
    status: 'queued', questions, answer: saved(answers) },
} });
const invalidAnswers = [
  ['foreign item', { other: { text: 'wrong question' } }],
  ['missing item', {}],
  ['extra item', { item: { text: 'original' }, other: { text: 'unrelated' } }],
  ['foreign option', { item: { selectedOptionIds: ['other'] } }],
  ['single-select overflow', { item: { selectedOptionIds: ['yes', 'no'] } }],
  ['repeated multi-selection', { item: { selectedOptionIds: ['yes', 'yes'] } }, [{ ...item, multiSelect: true }]],
  ['empty answer', { item: {} }],
  ['blank freeform', { item: { text: ' \t\n' } }],
];

for (const shared of [false, true]) {
  for (const [name, answers, questions] of invalidAnswers) {
    test(`${shared ? 'shared' : 'exclusive'}: ${name} saved answer cannot exhaust recovery`, t => {
      const f = fixture(t, shared);
      for (let revision = 2; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 2; revision++)
        f.emit(changed(answers, revision, questions));
      const valid = changed({ item: { selectedOptionIds: ['yes'] } });
      const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
      f.emit(valid); f.emit(progress); f.recovering.finish();
      assert.ok(f.recovering.client.messages[0]?.result?.thread,
        'a mismatched saved answer must not turn successful resume into -32047');
      assert.deepEqual(f.recovering.client.messages.slice(1), [valid, progress]);
      if (f.owner) assert.deepEqual(f.owner.client.messages.slice(1), [valid, progress]);
      assert.equal(f.broker.activeTurns.size, 0);
      assert.equal(f.broker.threadDrains.size, 0);
      assert.ok(f.upstream.every(message => message.method === 'thread/resume'),
        'recovery must never answer, cancel, interrupt or replay input');
    });
  }

  test(`${shared ? 'shared' : 'exclusive'}: valid choices, freeform, multi-select and legacy omission preserve order`, t => {
    const f = fixture(t, shared);
    const messages = [
      changed({ item: { selectedOptionIds: ['yes'], text: null } }),
      changed({ item: { text: ' Original answer ' } }, 2),
      changed({ item: { selectedOptionIds: ['no', 'yes'] } }, 2, [{ ...item, multiSelect: true }]),
      changed({ item: { text: ' Legacy answer ' } }, 2, undefined),
    ];
    delete messages[3].params.question.questions;
    for (const [index, frame] of messages.entries()) {
      Object.assign(frame.params.question, {
        questionId: `question-${index}`, requestId: `request-${index}`, toolCallId: `tool-${index}`,
      });
      f.emit(frame);
    }
    f.recovering.finish();
    assert.ok(f.recovering.client.messages[0]?.result?.thread);
    assert.deepEqual(f.recovering.client.messages.slice(1), messages);
  });
}

test('Office: mismatched saved answers cannot displace original interactions', () => {
  const handoff = new BrokerOfficeTaskOwnerHandoff();
  const pending = { method: 'integrations/assistant/adopt',
    client: { channel: 'runtime', initialized: true }, params: {
      contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' },
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: {} },
    } };
  for (const [, answers, questions] of invalidAnswers)
    for (let revision = 2; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 2; revision++)
      assert.equal(handoff.capture(changed(answers, revision, questions), [pending]), false);
  const valid = changed({ item: { selectedOptionIds: ['yes'] } });
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
