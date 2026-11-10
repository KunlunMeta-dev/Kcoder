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

for (const method of ['thread/delete', 'thread/dispose', RELEASE]) {
  for (const lifecycle of ['expired', 'disconnected', 'expired-disconnected']) {
    for (const outcome of (method === RELEASE
      ? ['released', 'rejected', 'unknown', 'foreign owner', 'foreign operation']
      : ['released', 'rejected'])) {
      test(`${method}: ${lifecycle} release receipt fences old answer admission only after success (outcome=${outcome})`, t => {
        const f = fixture(t);
        const confirmed = outcome === 'released';
        const release = f.send(method, method === RELEASE ? {
          operationId: 'release-once', expectedServerId: 'native-server',
          expectedOwnerRef: 'original-owner', expectedClientTurnCount: 0,
        } : {});
        if (lifecycle.startsWith('expired')) f.broker.expireRequest(release.id);
        if (lifecycle.endsWith('disconnected')) f.broker.detach(f.client);
        const retained = f.broker.pending.get(release.id);
        assert.ok(retained, 'release identity must survive timeout and owner disconnect');
        assert.deepEqual(retained.params, method === RELEASE ? {
          threadId: 'thread', operationId: 'release-once', expectedServerId: 'native-server',
          expectedOwnerRef: 'original-owner',
        } : { threadId: 'thread' });
        const delivered = f.client.messages.length;
        f.serverMessage({ id: release.id, ...(outcome === 'rejected'
          ? { error: { code: -32036, message: 'runtime is busy' } }
          : { result: method === RELEASE ? {
            snapshot: { serverId: 'native-server', threadId: 'thread', ownerRef: null,
              clientTurnCount: null, releasable: false },
            receipt: { serverId: 'native-server', threadId: 'thread', operationId: outcome === 'foreign operation' ? 'another-operation' : 'release-once',
              ownerRef: outcome === 'foreign owner' ? 'another-owner' : 'original-owner',
              status: outcome === 'unknown' ? 'unknown' : 'released' },
          } : {} }) });
        f.answerReceipt();
        const disconnected = lifecycle.endsWith('disconnected');
        assert.equal(f.broker.activeTurns.has('thread'), !confirmed && !disconnected,
          'a late confirmed release must prevent an older answer from recreating the binding');
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), !confirmed && disconnected,
          'confirmed release must not create stale interruption or drain work');
        assert.equal(f.broker.threadDrains.has('thread'), !confirmed && disconnected);
        assert.equal(f.broker.threadOwners.has('thread'), !confirmed && !disconnected);
        assert.equal(f.broker.pending.has(release.id), false, 'the actual receipt releases its pending slot');
        assert.equal(f.client.messages.length, delivered + (disconnected ? 0 : 1),
          'a timed-out release response is not redelivered; the original answer receipt remains readable');
        assert.equal(f.upstream.filter(message => message.method === method).length, 1,
          'receipt recovery must not resend the release');
      });
    }
  }
}
