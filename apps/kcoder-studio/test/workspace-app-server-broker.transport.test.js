import { retireRestartScopeAdmissions } from '../src/workspace-broker-release.js';
import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceAppServerBroker } from "../src/workspace-app-server-broker.js";
import { brokerFixture, fakeChild, fakeClient, validInitializeParams } from './workspace-app-server-broker.test-support.js';

// Turn and transport behavior: disconnect interrupts and drains, legacy servers,
// malformed or oversized frames, transport failure, MCP authorization, Wiki
// archives, desktop recovery, initialize negotiation and restart scope.

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
  const interrupt = upstream.at(-1);
  assert.equal(upstream.length, beforeSecondDetach + 1);
  assert.equal(interrupt.jsonrpc, "2.0");
  assert.notEqual(interrupt.id, undefined);
  assert.equal(interrupt.method, "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-b", turnId: "turn-b" });
  assert.equal(broker.pending.get(interrupt.id)?.client, null);
  assert.equal(broker.pending.get(interrupt.id)?.clientId, null);
  const clientMessageCount = second.messages.length;
  respond({ jsonrpc: "2.0", id: interrupt.id, result: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.pending.has(interrupt.id), false);
  assert.equal(second.messages.length, clientMessageCount, "internal cleanup response must not reach a client");
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
  const firstInterrupt = upstream[4];
  assert.equal(firstInterrupt.jsonrpc, "2.0");
  assert.notEqual(firstInterrupt.id, undefined);
  assert.equal(firstInterrupt.method, "turn/interrupt");
  assert.deepEqual(firstInterrupt.params, { threadId: "thread-a", turnId: "turn-a" });
  assert.equal(broker.pending.get(firstInterrupt.id)?.client, null);
  assert.equal(broker.pending.get(firstInterrupt.id)?.clientId, null);
  assert.equal(broker.pending.has(firstStartUpstreamId), false);
  respond({ jsonrpc: "2.0", id: firstInterrupt.id, result: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.pending.has(firstInterrupt.id), false);
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
  const secondInterrupt = upstream.at(-1);
  assert.equal(upstream.length, beforeSecondDetach + 1);
  assert.equal(secondInterrupt.jsonrpc, "2.0");
  assert.notEqual(secondInterrupt.id, undefined);
  assert.equal(secondInterrupt.method, "turn/interrupt");
  assert.deepEqual(secondInterrupt.params, { threadId: "thread-b", turnId: "turn-b" });
  assert.equal(broker.pending.get(secondInterrupt.id)?.client, null);
  respond({ jsonrpc: "2.0", id: secondInterrupt.id, result: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.pending.has(secondInterrupt.id), false);
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
  const interrupt = upstream[2];
  assert.equal(interrupt.jsonrpc, "2.0");
  assert.notEqual(interrupt.id, undefined);
  assert.equal(interrupt.method, "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-race", turnId: "turn-race" });
  assert.equal(broker.pending.get(interrupt.id)?.client, null);

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "thread/resume", params: { threadId: "thread-race" },
  }));
  assert.equal(upstream.length, 3, "reconnect must wait for the interrupt terminal event");
  assert.deepEqual(second.messages, []);
  respond({ jsonrpc: "2.0", id: interrupt.id, result: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.pending.has(interrupt.id), false);

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
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: validInitializeParams() }));
  respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'expected value at line 1 column 1' } });
  assert.equal(closed, true);
  assert.equal(broker.pending.size, 0);
  assert.ok(client.messages.some(message => message.method === 'server/transportError'));
});

test('a dropped notification with a nested ID cannot settle an in-flight async answer', t => {
  t.mock.method(console, 'error', () => {});
  const { broker, child, upstream, respond } = brokerFixture({ maxMessageBytes: 1024, residentThreads: true });
  t.after(() => broker.clearTransientState());
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  const client = fakeClient();
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
  const send = (id, method, params) => {
    broker.receive(client, JSON.stringify({ id, method, params: { threadId: 'thread', ...params } }));
    assert.equal(upstream.at(-1).method, method);
    return upstream.at(-1).id;
  };
  respond({ id: send(1, 'thread/resume'), result: { thread: { id: 'thread' } } });
  const answers = { item: { text: 'Continue' } };
  const answerId = send(2, 'asyncQuestion/answer', { questionId: 'question',
    expectedRevision: 1, submissionId: 'submission', answers });
  respond({ jsonrpc: '2.0', method: 'item/event', params: { id: answerId, text: 'x'.repeat(2048) } });
  assert.equal(broker.pending.has(answerId), true, 'nested notification IDs own no RPC response');
  assert.equal(client.messages.some(message => message.id === 2), false);

  const result = { threadId: 'thread', accepted: true, duplicate: false,
    question: { threadId: 'thread', questionId: 'question', requestId: 'request', sourceTurnId: 'source',
      toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
      questions: [{ id: 'item', header: 'Mode', question: 'Continue?', options: [], multiSelect: false }],
      answer: { submissionId: 'submission', acceptedAtMs: 2, answers } } };
  respond({ jsonrpc: '2.0', id: answerId, result });
  assert.deepEqual(client.messages.at(-1), { jsonrpc: '2.0', id: 2, result });
  assert.equal(broker.pending.has(answerId), false);
  assert.equal(upstream.filter(message => message.method === 'asyncQuestion/answer').length, 1);

  const listId = send(3, 'asyncQuestion/list');
  const oversized = Buffer.from(JSON.stringify({ id: listId, jsonrpc: '2.0',
    result: { threadId: 'thread', questions: [], pad: 'x'.repeat(64 * 1024) } }) + '\n');
  const split = 17;
  child.stdout.write(oversized.subarray(0, split));
  const concat = t.mock.method(Buffer, 'concat');
  child.stdout.write(oversized.subarray(split));
  const copySizes = concat.mock.calls.map(({ arguments: [parts] }) =>
    parts.reduce((bytes, part) => bytes + part.length, 0));
  concat.mock.restore();
  assert.ok(copySizes.every(bytes => bytes <= 4096), 'the dropped response body must not be copied');
  assert.equal(broker.pending.has(listId), false, 'a real oversized response still settles');
  assert.equal(client.messages.at(-1).id, 3);
  assert.equal(client.messages.at(-1).error?.code, -32045);
});

test('async question notifications and oversized read refusals preserve stdout order', t => {
  const { broker, child, upstream, respond } = brokerFixture({ maxMessageBytes: 1024, residentThreads: true });
  t.after(() => broker.clearTransientState());
  broker.initializeResponse = { result: { capabilities: { experimental: { asyncUserQuestionsV1: true } } } };
  const client = fakeClient();
  broker.attach(client);
  Object.assign(client, { initialized: true, gatewaySharedThreadsV1: true, asyncUserQuestionsV1: true });
  broker.receive(client, JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread' } }));
  respond({ id: upstream.at(-1).id, result: { thread: { id: 'thread' } } });
  broker.receive(client, JSON.stringify({ id: 2, method: 'asyncQuestion/list', params: { threadId: 'thread' } }));
  assert.equal(upstream.at(-1).method, 'asyncQuestion/list');
  const change = (questionId) => JSON.stringify({ jsonrpc: '2.0', method: 'asyncQuestion/changed',
    params: { threadId: 'thread', question: { threadId: 'thread', questionId, revision: 1 } } });
  const oversized = JSON.stringify({ jsonrpc: '2.0', id: upstream.at(-1).id,
    result: { threadId: 'thread', questions: [], pad: 'x'.repeat(2048) } });

  child.stdout.write(`${change('before')}\n${oversized.slice(0, 1200)}`);
  child.stdout.write(`${oversized.slice(1200)}\n${change('after')}\n`);
  // Also cover the same sequence when all complete frames arrive in one chunk.
  broker.receive(client, JSON.stringify({ id: 3, method: 'asyncQuestion/list', params: { threadId: 'thread' } }));
  const oversizedAgain = JSON.stringify({ jsonrpc: '2.0', id: upstream.at(-1).id,
    result: { threadId: 'thread', questions: [], pad: 'x'.repeat(2048) } });
  child.stdout.write(`${change('same-chunk-before')}\n${oversizedAgain}\n${change('same-chunk-after')}\n`);

  assert.deepEqual(client.messages.slice(1).map(message => message.error?.code ?? message.params?.question?.questionId),
    ['before', -32045, 'after', 'same-chunk-before', -32045, 'same-chunk-after']);
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
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: validInitializeParams() }));
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
    assert.notEqual(cleanup[0].id, undefined);
    assert.deepEqual(cleanup[0].params, { flowId: "orphan-flow" });
    assert.equal(broker.pending.get(cleanup[0].id)?.client, null);
    assert.equal(broker.pending.get(cleanup[0].id)?.clientId, null);
    assert.equal(broker.pending.get(cleanup[0].id)?.internalRequestTimer.hasRef(), false);
    assert.equal(broker.mcpFlowOwners.size, 0);
    respond({ id: cleanup[0].id, result: { cancelled: true } });
    assert.equal(broker.pending.size, 0);
  }
});

test("detaching a browser settings owner closes only that client's owned browser session", () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient("browser");
  const peer = fakeClient("browser");
  broker.attach(owner);
  broker.attach(peer);
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "browser/start", params: {} }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { session: { id: "browser-owned" } } });
  broker.receive(peer, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "browser/start", params: {} }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { session: { id: "browser-peer" } } });
  owner.messages.length = 0;
  peer.messages.length = 0;

  broker.detach(owner);
  const close = upstream.at(-1);
  assert.notEqual(close.id, undefined);
  assert.equal(close.method, "browser/close");
  assert.deepEqual(close.params, { session_id: "browser-owned" });
  assert.equal(broker.pending.get(close.id)?.client, null);
  assert.equal(broker.pending.get(close.id)?.clientId, null);
  assert.equal(broker.resourceOwners.get("browser\0browser-peer"), peer);
  assert.deepEqual(owner.messages, []);
  assert.deepEqual(peer.messages, []);
  respond({ jsonrpc: "2.0", id: close.id, result: { closed: true } });
  assert.equal(broker.pending.has(close.id), false);
  assert.deepEqual(owner.messages, []);
  assert.deepEqual(peer.messages, []);

  broker.detach(peer);
  const peerClose = upstream.at(-1);
  assert.equal(peerClose.method, "browser/close");
  assert.deepEqual(peerClose.params, { session_id: "browser-peer" });
  respond({ jsonrpc: "2.0", id: peerClose.id, result: { closed: true } });
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


test("preserves receipt-backed late thread creation without assigning a disconnected owner", () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  broker.initializeResponse = { result: { capabilities: { experimental: { threadCreationReceiptsV1: true } } } };
  const client = fakeClient(); broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "thread/start", params: { clientRequestId: "create-once" } }));
  const requestId = upstream[0].id;
  broker.detach(client);
  const before = upstream.length;
  respond({ id: requestId, result: { thread: { id: "durable-created-thread" } } });
  assert.equal(upstream.length, before, "must not delete a receipt-backed creation");
  assert.equal(broker.threadOwners.has("durable-created-thread"), false);
  assert.equal(broker.pending.size, 0);
});

test('Wiki artifacts and directory snapshots preserve multiplexed attachment ownership', () => {
  for (const creation of ['knowledge/export', 'knowledge/markdown/export', 'knowledge/source/original/export', 'knowledge/source/directoryStage']) {
    const { broker, upstream, respond } = brokerFixture();
    const owner = fakeClient(), other = fakeClient(); broker.attach(owner); broker.attach(other);
    broker.receive(owner, JSON.stringify({ id: 1, method: creation, params: {} }));
    respond({ id: upstream.at(-1).id, result: creation.endsWith('directoryStage') ? { items: [{ attachmentPath: '/staged/wiki' }] } : { path: '/staged/wiki' } });
    for (const method of ['knowledge/source/importAttachment', 'knowledge/importArchive', 'knowledge/markdown/import', 'knowledge/export/read']) {
      const count = upstream.length;
      broker.receive(other, JSON.stringify({ id: 2, method, params: { attachmentPath: '/staged/wiki' } }));
      assert.equal(other.messages.at(-1).error.code, -32048);
      assert.equal(upstream.length, count);
      broker.receive(owner, JSON.stringify({ id: 3, method, params: { attachmentPath: '/staged/missing' } }));
      assert.equal(owner.messages.at(-1).error.code, -32049);
      broker.receive(owner, JSON.stringify({ id: 4, method, params: { attachmentPath: '/staged/wiki' } }));
      assert.equal(upstream.at(-1).method, method);
      respond({ id: upstream.at(-1).id, result: {} });
    }
    broker.detach(owner);
    assert.equal(upstream.at(-1).method, 'attachment/delete');
    assert.equal(upstream.at(-1).params.path, '/staged/wiki');
  }
});

test('scheduled admission errors reach clients and release the running lease without retry', () => {
  const { broker, child, respond, upstream } = brokerFixture();
  const client = fakeClient(); client.initialized = true; broker.attach(client);
  const requestId = 'kcoder-automation-turn:fixture';
  respond({jsonrpc:'2.0', method:'automation/runStarted', params:{jobId:'job', threadId:'automatic', requestId, workspacePath:'/fixture'}});
  assert.equal(broker.hasProjectAutomations, true);
  const count = upstream.length;
  respond({jsonrpc:'2.0', id:requestId, error:{code:-32602, message:'Provider API key missing'}});
  const failure = client.messages.find(message => message.method === 'automation/runFailed');
  assert.equal(failure.params.threadId, 'automatic');
  assert.equal(failure.params.error.message, 'Provider API key missing');
  assert.equal(broker.hasProjectAutomations, false);
  assert.equal(upstream.length, count, 'do not repeat scheduled side effects');
  respond({jsonrpc:'2.0', id:requestId, error:{code:-32602, message:'duplicate'}});
  assert.equal(client.messages.filter(message=>message.method==='automation/runFailed').length,1);
  child.emit('exit',0,null);
});

test('desktop recovery is owned, tracks its new turn, and detach revokes the backend grant', () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  broker.initializeResponse = { result: { capabilities: { experimental: { computerUseRecoveryV1: true } } } };
  const client = fakeClient(), foreign = fakeClient();
  broker.attach(client); broker.attach(foreign);
  client.initialized = true; foreign.initialized = true;
  client.computerUseRecoveryV1 = true;
  broker.threadOwners.set('desktop', client);
  broker.receive(foreign, JSON.stringify({ id: 1, method: 'computerUse/recover', params: { threadId: 'desktop', previousTurnId: 'old' } }));
  assert.equal(upstream.length, 0);
  assert.equal(foreign.messages.at(-1)?.error?.code, -32023);
  broker.receive(client, JSON.stringify({ id: 2, method: 'computerUse/recover', params: { threadId: 'desktop', previousTurnId: 'old' } }));
  respond({ id: upstream.at(-1).id, result: { threadId: 'desktop', previousTurnId: 'old', turnId: 'new', status: 'running' } });
  assert.equal(broker.activeTurns.get('desktop')?.turnId, 'new');
  broker.detach(client);
  const revoke = upstream.find(request => request.method === 'computerUse/revoke');
  assert.equal(typeof revoke.id, 'number');
  assert.deepEqual(revoke.params, { threadId: 'desktop' });
  assert.equal(broker.threadOwners.has('desktop'), false);
});

test('completed recovery receipts never resurrect active turns and legacy clients receive basic lifecycle only', () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const client = fakeClient(), legacy = fakeClient();
  broker.attach(client); broker.attach(legacy);
  client.initialized = true; legacy.initialized = true;
  client.computerUseRecoveryV1 = true;
  broker.threadOwners.set('desktop', client);
  broker.receive(client, JSON.stringify({ id: 1, method: 'computerUse/recover', params: { threadId: 'desktop', previousTurnId: 'old' } }));
  respond({ id: upstream.at(-1).id, result: { threadId: 'desktop', previousTurnId: 'old', turnId: 'new', status: 'completed' } });
  assert.equal(broker.activeTurns.has('desktop'), false);
  broker.sendServerNotification(legacy, { method: 'computerUse/stateChanged', params: { state: 'stopped', target: 'local_windows_desktop', diagnostic: { authorization: 'valid' }, recoveryAvailable: true } });
  assert.equal(legacy.messages.at(-1).params.diagnostic, undefined);
  assert.equal(legacy.messages.at(-1).params.recoveryAvailable, undefined);
});

test('Wiki archive RPCs bind the real creating client, reject foreign/missing IDs and cancel only owned transfers', () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const owner = fakeClient(), observer = fakeClient(); broker.attach(owner); broker.attach(observer);
  broker.receive(owner, JSON.stringify({ id: 1, method: 'knowledge/archiveTransfer/exportStart', params: { libraryId: 'library' } }));
  respond({ id: upstream.at(-1).id, result: { transferId: 'actual-archive', phase: 'ready' } });
  for (const method of ['status', 'read', 'chunk', 'importFinish', 'cancel']) {
    const count = upstream.length;
    broker.receive(observer, JSON.stringify({ id: 2, method: `knowledge/archiveTransfer/${method}`, params: { transferId: 'actual-archive' } }));
    assert.equal(observer.messages.at(-1).error.code, -32048);
    broker.receive(owner, JSON.stringify({ id: 3, method: `knowledge/archiveTransfer/${method}`, params: { transferId: 'unknown-archive' } }));
    assert.equal(owner.messages.at(-1).error.code, -32049);
    assert.equal(upstream.length, count);
  }
  broker.receive(owner, JSON.stringify({ id: 4, method: 'knowledge/archiveTransfer/read', params: { transferId: 'actual-archive', index: 0, offset: 0 } }));
  assert.equal(upstream.at(-1).method, 'knowledge/archiveTransfer/read');
  respond({ id: upstream.at(-1).id, result: { contentBase64: 'eA==' } });
  const before = upstream.length;
  broker.detach(observer);
  assert.equal(upstream.length, before, 'observer disconnect cannot cancel another client collection');
  broker.detach(owner);
  assert.equal(upstream.at(-1).method, 'knowledge/archiveTransfer/cancel');
  assert.ok(upstream.at(-1).id !== undefined, 'cleanup is a correlated RPC');
  assert.equal(upstream.at(-1).params.transferId, 'actual-archive');
  respond({ id: upstream.at(-1).id, result: { transferId: 'actual-archive', phase: 'cancelled' } });
  assert.equal(broker.resourceOwners.size, 0);
});
test('late archive start after disconnect is cancelled without restoring a client owner', () => {
  for (const method of ['knowledge/archiveTransfer/exportStart', 'knowledge/archiveTransfer/importStart']) {
    const { broker, upstream, respond } = brokerFixture();
    const client = fakeClient(); broker.attach(client);
    broker.receive(client, JSON.stringify({ id: 1, method, params: {} }));
    const id = upstream.at(-1).id;
    broker.detach(client);
    respond({ id, result: { transferId: 'late-archive', phase: 'processing' } });
    assert.equal(upstream.at(-1).method, 'knowledge/archiveTransfer/cancel');
    assert.equal(upstream.at(-1).params.transferId, 'late-archive');
    assert.equal(broker.resourceOwners.has('wiki-archive\0late-archive'), false);
    respond({ id: upstream.at(-1).id, result: { phase: 'cancelled' } });
    assert.equal(broker.pending.size, 0);
  }
});


const snapshotInitializeParams = (enabled = false) => ({ protocolVersion: "2026-07-27",
  clientInfo: { name: "contract-client", version: "1" }, capabilities: { experimental: { threadTranscriptSnapshotV1: enabled } } });
const snapshotInitializeResponse = { capabilities: { experimental: { residentThreads: true, threadTranscriptSnapshotV1: true } } };
for (const cache of [false, true]) {
  test(`snapshot initialize validates ID and typed params before freezing choices (cached=${cache})`, () => {
    const f = brokerFixture({ residentThreads: true });
    if (cache) f.broker.initializeResponse = { result: snapshotInitializeResponse };
    const invalid = [
      { params: snapshotInitializeParams(true) },
      ...[null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []].map(id => ({ id, params: snapshotInitializeParams(true) })),
      ...[null, {}, { ...snapshotInitializeParams(), clientInfo: { name: "missing version" } },
        { ...snapshotInitializeParams(), capabilities: { experimental: { threadTranscriptSnapshotV1: "true" } } },
        { ...snapshotInitializeParams(), protocolVersion: "old" }].map(params => ({ id: "invalid", params })),
    ];
    for (const value of invalid) {
      const client = fakeClient(); f.broker.attach(client);
      f.broker.receive(client, JSON.stringify({ method: "initialize", ...value }));
      assert.equal(client.initialized, false);
      assert.equal(client.threadTranscriptSnapshotV1, undefined);
      assert.equal(f.upstream.length, 0);
      if (Object.hasOwn(value, "id")) assert.ok(client.messages.at(-1)?.error);
      f.broker.detach(client);
    }
  });
}
for (const rawPassthrough of [false, true]) for (const order of ["legacy-first", "modern-first", "concurrent"]) {
  test(`snapshot page negotiation is per client and immutable (${order}, raw=${rawPassthrough})`, () => {
    const f = brokerFixture({ residentThreads: true, adapter: {
      rawPassthrough, toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    } });
    const modern = fakeClient(); const legacy = fakeClient();
    f.broker.attach(modern); f.broker.attach(legacy);
    const first = order === "modern-first" ? modern : legacy; const second = first === modern ? legacy : modern;
    const init = client => f.broker.receive(client, JSON.stringify({ id: client === modern ? "modern" : "legacy", method: "initialize", params: snapshotInitializeParams(client === modern) }));
    init(first);
    assert.equal(f.upstream[0].params.capabilities.experimental.threadTranscriptSnapshotV1, true);
    assert.equal(first.threadTranscriptSnapshotV1, undefined, "pending choice is not successful initialization");
    if (order === "concurrent") init(second);
    f.respond({ id: f.upstream[0].id, result: snapshotInitializeResponse });
    if (order !== "concurrent") init(second);
    assert.equal(modern.threadTranscriptSnapshotV1, true); assert.equal(legacy.threadTranscriptSnapshotV1, false);
    for (const client of [modern, legacy]) {
      assert.equal(client.initialized, true);
      f.broker.receive(client, JSON.stringify({ id: "duplicate", method: "initialize", params: snapshotInitializeParams(client !== modern) }));
      assert.ok(client.messages.at(-1)?.error);
      assert.equal(client.threadTranscriptSnapshotV1, client === modern, "duplicate cannot change frozen choice");
    }
    const snapshot = { status: "available", snapshotId: "a".repeat(64), viewKey: "b".repeat(64) };
    for (const method of ["thread/read", "thread/read/indexed", "thread/resume"]) {
      const result = method === "thread/resume" ? { thread: { id: "thread-1" }, history: { status: "ready", page: { messages: [], transcriptSnapshotV1: snapshot } } }
        : { thread: { id: "thread-1" }, messages: [], transcriptSnapshotV1: snapshot };
      const original = JSON.parse(JSON.stringify(result));
      for (const client of [modern, legacy]) {
        if (method === "thread/resume") f.broker.threadOwners.set("thread-1", client);
        f.broker.receive(client, JSON.stringify({ id: method, method, params: { threadId: "thread-1" } }));
        f.respond({ id: f.upstream.at(-1).id, result });
        const received = client.messages.at(-1).result;
        assert.deepEqual(method === "thread/resume" ? received.history.page.transcriptSnapshotV1 : received.transcriptSnapshotV1, client === modern ? snapshot : undefined);
      }
      assert.deepEqual(result, original, "client projection must not mutate backend payload");
    }
  });
}
test("snapshot initialize rejects pending duplicates and allows retry after upstream failure", () => {
  const f = brokerFixture({ residentThreads: true }); const client = fakeClient(); f.broker.attach(client);
  f.broker.receive(client, JSON.stringify({ id: 1, method: "initialize", params: snapshotInitializeParams(false) }));
  f.broker.receive(client, JSON.stringify({ id: 2, method: "initialize", params: snapshotInitializeParams(true) }));
  assert.ok(client.messages.at(-1)?.error); assert.equal(f.upstream.length, 1);
  f.respond({ id: f.upstream[0].id, error: { code: -32602, message: "fixture failed" } });
  assert.equal(client.initialized, false); assert.equal(client.threadTranscriptSnapshotV1, undefined);
  f.broker.receive(client, JSON.stringify({ id: 3, method: "initialize", params: snapshotInitializeParams(true) }));
  assert.equal(f.upstream.length, 2);
  f.respond({ id: f.upstream[1].id, result: snapshotInitializeResponse });
  assert.equal(client.initialized, true); assert.equal(client.threadTranscriptSnapshotV1, true);
});


test("snapshot initialize choices are released on deadline and shared failure", () => {
  for (const outcome of ["expired", "rejected"]) {
    const f = brokerFixture({ residentThreads: true }); const first = fakeClient(); const peer = fakeClient();
    f.broker.attach(first); f.broker.attach(peer);
    f.broker.receive(first, JSON.stringify({ id: 1, method: "initialize", params: snapshotInitializeParams(false) }));
    if (outcome === "expired") f.broker.expireRequest(f.upstream[0].id);
    else {
      f.broker.receive(peer, JSON.stringify({ id: 2, method: "initialize", params: snapshotInitializeParams(false) }));
      f.respond({ id: f.upstream[0].id, error: { code: -32602, message: "fixture" } });
      assert.equal(peer.pendingInitializeChoices, null); assert.equal(peer.initialized, false);
    }
    assert.equal(first.pendingInitializeChoices, null); assert.equal(first.initialized, false);
    f.broker.receive(first, JSON.stringify({ id: 3, method: "initialize", params: snapshotInitializeParams(true) }));
    assert.equal(f.upstream.length, outcome === "expired" ? 1 : 2, "retry joins only an unresolved upstream initialize");
    f.respond({ id: f.upstream.at(-1).id, result: snapshotInitializeResponse });
    assert.equal(first.initialized, true); assert.equal(first.threadTranscriptSnapshotV1, true);
    assert.equal(first.messages.at(-1).id, 3);
  }
});

test("snapshot backend opt-in also applies to parent internal initialization", () => {
  const f = brokerFixture();
  const id = f.broker.sendInternalRequest("initialize", snapshotInitializeParams(false));
  assert.equal(f.upstream[0].params.capabilities.experimental.threadTranscriptSnapshotV1, true);
  f.respond({ id, result: snapshotInitializeResponse });
});

test("snapshot initialize accepts the exact JS ID subset and default or future typed fields", () => {
  for (const id of [0, Number.MAX_SAFE_INTEGER, "", "string-id"]) {
    const f = brokerFixture({ residentThreads: true }); const client = fakeClient(); f.broker.attach(client);
    const params = { ...validInitializeParams(), futureField: { ignored: true } };
    f.broker.receive(client, JSON.stringify({ id, method: "initialize", params }));
    assert.equal(f.upstream.length, 1);
    f.respond({ id: f.upstream[0].id, result: snapshotInitializeResponse });
    assert.equal(client.initialized, true); assert.equal(client.threadTranscriptSnapshotV1, false);
    assert.equal(client.messages.at(-1).id, id);
  }
});


test("snapshot initialize waiter deadline allows retry and preserves a later peer and late success", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = brokerFixture({ residentThreads: true, pendingBudget: { ttlMs: 100 } });
  const origin = fakeClient(), waiter = fakeClient(), peer = fakeClient();
  for (const client of [origin, waiter, peer]) f.broker.attach(client);
  const init = (client, id, enabled) => f.broker.receive(client, JSON.stringify({ id, method: "initialize", params: snapshotInitializeParams(enabled) }));
  init(origin, "origin", false);
  const sharedId = f.upstream[0].id;
  t.mock.timers.tick(100);
  init(waiter, "expired-waiter", false);
  t.mock.timers.tick(50);
  init(peer, "peer", false);
  t.mock.timers.tick(50);
  assert.equal(waiter.messages.at(-1)?.id, "expired-waiter");
  assert.deepEqual(waiter.messages.at(-1)?.error?.data, { kind: "gatewayRequestExpired", outcome: "unknown" });
  assert.equal(waiter.pendingInitializeChoices, null);
  assert.equal(peer.messages.length, 0, "a later peer keeps its own deadline");
  assert.equal(f.broker.initializePending, sharedId);
  init(waiter, "retry", true);
  assert.equal(f.upstream.length, 1, "waiter retries never reissue the shared initialize");
  f.respond({ id: sharedId, result: snapshotInitializeResponse });
  assert.equal(waiter.messages.at(-1)?.id, "retry");
  assert.equal(waiter.initialized, true); assert.equal(waiter.threadTranscriptSnapshotV1, true);
  assert.equal(peer.messages.at(-1)?.id, "peer");
  assert.equal(peer.initialized, true); assert.equal(peer.threadTranscriptSnapshotV1, false);
  assert.equal(origin.initialized, false, "expired origin is not silently initialized by late success");
  assert.equal(f.broker.pendingLoad.admitted, 0);
  const counts = [origin, waiter, peer].map(client => client.messages.length);
  t.mock.timers.tick(1000);
  assert.deepEqual([origin, waiter, peer].map(client => client.messages.length), counts);
  f.child.emit("close", 0, null);
});

test("snapshot initialize waiters obey admission limits and release deadlines on detach and close", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = brokerFixture({ residentThreads: true, pendingBudget: { total: 2, ttlMs: 100 } });
  const origin = fakeClient(), waiter = fakeClient(), peer = fakeClient();
  for (const client of [origin, waiter, peer]) f.broker.attach(client);
  const init = (client, id) => f.broker.receive(client, JSON.stringify({ id, method: "initialize", params: snapshotInitializeParams(true) }));
  init(origin, "origin"); init(waiter, "waiter"); init(peer, "denied");
  assert.match(peer.messages.at(-1)?.error?.message ?? "", /capacity/);
  assert.equal(peer.pendingInitializeChoices, null);
  assert.equal(f.broker.pendingLoad.admitted, 2);
  f.broker.detach(waiter);
  assert.equal(waiter.pendingInitializeChoices, null);
  assert.equal(f.broker.pendingLoad.admitted, 1);
  init(peer, "admitted-after-detach");
  assert.equal(f.broker.initializeWaiters.length, 1);
  assert.equal(f.broker.pendingLoad.admitted, 2);
  const detachedMessages = waiter.messages.length;
  f.child.emit("close", 0, null);
  assert.equal(peer.pendingInitializeChoices, null);
  assert.equal(f.broker.initializeWaiters.length, 0);
  assert.equal(f.broker.pendingLoad.admitted, 0);
  const peerMessages = peer.messages.length;
  t.mock.timers.tick(1000);
  assert.equal(waiter.messages.length, detachedMessages);
  assert.equal(peer.messages.length, peerMessages);
});

test('shared history worker state is negotiated and projected separately for old and new clients', () => {
  const { broker, upstream, respond, child } = brokerFixture({ residentThreads: true });
  const modern = fakeClient(), legacy = fakeClient();
  broker.attach(modern); broker.attach(legacy);
  broker.receive(modern, JSON.stringify({ id: 1, method: 'initialize', params: {
    ...validInitializeParams(), capabilities: { experimental: { migrationHistoryWorkerStateClientV1: true } },
  } }));
  assert.equal(upstream[0].params.capabilities.experimental.migrationHistoryWorkerStateV1, true);
  assert.equal(Object.hasOwn(upstream[0].params.capabilities.experimental, 'migrationHistoryWorkerStateClientV1'), false);
  respond({ id: upstream[0].id, result: { capabilities: { experimental: { residentThreads: true, migrationHistoryWorkerStateV1: true } } } });
  broker.receive(legacy, JSON.stringify({ id: 2, method: 'initialize', params: validInitializeParams() }));
  assert.equal(modern.messages.at(-1).result.capabilities.experimental.migrationHistoryWorkerStateV1, true);
  assert.equal(legacy.messages.at(-1).result.capabilities.experimental.migrationHistoryWorkerStateV1, false);
  for (const client of [modern, legacy]) {
    broker.receive(client, JSON.stringify({ id: 3, method: 'migration/history/read', params: { jobId: 'owned' } }));
    respond({ id: upstream.at(-1).id, result: { job: { jobId: 'owned' }, workerRunning: false, workerState: 'unknown' } });
    assert.equal(Object.hasOwn(client.messages.at(-1).result, 'workerState'), client === modern);
    broker.receive(client, JSON.stringify({ id: 4, method: 'migration/history/jobs', params: {} }));
    respond({ id: upstream.at(-1).id, result: { jobs: [{ job: { jobId: 'owned' }, workerRunning: false, workerState: 'unknown' }], nextCursor: null } });
    assert.equal(Object.hasOwn(client.messages.at(-1).result.jobs[0], 'workerState'), client === modern);
  }
  assert.equal(modern.messages.find(message => message.id === 3).result.workerState, 'unknown');
  child.emit('close', 0, null);
});


test('same-workspace restart retires both real broker admissions without killing an old busy peer or another owner', () => {
  const a = brokerFixture({ residentThreads: true });
  const b = brokerFixture({ residentThreads: true });
  const otherOwner = brokerFixture({ residentThreads: true });
  const otherTarget = brokerFixture({ residentThreads: true });
  const otherPath = brokerFixture({ residentThreads: true });
  for (const value of [a, b, otherOwner, otherTarget, otherPath]) {
    value.broker.targetId = 'exact-target'; value.broker.loginOwner = 'exact-login-owner';
  }
  otherOwner.broker.loginOwner = 'other-login-owner';
  otherTarget.broker.targetId = 'other-target';
  const peer = fakeClient();
  b.broker.attach(peer);
  b.broker.receive(peer, JSON.stringify({ jsonrpc: '2.0', id: 'initialize-peer', method: 'initialize', params: validInitializeParams() }));
  b.respond({ jsonrpc: '2.0', id: b.upstream[0].id, result: { capabilities: { experimental: { residentThreads: true } } } });
  b.broker.activeTurns.set('owned-existing-turn', { owner: peer });
  let exits = 0;
  for (const value of [a, b, otherOwner, otherTarget, otherPath]) value.child.once('close', () => { exits++; });
  const registry = new Map([
    ['canonical-scope-A', new Set([a.broker, b.broker, otherOwner.broker, otherTarget.broker])],
    ['same-workspace-name-different-path', new Set([otherPath.broker])],
  ]);
  assert.equal(retireRestartScopeAdmissions(registry, 'canonical-scope-A', { targetId: 'exact-target', loginOwner: 'exact-login-owner' }), 2);
  assert.equal(a.broker.acceptsClient, false); assert.equal(b.broker.acceptsClient, false);
  assert.equal(otherOwner.broker.acceptsClient, true); assert.equal(otherTarget.broker.acceptsClient, true); assert.equal(otherPath.broker.acceptsClient, true);
  assert.equal(exits, 0); assert.equal(b.broker.clientCount, 1); assert.equal(b.broker.activeTurns.size, 1);
  const before = b.upstream.length;
  b.broker.receive(peer, JSON.stringify({ jsonrpc: '2.0', id: 'existing-peer-read', method: 'thread/list', params: { limit: 1 } }));
  assert.equal(b.upstream.length, before + 1, 'retirement does not revoke the old peer connection');
  assert.throws(() => b.broker.attach(fakeClient()), /closed or restarting/);
  const fresh = brokerFixture({ residentThreads: true }); fresh.broker.targetId = 'exact-target'; fresh.broker.loginOwner = 'exact-login-owner';
  registry.get('canonical-scope-A').add(fresh.broker);
  const selected = [...registry.get('canonical-scope-A')].find(candidate => candidate.targetId === 'exact-target' && candidate.loginOwner === 'exact-login-owner' && candidate.acceptsClient);
  assert.equal(selected, fresh.broker, 'a subsequent probe cannot return to either old configuration process');
});
