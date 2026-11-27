import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { answeredAsyncQuestion } from './fixtures/async-question-answer.mjs';

function fixture(t, mode, queued, replayEvent) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: true,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let sequence = 0;
  const send = (client, method, params = { threadId: 'thread' }) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params }));
    return upstream.slice(before).find(message => message.method === method);
  };
  const client = () => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: mode !== 'exclusive', asyncUserQuestionsV1: true });
    return value;
  };
  const reply = (request, result) => broker.routeServerMessage({ id: request.id, result });
  const owner = mode === 'shared' ? client() : null;
  if (owner) reply(send(owner, 'thread/resume'), { thread: { id: 'thread' } });
  const recovering = client();
  // The bridge exposes queue admission separately from socket backpressure.
  // A false writable result alone does not mean the frame was rejected.
  recovering.sendWithQueueStatus = message => {
    const admitted = queued && !(replayEvent && message.method === replayEvent.method);
    if (admitted) recovering.messages.push(message);
    return { queued: admitted, writable: false };
  };
  recovering.send = message => recovering.sendWithQueueStatus(message).writable;
  const resume = send(recovering, 'thread/resume');
  assert.ok(resume);
  const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
  if (replayEvent) broker.routeServerMessage(replayEvent);
  broker.routeServerMessage(changed);
  reply(resume, { thread: { id: 'thread' } });
  // Subsequent actions run after the socket has drained or become writable.
  recovering.sendWithQueueStatus = message => {
    recovering.messages.push(message);
    return { queued: true, writable: true };
  };
  return { broker, upstream, send, reply, owner, recovering, changed, client };
}

for (const mode of ['exclusive', 'shared', 'shared-first-owner']) {
  test(`${mode}: a queued resume under backpressure preserves question recovery and answer authority`, t => {
    const f = fixture(t, mode, true);
    assert.ok(f.recovering.messages[0]?.result?.thread, 'the resume response was queued exactly once');
    assert.deepEqual(f.recovering.messages.slice(1), [f.changed], 'the original question update follows its resume');
    assert.equal(f.broker.threadOwners.get('thread'), f.owner ?? f.recovering);
    if (mode !== 'exclusive') assert.equal(f.broker.sharedThreads.has('thread', f.recovering), true);
    const read = f.send(f.recovering, 'asyncQuestion/list');
    assert.ok(read, 'the recovered client can refresh the original question');
    f.reply(read, { threadId: 'thread', questions: [f.changed.params.question] });
    const answer = f.send(f.recovering, 'asyncQuestion/answer', {
      threadId: 'thread', questionId: 'question', expectedRevision: 1,
      submissionId: 'original-submission', answers: { item: { text: 'original answer' } },
    });
    assert.ok(answer, 'the recovered client can answer the original task');
    f.reply(answer, { threadId: 'thread', accepted: true, duplicate: false,
      question: answeredAsyncQuestion(answer.params) });
    assert.equal(f.recovering.messages.at(-1).result.accepted, true);
    assert.equal(f.upstream.filter(message => message.method === 'thread/resume').length, f.owner ? 2 : 1);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });

  test(`${mode}: an unqueued resume still revokes provisional question authority`, t => {
    const f = fixture(t, mode, false);
    const attachments = () => f.upstream.filter(message => message.method === 'thread/attach');
    assert.equal(attachments().length, f.owner ? 1 : 0,
      'an undelivered resume must not register a renewing compatibility attachment');
    assert.deepEqual(f.recovering.messages, []);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner ?? undefined);
    assert.equal(f.broker.sharedThreads.has('thread', f.recovering), false);
    assert.equal(f.send(f.recovering, 'asyncQuestion/list'), undefined);
    assert.equal(f.recovering.messages.at(-1).error.code, -32023);
    if (f.owner) assert.deepEqual(f.owner.messages.at(-1), f.changed);
    const retry = f.send(f.recovering, 'thread/resume');
    assert.ok(retry, 'an explicit resume can recover after an unqueued response');
    f.reply(retry, { thread: { id: 'thread' } });
    assert.equal(attachments().length, f.owner ? 2 : 1);
    const read = f.send(f.recovering, 'asyncQuestion/list');
    assert.ok(read, 'question reads reopen only after successful recovery');
    f.reply(read, { threadId: 'thread', questions: [f.changed.params.question] });
  });
}

for (const stale of [false, true]) {
  test(`an unqueued ${stale ? 'superseded' : 'repeated'} shared resume preserves confirmed question access`, t => {
    const f = fixture(t, 'shared', true);
    const pending = f.send(f.recovering, 'thread/resume');
    assert.ok(pending);

    if (stale) {
      f.reply(f.send(f.owner, 'thread/delete'), { threadId: 'thread' });
      f.reply(f.send(f.owner, 'thread/resume'), { thread: { id: 'thread' } });
      f.reply(f.send(f.recovering, 'thread/resume'), { thread: { id: 'thread' } });
    }
    assert.equal(f.broker.sharedThreads.has('thread', f.recovering), true);

    const prompt = { id: 500, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', questionId: 'live-question',
      questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
    } };
    f.broker.routeServerMessage(prompt);
    assert.deepEqual(f.recovering.messages.at(-1), prompt);
    const before = f.recovering.messages.length;
    const sendWithQueueStatus = f.recovering.sendWithQueueStatus;
    let unqueued;
    f.recovering.sendWithQueueStatus = message => {
      if (message.method) return sendWithQueueStatus(message);
      unqueued = message;
      return { queued: false, writable: false };
    };
    f.reply(pending, { thread: { id: 'thread' } });
    f.recovering.sendWithQueueStatus = sendWithQueueStatus;

    assert.equal(unqueued.error?.code, stale ? -32023 : undefined);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner);
    const list = f.send(f.recovering, 'asyncQuestion/list');
    assert.ok(list, 'a failed delivery cannot undo a separately confirmed resume');
    assert.equal(f.recovering.messages.length, before, 'an unqueued resume cannot replay the live question');
    assert.equal(f.broker.serverRequests.get(prompt.id), f.owner);
    f.reply(list, { threadId: 'thread', questions: [f.changed.params.question] });
    assert.deepEqual(f.recovering.messages.at(-1).result?.questions, [f.changed.params.question]);
    assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
  });
}

test('a shared resume drops only the recovering socket when an earlier replay frame cannot be queued', t => {
  const started = { method: 'turn/started', params: { threadId: 'thread', sequence: 1,
    turn: { id: 'turn', threadId: 'thread', status: 'running' } } };
  const f = fixture(t, 'shared', true, started);

  assert.ok(f.recovering.messages[0]?.result?.thread);
  assert.deepEqual(f.recovering.messages.slice(1), [], 'do not deliver a question after dropping its turn event');
  assert.equal(f.broker.clients.has(f.recovering), false);
  assert.equal(f.broker.sharedThreads.has('thread', f.recovering), false);
  assert.equal(f.broker.closed, false);
  assert.equal(f.broker.threadOwners.get('thread'), f.owner);
  assert.deepEqual(f.owner.messages.slice(-2), [started, f.changed]);
  assert.equal(f.upstream.filter(message => message.method === 'thread/attach').length, 1,
    'the only compatibility attachment belongs to the existing owner');

  const reconnected = f.client();
  f.reply(f.send(reconnected, 'thread/resume'), { thread: { id: 'thread' } });
  f.reply(f.send(reconnected, 'asyncQuestion/list'), { threadId: 'thread', questions: [f.changed.params.question] });
  assert.deepEqual(reconnected.messages.at(-1).result.questions, [f.changed.params.question]);
  assert.equal(f.upstream.some(message => ['asyncQuestion/answer', 'turn/interrupt'].includes(message.method)), false);
});
