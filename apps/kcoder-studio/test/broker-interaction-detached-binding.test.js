import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, epoch = 'original-epoch') {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const serverMessage = message => {
    const line = `${JSON.stringify(message)}\n`, middle = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, middle)); child.stdout.write(line.slice(middle));
  };
  let sequence = 0;
  const join = (threadId = 'thread') => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    serverMessage({ id: upstream.at(-1).id, result: { thread: { id: threadId } } });
    return client;
  };
  const owner = join(), viewer = join();
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'original-turn', [field]: 'original-interaction',
    ...(epoch == null ? {} : { appServerEpoch: epoch }),
  } };
  serverMessage(request);
  const receipt = { method: `${kind}/resolved`, params: { ...request.params, requestId: request.id,
    reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  return { broker, upstream, serverMessage, join, owner, viewer, field, request, receipt };
}

for (const kind of ['question', 'approval']) {
  for (const submitted of [false, true]) {
    for (const mismatch of ['identity', 'missing identity', 'type', 'turn', 'thread', 'epoch', 'missing epoch']) {
      test(`${kind}: ${submitted ? 'submitted' : 'pending'} detached binding rejects a ${mismatch} receipt`, t => {
        const f = fixture(t, kind);
        if (submitted) f.broker.receive(f.owner, JSON.stringify({ id: f.request.id,
          result: kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' } }));
        f.broker.detach(f.owner);
        f.broker.detach(f.viewer);
        const late = f.join(), unrelated = f.join('other-thread');
        const invalid = structuredClone(f.receipt);
        if (mismatch === 'identity') invalid.params[f.field] = 'another-interaction';
        if (mismatch === 'missing identity') delete invalid.params[f.field];
        if (mismatch === 'type') invalid.method = kind === 'question' ? 'approval/resolved' : 'question/resolved';
        if (mismatch === 'turn') invalid.params.turnId = 'another-turn';
        if (mismatch === 'thread') invalid.params.threadId = 'other-thread';
        if (mismatch === 'epoch') invalid.params.appServerEpoch = 'another-epoch';
        if (mismatch === 'missing epoch') delete invalid.params.appServerEpoch;
        const delivered = [late.messages.length, unrelated.messages.length];
        f.serverMessage(invalid);
        assert.deepEqual([late.messages.length, unrelated.messages.length], delivered,
          'disconnect must not discard the original receipt validation fence');
        f.serverMessage(f.receipt);
        assert.deepEqual(late.messages.at(-1), f.receipt,
          'a mismatched receipt must not consume the first authoritative outcome');
        assert.equal(unrelated.messages.length, delivered[1]);
        const after = late.messages.length;
        f.serverMessage({ ...f.receipt, params: { ...f.receipt.params, reason: 'cancelled' } });
        f.serverMessage(f.request);
        assert.equal(late.messages.length, after, 'the terminal outcome stays immutable and the card stays closed');
        assert.equal(f.broker.serverRequests.has(f.request.id), false);
      });
    }
  }

  test(`${kind}: detached legacy receipts keep their original absent epoch binding`, t => {
    const f = fixture(t, kind, null);
    f.broker.detach(f.owner); f.broker.detach(f.viewer);
    const late = f.join(), delivered = late.messages.length;
    f.serverMessage({ ...f.receipt, params: { ...f.receipt.params, appServerEpoch: 'new-epoch' } });
    assert.equal(late.messages.length, delivered);
    f.serverMessage(f.receipt);
    assert.deepEqual(late.messages.at(-1), f.receipt);
  });
}
