import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WorkspaceAppServerBroker } from "../src/workspace-app-server-broker.js";

// Model-independent tests exercise actual multiplexing and late JSON-RPC responses.
const METHOD = "thread/history/refresh";
test("invalid refresh envelopes cannot claim through rewritten request ids", () => {
  for (const fields of [{ jsonrpc: "2.0", id: {} }, { jsonrpc: "1.0", id: 5 }, { id: 6 }]) {
    const f = fixture();
    assert.doesNotThrow(() => f.broker.receive(f.a, JSON.stringify({
      ...fields, method: METHOD, params: { acknowledgeExternalWriters: true },
    })));
    assert.equal(f.upstream.length, 0);
    assert.equal(f.a.messages.at(-1).error.code, -32600);
    assert.equal(f.a.closed, false);
    f.request(f.b, { acknowledgeExternalWriters: true });
    assert.equal(f.upstream.length, 1);
  }
});
function fixture(initialize = true) {
  const child = new EventEmitter();
  for (const name of ["stdin", "stdout", "stderr"]) child[name] = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true,
    adapter: { rawPassthrough: true }, maxMessageBytes: 1024 * 1024, serverId: "local" });
  const upstream = [];
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) upstream.push(JSON.parse(line));
  });
  const client = () => {
    const value = { channel: "runtime", closed: false, messages: [],
      send(message) { this.messages.push(message); }, pause() {}, resume() {}, close() { this.closed = true; } };
    broker.attach(value);
    return value;
  };
  const a = client(), b = client();
  if (initialize) {
    broker.receive(a, JSON.stringify({ id: "init-a", method: "initialize", params: {} }));
    broker.routeServerMessage({ id: upstream.at(-1).id, result: {
      capabilities: { experimental: { residentThreads: true } },
    } });
    broker.receive(b, JSON.stringify({ id: "init-b", method: "initialize", params: {} }));
    upstream.length = 0;
    a.messages.length = b.messages.length = 0;
  }
  let next = 1;
  const request = (owner, params, method = METHOD) => {
    broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: next++, method, params }));
    return upstream.at(-1);
  };
  const respond = (request, result, error) => broker.routeServerMessage({
    jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }),
  });
  const reject = (owner, params, pattern, code) => {
    const id = next++;
    const sent = upstream.length;
    assert.doesNotThrow(() => broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id, method: METHOD, params })));
    assert.equal(upstream.length, sent);
    const response = owner.messages.at(-1);
    assert.equal(response.id, id);
    assert.match(response.error.message, pattern);
    if (code !== undefined) assert.equal(response.error.code, code);
    assert.equal(owner.closed, false);
    assert.equal(broker.clients.has(owner), true);
  };
  return { broker, child, upstream, a, b, request, respond, reject };
}
const building = cursor => ({ status: "building", nextCursor: cursor, examinedEntries: 1, indexedSessions: 0, issueCount: 0 });

test("uninitialized refresh gets a protocol error before owner claim", () => {
  const f = fixture(false);
  f.reject(f.a, { acknowledgeExternalWriters: true }, /initialize/i, -32002);
  assert.equal(f.broker.historyRefresh.state, null);
  assert.equal(f.broker.pending.size, 0);
});

test("business refresh rejection preserves the same client's connection and resources", () => {
  const f = fixture();
  const start = f.request(f.a, { acknowledgeExternalWriters: true });
  f.respond(start, building("owned"));
  f.broker.threadOwners.set("b-thread", f.b);
  f.broker.resourceOwners.set("terminal\0b-terminal", f.b);
  f.reject(f.b, { acknowledgeExternalWriters: true }, /another client/i, -32020);
  f.reject(f.b, { cursor: "owned", cancel: "yes" }, /parameters/i, -32602);
  assert.equal(f.broker.threadOwners.get("b-thread"), f.b);
  assert.equal(f.broker.resourceOwners.get("terminal\0b-terminal"), f.b);
  const list = f.request(f.b, {}, "thread/list");
  f.respond(list, { threads: [] });
  assert.deepEqual(f.b.messages.at(-1).result, { threads: [] });
  assert.equal(f.b.messages.some(message => message.method === "server/transportError"), false);
  assert.equal(f.b.closed, false);
  f.reject(f.a, { cursor: "stale" }, /cursor/i, -32020);
  const step = f.request(f.a, { cursor: "owned" });
  assert.equal(step.params.cursor, "owned");
});

test("refresh owner is claimed before start reply and only owns one in-flight request", () => {
  const f = fixture();
  const start = f.request(f.a, { acknowledgeExternalWriters: true });
  f.reject(f.b, { acknowledgeExternalWriters: true }, /refresh.*(owner|client|busy|progress)/i);
  f.reject(f.a, { acknowledgeExternalWriters: true }, /refresh.*(busy|progress|flight)/i);
  assert.equal(f.upstream.length, 1);
  f.respond(start, building("first"));
  f.reject(f.b, { cursor: "first", cancel: true }, /refresh/i);
  f.reject(f.a, { cursor: "wrong" }, /cursor/i);
  const step = f.request(f.a, { cursor: "first" });
  f.respond(step, building("second"));
  f.reject(f.a, { cursor: "first" }, /cursor/i);
  const cancel = f.request(f.a, { cursor: "second", cancel: true });
  f.respond(cancel, { status: "cancelled" });
  assert.equal(f.request(f.b, { acknowledgeExternalWriters: true }).method, METHOD);
});

test("detach during start or step keeps tombstone and cancels the newly returned cursor once", () => {
  for (const duringStep of [false, true]) {
    const f = fixture();
    let pending = f.request(f.a, { acknowledgeExternalWriters: true });
    if (duringStep) {
      f.respond(pending, building("old"));
      pending = f.request(f.a, { cursor: "old" });
    }
    const sent = f.upstream.length;
    f.broker.detach(f.a);
    assert.equal(f.broker.pending.has(pending.id), true);
    assert.equal(f.upstream.length, sent);
    f.reject(f.b, { acknowledgeExternalWriters: true }, /refresh/i);
    f.respond(pending, building("new"));
    const cancel = f.upstream.at(-1);
    assert.equal(cancel.method, METHOD);
    assert.deepEqual(cancel.params, { cursor: "new", cancel: true });
    assert.notEqual(cancel.id, undefined, "app-server ignores refresh notifications");
    assert.equal(f.broker.pending.has(cancel.id), true);
    f.reject(f.b, { acknowledgeExternalWriters: true }, /refresh/i);
    f.respond(cancel, { status: "cancelled" });
    f.respond(pending, building("duplicate"));
    assert.equal(f.upstream.length, sent + 1);
    f.request(f.b, { acknowledgeExternalWriters: true });
  }
});

test("idle detach cancels known cursor without touching another client's thread or terminal", () => {
  const f = fixture();
  const start = f.request(f.a, { acknowledgeExternalWriters: true });
  f.respond(start, building("idle"));
  f.broker.threadOwners.set("other-thread", f.b);
  f.broker.resourceOwners.set("terminal\0other-terminal", f.b);
  f.broker.detach(f.a);
  const cancel = f.upstream.at(-1);
  assert.deepEqual(cancel.params, { cursor: "idle", cancel: true });
  assert.equal(f.broker.pending.has(cancel.id), true);
  f.broker.detach(f.a);
  assert.equal(f.upstream.filter(message => message.method === METHOD && message.params.cancel).length, 1);
  f.respond(cancel, null, { code: -32020, message: "cleanup failed" });
  assert.equal(f.broker.threadOwners.get("other-thread"), f.b);
  assert.equal(f.broker.resourceOwners.get("terminal\0other-terminal"), f.b);
  f.request(f.b, { acknowledgeExternalWriters: true });
});

test("invalid refresh parameters never claim owner or mutate an existing cursor", () => {
  const f = fixture();
  for (const params of [{}, [], null, { force: true }, { acknowledgeExternalWriters: "true" },
    { acknowledgeExternalWriters: true, cursor: 1 }, { cancel: true }, { cursor: "", cancel: true }]) {
    f.reject(f.a, params, /refresh|cursor|acknowledge/i);
  }
  assert.equal(f.upstream.length, 0);
  const start = f.request(f.b, { acknowledgeExternalWriters: true });
  f.respond(start, building("valid"));
  f.reject(f.b, { cursor: "valid", cancel: "true" }, /refresh/i);
  f.request(f.b, { cursor: "valid" });
});

test("refresh write rejection restores an attached owner's usable cursor", () => {
  const f = fixture();
  const start = f.request(f.a, { acknowledgeExternalWriters: true });
  f.respond(start, building("retained"));
  const write = f.child.stdin.write;
  f.child.stdin.write = () => { throw new Error("injected rejected write"); };
  assert.throws(() => f.request(f.a, { cursor: "retained" }), /rejected write/);
  assert.equal(f.broker.pending.size, 0);
  f.reject(f.b, { acknowledgeExternalWriters: true }, /refresh/i);
  f.child.stdin.write = write;
  const step = f.request(f.a, { cursor: "retained" });
  f.respond(step, null, { code: -32020, message: "processor failed and released its builder" });
  f.request(f.b, { acknowledgeExternalWriters: true });
});

test("failed internal cleanup writes neither loop nor terminate another client's backend", () => {
  const f = fixture();
  const start = f.request(f.a, { acknowledgeExternalWriters: true });
  f.respond(start, building("idle"));
  const write = f.child.stdin.write;
  let attempts = 0;
  f.child.stdin.write = () => { attempts++; throw new Error("injected cleanup write rejection"); };
  f.broker.threadOwners.set("other", f.b);
  f.broker.detach(f.a);
  f.broker.detach(f.a);
  assert.equal(attempts, 1);
  assert.equal(f.broker.pending.size, 0);
  assert.equal(f.broker.closed, false);
  assert.equal(f.broker.threadOwners.get("other"), f.b);
  f.child.stdin.write = write;
  // A fresh acknowledged begin lets the authoritative processor replace any orphaned build.
  f.request(f.b, { acknowledgeExternalWriters: true });
});

test("backend close clears refresh tombstones and ignores late cleanup responses", () => {
  for (const replied of [false, true]) {
    const f = fixture();
    const start = f.request(f.a, { acknowledgeExternalWriters: true });
    if (replied) f.respond(start, building("idle"));
    f.broker.detach(f.a);
    const pending = f.upstream.at(-1);
    assert.equal(f.broker.pending.size, 1);
    const before = f.upstream.length;
    f.child.emit("close", 0, null);
    assert.equal(f.broker.pending.size, 0);
    assert.equal(f.broker.historyRefresh.state, null);
    f.respond(pending, building("late"));
    assert.equal(f.upstream.length, before);
  }
});

test("detached terminal refresh results release owner without compensating an already finished build", () => {
  for (const status of ["ready", "incomplete"]) {
    const f = fixture();
    const start = f.request(f.a, { acknowledgeExternalWriters: true });
    f.broker.detach(f.a);
    f.respond(start, { status, examinedEntries: 1, indexedSessions: 0, issueCount: status === "incomplete" ? 1 : 0 });
    assert.equal(f.upstream.length, 1);
    assert.equal(f.broker.pending.size, 0);
    f.request(f.b, { acknowledgeExternalWriters: true });
  }
});

test("refresh notifications cannot claim ownership and disconnect does not forward late cursors", () => {
  const f = fixture();
  f.broker.receive(f.a, JSON.stringify({ method: METHOD, params: { acknowledgeExternalWriters: true } }));
  assert.equal(f.upstream.length, 0);
  const start = f.request(f.b, { acknowledgeExternalWriters: true });
  const before = f.b.messages.length;
  f.broker.detach(f.b);
  f.respond(start, building("private-late-cursor"));
  assert.equal(f.b.messages.length, before);
  assert.equal(f.a.messages.length, 0);
  const cancel = f.upstream.at(-1);
  f.respond(cancel, { status: "cancelled" });
  assert.equal(f.a.messages.length, 0);
});
