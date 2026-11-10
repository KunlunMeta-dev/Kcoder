import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { THREAD_RUNTIME_HANDOFF_RELEASE as RELEASE } from '../shared/threadRuntimeHandoff.mjs';

function fixture(t, lifetime = false) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, threadRuntimeHandoffV1: true, sessionLifetimeV1: lifetime,
  } } } };
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const serverMessage = message => {
    const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
  };
  const client = { channel: 'runtime', messages: [],
    send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  Object.assign(client, { initialized: true, asyncUserQuestionsV1: true, threadRuntimeHandoffV1: true });
  let sequence = 0;
  const send = (method, params = {}) => {
    const before = upstream.length;
    broker.receive(client, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread', ...params } }));
    const request = upstream.slice(before).find(message => message.method === method);
    assert.ok(request, `${method} must reach the backend`);
    return request;
  };
  serverMessage({ id: send('thread/resume').id, result: { thread: { id: 'thread' } } });
  const answer = send('asyncQuestion/answer', { questionId: 'question', submissionId: 'submission',
    expectedRevision: 1, answers: { item: { text: 'original answer' } } });
  const answerReceipt = () => serverMessage({ id: answer.id, result: {
    threadId: 'thread', accepted: true, duplicate: false,
    question: { threadId: 'thread', questionId: 'question',
      answer: { submissionId: 'submission', answers: answer.params.answers } },
    startedTurn: { id: 'answer-turn', status: 'running' },
  } });
  return { broker, client, send, serverMessage, upstream, answer, answerReceipt };
}

for (const lifecycle of ['connected', 'expired', 'disconnected', 'expired-disconnected']) {
  for (const outcome of ['released', 'rejected', 'unknown', 'fresh owner', 'other task', 'mismatched receipt']) {
    test(`${lifecycle}: ${outcome} runtime release fences only the confirmed original answer binding`, t => {
      const f = fixture(t);
      const threadId = outcome === 'other task' ? 'other-thread' : 'thread';
      const release = f.send(RELEASE, { threadId, operationId: 'release-once',
        expectedServerId: 'native-server', expectedOwnerRef: 'original-owner', expectedClientTurnCount: 0 });
      if (lifecycle.startsWith('expired')) f.broker.expireRequest(f.answer.id);
      f.serverMessage({ id: release.id, ...(outcome === 'rejected'
        ? { error: { code: -32036, message: 'runtime is busy' } }
        : { result: {
          snapshot: { serverId: 'native-server', threadId,
            ownerRef: outcome === 'fresh owner' ? 'new-owner' : null,
            clientTurnCount: outcome === 'fresh owner' ? 0 : null, releasable: outcome === 'fresh owner' },
          receipt: { serverId: 'native-server', threadId, operationId: 'release-once',
            ownerRef: outcome === 'mismatched receipt' ? 'foreign-owner' : 'original-owner',
            status: outcome === 'unknown' ? 'unknown' : 'released' },
        } }) });
      if (lifecycle.endsWith('disconnected')) f.broker.detach(f.client);
      const delivered = f.client.messages.length;
      f.answerReceipt();
      const invalidated = outcome === 'released';
      const disconnected = lifecycle.endsWith('disconnected');
      assert.equal(f.broker.activeTurns.has('thread'), !invalidated && !disconnected,
        'a delayed answer cannot recreate the released resident binding');
      assert.equal(f.broker.threadOwners.has('thread'), !invalidated && !disconnected);
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), !invalidated && disconnected,
        'a released binding must not generate stale interruption work');
      assert.equal(f.broker.threadDrains.has('thread'), !invalidated && disconnected);
      assert.equal(f.upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);
      if (lifecycle === 'connected') assert.equal(f.client.messages.at(-1).result?.accepted, true,
        'the authoritative answer fact remains readable after release');
      else assert.equal(f.client.messages.length, delivered, 'expired or detached receipts are not redelivered');
    });
  }
}

for (const lifetime of [false, true]) {
  for (const receiptFirst of [false, true]) {
    test(`released answer binding stays invalid after a fresh resume (lifetime=${lifetime}, old receipt first=${receiptFirst})`, t => {
      const f = fixture(t, lifetime);
      const release = f.send(RELEASE, { operationId: 'release-once', expectedServerId: 'native-server',
        expectedOwnerRef: 'original-owner', expectedClientTurnCount: 0 });
      f.serverMessage({ id: release.id, result: {
        snapshot: { serverId: 'native-server', threadId: 'thread', ownerRef: null,
          clientTurnCount: null, releasable: false },
        receipt: { serverId: 'native-server', threadId: 'thread', operationId: 'release-once',
          ownerRef: 'original-owner', status: 'released' },
      } });
      f.serverMessage({ id: f.send('thread/resume').id, result: { thread: { id: 'thread' } } });
      const answer = f.send('asyncQuestion/answer', { questionId: 'new-question', submissionId: 'new-submission',
        expectedRevision: 1, answers: { item: { text: 'new answer' } } });
      if (receiptFirst) {
        f.answerReceipt();
        assert.equal(f.broker.activeTurns.has('thread'), false, 'resuming must not revalidate the old admission');
      }
      f.serverMessage({ id: answer.id, result: {
        threadId: 'thread', accepted: true, duplicate: false,
        question: { threadId: 'thread', questionId: 'new-question',
          answer: { submissionId: 'new-submission', answers: answer.params.answers } },
        startedTurn: { id: 'new-answer-turn', status: 'running' },
      } });
      if (!receiptFirst) f.answerReceipt();
      assert.deepEqual(f.broker.activeTurns.get('thread'), { turnId: 'new-answer-turn', owner: f.client },
        'a new admission retains its own binding and the old receipt cannot replace it');
      assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);
    });
  }
}
