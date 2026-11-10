import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, mode, queued) {
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
    if (queued) recovering.messages.push(message);
    return { queued, writable: false };
  };
  recovering.send = message => recovering.sendWithQueueStatus(message).writable;
  const resume = send(recovering, 'thread/resume');
  assert.ok(resume);
  const changed = { method: 'asyncQuestion/changed', params: { threadId: 'thread',
    question: { threadId: 'thread', questionId: 'question', revision: 1 } } };
  broker.routeServerMessage(changed);
  reply(resume, { thread: { id: 'thread' } });
  // Subsequent actions run after the socket has drained or become writable.
  recovering.sendWithQueueStatus = message => {
    recovering.messages.push(message);
    return { queued: true, writable: true };
  };
  return { broker, upstream, send, reply, owner, recovering, changed };
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
      question: { ...f.changed.params.question, answer: {
        submissionId: 'original-submission', answers: answer.params.answers,
      } } });
    assert.equal(f.recovering.messages.at(-1).result.accepted, true);
    assert.equal(f.upstream.filter(message => message.method === 'thread/resume').length, f.owner ? 2 : 1);
    assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
    assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
  });

  test(`${mode}: an unqueued resume still revokes provisional question authority`, t => {
    const f = fixture(t, mode, false);
    assert.deepEqual(f.recovering.messages, []);
    assert.equal(f.broker.threadOwners.get('thread'), f.owner ?? undefined);
    assert.equal(f.broker.sharedThreads.has('thread', f.recovering), false);
    assert.equal(f.send(f.recovering, 'asyncQuestion/list'), undefined);
    assert.equal(f.recovering.messages.at(-1).error.code, -32023);
    if (f.owner) assert.deepEqual(f.owner.messages.at(-1), f.changed);
    const retry = f.send(f.recovering, 'thread/resume');
    assert.ok(retry, 'an explicit resume can recover after an unqueued response');
    f.reply(retry, { thread: { id: 'thread' } });
    const read = f.send(f.recovering, 'asyncQuestion/list');
    assert.ok(read, 'question reads reopen only after successful recovery');
    f.reply(read, { threadId: 'thread', questions: [f.changed.params.question] });
  });
}
