import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { compactRequestParams } from '../src/broker-request-budget.js';

const METHODS = ['runtime.worktrees.comparison.bind', 'runtime.worktrees.comparison.read', 'runtime.worktrees.comparison.select'];
const init = () => ({ protocolVersion: '2026-07-27', clientInfo: { name: 'comparison-broker-fixture', version: '1' },
  capabilities: { experimental: { taskComparisonV1: true, taskDeliveryV1: true } } });

function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true,
    serverId: 'comparison-target', maxMessageBytes: 1024 * 1024,
    adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  const upstream = []; let buffer = '';
  child.stdin.on('data', bytes => {
    buffer += bytes.toString('utf8');
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); upstream.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
    }
  });
  const client = () => {
    const value = { channel: 'runtime', authorizationOwner: 'same-workspace', messages: [],
      send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(value); return value;
  };
  const send = async (owner, id, method, params) => {
    broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    await new Promise(resolve => setImmediate(resolve));
    return upstream.at(-1);
  };
  const respond = async message => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  const initialize = async (owner, id) => send(owner, id, 'initialize', init());
  const resume = async (owner, id, threadId) => {
    const sent = await send(owner, id, 'thread/resume', { threadId });
    await respond({ id: sent.id, result: { thread: { id: threadId } } });
    assert.equal(broker.threadOwners.get(threadId), owner);
  };
  return { broker, upstream, client, send, respond, initialize, resume,
    close() { broker.clearTransientState(); child.emit('close', 0, null); } };
}
function comparison(method, ownerThreadId = 'thread-a') {
  const base = { sourcePath: '/owned-source', deviceId: 'comparison-target', comparisonId: 'comparison-1', ownerThreadId };
  if (method === METHODS[0]) return { ...base, path: '/owned-source-b', expectedRevision: 1,
    taskId: 'task-b', threadId: 'thread-b', requirement: 'same requirement', label: 'B' };
  if (method === METHODS[2]) return { ...base, threadId: 'thread-b', expectedRevision: 1,
    expectedHeadCommit: 'a'.repeat(40), expectedContentToken: 'b'.repeat(64) };
  return base;
}
async function ownedFixture(t) {
  const f = fixture(); t.after(() => f.close());
  const a = f.client(); const b = f.client(); const c = f.client();
  const first = await f.initialize(a, 'initialize-a');
  await f.respond({ id: first.id, result: { protocolVersion: '2026-07-27', capabilities: {
    experimental: { residentThreads: true, taskComparisonV1: true, taskDeliveryV1: true } } } });
  await f.initialize(b, 'initialize-b'); await f.initialize(c, 'initialize-c');
  await f.resume(a, 'resume-a', 'thread-a'); await f.resume(b, 'resume-b', 'thread-b');
  await f.resume(c, 'resume-c', 'thread-c');
  return { ...f, a, b, c };
}

test('comparison bind/read/select use current owner A while retaining candidate B in the Native request', async t => {
  const f = await ownedFixture(t);
  for (const [index, method] of METHODS.entries()) {
    const before = f.upstream.length;
    const params = comparison(method);
    const sent = await f.send(f.a, `owned-${index}`, method, params);
    assert.equal(f.upstream.length, before + 1);
    assert.equal(sent.method, method);
    assert.equal(sent.params.ownerThreadId, 'thread-a');
    assert.deepEqual(sent.params, params, 'candidate identity and CAS fields must stay unchanged');
    await f.respond({ id: sent.id, result: { ownerThreadId: 'thread-a', candidates: [] } });
    assert.equal(f.a.messages.at(-1).id, `owned-${index}`);
    assert.equal(f.b.messages.some(message => message.id === `owned-${index}`), false);
    assert.equal(f.broker.threadOwners.get('thread-b'), f.b);
  }
});

test('candidate B and peer C cannot impersonate A, and missing owner never falls back to candidate or bootstrap', async t => {
  const f = await ownedFixture(t);
  for (const [index, method] of METHODS.entries()) {
    for (const peer of [f.b, f.c]) {
      const before = f.upstream.length;
      await f.send(peer, `impersonate-${index}`, method, comparison(method));
      assert.equal(peer.messages.at(-1).error?.code, -32023);
      assert.equal(f.upstream.length, before);
    }
    for (const ownerThreadId of [undefined, null, '', 7, 'thread-c', 'unowned-thread']) {
      const before = f.upstream.length;
      const params = { ...comparison(method), threadId: 'thread-a' };
      if (ownerThreadId === undefined) delete params.ownerThreadId;
      else params.ownerThreadId = ownerThreadId;
      await f.send(f.a, `missing-${index}-${ownerThreadId}`, method, params);
      assert.equal(f.a.messages.at(-1).error?.code, -32023);
      assert.equal(f.upstream.length, before, 'invalid owner must not reach Native or choose candidate A');
    }
  }
});

test('a Native comparison rejection is returned once without retry or ownership transfer', async t => {
  const f = await ownedFixture(t);
  const before = f.upstream.length;
  const sent = await f.send(f.a, 'native-rejected', METHODS[2], comparison(METHODS[2]));
  await f.respond({ id: sent.id, error: { code: -32602, message: 'selected source changed' } });
  assert.equal(f.a.messages.at(-1).error.code, -32602);
  assert.equal(f.upstream.length, before + 1, 'a rejected Native selection cannot be replayed');
  assert.equal(f.broker.threadOwners.get('thread-a'), f.a);
  assert.equal(f.broker.threadOwners.get('thread-b'), f.b);
});

test('disconnecting A with a pending candidate B request preserves peer ownership, turn and drain state', async t => {
  const f = await ownedFixture(t);
  f.broker.activeTurns.set('thread-b', { owner: f.b, turnId: 'peer-turn-b' });
  const sent = await f.send(f.a, 'pending-bind', METHODS[0], comparison(METHODS[0]));
  const beforeDetach = f.upstream.length;
  f.broker.detach(f.a);
  assert.equal(f.broker.threadDrains.has('thread-b'), false);
  assert.deepEqual(f.broker.activeTurns.get('thread-b'), { owner: f.b, turnId: 'peer-turn-b' });
  assert.equal(f.broker.threadOwners.get('thread-b'), f.b);
  assert.equal(f.upstream.slice(beforeDetach).some(message => message.params?.threadId === 'thread-b'), false);
  await f.respond({ id: sent.id, result: { ownerThreadId: 'thread-a', candidates: [] } });
  assert.equal(f.broker.threadOwners.get('thread-a'), undefined);
  assert.equal(f.broker.threadOwners.get('thread-b'), f.b);
  assert.equal(f.broker.threadDrains.has('thread-b'), false);
  assert.equal(f.a.messages.some(message => message.id === 'pending-bind'), false);
});

test('a draining candidate B does not queue or block owner A comparison requests', async t => {
  const f = await ownedFixture(t);
  f.broker.beginThreadDrain('thread-b', 'peer-turn-b');
  const before = f.upstream.length;
  const sent = await f.send(f.a, 'select-while-peer-drains', METHODS[2], comparison(METHODS[2]));
  assert.equal(f.upstream.length, before + 1, 'candidate B drain must not be mistaken for owner A drain');
  assert.equal(sent.params.ownerThreadId, 'thread-a');
  assert.equal(f.broker.threadDrains.get('thread-b').queue.length, 0);
  await f.respond({ id: sent.id, error: { code: -32602, message: 'candidate unavailable while terminating' } });
  assert.equal(f.a.messages.at(-1).error.code, -32602);
  assert.equal(f.broker.threadDrains.has('thread-b'), true);
  assert.equal(f.broker.threadOwners.get('thread-b'), f.b);
});

test('request compaction retains only both explicit comparison owner and candidate identities', () => {
  assert.deepEqual(compactRequestParams({ ownerThreadId: 'thread-a', threadId: 'thread-b', requirement: 'private unsent text', body: 'private PR text' }),
    { threadId: 'thread-b', ownerThreadId: 'thread-a' });
});

test('backend comparison/delivery capability values survive first, waiting and cached initialize projections', async t => {
  for (const state of [true, false, undefined]) {
    const f = fixture(); t.after(() => f.close());
    const a = f.client(); const waiting = f.client(); const cached = f.client();
    const first = await f.initialize(a, 'first');
    assert.equal(first.params.capabilities.experimental.taskComparisonV1, true);
    assert.equal(first.params.capabilities.experimental.taskDeliveryV1, true);
    await f.initialize(waiting, 'waiting');
    assert.equal(f.upstream.length, 1);
    const experimental = { residentThreads: true };
    if (state !== undefined) Object.assign(experimental, { taskComparisonV1: state, taskDeliveryV1: state });
    await f.respond({ id: first.id, result: { protocolVersion: '2026-07-27', capabilities: { experimental } } });
    await f.initialize(cached, 'cached');
    for (const peer of [a, waiting, cached]) {
      assert.equal(peer.messages.at(-1).result.capabilities.experimental.taskComparisonV1, state);
      assert.equal(peer.messages.at(-1).result.capabilities.experimental.taskDeliveryV1, state);
    }
  }
});
