import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WorkspaceAppServerBroker } from "../src/workspace-app-server-broker.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

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
  for (const reason of ['projection_pending', 'untrusted raw details']) {
    const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
    broker.initializeResponse = { result: { capabilities: { experimental: { serverIdleShutdownV1: true } } } };
    const stop = broker.stopWhenIdle();
    respond({ id: upstream[0].id, result: { instanceId: 'instance' } });
    await new Promise(resolve => setImmediate(resolve));
    respond({ id: upstream[1].id, result: { accepted: false, reason } });
    assert.deepEqual(await stop, reason === 'projection_pending' ? { status: 'busy', reason } : { status: 'busy' });
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

function fakeClient(channel = "runtime") {
  return {
    channel,
    messages: [],
    send(message) { this.messages.push(message); return true; },
    pause() {},
    resume() {},
    close() {},
  };
}

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

function brokerFixture(options = {}) {
  const child = fakeChild();
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: "local",
    ...options,
  });
  const upstream = [];
  let buffered = "";
  child.stdin.on("data", chunk => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      upstream.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  const respond = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  return { broker, child, upstream, respond };
}

// These tests measure protocol lifecycle boundaries, not model behavior.
test("path preview capability is isolated for cached and pending clients", () => {
  for (const newFirst of [false, true]) {
    const f = brokerFixture({ residentThreads: true });
    const modern = fakeClient();
    const legacy = fakeClient();
    const late = fakeClient();
    for (const client of [modern, legacy, late]) f.broker.attach(client);
    const initialize = (client, enabled) => f.broker.receive(client, JSON.stringify({
      id: 1, method: "initialize", params: {
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
    id: 1, method: "initialize", params: { capabilities: { experimental: { toolPathPreviewV1: value } } },
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
  for (const client of clients.slice(1)) assert.equal(client.messages.filter(m => m.method === "item/event").length, 0);
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
  const id = f.request(client, "initialize");
  f.at(140);
  f.respond({ jsonrpc: "2.0", id, result: { capabilities: { experimental: { residentThreads: true } } } });
  f.at(200);
  f.request(client, "initialize");
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
      const id = f.request(client, "initialize");
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
  const id = f.request(first, "initialize");
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

test("lifecycle metrics aggregate resume success error and abandoned without extra frames or timers", t => {
  t.mock.method(globalThis, "setTimeout", () => { throw new Error("unexpected timer"); });
  t.mock.method(globalThis, "setInterval", () => { throw new Error("unexpected poll"); });
  const f = lifecycleFixture({ residentThreads: true });
  const client = fakeClient();
  f.broker.attach(client);
  const initialize = f.request(client, "initialize");
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
  const { broker, child, upstream } = brokerFixture();
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
  assert.deepEqual(upstream, [{jsonrpc:'2.0',method:'thread/automation/suspend',params:{threadId:'owned'}}]);
  assert.equal(broker.threadOwners.get('other'), other);
  broker.detach(other);
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
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
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
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
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
  assert.ok(upstream.some(message => message.method === "thread/dispose" && message.params.threadId === "private-child"));
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
  assert.equal(upstream.at(-1).method, "thread/dispose");
  assert.equal(upstream.at(-1).params.threadId, "late-child");
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
    assert.equal(other.messages.at(-1).error.code, -32041);
  }
  broker.detach(owner);
  for (const method of ["attachment/read", "attachment/read/chunk"]) {
    broker.receive(other, JSON.stringify({ jsonrpc: "2.0", id: 4, method, params: { threadId: "other", path: "/staged/private.txt" } }));
    assert.equal(other.messages.at(-1).error.code, -32041);
  }
  assert.equal(upstream.length, 1);
});

test("explicit self detach acknowledges only after its own cancellation completes and preserves peers", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient(), peer = fakeClient();
  broker.attach(owner); broker.attach(peer);
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
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
  assert.equal(other.messages.at(-1).error.code, -32041);
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
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
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

test("multiplexes request ids, caches initialize, and routes thread requests to their owner", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  broker.attach(first);
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  assert.equal(upstream.length, 1);
  const initializeId = upstream[0].id;
  respond({
    jsonrpc: "2.0",
    id: initializeId,
    result: { capabilities: { experimental: { residentThreads: true } } },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.reusable, true);
  assert.equal(first.messages[0].id, 1);

  const second = fakeClient();
  broker.attach(second);
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  assert.equal(upstream.length, 1, "cached initialize must not reach app-server twice");
  assert.equal(second.messages[0].id, 1);

  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId: "thread-a" } }));
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId: "thread-b" } }));
  assert.notEqual(upstream[1].id, upstream[2].id);
  respond({ jsonrpc: "2.0", id: upstream[2].id, result: { thread: { id: "thread-b" } } });
  respond({ jsonrpc: "2.0", id: upstream[1].id, result: { thread: { id: "thread-a" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.messages.at(-1).id, 2);
  assert.equal(first.messages.at(-1).result.thread.id, "thread-a");
  assert.equal(second.messages.at(-1).id, 2);
  assert.equal(second.messages.at(-1).result.thread.id, "thread-b");

  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 29, method: "thread/read/indexed", params: { threadId: "thread-a", beforeCursor: "tp1:generation:4" } }));
  assert.equal(upstream.at(-1).method, "thread/read/indexed");
  assert.equal(upstream.at(-1).params.beforeCursor, "tp1:generation:4");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, error: { code: -32041, message: "TRANSCRIPT_CURSOR_STALE" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.messages.at(-1).id, 29);
  assert.equal(second.messages.at(-1).error.code, -32041);
  assert.notEqual(first.messages.at(-1).id, 29);

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 30, method: "thread/goal/get", params: { threadId: "thread-a" },
  }));
  assert.equal(upstream.at(-1).method, "thread/goal/get", "readonly goal lookup may cross owners");
  respond({
    jsonrpc: "2.0",
    id: upstream.at(-1).id,
    result: { threadId: "thread-a", goal: { objective: "shared goal", status: "active" } },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.messages.at(-1).id, 30);
  assert.equal(second.messages.at(-1).result.goal.objective, "shared goal");
  assert.notEqual(first.messages.at(-1).id, 30, "readonly response must return to its requester");
  broker.receive(second, JSON.stringify({jsonrpc:'2.0',id:301,method:'session/modes',params:{threadId:'thread-a'}}));
  assert.equal(upstream.at(-1).method, 'session/modes', 'readonly mode inspection may cross owners');
  respond({jsonrpc:'2.0',id:upstream.at(-1).id,result:{sessionMode:'orchestrate'}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.messages.at(-1).id, 301);

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 32, method: "thread/goal/history", params: { threadId: "thread-a" },
  }));
  assert.equal(upstream.at(-1).method, "thread/goal/history", "readonly goal history may cross owners");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { threadId: "thread-a", goals: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.messages.at(-1).id, 32);
  assert.deepEqual(second.messages.at(-1).result.goals, []);

  const beforeConflictingResume = upstream.length;
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "thread/resume", params: { threadId: "thread-a" } }));
  assert.equal(upstream.length, beforeConflictingResume, "conflicting resume must not reach app-server");
  assert.equal(second.messages.at(-1).error.code, -32023);
  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0",
    id: 31,
    method: "device/execute",
    params: { command_key: "turn_file_changes_review", thread_id: "thread-a", args: ["artifact-a"] },
  }));
  assert.equal(upstream.length, beforeConflictingResume, "thread-scoped device command must not cross Gateway owners");
  assert.equal(second.messages.at(-1).error.code, -32023);
  respond({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-a" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.messages.at(-1).method, "turn/completed", "failed resume must not steal thread ownership");
  assert.notEqual(second.messages.at(-1).method, "turn/completed");

  respond({ jsonrpc: "2.0", id: 9001, method: "item/tool/requestApproval", params: { threadId: "thread-b" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.messages.at(-1).method, "item/tool/requestApproval");
  assert.notEqual(first.messages.at(-1).method, "item/tool/requestApproval");

  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 40, method: "device/execute",
    params: { command_key: "turn_file_changes_review", args: ["legacy-a"] },
  }));
  assert.equal(upstream.at(-1).params.threadId, "thread-a", "single-owner legacy command gets an explicit thread");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { success: true } });
  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 41, method: "thread/resume", params: { threadId: "thread-c" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { thread: { id: "thread-c" } } });
  await new Promise(resolve => setImmediate(resolve));
  const beforeAmbiguous = upstream.length;
  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 42, method: "device/execute",
    params: { command_key: "turn_file_changes_review", args: ["ambiguous"] },
  }));
  assert.equal(upstream.length, beforeAmbiguous);
  assert.equal(first.messages.at(-1).error.code, -32602);

  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "thread/delete", params: { threadId: "thread-a" } }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { threadId: "thread-a", deleted: true } });
  await new Promise(resolve => setImmediate(resolve));
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 5, method: "thread/resume", params: { threadId: "thread-a" } }));
  assert.equal(upstream.at(-1).method, "thread/resume", "successful delete must release the Gateway owner");
});

test("reports a successful workspace removal to the Gateway host after responding", async () => {
  const removed = [];
  const { broker, upstream, respond } = brokerFixture({
    onWorkspaceRemoved: params => removed.push(params),
  });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0",
    id: 17,
    method: "runtime.workspaces.remove",
    params: { workspacePath: "/workspace/removed", projectKey: "removed" },
  }));

  respond({ jsonrpc: "2.0", id: upstream[0].id, result: { accepted: true } });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(client.messages, [{
    jsonrpc: "2.0",
    id: 17,
    result: { accepted: true },
  }]);
  assert.deepEqual(removed, [{ workspacePath: "/workspace/removed", projectKey: "removed" }]);
});

test("does not report a rejected workspace removal to the Gateway host", async () => {
  const removed = [];
  const { broker, upstream, respond } = brokerFixture({
    onWorkspaceRemoved: params => removed.push(params),
  });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0",
    id: 18,
    method: "runtime.workspaces.remove",
    params: { workspacePath: "/workspace/retained" },
  }));

  respond({
    jsonrpc: "2.0",
    id: upstream[0].id,
    error: { code: -32000, message: "remove failed" },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(removed, []);
});

test("reserves a thread owner while the first resume is still in flight", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);

  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "thread/resume", params: { threadId: "thread-shared" },
  }));
  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId: "thread-shared" },
  }));

  assert.equal(upstream.length, 1, "a competing resume must not reach the shared app-server");
  assert.equal(second.messages.at(-1).error.code, -32023);

  respond({ jsonrpc: "2.0", id: upstream[0].id, error: { code: -32022, message: "not found" } });
  await new Promise(resolve => setImmediate(resolve));
  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "thread/resume", params: { threadId: "thread-shared" },
  }));
  assert.equal(upstream.length, 2, "a failed resume must release its in-flight ownership claim");
});

test("drops cross-client thread notifications without forwarding them", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const intruder = fakeClient();
  broker.attach(owner);
  broker.attach(intruder);

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "thread/resume", params: { threadId: "thread-owned" },
  }));
  respond({
    jsonrpc: "2.0", id: upstream[0].id, result: { thread: { id: "thread-owned" } },
  });
  await new Promise(resolve => setImmediate(resolve));

  const before = upstream.length;
  broker.receive(intruder, JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/interrupt",
    params: { threadId: "thread-owned", turnId: "turn-owned" },
  }));

  assert.equal(upstream.length, before, "cross-owner notification must not reach app-server");
});

test("drops request-style notifications before they can create orphan resources", () => {
  const { broker, upstream } = brokerFixture();
  const client = fakeClient();
  broker.attach(client);

  for (const [method, params] of [
    ["thread/start", {}],
    ["terminal/start", {}],
    ["browser/start", {}],
    ["attachment/save", { name: "orphan.txt" }],
  ]) {
    broker.receive(client, JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  assert.deepEqual(upstream, [], "request-style notifications must not reach app-server");
});

test("owns chunked attachment uploads and cleans the finished path on disconnect", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const intruder = fakeClient();
  broker.attach(owner);
  broker.attach(intruder);

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/upload/start", params: { filename: "large.bin", size: 300000 },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { upload_id: "upload-owned" } });

  const beforeIntruder = upstream.length;
  broker.receive(intruder, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "attachment/upload/chunk", params: { upload_id: "upload-owned", index: 0, content_base64: "AAAA" },
  }));
  assert.equal(upstream.length, beforeIntruder, "cross-client chunks must not reach app-server");
  assert.equal(intruder.messages.at(-1).error.code, -32041);

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "attachment/upload/finish", params: { upload_id: "upload-owned" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { path: "/attachments/large.bin" } });
  broker.detach(owner);
  assert.deepEqual(upstream.at(-1), {
    jsonrpc: "2.0", method: "attachment/delete", params: { path: "/attachments/large.bin" },
  });
});

test("uses the canonical upload id even when a chunk carries a forged path", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const intruder = fakeClient();
  broker.attach(owner);
  broker.attach(intruder);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/upload/start", params: { filename: "large.bin", size: 4 },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { upload_id: "private-upload" } });

  const before = upstream.length;
  broker.receive(intruder, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "attachment/upload/chunk",
    params: { upload_id: "private-upload", path: "/forged/unowned", terminalId: "forged-terminal", sessionId: "forged-browser", index: 0, content_base64: "AAAA" },
  }));
  assert.equal(upstream.length, before);
  assert.equal(intruder.messages.at(-1).error.code, -32041);
});

test("rejects turn input that references another client's staged attachment", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const intruder = fakeClient();
  broker.attach(owner);
  broker.attach(intruder);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/save", params: { filename: "secret.txt", content_base64: "c2VjcmV0" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { path: "/attachments/private-secret.txt" } });

  const before = upstream.length;
  broker.receive(intruder, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "turn/start",
    params: {
      threadId: "intruder-thread",
      input: [{ type: "text", text: '<kcoder_attachments version="1">\n{"filename":"secret.txt","path":"/attachments/private-secret.txt"}\n</kcoder_attachments>' }],
    },
  }));
  assert.equal(upstream.length, before);
  assert.equal(intruder.messages.at(-1).error.code, -32041);
});

test("retains queued attachments across disconnect and lets the next client claim them", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const intruder = fakeClient();
  broker.attach(owner);
  broker.attach(intruder);

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/save", params: { filename: "queued.png", content_base64: "AAAA" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { path: "/attachments/queued.png" } });

  const beforeRetain = upstream.length;
  broker.receive(intruder, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "gateway/attachments/retain", params: { paths: ["/attachments/queued.png"] },
  }));
  assert.equal(upstream.length, beforeRetain, "Gateway-only retain must not reach app-server");
  assert.equal(intruder.messages.at(-1).error.code, -32041);

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "gateway/attachments/retain", params: { paths: ["/attachments/queued.png"] },
  }));
  assert.deepEqual(owner.messages.at(-1).result, {
    retained: true,
    paths: ["/attachments/queued.png"],
  });
  broker.detach(owner);
  assert.equal(upstream.some(message => message.method === "attachment/delete"), false,
    "a queued attachment must survive its Gateway owner disconnecting");

  const nextClient = fakeClient();
  broker.attach(nextClient);
  broker.receive(nextClient, JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "turn/start",
    params: {
      threadId: "thread-restored",
      input: [{
        type: "text",
        text: '<kcoder_attachments version="1">\n{"filename":"queued.png","path":"/attachments/queued.png"}\n</kcoder_attachments>',
      }],
    },
  }));
  assert.equal(upstream.at(-1).method, "turn/start");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { turn: { id: "turn-restored" } } });
  await new Promise(resolve => setImmediate(resolve));

  broker.receive(nextClient, JSON.stringify({
    jsonrpc: "2.0", id: 5, method: "attachment/delete", params: { path: "/attachments/queued.png" },
  }));
  assert.equal(upstream.at(-1).method, "attachment/delete", "explicit queue cleanup still reaches app-server");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { deleted: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.persistentResources.has("attachment\0/attachments/queued.png"), false);
});

test("rejects malformed or partially foreign attachment retain batches atomically", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  broker.attach(owner);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/save", params: { filename: "owned.png", content_base64: "AAAA" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { path: "/attachments/owned.png" } });

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "gateway/attachments/retain",
    params: { paths: ["/attachments/owned.png", "/attachments/missing.png"] },
  }));
  assert.equal(owner.messages.at(-1).error.code, -32041);
  assert.equal(broker.persistentResources.has("attachment\0/attachments/owned.png"), false);

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "gateway/attachments/retain", params: { paths: [] },
  }));
  assert.equal(owner.messages.at(-1).error.code, -32602);
});

test("mirrors the server envelope parser when JSON contains a closing-tag string", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const intruder = fakeClient();
  broker.attach(owner);
  broker.attach(intruder);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/save", params: { filename: "secret.txt", content_base64: "c2VjcmV0" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { path: "/attachments/tag-secret.txt" } });

  const record = JSON.stringify({ note: "</kcoder_attachments>", filename: "secret.txt", path: "/attachments/tag-secret.txt" });
  const before = upstream.length;
  broker.receive(intruder, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "turn/start",
    params: { threadId: "intruder-thread", input: [{ type: "text", text: `prompt\n<kcoder_attachments version="1">\n${record}\n</kcoder_attachments>` }] },
  }));
  assert.equal(upstream.length, before);
  assert.equal(intruder.messages.at(-1).error.code, -32041);
});

test("releases upload ownership after a failed finish consumes server upload state", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const nextClient = fakeClient();
  broker.attach(owner);
  broker.attach(nextClient);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/upload/start", params: { filename: "partial.bin", size: 8 },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { upload_id: "failed-upload" } });
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "attachment/upload/finish", params: { upload_id: "failed-upload" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, error: { code: -32602, message: "size mismatch" } });

  const before = upstream.length;
  broker.receive(nextClient, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "attachment/upload/chunk",
    params: { upload_id: "failed-upload", index: 0, content_base64: "AAAA" },
  }));
  assert.equal(upstream.length, before + 1, "failed finish must not leak a stale owner entry");
});

test("compensates successful thread and resource creation responses after owner disconnect", async () => {
  const cases = [
    {
      method: "thread/start",
      params: {},
      result: { thread: { id: "thread-orphan" } },
      cleanup: { method: "thread/delete", params: { threadId: "thread-orphan" } },
    },
    {
      method: "thread/fork",
      params: { threadId: "thread-source", lastTurnId: "turn-1" },
      result: { thread: { id: "thread-fork-orphan" } },
      cleanup: { method: "thread/delete", params: { threadId: "thread-fork-orphan" } },
    },
    {
      method: "terminal/start",
      params: {},
      result: { session_id: "terminal-orphan" },
      cleanup: { method: "terminal/close", params: { session_id: "terminal-orphan" } },
    },
    {
      method: "browser/start",
      channel: "browser",
      params: {},
      result: { session: { id: "browser-orphan" } },
      cleanup: { method: "browser/close", params: { session_id: "browser-orphan" } },
    },
    {
      method: "attachment/save",
      params: {},
      result: { path: "/attachments/orphan.png" },
      cleanup: { method: "attachment/delete", params: { path: "/attachments/orphan.png" } },
    },
  ];

  for (const testCase of cases) {
    const { broker, upstream, respond } = brokerFixture();
    const client = fakeClient(testCase.channel);
    broker.attach(client);
    broker.receive(client, JSON.stringify({
      jsonrpc: "2.0", id: 1, method: testCase.method, params: testCase.params,
    }));
    const requestId = upstream[0].id;

    broker.detach(client);
    assert.equal(broker.pending.has(requestId), true, `${testCase.method} must leave a tombstone`);
    respond({ jsonrpc: "2.0", id: requestId, result: testCase.result });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(upstream.at(-1), { jsonrpc: "2.0", ...testCase.cleanup });
    assert.equal(broker.pending.has(requestId), false);
    assert.equal(broker.threadOwners.size, 0);
    assert.equal(broker.resourceOwners.size, 0);
    assert.deepEqual(client.messages, []);
  }
});

test("fans out one concurrent initialize and only broadcasts workspace-level notifications", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }));
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 8, method: "initialize", params: {} }));
  assert.equal(upstream.length, 1);
  respond({ jsonrpc: "2.0", id: upstream[0].id, result: { capabilities: { experimental: { residentThreads: true } } } });
  respond({ jsonrpc: "2.0", method: "runtime/workspaceChanged", params: { workspacePath: "/workspace" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.messages[0].id, 7);
  assert.equal(second.messages[0].id, 8);
  assert.equal(first.messages.at(-1).method, "runtime/workspaceChanged");
  assert.equal(second.messages.at(-1).method, "runtime/workspaceChanged");
});

test("keeps an in-flight initialize alive when its originating client disconnects", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  broker.attach(first);
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }));
  assert.equal(upstream.length, 1);
  broker.detach(first);

  const second = fakeClient();
  broker.attach(second);
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 8, method: "initialize", params: {} }));
  assert.equal(upstream.length, 1, "the live waiter must share the original upstream initialize");
  respond({
    jsonrpc: "2.0",
    id: upstream[0].id,
    result: { capabilities: { experimental: { residentThreads: true } } },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(first.messages, [], "the disconnected initialize owner must not receive a response");
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].id, 8);
  assert.equal(broker.reusable, true);
});

test("fails closed when an interaction has no live thread owner", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const client = fakeClient();
  broker.attach(client);
  respond({ jsonrpc: "2.0", id: 9010, method: "item/tool/requestApproval", params: { threadId: "orphan" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(upstream.at(-1), {
    jsonrpc: "2.0",
    id: 9010,
    error: { code: -32040, message: "app-server request has no connected owner: item/tool/requestApproval" },
  });
  assert.throws(
    () => broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1_000_000, result: { answers: {} } })),
    /unsolicited app-server response/,
  );
});

test("isolates resource sessions and releases only client-owned resources on disconnect", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);

  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "terminal/start", params: {} }));
  respond({ jsonrpc: "2.0", id: upstream[0].id, result: { session_id: "terminal-a" } });
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "attachment/save", params: { threadId: "thread-a" } }));
  respond({ jsonrpc: "2.0", id: upstream[1].id, result: { path: "/attachments/a.png" } });
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 20, method: "attachment/save", params: { threadId: "thread-a" } }));
  respond({ jsonrpc: "2.0", id: upstream[2].id, result: { path: "/attachments/unsent.png" } });
  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0",
    id: 21,
    method: "turn/start",
    params: { threadId: "thread-a", input: [{ type: "text", text: '<kcoder_attachments version="1">\n{"path":"/attachments/a.png","filename":"a.png"}\n</kcoder_attachments>' }] },
  }));
  respond({ jsonrpc: "2.0", id: upstream[3].id, result: { turn: { id: "turn-a" } } });
  await new Promise(resolve => setImmediate(resolve));

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "terminal/write",
    params: { session_id: "terminal-a", data: "not-owned" },
  }));
  assert.equal(second.messages.at(-1).error.code, -32041);
  assert.equal(upstream.length, 4, "cross-client resource access must not reach app-server");

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "attachment/read",
    params: { threadId: "thread-a", path: "/attachments/a.png" },
  }));
  assert.equal(upstream.at(-1).method, "attachment/read", "persistent attachments are cross-client readable");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { data: "image" } });
  await new Promise(resolve => setImmediate(resolve));

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    method: "attachment/read/chunk",
    params: { threadId: "thread-a", path: "/attachments/a.png", offset: 0, length: 1024 },
  }));
  assert.equal(upstream.at(-1).method, "attachment/read/chunk", "persistent attachment chunks are cross-client readable");
  respond({
    jsonrpc: "2.0",
    id: upstream.at(-1).id,
    result: { contentBase64: "aW1hZ2U=", offset: 0, size: 5, totalSize: 5, eof: true },
  });
  await new Promise(resolve => setImmediate(resolve));

  respond({ jsonrpc: "2.0", method: "terminal/output", params: { session_id: "terminal-a", data: "owned" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.messages.at(-1).method, "terminal/output");
  assert.notEqual(second.messages.at(-1).method, "terminal/output");

  broker.detach(first);
  assert.equal(upstream.some(message => message.method === "terminal/close"), false,
    "live terminals survive a Gateway client disconnect");
  assert.equal(broker.liveTerminals.has("terminal-a"), true);
  assert.deepEqual(upstream.at(-1),
    { jsonrpc: "2.0", method: "attachment/delete", params: { path: "/attachments/unsent.png" } });
  assert.equal(upstream.some(message => message.method === "attachment/delete" && message.params?.path === "/attachments/a.png"), false,
    "attachments accepted by a turn are thread-persistent and survive owner disconnect");
});

test("does not resurrect a short-lived terminal whose exit precedes start response", () => {
  const { broker, upstream, respond } = brokerFixture();
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "terminal/start", params: {} }));
  const startId = upstream.at(-1).id;
  respond({ jsonrpc: "2.0", method: "terminal/exit", params: { session_id: "terminal-short", sequence: 1, exit_code: 0 } });
  respond({ jsonrpc: "2.0", id: startId, result: { session_id: "terminal-short", cwd: "/workspace" } });
  assert.equal(broker.hasLiveTerminals, false);
});

test("does not resurrect a terminal whose exit precedes attach response", () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "terminal/start", params: {} }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { session_id: "terminal-attach-exit", cwd: "/workspace" } });
  broker.detach(first);
  broker.attach(second);
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "terminal/attach", params: { session_id: "terminal-attach-exit" } }));
  const attachId = upstream.at(-1).id;
  respond({ jsonrpc: "2.0", method: "terminal/exit", params: { session_id: "terminal-attach-exit", sequence: 2, exit_code: 0 } });
  respond({ jsonrpc: "2.0", id: attachId, result: { session_id: "terminal-attach-exit", cwd: "/workspace", transcript: "", through_sequence: 1 } });
  assert.equal(broker.hasLiveTerminals, false);
});

test("keeps a live terminal resident and transfers it through an exclusive attach claim", async () => {
  const idleChanges = [];
  const { broker, upstream, respond } = brokerFixture({
    onIdleStateChange: changed => idleChanges.push(changed.hasLiveTerminals),
  });
  const original = fakeClient();
  const attaching = fakeClient();
  const competitor = fakeClient();
  broker.attach(original);
  broker.attach(attaching);
  broker.attach(competitor);

  broker.receive(original, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "terminal/start", params: {},
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { session_id: "resident-terminal" } });
  await new Promise(resolve => setImmediate(resolve));
  broker.detach(original);
  assert.equal(upstream.some(message => message.method === "terminal/close"), false);
  assert.equal(broker.hasLiveTerminals, true);

  const beforeUnattachedWrite = upstream.length;
  broker.receive(competitor, JSON.stringify({
    jsonrpc: "2.0", id: 20, method: "terminal/write",
    params: { session_id: "resident-terminal", data: "must not pass" },
  }));
  assert.equal(upstream.length, beforeUnattachedWrite, "an unowned resident terminal requires attach first");
  assert.equal(competitor.messages.at(-1).error.code, -32041);

  broker.receive(attaching, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "terminal/attach",
    params: { session_id: "resident-terminal", terminalId: "forged-terminal" },
  }));
  const attachRequest = upstream.at(-1);
  assert.equal(broker.terminalClaims.get("resident-terminal"), attaching,
    "canonical session_id must be claimed before forwarding attach");

  respond({
    jsonrpc: "2.0", method: "terminal/output",
    params: { session_id: "resident-terminal", data: "during attach" },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attaching.messages.at(-1).method, "terminal/output",
    "terminal output must follow the in-flight attach claim");

  const beforeCompetingAttach = upstream.length;
  broker.receive(competitor, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "terminal/attach", params: { session_id: "resident-terminal" },
  }));
  assert.equal(upstream.length, beforeCompetingAttach);
  assert.equal(competitor.messages.at(-1).error.code, -32041);

  const beforeDuplicateAttach = upstream.length;
  broker.receive(attaching, JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "terminal/attach", params: { session_id: "resident-terminal" },
  }));
  assert.equal(upstream.length, beforeDuplicateAttach, "even the claimant cannot overlap a second attach");
  assert.equal(attaching.messages.at(-1).error.code, -32041);

  respond({
    jsonrpc: "2.0", id: attachRequest.id,
    result: { session_id: "resident-terminal", transcript: "during attach" },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.terminalClaims.has("resident-terminal"), false);
  assert.equal(broker.resourceOwners.get("terminal\0resident-terminal"), attaching,
    "a successful attach must promote the claim to owner");
  assert.deepEqual(idleChanges, [true]);
});

test("releases failed and disconnected terminal attach claims", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);

  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "terminal/attach", params: { session_id: "missing-terminal" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, error: { code: -32004, message: "not found" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.terminalClaims.has("missing-terminal"), false);

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "terminal/attach", params: { session_id: "missing-terminal" },
  }));
  assert.equal(upstream.at(-1).method, "terminal/attach", "a failed attach must release its claim");
  broker.detach(second);
  assert.equal(broker.terminalClaims.has("missing-terminal"), false,
    "disconnecting during attach must release its claim");
  assert.equal(broker.pending.has(upstream.at(-1).id), false);
});

test("delivers terminal exit before clearing residency and reschedules idle eligibility", async () => {
  const idleChanges = [];
  const { broker, upstream, respond } = brokerFixture({
    onIdleStateChange: changed => idleChanges.push(changed.hasLiveTerminals),
  });
  const client = fakeClient();
  let liveWhileDelivered = false;
  client.send = function send(message) {
    if (message.method === "terminal/exit") liveWhileDelivered = broker.liveTerminals.has("terminal-exit");
    this.messages.push(message);
    return true;
  };
  broker.attach(client);
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "terminal/start", params: {},
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { session_id: "terminal-exit" } });
  await new Promise(resolve => setImmediate(resolve));
  respond({
    jsonrpc: "2.0", method: "terminal/exit",
    params: { session_id: "terminal-exit", exit_code: 0 },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(liveWhileDelivered, true, "exit must be delivered before terminal state is cleared");
  assert.equal(broker.hasLiveTerminals, false);
  assert.equal(broker.resourceOwners.has("terminal\0terminal-exit"), false);
  assert.deepEqual(idleChanges, [true, false]);
});

test("a successful terminal close clears residency and reschedules idle eligibility", async () => {
  const idleChanges = [];
  const { broker, upstream, respond } = brokerFixture({
    onIdleStateChange: changed => idleChanges.push(changed.hasLiveTerminals),
  });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "terminal/start", params: {},
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { session_id: "terminal-close" } });
  await new Promise(resolve => setImmediate(resolve));
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "terminal/close", params: { session_id: "terminal-close" },
  }));
  const closeRequestId = upstream.at(-1).id;
  broker.detach(client);
  assert.equal(broker.pending.has(closeRequestId), true,
    "an in-flight close survives disconnect so its response can clear residency");
  respond({ jsonrpc: "2.0", id: closeRequestId, result: { closed: true } });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(broker.hasLiveTerminals, false);
  assert.equal(broker.pending.has(closeRequestId), false);
  assert.deepEqual(idleChanges, [true, false]);
});

test("interrupts only the disconnecting client's active turns and clears terminal turns", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);

  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "thread/resume", params: { threadId: "thread-a" },
  }));
  respond({ jsonrpc: "2.0", id: upstream[0].id, result: { thread: { id: "thread-a" } } });
  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId: "thread-b" },
  }));
  respond({ jsonrpc: "2.0", id: upstream[1].id, result: { thread: { id: "thread-b" } } });
  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "thread-a", input: [] },
  }));
  respond({ jsonrpc: "2.0", id: upstream[2].id, result: { turn: { id: "turn-a", threadId: "thread-a" } } });
  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "turn/start", params: { threadId: "thread-b", input: [] },
  }));
  respond({ jsonrpc: "2.0", id: upstream[3].id, result: { turn: { id: "turn-b", threadId: "thread-b" } } });
  await new Promise(resolve => setImmediate(resolve));

  respond({
    jsonrpc: "2.0", method: "turn/completed",
    params: { threadId: "thread-a", turnId: "turn-a", turn: { id: "turn-a", status: "completed" } },
  });
  await new Promise(resolve => setImmediate(resolve));
  const beforeFirstDetach = upstream.length;
  broker.detach(first);
  assert.equal(upstream.length, beforeFirstDetach, "a terminal turn must not be interrupted on detach");

  respond({
    jsonrpc: "2.0", method: "turn/completed",
    params: { threadId: "thread-b", turnId: "stale-turn", turn: { id: "stale-turn", status: "completed" } },
  });
  await new Promise(resolve => setImmediate(resolve));
  const beforeSecondDetach = upstream.length;
  broker.detach(second);
  assert.deepEqual(upstream.slice(beforeSecondDetach), [{
    jsonrpc: "2.0",
    method: "turn/interrupt",
    params: { threadId: "thread-b", turnId: "turn-b" },
  }]);
});

test("interrupts an in-flight turn/start when its client disconnects before the response", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);

  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "thread/resume", params: { threadId: "thread-a" },
  }));
  respond({ jsonrpc: "2.0", id: upstream[0].id, result: { thread: { id: "thread-a" } } });
  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId: "thread-b" },
  }));
  respond({ jsonrpc: "2.0", id: upstream[1].id, result: { thread: { id: "thread-b" } } });
  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "thread-a", input: [] },
  }));
  const firstStartUpstreamId = upstream[2].id;
  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "turn/start", params: { threadId: "thread-b", input: [] },
  }));
  const secondStartUpstreamId = upstream[3].id;

  broker.detach(first);
  assert.equal(upstream.length, 4, "the real protocol needs the turnId before interrupting");
  assert.equal(broker.pending.has(firstStartUpstreamId), true,
    "the detached turn/start must remain as a tombstone until its response supplies turnId");
  assert.equal(broker.pending.has(secondStartUpstreamId), true,
    "disconnecting one client must preserve another client's pending turn/start");

  respond({
    jsonrpc: "2.0", id: firstStartUpstreamId,
    result: { turn: { id: "turn-a", threadId: "thread-a" } },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(upstream[4], {
    jsonrpc: "2.0",
    method: "turn/interrupt",
    params: { threadId: "thread-a", turnId: "turn-a" },
  });
  assert.equal(broker.pending.has(firstStartUpstreamId), false);
  respond({
    jsonrpc: "2.0", id: secondStartUpstreamId,
    result: { turn: { id: "turn-b", threadId: "thread-b" } },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.activeTurns.has("thread-a"), false, "a late response must not revive the detached turn");
  assert.equal(broker.activeTurns.get("thread-b")?.turnId, "turn-b");
  assert.deepEqual(first.messages.filter(message => message.id === 3), []);

  const beforeSecondDetach = upstream.length;
  broker.detach(second);
  assert.deepEqual(upstream.slice(beforeSecondDetach), [{
    jsonrpc: "2.0",
    method: "turn/interrupt",
    params: { threadId: "thread-b", turnId: "turn-b" },
  }]);
});

test("drains a detached thread before allowing a reconnecting client to resume it", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);

  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "thread/resume", params: { threadId: "thread-race" },
  }));
  respond({ jsonrpc: "2.0", id: upstream[0].id, result: { thread: { id: "thread-race" } } });
  broker.receive(first, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId: "thread-race", input: [] },
  }));
  respond({ jsonrpc: "2.0", id: upstream[1].id, result: { turn: { id: "turn-race", threadId: "thread-race" } } });

  broker.detach(first);
  assert.deepEqual(upstream[2], {
    jsonrpc: "2.0",
    method: "turn/interrupt",
    params: { threadId: "thread-race", turnId: "turn-race" },
  });

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "thread/resume", params: { threadId: "thread-race" },
  }));
  assert.equal(upstream.length, 3, "reconnect must wait for the interrupt terminal event");
  assert.deepEqual(second.messages, []);

  respond({
    jsonrpc: "2.0", method: "turn/interrupted",
    params: { threadId: "thread-race", turnId: "turn-race" },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstream[3].method, "thread/resume");
  respond({ jsonrpc: "2.0", id: upstream[3].id, result: { thread: { id: "thread-race" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.messages.at(-1).id, 3);
  assert.equal(second.messages.at(-1).result.thread.id, "thread-race");
});

test("clears failed and interrupted turns without crossing client owners", async () => {
  for (const terminalMethod of ["turn/failed", "turn/interrupted"]) {
    const { broker, upstream, respond } = brokerFixture();
    const client = fakeClient();
    broker.attach(client);
    broker.receive(client, JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "thread/resume", params: { threadId: "thread-a" },
    }));
    respond({ jsonrpc: "2.0", id: upstream[0].id, result: { thread: { id: "thread-a" } } });
    broker.receive(client, JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId: "thread-a", input: [] },
    }));
    respond({ jsonrpc: "2.0", id: upstream[1].id, result: { turn: { id: "turn-a" } } });
    await new Promise(resolve => setImmediate(resolve));
    respond({ jsonrpc: "2.0", method: terminalMethod, params: { threadId: "thread-a", turnId: "turn-a" } });
    await new Promise(resolve => setImmediate(resolve));
    const beforeDetach = upstream.length;
    broker.detach(client);
    assert.equal(upstream.length, beforeDetach, `${terminalMethod} must clear the active turn`);
  }
});

test("does not multiplex clients when health reports a legacy app-server", () => {
  const child = fakeChild();
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: "legacy",
    residentThreads: false,
  });
  const client = fakeClient();
  assert.equal(broker.acceptsClient, true);
  broker.attach(client);
  assert.equal(broker.acceptsClient, false);
  assert.equal(broker.reusable, false);
});

test("returns malformed JSON errors only to the originating client", () => {
  const { broker, upstream } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);

  broker.receive(first, "{not-json");
  assert.deepEqual(first.messages, [{
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  }]);
  assert.deepEqual(second.messages, []);
  assert.deepEqual(upstream, []);
});

test("unattributed upstream parse errors close the corrupted transport instead of hanging requests", () => {
  const { broker, respond } = brokerFixture();
  const client = fakeClient();
  let closed = false;
  client.close = () => { closed = true; };
  broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'expected value at line 1 column 1' } });
  assert.equal(closed, true);
  assert.equal(broker.pending.size, 0);
  assert.ok(client.messages.some(message => message.method === 'server/transportError'));
});

test("oversized upstream frames keep the shared pool alive", async t => {
  const loggedDrops = t.mock.method(console, 'error', () => {});
  const { broker, child, upstream, respond } = brokerFixture({ maxMessageBytes: 128 });
  const client = fakeClient();
  let closed = false;
  client.close = () => { closed = true; };
  broker.attach(client);

  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "thread/list", params: {},
  }));
  const ownedId = upstream.at(-1).id;
  const oversized = JSON.stringify({ jsonrpc: "2.0", id: ownedId, result: { pad: "x".repeat(200) } });
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "server/status", params: { online: true } });
  assert.ok(Buffer.byteLength(oversized) > 128, "fixture must exceed the frame limit");
  assert.ok(Buffer.byteLength(notification) <= 128, "the following frame must still fit the limit");
  // One chunk carrying an oversized response plus an ordinary frame: only the
  // oversized line may be dropped, and the decoder must resync for the next one.
  child.stdout.write(`${oversized}\n${notification}\n`);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(broker.closed, false);
  assert.equal(closed, false);
  assert.equal(client.messages.some(message => message.method === "server/transportError"), false);
  assert.equal(broker.pending.size, 0, "the owning request must be settled, not left hanging");
  assert.deepEqual(client.messages.filter(message => message.error?.code === -32045), [{
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32045, message: "app-server response exceeded the frame limit" },
  }]);
  assert.equal(client.messages.some(message => message.method === "server/status"), true);

  // Lines that cannot be attributed to a pending request (plain text without an
  // id, and an id nobody waits for) are only logged: one bad frame never owns
  // the pool shared by every client.
  const unowned = JSON.stringify({ jsonrpc: "2.0", id: 424242, result: { pad: "y".repeat(200) } });
  child.stdout.write(`${"z".repeat(200)}\n${unowned}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loggedDrops.mock.calls.length, 2);
  assert.equal(broker.closed, false);
  assert.equal(closed, false);
  assert.equal(client.messages.filter(message => message.error?.code === -32045).length, 1);

  // The shared pool still serves new requests after both drops.
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "thread/list", params: {},
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { threads: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.messages.at(-1), { jsonrpc: "2.0", id: 2, result: { threads: [] } });
});

test("app-server close clears owned interactions and resources before socket detach", async () => {
  let closeCount = 0;
  const { broker, upstream, respond } = brokerFixture({ onClose: () => { closeCount += 1; } });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "thread/resume", params: { threadId: "thread-a" },
  }));
  respond({ jsonrpc: "2.0", id: upstream[0].id, result: { thread: { id: "thread-a" } } });
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "terminal/start", params: {} }));
  respond({ jsonrpc: "2.0", id: upstream[1].id, result: { session_id: "terminal-a" } });
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "attachment/save", params: {} }));
  respond({ jsonrpc: "2.0", id: upstream[2].id, result: { path: "/attachments/a.png" } });
  respond({
    jsonrpc: "2.0", id: 9001, method: "item/tool/requestApproval", params: { threadId: "thread-a" },
  });
  await new Promise(resolve => setImmediate(resolve));

  broker.child.stdin.destroy();
  broker.child.emit("close", 1, null);
  assert.doesNotThrow(() => broker.detach(client));
  broker.child.emit("close", 1, null);
  assert.equal(closeCount, 1);
  assert.equal(broker.serverRequests.size, 0);
  assert.equal(broker.resourceOwners.size, 0);
  assert.equal(broker.persistentResources.size, 0);
});

test("transport failure closes the broker and clears initialize and turn state", async () => {
  let closeCount = 0;
  const { broker, upstream, respond } = brokerFixture({ onClose: () => { closeCount += 1; } });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  broker.receive(client, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId: "thread-a" },
  }));
  respond({ jsonrpc: "2.0", id: upstream[1].id, result: { thread: { id: "thread-a" } } });
  broker.fail(new Error("broken transport"));

  assert.equal(broker.closed, true);
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.initializePending, null);
  assert.equal(broker.initializeWaiters.length, 0);
  assert.equal(broker.activeTurns.size, 0);
  assert.equal(closeCount, 1);
  broker.child.emit("close", 1, null);
  assert.equal(closeCount, 1);
});

test("releases workspace stdout backpressure when the slow client disconnects", async () => {
  const { broker, respond } = brokerFixture();
  const slow = fakeClient();
  const healthy = fakeClient();
  broker.attach(slow);
  broker.attach(healthy);
  broker.blockStdout(slow);
  assert.equal(broker.child.stdout.isPaused(), true);

  broker.detach(slow);
  assert.equal(broker.child.stdout.isPaused(), false);
  respond({ jsonrpc: "2.0", method: "runtime/workspaceChanged", params: { workspacePath: "/workspace" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(healthy.messages.at(-1).method, "runtime/workspaceChanged");
});

test("MCP authorization belongs to its Gateway client even with a shared app-server", () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const owner = fakeClient();
  const other = fakeClient();
  broker.attach(owner);
  broker.attach(other);
  const send = (client, id, method, params = {}) => broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  send(owner, 1, "mcp/login", { server: { name: "oauth" } });
  respond({ id: upstream.at(-1).id, result: { flowId: "owned-flow", authorizationUrl: "https://auth.invalid" } });
  const before = upstream.length;
  send(other, 2, "mcp/callback", { flowId: "owned-flow", callbackUrl: "http://127.0.0.1/callback?code=secret" });
  send(other, 3, "mcp/cancel", { flowId: "owned-flow" });
  assert.equal(upstream.length, before);
  assert.equal(other.messages.filter(message => message.error).length, 2);
  send(owner, 4, "mcp/callback", { flowId: "owned-flow", callbackUrl: "http://127.0.0.1/callback" });
  assert.equal(upstream.at(-1).method, "mcp/callback");
  respond({ id: upstream.at(-1).id, result: { authorized: true } });
  assert.equal(broker.mcpFlowOwners.size, 0);
});

test("MCP pending authorizations are cancelled on detach including late login responses", () => {
  for (const late of [false, true]) {
    const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
    const client = fakeClient();
    broker.attach(client);
    broker.receive(client, JSON.stringify({ id: 1, method: "mcp/login", params: { server: { name: "oauth" } } }));
    const loginId = upstream.at(-1).id;
    if (late) broker.detach(client);
    respond({ id: loginId, result: { flowId: "orphan-flow", authorizationUrl: "https://auth.invalid" } });
    if (!late) broker.detach(client);
    const cleanup = upstream.filter(message => message.method === "mcp/cancel");
    assert.equal(cleanup.length, 1);
    assert.deepEqual(cleanup[0].params, { flowId: "orphan-flow" });
    assert.equal(broker.mcpFlowOwners.size, 0);
    respond({ id: cleanup[0].id, result: { cancelled: true } });
    assert.equal(broker.pending.size, 0);
  }
});

test("Gateway browser authorization relays a real HTTP callback only to its originating target", async t => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const owner = fakeClient();
  const observer = fakeClient();
  broker.attach(owner);
  broker.attach(observer);
  owner.initialized = true;
  t.after(() => { broker.detach(owner); broker.detach(observer); });
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 91, method: "gateway/mcp/login",
    params: { server: { name: "target-oauth" } } }));
  const deadline = Date.now() + 2000;
  while (!upstream.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const login = upstream.at(-1);
  assert.equal(login.method, "mcp/login");
  assert.deepEqual(login.params.server, { name: "target-oauth" });
  const redirect = new URL(login.params.redirectUri);
  assert.equal(redirect.hostname, "127.0.0.1");
  const authorization = new URL("https://auth.example.test/authorize");
  authorization.searchParams.set("state", "relay-state");
  authorization.searchParams.set("redirect_uri", redirect.href);
  respond({ id: login.id, result: { flowId: "relay-flow", authorizationUrl: authorization.href } });
  assert.equal(owner.messages.at(-1).id, 91);
  const callback = new URL(redirect);
  callback.searchParams.set("state", "relay-state");
  callback.searchParams.set("code", "private-relay-code");
  const browserResponse = fetch(callback);
  const callbackDeadline = Date.now() + 2000;
  while (upstream.at(-1)?.method !== "mcp/callback" && Date.now() < callbackDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  const forwarded = upstream.at(-1);
  assert.equal(forwarded.method, "mcp/callback");
  assert.deepEqual(forwarded.params, { flowId: "relay-flow", callbackUrl: callback.href });
  respond({ id: forwarded.id, result: { authorized: true } });
  assert.equal((await browserResponse).status, 200);
  assert.deepEqual(owner.messages.at(-1), { jsonrpc: "2.0", method: "mcp/authorizationChanged",
    params: { flowId: "relay-flow", status: "authorized" } });
  assert.equal(observer.messages.length, 0);
  assert.equal(broker.mcpFlowOwners.size, 0);
  assert.equal(broker.mcpOAuth.tickets.size, 0);
  await assert.rejects(fetch(redirect));
});

test("Gateway detach closes the callback port before a late authorization response", async t => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const client = fakeClient();
  broker.attach(client);
  client.initialized = true;
  t.after(() => broker.detach(client));
  broker.receive(client, JSON.stringify({ id: 1, method: "gateway/mcp/login", params: { server: { name: "oauth" } } }));
  const deadline = Date.now() + 2000;
  while (!upstream.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const login = upstream.at(-1);
  broker.detach(client);
  await assert.rejects(fetch(login.params.redirectUri));
  respond({ id: login.id, result: { flowId: "late-relay-flow", authorizationUrl: "https://auth.invalid" } });
  assert.equal(upstream.at(-1).method, "mcp/cancel");
  assert.equal(upstream.at(-1).params.flowId, "late-relay-flow");
  assert.equal(broker.mcpOAuth.tickets.size, 0);
});
