import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind) {
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
  const client = () => {
    const value = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value);
    Object.assign(value, { initialized: true, gatewaySharedThreadsV1: true });
    return value;
  };
  let sequence = 0;
  const resume = (value, threadId = 'thread', finish = true) => {
    const before = upstream.length;
    broker.receive(value, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId } }));
    assert.ok(upstream.length > before, 'resume must reach the backend');
    const request = upstream.at(-1);
    const complete = () => serverMessage({ id: request.id, result: { thread: { id: threadId } } });
    if (finish) complete();
    return complete;
  };
  const owner = client(); resume(owner); resume(owner, 'other-thread');
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', [field]: 'interaction', appServerEpoch: 'epoch',
  } };
  serverMessage(request);
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  const reply = () => broker.receive(owner, JSON.stringify({ id: request.id,
    result: kind === 'question' ? { answers: { item: { answers: ['yes'] } } } : { decision: 'accept' } }));
  return { broker, upstream, client, resume, serverMessage, owner, field, request, receipt, reply };
}

for (const kind of ['question', 'approval']) {
  for (const mismatch of ['identity', 'missing identity', 'type', 'turn', 'thread', 'epoch', 'missing epoch']) {
    test(`${kind}: a ${mismatch} mismatch during resume cannot bypass receipt binding via buffered delivery`, t => {
      const f = fixture(t, kind);
      const invalid = structuredClone(f.receipt);
      if (mismatch === 'identity') invalid.params[f.field] = 'other-interaction';
      if (mismatch === 'missing identity') delete invalid.params[f.field];
      if (mismatch === 'type') invalid.method = kind === 'question' ? 'approval/resolved' : 'question/resolved';
      if (mismatch === 'turn') invalid.params.turnId = 'other-turn';
      if (mismatch === 'thread') invalid.params.threadId = 'other-thread';
      if (mismatch === 'epoch') invalid.params.appServerEpoch = 'other-epoch';
      if (mismatch === 'missing epoch') delete invalid.params.appServerEpoch;
      const viewer = f.client(), finish = f.resume(viewer, invalid.params.threadId, false);
      f.serverMessage(invalid);
      assert.equal(f.owner.messages.some(message => ['question/resolved', 'approval/resolved'].includes(message.method)), false);
      finish();
      assert.equal(viewer.messages.some(message => ['question/resolved', 'approval/resolved'].includes(message.method)),
        false, 'a buffered handoff must retain the live path receipt fence');
      assert.equal(f.broker.serverRequests.get(f.request.id), f.owner);
      if (mismatch !== 'thread') assert.deepEqual(viewer.messages.at(-1), f.request);
      const before = f.upstream.length;
      f.reply();
      assert.equal(f.upstream.length, before + 1, 'the original interaction remains answerable exactly once');
      f.serverMessage(f.receipt);
      f.reply();
      assert.deepEqual(f.owner.messages.at(-1), f.receipt);
      assert.equal(f.upstream.length, before + 1, 'terminal receipt replay must not resend the answer');
    });
  }

  test(`${kind}: resume delivers the first valid receipt once and discards conflicting duplicates`, t => {
    const f = fixture(t, kind), viewer = f.client(), finish = f.resume(viewer, 'thread', false);
    f.reply();
    f.serverMessage(f.receipt);
    f.serverMessage({ ...f.receipt, params: { ...f.receipt.params, reason: 'cancelled',
      ...(kind === 'approval' ? { decision: 'decline' } : {}) } });
    finish();
    assert.deepEqual(viewer.messages.filter(message => message.method === f.receipt.method), [f.receipt]);
    assert.equal(viewer.messages.some(message => message.method === f.request.method), false);
    f.reply();
    assert.deepEqual(f.owner.messages.at(-1), f.receipt);
  });

  test(`${kind}: rejected receipts cannot exhaust the resume buffer or suppress valid progress`, t => {
    const f = fixture(t, kind), viewer = f.client(), finish = f.resume(viewer, 'thread', false);
    for (let index = 0; index < 65; index++) f.serverMessage({ ...f.receipt,
      params: { ...f.receipt.params, [f.field]: `wrong-${index}` } });
    const progress = { method: 'item/delta', params: { threadId: 'thread', turnId: 'turn', delta: { text: 'progress' } } };
    f.serverMessage(progress);
    finish();
    assert.ok(viewer.messages[0].result?.thread, 'invalid receipts must not turn a successful resume into overflow');
    assert.deepEqual(viewer.messages.filter(message => message.method === progress.method), [progress]);
    assert.deepEqual(viewer.messages.at(-1), f.request);
  });

  test(`${kind}: resume preserves an authoritative recovery receipt without a local pending request`, t => {
    const f = fixture(t, kind), viewer = f.client(), finish = f.resume(viewer, 'thread', false);
    const restored = { ...f.receipt, params: { ...f.receipt.params, requestId: 900,
      [f.field]: 'restored-interaction' } };
    f.serverMessage(restored);
    finish();
    assert.deepEqual(viewer.messages.filter(message => message.method === restored.method), [restored]);
  });
}
