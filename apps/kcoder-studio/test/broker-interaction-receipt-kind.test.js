import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t, kind, shared = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', residentThreads: true,
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const upstream = []; let sequence = 0;
  child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const resume = () => {
    const client = { channel: 'runtime', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(client);
    Object.assign(client, { initialized: true, gatewaySharedThreadsV1: shared });
    broker.receive(client, JSON.stringify({ id: ++sequence, method: 'thread/resume', params: { threadId: 'thread' } }));
    return { client, finish: () => emit({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } }) };
  };
  const join = () => { const pending = resume(); pending.finish(); return pending.client; };
  const field = kind === 'question' ? 'questionId' : 'approvalId';
  const otherField = kind === 'question' ? 'approvalId' : 'questionId';
  const request = { id: 500, method: `${kind}/request`, params: {
    threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch', [field]: 'original',
  } };
  const receipt = { method: `${kind}/resolved`, params: { ...request.params,
    requestId: request.id, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}) } };
  const invalid = { ...receipt, params: { ...receipt.params, [otherField]: 'foreign-interaction' } };
  return { broker, upstream, emit, resume, join, request, receipt, invalid, otherField };
}

for (const kind of ['question', 'approval']) {
  for (const shared of [false, true]) test(`${kind}: mixed-kind terminal preserves ${shared ? 'shared' : 'exclusive'} input and the real receipt`, t => {
    const f = fixture(t, kind, shared), owner = f.join();
    const viewer = shared ? f.join() : owner;
    f.emit(f.request);
    const delivered = viewer.messages.length;
    f.emit(f.invalid);
    assert.equal(f.broker.serverRequests.get(500), owner, 'conflicting kind cannot consume the original waiter');
    assert.equal(viewer.messages.length, delivered, 'conflicting receipt cannot close the visible card');
    const reply = () => f.broker.receive(owner, JSON.stringify({ id: 500,
      result: kind === 'question' ? { answers: {} } : { decision: 'accept' } }));
    const before = f.upstream.length;
    reply();
    assert.equal(f.upstream.length, before + 1, 'original input is still forwarded exactly once');
    // Null denotes an absent optional kind in compatibility recovery frames.
    const valid = { ...f.receipt, params: { ...f.receipt.params, [f.otherField]: null } };
    f.emit(valid);
    if (shared) reply();
    f.emit(valid);
    assert.equal(f.upstream.length, before + 1, 'terminal replay does not resend the answer');
    assert.deepEqual(owner.messages.at(-1), valid);
    assert.deepEqual(viewer.messages.at(-1), valid);
  });

  test(`${kind}: mixed-kind receipt before recovery cannot retire an unseen prompt`, t => {
    const f = fixture(t, kind), owner = f.join();
    const delivered = owner.messages.length;
    f.emit(f.invalid);
    assert.equal(owner.messages.length, delivered);
    f.emit(f.request);
    assert.deepEqual(owner.messages.at(-1), f.request, 'recovered original prompt stays answerable');
    assert.equal(f.broker.serverRequests.get(500), owner);
    f.emit(f.receipt);
    assert.deepEqual(owner.messages.at(-1), f.receipt);
  });

  test(`${kind}: mixed-kind late receipt cannot replace a detached original outcome`, t => {
    const f = fixture(t, kind), owner = f.join();
    f.emit(f.request); f.broker.detach(owner);
    const viewer = f.join(), delivered = viewer.messages.length;
    f.emit(f.invalid);
    assert.equal(viewer.messages.length, delivered);
    f.emit(f.receipt);
    assert.deepEqual(viewer.messages.at(-1), f.receipt);
    const settled = viewer.messages.length;
    f.emit(f.request); f.emit(f.receipt);
    assert.equal(viewer.messages.length, settled, 'reconnect cannot reopen or duplicate the resolved card');
  });

  test(`${kind}: mixed-kind restored receipts cannot exhaust the resume buffer`, t => {
    const f = fixture(t, kind); f.join();
    const pending = f.resume();
    for (let index = 0; index < 66; index++)
      f.emit({ ...f.invalid, params: { ...f.invalid.params, requestId: 900 + index } });
    f.emit(f.receipt); pending.finish();
    assert.ok(pending.client.messages[0]?.result?.thread, 'invalid receipts cannot break refresh with a handoff overflow');
    assert.deepEqual(pending.client.messages.filter(message => message.method === `${kind}/resolved`), [f.receipt]);
    assert.equal(f.upstream.filter(message => message.method === 'turn/start').length, 0);
  });
}
