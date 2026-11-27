import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, shared, lifetime) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  broker.initializeResponse = { result: { capabilities: { experimental: {
    asyncUserQuestionsV1: true, sessionLifetimeV1: lifetime,
  } } } };
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
  const client = () => {
    const value = { channel: 'runtime', messages: [], closes: 0,
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {},
      close() { this.closes++; } };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: shared, asyncUserQuestionsV1: true });
    return value;
  };
  const resume = (peer, threadId) => {
    const request = send(peer, 'thread/resume', { threadId });
    return () => emit({ id: request.id, result: { thread: { id: threadId } } });
  };
  return { broker, upstream, emit, send, client, resume };
}

for (const [kind, queued] of [['turn', false], ['turn', true], ['compacted item', false]]) {
  test(`fresh resume handles a buffered ${kind} before replaying a question (queued=${queued})`, t => {
    const f = fixture(t, true, true);
    const peer = f.client(), recovering = f.client();
    f.resume(peer, 'peer-thread')();
    const threadId = 'recovering-thread';
    const finish = f.resume(recovering, threadId);
    const prior = kind === 'turn'
      ? { method: 'turn/started', params: { threadId, turnId: 'turn' } }
      : { method: 'item/completed', params: { threadId, turnId: 'turn', item: {
        name: 'mcp__kcoder_computer_use__Screenshot', outputImages: ['x'.repeat(300 * 1024)],
      } } };
    const changed = { method: 'asyncQuestion/changed', params: { threadId,
      question: { threadId, questionId: 'question', revision: 1 } } };
    f.emit(prior);
    f.emit(changed);
    let attemptedPrior;
    recovering.sendWithQueueStatus = function (message) {
      if (message.method === prior.method) {
        attemptedPrior = message;
        if (queued) this.messages.push(message);
        return { queued, writable: false };
      }
      this.messages.push(message);
      return { queued: true, writable: true };
    };
    finish();

    assert.ok(attemptedPrior);
    if (kind === 'compacted item') assert.equal(attemptedPrior.params.item.outputImagesOmitted, true);
    assert.equal(f.broker.clients.has(recovering), queued);
    assert.equal(f.broker.sharedThreads.has(threadId, recovering), queued);
    assert.equal(f.broker.threadOwners.get(threadId), queued ? recovering : undefined);
    assert.equal(recovering.closes, queued ? 0 : 1);
    assert.deepEqual(recovering.messages.filter(message => message.method), queued ? [prior, changed] : []);
    assert.equal(f.broker.closed, false);
    assert.equal(f.broker.threadOwners.get('peer-thread'), peer);
    assert.equal(peer.messages.some(message => message.method === changed.method), false);
    assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
    if (!queued) {
      const reconnected = f.client();
      f.resume(reconnected, threadId)();
      const read = f.send(reconnected, 'asyncQuestion/list', { threadId, includeTerminal: true });
      const result = { threadId, questions: [changed.params.question] };
      f.emit({ id: read.id, result });
      assert.deepEqual(reconnected.messages.at(-1).result, result);
    }
  });
}

for (const queued of [false, true]) {
  test(`Office adoption only replays questions after its receipt is queued (queued=${queued})`, t => {
    const f = fixture(t, true, true);
    const owner = f.client(), peer = f.client();
    f.resume(peer, 'peer-thread')();
    const capabilities = { integrationScopeV1: true, officeWorkspaceV1: true };
    Object.assign(f.broker.initializeResponse.result.capabilities.experimental, capabilities);
    Object.assign(owner, capabilities);
    const threadId = 'office-thread';
    const request = f.send(owner, 'integrations/assistant/adopt', {
      contractVersion: 'parallel-v1',
      scope: { accountId: 'owned', targetId: 'local', workspaceId: 'workspace',
        identityGeneration: '1', targetRevision: '1' },
      requestId: 'request', operationId: 'operation', timeoutMs: 30000,
      payload: { id: 'builtin.office-task', version: '2', startTask: true, inputs: { request: 'Fixture document' } },
    });
    const changed = { method: 'asyncQuestion/changed', params: { threadId,
      question: { threadId, questionId: 'saved-question', revision: 1 } } };
    f.emit(changed);
    assert.deepEqual(owner.messages, []);
    owner.sendWithQueueStatus = function (message) {
      const admitted = message.method !== undefined || queued;
      if (admitted) this.messages.push(message);
      return { queued: admitted, writable: message.method !== undefined };
    };
    owner.send = message => owner.sendWithQueueStatus(message).writable;
    f.emit({ id: request.id, result: {
      contractVersion: 'parallel-v1', requestId: 'request', operationId: 'operation',
      status: 'completed', error: null, entityRevision: null, observedAt: '2026-11-11T00:00:00Z',
      result: { nativeTask: { threadId, turnId: 'turn', state: 'running' } },
    } });

    assert.equal(f.broker.threadOwners.get(threadId), queued ? owner : undefined);
    assert.deepEqual(owner.messages.slice(1), queued ? [changed] : []);
    if (queued) assert.equal(owner.messages[0]?.result?.result?.nativeTask?.threadId, threadId);
    else assert.deepEqual(owner.messages, []);
    assert.equal(f.broker.threadOwners.get('peer-thread'), peer);
    assert.equal(f.broker.closed, false);
    assert.deepEqual(f.upstream.filter(message => message.method !== 'thread/attach').map(message => message.method),
      ['thread/resume', 'integrations/assistant/adopt']);
  });
}

for (const shared of [false, true]) {
  for (const lifetime of [false, true]) {
    for (const queueStatus of [false, true]) {
      test(`failed resume delivery preserves original questions (shared=${shared}, lifetime=${lifetime}, queueStatus=${queueStatus})`, t => {
        const f = fixture(t, shared, lifetime), owner = f.client();
        f.resume(owner, 'thread')();
        const start = f.send(owner, 'turn/start', { threadId: 'thread' });
        f.emit({ id: start.id, result: { turn: { id: 'turn', threadId: 'thread', status: 'running' } } });
        const prompt = { id: 500, method: 'question/request', params: {
          threadId: 'thread', turnId: 'turn', questionId: 'original-question',
          questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
        } };
        f.emit(prompt);
        const recovering = f.client(), threadId = shared ? 'thread' : 'recovering-thread';
        const finish = f.resume(recovering, threadId);
        const changed = { method: 'asyncQuestion/changed', params: { threadId,
          question: { threadId, questionId: 'async-question', revision: 1 } } };
        f.emit(changed);
        // The socket closes after admission, before its snapshot can be queued.
        const failDelivery = () => { throw new Error('recovering socket write failed'); };
        if (queueStatus) recovering.sendWithQueueStatus = failDelivery;
        else recovering.send = failDelivery;
        if (shared && queueStatus) {
          recovering.close = function () {
            this.closes++;
            throw new Error('recovering socket close failed');
          };
        }
        finish();
        assert.equal(f.broker.closed, false, 'one failed resume must not fail shared stdout');
        assert.equal(f.broker.clients.has(recovering), false);
        assert.equal(recovering.closes, 1);
        assert.equal(owner.closes, 0);
        assert.equal(f.broker.clients.has(owner), true);
        assert.equal(f.broker.threadOwners.get('thread'), owner);
        assert.equal(f.broker.activeTurns.get('thread')?.owner, owner);
        assert.equal(f.broker.serverRequests.get(prompt.id), owner);
        assert.equal(f.broker.sharedThreads.has(threadId, recovering), false);
        assert.equal(f.broker.threadClaims.has(threadId), false);
        f.broker.receive(owner, JSON.stringify({ id: prompt.id,
          result: { answers: { item: { answers: ['original answer'] } } } }));
        assert.equal(f.upstream.filter(message => message.id === prompt.id && message.result).length, 1);
        assert.equal(f.upstream.some(message => message.method === 'turn/interrupt'), false);

        // A healthy reconnect reads the same task without replaying the answer.
        const reconnected = f.client();
        f.resume(reconnected, threadId)();
        assert.ok(reconnected.messages[0]?.result?.thread);
        const read = f.send(reconnected, 'asyncQuestion/list', { threadId, includeTerminal: true });
        f.emit({ id: read.id, result: { threadId, questions: [changed.params.question] } });
        assert.deepEqual(reconnected.messages.at(-1).result.questions, [changed.params.question]);
        assert.equal(f.upstream.some(message => message.method === 'asyncQuestion/answer'), false);
      });
    }
  }
}
