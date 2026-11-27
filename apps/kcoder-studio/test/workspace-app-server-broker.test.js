import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceAppServerBroker } from "../src/workspace-app-server-broker.js";
import { brokerFixture, fakeClient, validInitializeParams } from './workspace-app-server-broker.test-support.js';

// Broker lifecycle: idle shutdown, drains, capability negotiation, lifecycle
// metrics, automation retention, restart, detach and workspace release.
// Ownership and transport suites live in sibling workspace-app-server-broker.*.test.js files.

test('profile human controls retain the same browser resource owner key as handoff and close',()=>{
  const key=WorkspaceAppServerBroker.prototype.resourceKeyFrom;
  assert.equal(key.call({}, {method:'browser/profile/humanAction',params:{expectedRevision:2,action:{session_id:'original-browser',action:'text',text:'fixture'}}}), 'browser\0original-browser');
  assert.equal(key.call({}, {method:'browser/profile/handoff',params:{sessionId:'original-browser',expectedRevision:1,mode:'human'}}), 'browser\0original-browser');
});

test('a browser cannot submit the private ACP Receiver binding to a Native backend', () => {
  const { broker, upstream } = brokerFixture({ residentThreads: true });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 'forged-bind',
    method: 'kcoder/nativeRemote/controlV1', params: { authority: true,
      message: { method: 'bind_original', params: {} } } }));
  assert.equal(upstream.length, 0);
  assert.equal(client.messages.at(-1).error.code, -32601);
});

test('resource sample epochs reject stale responses and preserve newer success across old failure', async () => {
  const value = residentBytes => ({ processId: 42, instanceId: 'target', residentBytes,
    memorySource: 'linux-vmrss', includesChildren: false });
  for (const mode of ['old-success', 'old-failure', 'new-failure']) {
    const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
    broker.initializeResponse = { result: { capabilities: { experimental: {
      serverResourceSnapshotV1: true, serverIdleShutdownV1: true,
    } } } };
    const old = broker.readResourceSnapshot();
    const stop = broker.stopWhenIdle();
    if (mode === 'new-failure') {
      respond({ id: upstream[1].id, error: { code: -1, message: 'fixture' } });
      assert.deepEqual(await stop, { status: 'unknown' });
    } else {
      respond({ id: upstream[1].id, result: value(200) });
      await new Promise(resolve => setImmediate(resolve));
      respond({ id: upstream[2].id, result: { accepted: false } });
      assert.deepEqual(await stop, { status: 'busy' });
    }
    respond(mode === 'old-failure'
      ? { id: upstream[0].id, error: { code: -1, message: 'fixture' } }
      : { id: upstream[0].id, result: value(100) });
    assert.equal(await old, null);
    assert.equal(broker.idleShutdown.resourceSample?.residentBytes ?? null, mode === 'new-failure' ? null : 200);
  }
});

test('resource probes coalesce without freezing clients and discard old samples on failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { broker, upstream, respond, child } = brokerFixture({ residentThreads: true, monotonicNow: () => 77 });
  child.pid = 900;
  broker.initializeResponse = { result: { capabilities: { experimental: { serverResourceSnapshotV1: true } } } };
  const probe = broker.readResourceSnapshot();
  assert.equal(broker.readResourceSnapshot(), probe);
  assert.equal(broker.acceptsClient, true);
  respond({ id: upstream[0].id, result: { processId: 42, instanceId: 'target',
    residentBytes: 4096, memorySource: 'windows-working-set', includesChildren: false, sampledAtMs: -1 } });
  const snapshot = await probe;
  assert.equal(snapshot.processId, 42);
  assert.equal(snapshot.receivedAt, 77);
  const failed = broker.readResourceSnapshot();
  assert.equal(broker.idleShutdown.resourceSample, null);
  t.mock.timers.tick(10_000);
  assert.equal(await failed, null);
  assert.equal(broker.idleShutdown.resourceSample, null);
  const pending = broker.readResourceSnapshot();
  child.emit('close', 0, null);
  assert.equal(await pending, null);
  assert.equal(broker.idleShutdown.resourceSample, null);
});

test('idle shutdown freezes attachment and waits for actual exit after acceptance', async () => {
  const { broker, upstream, respond, child } = brokerFixture({ residentThreads: true });
  broker.initializeResponse = { result: { capabilities: { experimental: { serverIdleShutdownV1: true } } } };
  let settled = false;
  const operation = broker.stopWhenIdle();
  assert.equal(broker.stopWhenIdle(), operation, 'concurrent stops must share one handshake');
  const stop = operation.then(result => { settled = true; return result; });
  assert.equal(broker.acceptsClient, false);
  assert.throws(() => broker.attach(fakeClient()), /closed or restarting/);
  assert.equal(upstream[0].method, 'server/resources/read');
  respond({ id: upstream[0].id, result: { instanceId: 'instance-a' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(upstream[1].params, { instanceId: 'instance-a' });
  assert.equal(upstream[1].method, 'server/shutdown/idle');
  respond({ id: upstream[1].id, result: { accepted: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit('close', 0, null);
  assert.deepEqual(await stop, { status: 'stopped' });
  assert.equal(broker.idleShutdown.requests.size, 0);
});

test('idle shutdown rejection restores admission and staged attachments prevent a probe', async () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  broker.initializeResponse = { result: { capabilities: { experimental: { serverIdleShutdownV1: true } } } };
  broker.persistentResources.add('attachment\0queued');
  assert.deepEqual(await broker.stopWhenIdle(), { status: 'busy' });
  assert.equal(upstream.length, 0);
  broker.persistentResources.clear();
  const stop = broker.stopWhenIdle();
  respond({ id: upstream[0].id, result: { instanceId: 'instance' } });
  await new Promise(resolve => setImmediate(resolve));
  respond({ id: upstream[1].id, result: { accepted: false } });
  assert.deepEqual(await stop, { status: 'busy' });
  assert.equal(broker.acceptsClient, true);
});

test('idle shutdown exit timeout remains sealed and never sends a kill', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { broker, upstream, respond, child } = brokerFixture({ residentThreads: true });
  child.kill = () => assert.fail('no force kill is authorized');
  broker.initializeResponse = { result: { capabilities: { experimental: { serverIdleShutdownV1: true } } } };
  const stop = broker.stopWhenIdle();
  respond({ id: upstream[0].id, result: { instanceId: 'instance' } });
  await new Promise(resolve => setImmediate(resolve));
  respond({ id: upstream[1].id, result: { accepted: true } });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  assert.deepEqual(await stop, { status: 'unknown' });
  assert.equal(broker.acceptsClient, false);
  assert.equal(broker.idleShutdown.exitWaiters.size, 0);
  assert.deepEqual(await broker.stopWhenIdle(), { status: 'unknown' });
  assert.equal(upstream.length, 2);
  child.emit('close', 0, null);
});

test('legacy servers do not fall back to unsafe force termination', async () => {
  const { broker, upstream } = brokerFixture();
  assert.deepEqual(await broker.stopWhenIdle(), { status: 'unsupported' });
  assert.equal(upstream.length, 0);
  assert.equal(broker.idleShutdown.closing, false);
});

test('idle rejection diagnostics retain only known reason labels', async () => {
  for (const reason of ['projection_pending', 'peer_wake_handoff', 'peer_wake_observation', 'untrusted raw details']) {
    const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
    broker.initializeResponse = { result: { capabilities: { experimental: { serverIdleShutdownV1: true } } } };
    const stop = broker.stopWhenIdle();
    respond({ id: upstream[0].id, result: { instanceId: 'instance' } });
    await new Promise(resolve => setImmediate(resolve));
    respond({ id: upstream[1].id, result: { accepted: false, reason } });
    assert.deepEqual(await stop, reason === 'untrusted raw details' ? { status: 'busy' } : { status: 'busy', reason });
  }
});

test('RPC timeout reopens only before shutdown could have been accepted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const shutdownSent of [false, true]) {
    const { broker, upstream, respond, child } = brokerFixture({ residentThreads: true });
    broker.initializeResponse = { result: { capabilities: { experimental: { serverIdleShutdownV1: true } } } };
    const stop = broker.stopWhenIdle();
    if (shutdownSent) {
      respond({ id: upstream[0].id, result: { instanceId: 'instance' } });
      await new Promise(resolve => setImmediate(resolve));
    }
    t.mock.timers.tick(10_000);
    assert.deepEqual(await stop, { status: 'unknown' });
    assert.equal(broker.idleShutdown.closing, shutdownSent);
    assert.equal(broker.idleShutdown.requests.size, 0);
    child.emit('close', 0, null);
  }
});

test('clients cannot invoke the lifecycle owner idle shutdown RPC', () => {
  const { broker, upstream } = brokerFixture();
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ id: 1, method: 'server/shutdown/idle', params: { instanceId: 'known' } }));
  assert.equal(upstream.length, 0);
  assert.equal(client.messages.at(-1).error.code, -32601);
});

test('pending work observation protects each registered protocol activity without a client', () => {
  const { broker } = brokerFixture({ residentThreads: true });
  assert.equal(broker.clientCount, 0);
  assert.equal(broker.hasPendingWork, false);
  for (const registry of [broker.pending, broker.activeTurns, broker.threadDrains, broker.serverRequests]) {
    registry.set('fixture', {});
    assert.equal(broker.hasPendingWork, true);
    registry.clear();
    assert.equal(broker.hasPendingWork, false);
  }
});

test('drain timeout remains busy and rejects writes until the matching terminal event', async () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const client = fakeClient();
  broker.attach(client);
  broker.beginThreadDrain('draining', 'turn-draining');
  broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'draining' } }));
  broker.finishThreadDrain('draining', false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstream.length, 0, 'timeout must not release queued mutation');
  assert.equal(broker.hasPendingWork, true);
  assert.equal(client.messages.at(-1)?.error?.code, -32043);
  broker.receive(client, JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: 'draining' } }));
  assert.equal(client.messages.at(-1)?.id, 2);
  assert.equal(client.messages.at(-1)?.error?.code, -32043);
  assert.equal(broker.threadDrains.get('draining').queue.length, 0);
  respond({ method: 'turn/completed', params: { turnId: 'unrelated' } });
  assert.equal(broker.hasPendingWork, true);
  respond({ method: 'turn/interrupted', params: { turnId: 'turn-draining' } });
  assert.equal(broker.hasPendingWork, false);
  broker.receive(client, JSON.stringify({ id: 3, method: 'thread/resume', params: { threadId: 'draining' } }));
  assert.equal(upstream.length, 1);
});

test('actual drain deadline preserves activity until a thread-scoped terminal arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { broker, respond } = brokerFixture({ residentThreads: true });
  broker.beginThreadDrain('deadline', 'deadline-turn');
  const done = broker.threadDrains.get('deadline').done;
  t.mock.timers.tick(15_000);
  assert.equal(await done, false);
  assert.equal(broker.hasPendingWork, true);
  assert.equal(broker.threadDrains.get('deadline').timedOut, true);
  respond({ method: 'turn/completed', params: { threadId: 'deadline', turnId: 'old-turn' } });
  assert.equal(broker.hasPendingWork, true);
  respond({ method: 'turn/completed', params: { threadId: 'deadline', turnId: 'deadline-turn' } });
  assert.equal(broker.hasPendingWork, false);
});

test('detached ordinary requests remain busy until their response without reviving ownership', () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'detached' } }));
  const id = upstream.at(-1).id;
  broker.detach(client);
  assert.equal(broker.pending.has(id), false);
  assert.equal(broker.hasPendingWork, true);
  respond({ id, result: { thread: { id: 'detached' } } });
  assert.equal(broker.hasPendingWork, false);
  assert.equal(broker.threadOwners.has('detached'), false);
  assert.equal(client.messages.length, 0);
});

test('detached correlation IDs are bounded and overflow never implies idle', () => {
  const { broker, child, respond } = brokerFixture({ residentThreads: true });
  const client = fakeClient();
  broker.attach(client);
  for (let id = 1; id <= 4097; id++) {
    broker.pending.set(id, { client, method: 'thread/list', params: { privateDraft: 'discard' } });
  }
  broker.detach(client);
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.detachedRequestIds.size, 4096);
  assert.equal(broker.detachedRequestsUnknown, true);
  for (let id = 1; id <= 4097; id++) respond({ id, result: {} });
  assert.equal(broker.detachedRequestIds.size, 0);
  assert.equal(broker.hasPendingWork, true);
  assert.equal(client.messages.length, 0);
  child.emit('close', 0, null);
  assert.equal(broker.detachedRequestsUnknown, false);
  assert.equal(broker.hasPendingWork, false);
});

test("interaction status read requires negotiated capability and current thread ownership", () => {
  const f = brokerFixture({ residentThreads: true });
  const owner = fakeClient(); const peer = fakeClient(); const legacy = fakeClient();
  for (const client of [owner, peer, legacy]) f.broker.attach(client);
  const initialize = (client, enabled) => f.broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: `initialize-${client === owner ? "owner" : client === peer ? "peer" : "legacy"}`,
    method: "initialize", params: { ...validInitializeParams(),
      capabilities: { experimental: { interactionStatusReadV1: enabled } },
    },
  }));
  initialize(owner, true);
  assert.equal(f.upstream[0].params.capabilities.experimental.interactionStatusReadV1, true);
  f.respond({ jsonrpc: "2.0", id: f.upstream[0].id, result: { capabilities: { experimental: {
    residentThreads: true, interactionStatusReadV1: true,
  } } } });
  initialize(peer, true);
  initialize(legacy, false);
  assert.equal(owner.interactionStatusReadV1, true);
  assert.equal(peer.interactionStatusReadV1, true);
  assert.equal(legacy.interactionStatusReadV1, false);

  const params = { serverId: "local", threadId: "owned-thread", turnId: "turn-1",
    requestId: 1000001, appServerEpoch: "epoch-1", kind: "approval", approvalId: "approval-1000001" };
  f.broker.threadOwners.set("owned-thread", owner);
  f.broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: "status-owner",
    method: "interaction/status/read", params }));
  assert.equal(f.upstream.at(-1).method, "interaction/status/read");
  assert.deepEqual(f.upstream.at(-1).params, params);

  const beforePeer = f.upstream.length;
  f.broker.receive(peer, JSON.stringify({ jsonrpc: "2.0", id: "status-peer",
    method: "interaction/status/read", params }));
  assert.equal(peer.messages.at(-1).error.code, -32023);
  f.broker.receive(legacy, JSON.stringify({ jsonrpc: "2.0", id: "status-legacy",
    method: "interaction/status/read", params }));
  assert.equal(legacy.messages.at(-1).error.code, -32601);
  f.broker.threadOwners.delete("owned-thread");
  f.broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: "status-unowned",
    method: "interaction/status/read", params }));
  assert.equal(owner.messages.at(-1).error.code, -32023);
  assert.equal(f.upstream.length, beforePeer);
});

test("client capability offer cannot enable interaction status read when the backend omits support", () => {
  const f = brokerFixture({ residentThreads: true });
  const client = fakeClient();
  f.broker.attach(client);
  f.broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: "initialize",
    method: "initialize", params: { ...validInitializeParams(),
      capabilities: { experimental: { interactionStatusReadV1: true } },
    },
  }));
  f.respond({ jsonrpc: "2.0", id: f.upstream[0].id, result: { capabilities: { experimental: {
    residentThreads: true,
  } } } });
  assert.equal(client.interactionStatusReadV1, true);
  assert.notEqual(f.broker.initializeResponse.result.capabilities.experimental.interactionStatusReadV1, true);
  f.broker.threadOwners.set("owned-thread", client);
  const before = f.upstream.length;
  f.broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: "status-unsupported",
    method: "interaction/status/read", params: { serverId: "local", threadId: "owned-thread",
      turnId: "turn-1", requestId: 1000001, appServerEpoch: "epoch-1", kind: "approval",
      approvalId: "approval-1000001",
    },
  }));
  assert.equal(client.messages.at(-1).error.code, -32601);
  assert.equal(f.upstream.length, before);
});

test("Gateway disconnect cancels its pending interaction and a resumed owner can only reconcile", () => {
  const f = brokerFixture({ residentThreads: true });
  const owner = fakeClient(); const resumed = fakeClient();
  f.broker.attach(owner);
  const initialize = client => f.broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: "initialize",
    method: "initialize", params: { ...validInitializeParams(),
      capabilities: { experimental: { interactionStatusReadV1: true } },
    },
  }));
  initialize(owner);
  f.respond({ jsonrpc: "2.0", id: f.upstream[0].id, result: { capabilities: { experimental: {
    residentThreads: true, interactionStatusReadV1: true,
  } } } });
  f.broker.threadOwners.set("owned-thread", owner);
  f.respond({ jsonrpc: "2.0", id: 9002, method: "approval/request", params: {
    threadId: "owned-thread", turnId: "turn-1", approvalId: "approval-1000001", appServerEpoch: "epoch-1",
  } });
  assert.equal(f.broker.serverRequests.get(9002), owner);

  f.broker.detach(owner);
  assert.equal(f.upstream.at(-1).id, 9002);
  assert.equal(f.upstream.at(-1).error.message, "owning Gateway client disconnected");
  assert.equal(f.broker.serverRequests.has(9002), false);
  assert.equal(f.broker.threadOwners.has("owned-thread"), false);

  f.broker.attach(resumed);
  initialize(resumed);
  assert.equal(resumed.interactionStatusReadV1, true);
  f.broker.threadOwners.set("owned-thread", resumed);
  assert.throws(() => f.broker.receive(resumed, JSON.stringify({ jsonrpc: "2.0", id: 9002,
    result: { decision: "accept", approvalId: "approval-1000001" },
  })), /another client|unsolicited/);
  f.broker.receive(resumed, JSON.stringify({ jsonrpc: "2.0", id: "status-reconcile",
    method: "interaction/status/read", params: { serverId: "local", threadId: "owned-thread",
      turnId: "turn-1", requestId: 1000001, appServerEpoch: "epoch-1", kind: "approval",
      approvalId: "approval-1000001",
    },
  }));
  assert.equal(f.upstream.at(-1).method, "interaction/status/read");
  assert.equal(f.upstream.at(-1).params.appServerEpoch, "epoch-1");
});

// These tests measure protocol lifecycle boundaries, not model behavior.
test("path preview capability is isolated for cached and pending clients", () => {
  for (const newFirst of [false, true]) {
    const f = brokerFixture({ residentThreads: true });
    const modern = fakeClient();
    const legacy = fakeClient();
    const late = fakeClient();
    for (const client of [modern, legacy, late]) f.broker.attach(client);
    const initialize = (client, enabled) => f.broker.receive(client, JSON.stringify({
      id: 1, method: "initialize", params: { ...validInitializeParams(),
        capabilities: { experimental: { toolPathPreviewV1: enabled } },
      },
    }));
    initialize(newFirst ? modern : legacy, newFirst);
    initialize(newFirst ? legacy : modern, !newFirst);
    f.respond({ id: f.upstream[0].id, result: { capabilities: { experimental: {
      residentThreads: true, toolPathPreviewV1: true,
    } } } });
    initialize(late, true);
    assert.equal(f.upstream.length, 1);
    assert.equal(f.upstream[0].params.capabilities.experimental.toolPathPreviewV1, true);
    const event = { method: "item/event", params: { event: {
      type: "tool_path_preview", attempt_id: "attempt", id: "call", path: "file.txt",
    } } };
    f.respond(event);
    assert.equal(modern.messages.filter(m => m.method === "item/event").length, 1);
    assert.equal(late.messages.filter(m => m.method === "item/event").length, 1);
    assert.equal(legacy.messages.filter(m => m.method === "item/event").length, 0);
    f.broker.threadOwners.set("owned", legacy);
    f.respond({ ...event, params: { ...event.params, threadId: "owned" } });
    assert.equal(legacy.messages.filter(m => m.method === "item/event").length, 0);
    f.broker.threadOwners.set("owned", modern);
    f.respond({ ...event, params: { ...event.params, threadId: "owned", event: { ...event.params.event, path: null } } });
    assert.equal(modern.messages.at(-1).params.event.path, null);
    assert.equal(late.messages.filter(m => m.method === "item/event").length, 1);
  }
});

test("path preview capability rejects unnegotiated recipients and cannot change mid-connection", () => {
  const f = brokerFixture({ residentThreads: true });
  const clients = [fakeClient(), fakeClient(), fakeClient(), fakeClient("metadata")];
  for (const client of clients) f.broker.attach(client);
  const initialize = (client, value) => f.broker.receive(client, JSON.stringify({
    id: 1, method: "initialize", params: { ...validInitializeParams(), capabilities: { experimental: { toolPathPreviewV1: value } } },
  }));
  initialize(clients[0], true);
  const event = { method: "item/event", params: { event: { type: "tool_path_preview", path: "private" } } };
  f.respond(event);
  assert.equal(clients[0].messages.length, 0, "pending initialize is not consent to delivery");
  f.respond({ id: f.upstream[0].id, result: { capabilities: { experimental: { residentThreads: true } } } });
  initialize(clients[1], "true");
  initialize(clients[3], true);
  f.respond(event);
  for (const client of clients) assert.equal(client.messages.filter(m => m.method === "item/event").length, 0);
  f.broker.initializeResponse.result.capabilities.experimental.toolPathPreviewV1 = true;
  initialize(clients[1], true);
  f.respond(event);
  assert.equal(clients[0].messages.filter(m => m.method === "item/event").length, 1);
  assert.equal(clients[1].messages.filter(m => m.method === "item/event").length, 1);
  for (const client of clients.slice(2)) assert.equal(client.messages.filter(m => m.method === "item/event").length, 0);
  f.respond({ method: "server/status", params: { online: true } });
  for (const client of clients) assert.equal(client.messages.at(-1).method, "server/status");
});

function lifecycleFixture(options = {}) {
  let now = 100;
  const finals = [];
  const fixture = brokerFixture({
    monotonicNow: () => now,
    onLifecycleMetrics: snapshot => finals.push(snapshot),
    ...options,
  });
  const request = (client, method, params = {}) => {
    fixture.broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }));
    return fixture.upstream.at(-1)?.id;
  };
  return { ...fixture, finals, request, at: value => { now = value; } };
}

test("lifecycle metrics count real initialize, not cached capability or repeated requests", () => {
  const f = lifecycleFixture({ residentThreads: true });
  const client = fakeClient();
  f.broker.attach(client);
  f.at(110);
  const id = f.request(client, "initialize", validInitializeParams());
  f.at(140);
  f.respond({ jsonrpc: "2.0", id, result: { capabilities: { experimental: { residentThreads: true } } } });
  f.at(200);
  f.request(client, "initialize", validInitializeParams());
  f.child.emit("close", 0, null);
  assert.equal(f.finals.length, 1);
  assert.equal(f.finals[0].initializeMs, 40);
  assert.equal(f.finals[0].initializeFailureCount, 0);
  assert.equal(f.upstream.length, 1, "cached initialize adds no upstream frames");
});

test("lifecycle metrics distinguish uninitialized from failed initialize and close only once", () => {
  for (const failed of [false, true]) {
    const f = lifecycleFixture({ residentThreads: true });
    const client = fakeClient();
    f.broker.attach(client);
    if (failed) {
      const id = f.request(client, "initialize", validInitializeParams());
      f.respond({ id, error: { code: -1, message: "secret" } });
    }
    f.at(130);
    f.broker.fail(new Error("secret endpoint"));
    f.broker.fail(new Error("again"));
    f.child.emit("close", 1, null);
    assert.equal(f.finals.length, 1);
    assert.equal(f.finals[0].initializeMs, null);
    assert.equal(f.finals[0].initializeFailureCount, Number(failed));
    assert.equal(f.finals[0].lifetimeMs, 30);
    assert.equal(f.finals[0].closedCount, 1);
    assert.ok(Object.values(f.finals[0]).every(v => v === null || typeof v === "number"));
    assert.doesNotMatch(JSON.stringify(f.finals), /secret|endpoint|serverId|workspace|pid|token/i);
  }
});

test("lifecycle metrics count client-free reuse but not concurrent or pre-ready attach", () => {
  const f = lifecycleFixture({ residentThreads: true });
  const first = fakeClient();
  const second = fakeClient();
  f.broker.attach(first);
  f.broker.detach(first);
  f.at(105);
  f.broker.attach(first);
  const id = f.request(first, "initialize", validInitializeParams());
  f.at(110);
  f.respond({ id, result: { capabilities: { experimental: { residentThreads: true } } } });
  f.broker.attach(second);
  f.at(120);
  f.broker.detach(first);
  f.at(125);
  f.broker.detach(second);
  f.at(130);
  f.broker.detach(second);
  f.at(150);
  f.broker.attach(first);
  f.at(160);
  f.broker.detach(first);
  f.at(170);
  f.broker.attach(second);
  f.child.emit("close", 0, null);
  assert.equal(f.finals.length, 1);
  assert.equal(f.finals[0].attachCount, 5);
  assert.equal(f.finals[0].reuseCount, 2);
  assert.equal(f.finals[0].clientFreeMsSum, 35);
  assert.equal(f.finals[0].clientFreeMsMax, 25);
});

test("lifecycle metrics aggregate resume success error and abandoned without extra frames or polling", t => {
  t.mock.method(globalThis, "setInterval", () => { throw new Error("unexpected poll"); });
  const f = lifecycleFixture({ residentThreads: true });
  const client = fakeClient();
  f.broker.attach(client);
  const initialize = f.request(client, "initialize", validInitializeParams());
  f.respond({ id: initialize, result: { capabilities: { experimental: { residentThreads: true } } } });
  for (const [start, end, error] of [[110, 130, false], [150, 155, false], [160, 175, true]]) {
    f.at(start);
    const id = f.request(client, "thread/resume", { threadId: "private-thread", path: "/secret" });
    f.at(end);
    f.respond(error ? { id, error: { code: -1, message: "secret" } } : { id, result: { threadId: "private-thread" } });
  }
  f.at(180);
  const abandoned = f.request(client, "thread/resume", { threadId: "private-thread" });
  f.broker.detach(client);
  f.respond({ id: abandoned, result: { threadId: "private-thread" } });
  f.broker.attach(client);
  f.request(client, "thread/resume", { threadId: "another-private-thread" });
  f.at(200);
  f.child.emit("close", 0, null);
  assert.equal(f.finals.length, 1);
  const s = f.finals[0];
  assert.equal(s.resumeStartedCount, 5);
  assert.equal(s.resumeSuccessCount, 2);
  assert.equal(s.resumeSuccessMsSum, 25);
  assert.equal(s.resumeSuccessMsMax, 20);
  assert.equal(s.resumeErrorCount, 1);
  assert.equal(s.resumeErrorMsSum, 15);
  assert.equal(s.resumeErrorMsMax, 15);
  assert.equal(s.resumeAbandonedCount, 2);
  assert.equal(f.upstream.length, 6);
  assert.doesNotMatch(JSON.stringify(s), /private|secret|threadId|path/);
});

test("lifecycle metrics observer exceptions do not interrupt close or failure cleanup", () => {
  for (const fail of [false, true]) {
    let closes = 0;
    let observed = 0;
    const f = lifecycleFixture({
      onClose: () => { closes += 1; },
      onLifecycleMetrics: () => { observed += 1; throw new Error("observer failure"); },
    });
    f.broker.attach(fakeClient());
    assert.doesNotThrow(() => fail ? f.broker.fail(new Error("upstream")) : f.child.emit("close", 0, null));
    f.child.emit("close", 1, null);
    assert.equal(observed, 1);
    assert.equal(closes, 1);
    assert.equal(f.broker.clientCount, 0);
    assert.equal(f.broker.pending.size, 0);
  }
});

test("lifecycle metrics final observer runs after onClose removes the broker registry entry", () => {
  for (const fail of [false, true]) {
    const registry = new Set();
    const order = [];
    const f = lifecycleFixture({
      onClose: broker => {
        assert.equal(registry.delete(broker), true);
        order.push("removed");
      },
      onLifecycleMetrics: () => {
        order.push(registry.size === 0 ? "observed-removed" : "observed-registered");
      },
    });
    registry.add(f.broker);
    if (fail) f.broker.fail(new Error("upstream"));
    else f.child.emit("close", 0, null);
    assert.deepEqual(order, ["removed", "observed-removed"]);
  }
});

test("lifecycle metrics start resume at forwarding, not after a synchronous write delay", () => {
  const f = lifecycleFixture({ residentThreads: true });
  const client = fakeClient();
  f.broker.attach(client);
  const write = f.child.stdin.write.bind(f.child.stdin);
  f.child.stdin.write = (...args) => {
    const result = write(...args);
    f.at(125);
    return result;
  };
  f.at(110);
  const id = f.request(client, "thread/resume", { threadId: "private" });
  f.at(130);
  f.respond({ id, result: { threadId: "private" } });
  f.child.emit("close", 0, null);
  assert.equal(f.finals[0].resumeSuccessMsSum, 20);
});

test("lifecycle metrics exclude rejected writes from resume counts", () => {
  const f = lifecycleFixture();
  const client = fakeClient();
  f.broker.attach(client);
  f.child.stdin.write = () => { throw new Error("rejected write"); };
  assert.throws(() => f.request(client, "thread/resume", { threadId: "private" }), /rejected write/);
  f.child.emit("close", 1, null);
  assert.equal(f.finals[0].resumeStartedCount, 0);
  assert.equal(f.finals[0].resumeAbandonedCount, 0);
});

test("thread tool catalogs require completed ownership even after detach", async () => {
  const { broker, child, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const next = fakeClient();
  broker.attach(owner);
  broker.attach(next);
  let id = 0;
  const catalog = client => broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: ++id, method: "tools/catalog", params: { threadId: "resident" },
  }));
  try {
    catalog(next);
    assert.equal(upstream.length, 0, "an unowned resident must not expose its tool catalog");
    broker.threadClaims.set("resident", next);
    catalog(next);
    assert.equal(upstream.length, 0, "a pending resume is not completed ownership");
    broker.threadClaims.delete("resident");
    broker.threadOwners.set("resident", owner);
    catalog(next);
    assert.equal(upstream.length, 0);
    catalog(owner);
    assert.equal(upstream.length, 1);
    respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { tools: [] } });
    await new Promise(resolve => setImmediate(resolve));
    broker.detach(owner);
    catalog(next);
    assert.equal(upstream.length, 1, "detach must not make a catalog public");
    broker.receive(next, JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "thread/resume", params: { threadId: "resident" } }));
    respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { thread: { id: "resident" } } });
    await new Promise(resolve => setImmediate(resolve));
    catalog(next);
    assert.equal(upstream.length, 3, "completed resume authorizes the new owner");
  } finally {
    child.emit("exit", 0, null);
  }
});

test('automation work retains its backend through pending and running states, then releases it', () => {
  const idleStates = [];
  const { broker, child, respond } = brokerFixture({ onIdleStateChange: current => idleStates.push(current.hasProjectAutomations) });
  respond({ jsonrpc: '2.0', method: 'automation/stateChanged', params: { jobCount: 1, pendingCount: 0 } });
  assert.equal(broker.hasProjectAutomations, true);
  respond({ jsonrpc: '2.0', method: 'automation/stateChanged', params: { jobCount: 0, pendingCount: 1 } });
  assert.equal(broker.hasProjectAutomations, true);
  respond({ jsonrpc: '2.0', method: 'automation/runStarted', params: { threadId: 'automatic', workspacePath: '/fixture' } });
  respond({ jsonrpc: '2.0', method: 'automation/stateChanged', params: { jobCount: 0, pendingCount: 0 } });
  assert.equal(broker.hasProjectAutomations, true);
  respond({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'automatic', turn: { status: 'completed' } } });
  assert.equal(broker.hasProjectAutomations, false);
  assert.equal(idleStates.at(-1), false);
  child.emit('exit', 0, null);
});

test('disconnect disarms only owned automatic goal work, not another thread or readonly observer', () => {
  const { broker, child, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const other = fakeClient();
  const observer = fakeClient();
  for (const client of [owner, other, observer]) broker.attach(client);
  broker.initializeResponse = {result:{capabilities:{experimental:{goalContinuation:true}}}};
  broker.threadOwners.set('owned', owner);
  broker.threadOwners.set('other', other);
  broker.detach(observer);
  assert.equal(upstream.length, 0);
  broker.detach(owner);
  const suspendOwned = upstream.at(-1);
  assert.equal(suspendOwned.jsonrpc, "2.0");
  assert.notEqual(suspendOwned.id, undefined);
  assert.equal(suspendOwned.method, "thread/automation/suspend");
  assert.deepEqual(suspendOwned.params, { threadId: "owned" });
  assert.equal(broker.pending.get(suspendOwned.id)?.client, null);
  respond({ jsonrpc: "2.0", id: suspendOwned.id, result: {} });
  assert.equal(broker.threadOwners.get('other'), other);
  broker.detach(other);
  const suspendOther = upstream.at(-1);
  assert.notEqual(suspendOther.id, undefined);
  assert.equal(suspendOther.method, "thread/automation/suspend");
  respond({ jsonrpc: "2.0", id: suspendOther.id, result: {} });
  child.emit('exit', 0, null);
});

test("restart rejects malformed, uninitialized and shared-client requests without stopping the backend", () => {
  let stops = 0;
  const { broker, upstream, respond } = brokerFixture({ onRestart: () => { stops += 1; } });
  const client = fakeClient();
  broker.attach(client);
  for (const params of [null, [], 42, "garbage", {}, { confirm: false }, { confirm: true, extra: true }, { confirm: true, force: "yes" }]) {
    broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "gateway/app-server/restart", params }));
    assert.equal(client.messages.at(-1).error.code, -32602);
  }
  for (const request of [
    { method: "gateway/app-server/restart", params: { confirm: true } },
    { jsonrpc: "2.0", id: null, method: "gateway/app-server/restart", params: { confirm: true } },
  ]) {
    broker.receive(client, JSON.stringify(request));
    assert.equal(client.messages.at(-1).error.code, -32600);
  }
  const restart = { jsonrpc: "2.0", id: 8, method: "gateway/app-server/restart", params: { confirm: true } };
  broker.receive(client, JSON.stringify(restart));
  assert.equal(client.messages.at(-1).error.code, -32002);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: validInitializeParams() }));
  respond({ id: upstream.at(-1).id, result: { capabilities: { experimental: { residentThreads: true } } } });
  broker.attach(fakeClient());
  broker.receive(client, JSON.stringify(restart));
  assert.equal(client.messages.at(-1).error.code, -32043);
  assert.equal(stops, 0);
});

test("exclusive restart waits for shutdown, reports reconnect required and never reports premature restart success", async () => {
  let finish;
  const { broker, child, upstream, respond } = brokerFixture({ onRestart: () => new Promise(resolve => { finish = resolve; }) });
  const client = fakeClient();
  let closed = false;
  client.close = () => { closed = true; };
  broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: validInitializeParams() }));
  respond({ id: upstream.at(-1).id, result: { capabilities: { experimental: { residentThreads: true } } } });
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "gateway/app-server/restart", params: { confirm: true } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.messages.some(message => message.id === 2), false);
  assert.equal(broker.acceptsClient, false);
  assert.throws(() => broker.attach(fakeClient()), /restarting/);
  child.emit("close", 0, null);
  assert.equal(closed, false);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.messages.at(-1).result, { restarted: false, stopped: true, reconnectRequired: true });
  assert.equal(closed, true);
});

test("failed browser start releases the channel reservation but an in-flight start does not", () => {
  const { broker, upstream, respond } = brokerFixture();
  const client = fakeClient("browser");
  broker.attach(client);
  const start = id => broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id, method: "browser/start", params: {} }));
  start(1);
  start(2);
  assert.equal(upstream.length, 1);
  assert.equal(client.messages.at(-1).error.code, -32601);
  respond({ id: upstream[0].id, error: { code: -32602, message: "fixture startup failure" } });
  start(3);
  assert.equal(upstream.length, 2);
  respond({ id: upstream[1].id, result: { sessionId: "browser-one" } });
  start(4);
  assert.equal(upstream.length, 2);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 41, method: "browser/close", params: { sessionId: "does-not-exist" } }));
  respond({ id: upstream.at(-1).id, result: { closed: false } });
  start(42);
  assert.equal(client.messages.at(-1).error.code, -32601);
  assert.equal(upstream.length, 3);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 5, method: "browser/close", params: { sessionId: "browser-one" } }));
  respond({ id: upstream.at(-1).id, result: { closed: true } });
  start(6);
  assert.equal(upstream.at(-1).method, "browser/start");
  assert.equal(upstream.length, 5);
});

test("ephemeral forks read a normal source, bind a private child owner, and dispose on disconnect", () => {
  const { broker, upstream, respond } = brokerFixture();
  const source = fakeClient(), temporary = fakeClient(), other = fakeClient();
  broker.attach(source); broker.attach(temporary); broker.attach(other);
  broker.receive(source, JSON.stringify({ id: 1, method: "thread/start", params: {} }));
  respond({ id: upstream.at(-1).id, result: { thread: { id: "source" } } });
  broker.receive(temporary, JSON.stringify({ id: 2, method: "thread/fork", params: { threadId: "source", ephemeral: true } }));
  assert.equal(upstream.at(-1).method, "thread/fork");
  respond({ id: upstream.at(-1).id, result: { thread: { id: "private-child" }, ephemeral: true } });
  assert.equal(broker.threadOwners.get("source"), source);
  assert.equal(broker.threadOwners.get("private-child"), temporary);
  for (const method of ["thread/read", "thread/read/indexed", "thread/resume", "thread/dispose", "thread/fork"]) {
    broker.receive(other, JSON.stringify({ id: 3, method, params: { threadId: "private-child", ephemeral: true } }));
    assert.equal(other.messages.at(-1).error.code, -32023);
  }
  broker.detach(temporary);
  const dispose = upstream.at(-1);
  assert.notEqual(dispose.id, undefined);
  assert.equal(dispose.method, "thread/dispose");
  assert.deepEqual(dispose.params, { threadId: "private-child" });
  assert.equal(broker.pending.get(dispose.id)?.client, null);
  respond({ jsonrpc: "2.0", id: dispose.id, result: {} });
  assert.equal(broker.threadOwners.get("source"), source);
});

test("late ephemeral fork completion disposes the child instead of creating durable history", () => {
  const { broker, upstream, respond } = brokerFixture();
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ id: 1, method: "thread/fork", params: { threadId: "source", ephemeral: true } }));
  const id = upstream.at(-1).id;
  broker.detach(client);
  respond({ id, result: { thread: { id: "late-child" }, ephemeral: true } });
  const dispose = upstream.at(-1);
  assert.notEqual(dispose.id, undefined);
  assert.equal(dispose.method, "thread/dispose");
  assert.deepEqual(dispose.params, { threadId: "late-child" });
  assert.equal(broker.pending.get(dispose.id)?.client, null);
  respond({ jsonrpc: "2.0", id: dispose.id, result: {} });
  assert.equal(broker.pending.has(dispose.id), false);
});

test("workspace upload publication retains ownership on conflict and consumes it on success", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient(), other = fakeClient();
  broker.attach(owner); broker.attach(other);
  broker.receive(owner, JSON.stringify({ id: 1, method: "attachment/save", params: {} }));
  respond({ id: upstream[0].id, result: { path: "/staged/upload.bin" } });
  const request = id => ({ id, method: "workspace/file/importAttachment",
    params: { attachmentPath: "/staged/upload.bin", parentPath: "/workspace", filename: "upload.bin" } });
  broker.receive(other, JSON.stringify(request(2)));
  assert.equal(other.messages.at(-1).error.code, -32048);
  assert.equal(upstream.length, 1);
  broker.receive(owner, JSON.stringify(request(3)));
  respond({ id: upstream.at(-1).id, result: { status: "conflict", revision: "stat:old" } });
  assert.equal(broker.resourceOwners.get("attachment\0/staged/upload.bin"), owner);
  broker.receive(owner, JSON.stringify(request(4)));
  respond({ id: upstream.at(-1).id, result: { status: "uploaded" } });
  assert.equal(broker.resourceOwners.has("attachment\0/staged/upload.bin"), false);
  broker.receive(owner, JSON.stringify(request(5)));
  assert.equal(owner.messages.at(-1).error.code, -32049);
  assert.equal(upstream.length, 3);
});

test("staged attachment previews cannot cross multiplexed client owners even when retained", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient(), other = fakeClient();
  broker.attach(owner); broker.attach(other);
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "attachment/save", params: {} }));
  respond({ id: upstream[0].id, result: { path: "/staged/private.txt" } });
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "gateway/attachments/retain", params: { paths: ["/staged/private.txt"] } }));
  for (const method of ["attachment/read", "attachment/read/chunk"]) {
    broker.receive(other, JSON.stringify({ jsonrpc: "2.0", id: 3, method, params: { threadId: "other", path: "/staged/private.txt" } }));
    assert.equal(other.messages.at(-1).error.code, -32048);
  }
  broker.detach(owner);
  for (const method of ["attachment/read", "attachment/read/chunk"]) {
    broker.receive(other, JSON.stringify({ jsonrpc: "2.0", id: 4, method, params: { threadId: "other", path: "/staged/private.txt" } }));
    assert.equal(other.messages.at(-1).error.code, -32049);
  }
  assert.equal(upstream.length, 1);
});

test("resource ownership failures are distinguishable from a stale transcript cursor", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient(), other = fakeClient();
  broker.attach(owner); broker.attach(other);
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "attachment/save", params: {} }));
  respond({ id: upstream[0].id, result: { path: "/staged/guarded.txt" } });
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "gateway/attachments/retain", params: { paths: ["/staged/guarded.txt"] } }));
  // Another client reading an owned resource is an ownership conflict. The
  // app-server reserves -32041 for a stale transcript cursor, which clients
  // answer by rebuilding their projection, so ownership must not claim it.
  broker.receive(other, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "attachment/read", params: { threadId: "other", path: "/staged/guarded.txt" } }));
  assert.equal(other.messages.at(-1).error.code, -32048);
  assert.notEqual(other.messages.at(-1).error.code, -32041);
  // Retained but not yet claimed by its next turn: a readiness failure, also
  // distinct from both the ownership conflict and the stale cursor.
  broker.detach(owner);
  broker.receive(other, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "attachment/read", params: { threadId: "other", path: "/staged/guarded.txt" } }));
  assert.equal(other.messages.at(-1).error.code, -32049);
  assert.notEqual(other.messages.at(-1).error.code, -32041);
});

test("explicit self detach acknowledges only after its own cancellation completes and preserves peers", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient(), peer = fakeClient();
  broker.attach(owner); broker.attach(peer);
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: validInitializeParams() }));
  respond({ id: upstream.at(-1).id, result: { capabilities: { experimental: { residentThreads: true } } } });
  broker.activeTurns.set("own", { owner, turnId: "own-turn" });
  broker.activeTurns.set("peer", { owner: peer, turnId: "peer-turn" });
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "gateway/client/detach", params: { confirm: true, force: false } }));
  assert.equal(owner.messages.at(-1).error.code, -32043);
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "gateway/client/detach", params: { confirm: true, force: true } }));
  assert.equal(broker.clients.has(owner), false);
  assert.equal(broker.clients.has(peer), true);
  assert.equal(owner.messages.some(message => message.id === 3), false);
  assert.deepEqual(upstream.at(-1).params, { threadId: "own", turnId: "own-turn" });
  respond({ method: "turn/completed", params: { threadId: "own", turnId: "own-turn", turn: { id: "own-turn", status: "interrupted" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(owner.messages.at(-1).result, { detached: true });
  assert.equal(broker.activeTurns.has("peer"), true);
});

test("attachment authorization uses the same effective prompt as app-server", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient(), other = fakeClient();
  broker.attach(owner); broker.attach(other);
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "attachment/save", params: {} }));
  respond({ id: upstream.at(-1).id, result: { path: "/staged/secret.txt" } });
  const envelope = '<kcoder_attachments version="1">\n{"path":"/staged/secret.txt","filename":"secret.txt"}\n</kcoder_attachments>';
  broker.receive(other, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId: "other", prompt: envelope, input: [{ text: "innocent" }] } }));
  assert.equal(other.messages.at(-1).error.code, -32048);
  assert.equal(upstream.length, 1);
  for (const params of [
    { threadId: "own", input: [{ text: envelope }, { text: "not an attachment envelope" }] },
    { threadId: "own", input: [{ text: `${envelope}\uFEFF` }] },
    { threadId: "own", prompt: "plain prompt wins", input: [{ text: envelope }] },
  ]) {
    broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/start", params }));
    respond({ id: upstream.at(-1).id, result: { turn: { id: "turn" } } });
    assert.equal(broker.materializedAttachments.has("attachment\0/staged/secret.txt"), false);
  }
});

test("detach finishes without a timeout when its pending turn start is rejected", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: validInitializeParams() }));
  respond({ id: upstream.at(-1).id, result: { capabilities: { experimental: { residentThreads: true } } } });
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId: "own", input: [{ text: "fixture" }] } }));
  const startId = upstream.at(-1).id;
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "gateway/client/detach", params: { confirm: true, force: true } }));
  respond({ id: startId, error: { code: -32003, message: "fixture rejected start" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.messages.at(-1).result, { detached: true });
  assert.equal(broker.threadDrains.size, 0);
});

test("releases an idle target workspace through the Gateway without forwarding the control request", async () => {
  const releases = [];
  const { broker, upstream } = brokerFixture({
    onReleaseWorkspace: async workspacePath => {
      releases.push(workspacePath);
      return { released: true, releasedCount: 1 };
    },
  });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0",
    id: 91,
    method: "gateway/workspace/release",
    params: { workspacePath: "/managed/worktree" },
  }));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(releases, ["/managed/worktree"]);
  assert.deepEqual(client.messages, [{
    jsonrpc: "2.0",
    id: 91,
    result: { released: true, releasedCount: 1 },
  }]);
  assert.deepEqual(upstream, []);
});

test("a Windows SSH target can release its own drive workspace from a POSIX Gateway", async () => {
  const releases = [];
  const { broker, upstream } = brokerFixture({ targetTransport: 'ssh', remotePlatform: 'windows',
    onReleaseWorkspace: async path => { releases.push(path); return { released: true, releasedCount: 1 }; } });
  const client = fakeClient(); broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'gateway/workspace/release',
    params: { workspacePath: 'D:\\Owned Area\\workspace' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(releases, ['D:\\Owned Area\\workspace']);
  assert.equal(client.messages.at(-1).result.releasedCount, 1);
  assert.deepEqual(upstream, []);
});

test("Windows SSH release rejects UNC, drive-relative and POSIX paths without invoking another target", () => {
  const releases = [];
  const { broker, upstream } = brokerFixture({ targetTransport: 'ssh', remotePlatform: 'windows',
    onReleaseWorkspace: path => { releases.push(path); } });
  const client = fakeClient(); broker.attach(client);
  for (const [id, workspacePath] of ['D:relative', 'relative', '\\\\server\\share', '\\\\?\\D:\\owned', '/srv/owned', '\\root-relative'].entries()) {
    broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id, method: 'gateway/workspace/release', params: { workspacePath } }));
    assert.equal(client.messages.at(-1).error.code, -32602);
  }
  assert.deepEqual(releases, []); assert.deepEqual(upstream, []);
});

test("rejects non-absolute workspace release paths at the Gateway boundary", () => {
  const { broker, upstream } = brokerFixture();
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0",
    id: 92,
    method: "gateway/workspace/release",
    params: { workspacePath: "relative" },
  }));

  assert.equal(client.messages[0].error.code, -32602);
  assert.deepEqual(upstream, []);
});
