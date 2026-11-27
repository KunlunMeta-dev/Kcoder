import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { RESUME_NOTIFICATION_BUFFER_LIMITS } from '../src/broker-resume-notification-buffer.js';
import { isContract } from '../shared/generated/validator.mjs';

const question = {
  threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
};
const changed = question => ({ method: 'asyncQuestion/changed', params: { threadId: 'thread', question } });

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
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} reaches the original app-server`);
    return request;
  };
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    const request = send(client, 'thread/resume', { threadId: 'thread' });
    return { client, finish: () => emit({ id: request.id, result: { thread: { id: 'thread' } } }) };
  };
  return { broker, upstream, emit, send, resume };
}

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'exclusive'}: unknown record fields cannot exhaust original-task recovery`, t => {
    const f = fixture(t, shared), owner = shared ? f.resume() : null;
    owner?.finish();
    const recovering = f.resume();
    assert.equal(isContract('AsyncQuestionRecord', { ...question, obsoleteDelivery: 'old metadata' }), false);
    // Distinct revisions prevent deduplication from hiding undeliverable frames.
    for (let revision = 1; revision <= RESUME_NOTIFICATION_BUFFER_LIMITS.perPendingFrames + 1; revision++)
      f.emit(changed({ ...question, revision, obsoleteDelivery: 'old metadata' }));
    const valid = changed(question);
    const legacy = changed({ threadId: 'thread', questionId: 'question', revision: 2 });
    const progress = { method: 'item/delta', params: { threadId: 'thread', delta: { text: 'progress' } } };
    f.emit(valid); f.emit(legacy); f.emit(progress); recovering.finish();
    assert.ok(recovering.client.messages[0]?.result?.thread,
      'client-rejected records must not turn a successful resume into -32047');
    assert.deepEqual(recovering.client.messages.slice(1), [valid, legacy, progress]);
    if (owner) assert.deepEqual(owner.client.messages.slice(1), [valid, legacy, progress]);
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.ok(f.upstream.every(message => message.method === 'thread/resume'), 'recovery never replays input');
  });
}

for (const lifecycle of ['connected', 'expired-disconnected']) {
  test(`an unknown record field cannot certify answer ownership (${lifecycle})`, t => {
    const f = fixture(t, true), original = f.resume(), answerer = f.resume();
    original.finish(); answerer.finish();
    const answers = { item: { text: 'Original answer' } };
    const request = f.send(answerer.client, 'asyncQuestion/answer', { threadId: 'thread',
      questionId: 'question', expectedRevision: 1, submissionId: 'submission', answers });
    if (lifecycle === 'expired-disconnected') {
      f.broker.expireRequest(request.id);
      f.broker.detach(answerer.client);
    }
    const deliveries = answerer.client.messages.length;
    const saved = { ...question, revision: 2, status: 'queued',
      answer: { submissionId: 'submission', acceptedAtMs: 2, answers } };
    f.emit({ id: request.id, result: { threadId: 'thread', accepted: true, duplicate: false,
      question: { ...saved, obsoleteDelivery: 'old metadata' },
      startedTurn: { id: 'answer-turn', status: 'running' } } });
    assert.equal(f.broker.threadOwners.get('thread'), original.client,
      'a receipt rejected by the card cannot transfer control');
    assert.equal(f.broker.activeTurns.size, 0);
    assert.equal(f.broker.threadDrains.size, 0);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false,
      'an unconfirmed receipt cannot authorize disconnect cleanup');
    if (lifecycle === 'connected') assert.equal(answerer.client.messages.at(-1).error?.code, -32001);
    else assert.equal(answerer.client.messages.length, deliveries, 'late receipts are not redelivered');
    f.emit({ id: f.send(original.client, 'asyncQuestion/list', { threadId: 'thread' }).id,
      result: { threadId: 'thread', questions: [saved] } });
    assert.deepEqual(original.client.messages.at(-1).result.questions, [saved]);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
  });
}
