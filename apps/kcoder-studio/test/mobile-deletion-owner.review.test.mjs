import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WorkspaceAppServerBroker } from "../src/workspace-app-server-broker.js";

function client() {
  return {
    channel: "runtime",
    messages: [],
    send(message) { this.messages.push(message); return true; },
    pause() {},
    resume() {},
    close() {},
  };
}

function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: "review",
    residentThreads: true,
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
  const respond = value => child.stdout.write(JSON.stringify(value) + "\n");
  return { broker, upstream, respond };
}

function scopedCleanupFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({
    child,
    adapter: {
      rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }),
    },
    maxMessageBytes: 1024 * 1024,
    serverId: "review-cleanup-race",
    residentThreads: true,
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
  const respond = (request, value) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...value }) + "\n");
  const attach = authorizationOwner => {
    const value = client();
    value.authorizationOwner = authorizationOwner;
    broker.attach(value);
    value.initialized = true;
    return value;
  };
  return { broker, upstream, respond, attach };
}

test("a cleanup client cannot delete another client's staged or materialized attachment", () => {
  const { broker, upstream, respond } = fixture();
  const owner = client();
  const cleanup = client();
  broker.attach(owner);
  broker.attach(cleanup);
  const path = "/attachments/review-owner.png";

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/save",
    params: { filename: "owner.png", content_base64: "AAAA" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { path } });
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "gateway/attachments/retain", params: { paths: [path] },
  }));
  const prompt = '<kcoder_attachments version="1">\n'
    + JSON.stringify({ filename: "owner.png", path })
    + "\n</kcoder_attachments>";
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "turn/start",
    params: { threadId: "thread-review", input: [{ type: "text", text: prompt }] },
  }));
  assert.equal(upstream.at(-1).method, "turn/start");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { turn: { id: "turn-review" } } });
  assert.equal(broker.persistentResources.has("attachment\0" + path), true);
  assert.equal(broker.materializedAttachments.get("attachment\0" + path), "thread-review");

  const before = upstream.length;
  broker.receive(cleanup, JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "attachment/delete", params: { path },
  }));
  assert.equal(upstream.length, before, "foreign deletion must not reach the shared app-server");
  assert.equal(cleanup.messages.at(-1).error.code, -32048);
  assert.equal(broker.resourceOwners.get("attachment\0" + path), owner);
});

test("same-family overlapping retained cleanup dispatches one delete and preserves its claim", async () => {
  const { broker, upstream, respond, attach } = scopedCleanupFixture();
  const owner = attach("family");
  const path = "/attachments/review-concurrent.png";
  const key = `attachment\0${path}`;
  broker.resourceOwners.set(key, owner);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "gateway/attachments/retain", params: { threadId: "deleted-thread", paths: [path] },
  }));
  assert.equal(owner.messages.at(-1).result.retained, true);
  const binding = broker.retainedAttachmentBindings.get(key);

  const first = broker.discardRetainedAttachments(owner, "deleted-thread", [path]);
  const read = upstream.at(-1);
  assert.equal(read.method, "thread/read");
  assert.equal(binding.cleaning, true);

  const beforeDirectDelete = upstream.length;
  broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "attachment/delete", params: { path } }));
  assert.equal(owner.messages.at(-1).error.code, -32048, "direct delete cannot bypass an in-flight scoped cleanup");
  assert.equal(upstream.length, beforeDirectDelete);

  const overlapping = await broker.discardRetainedAttachments(owner, "deleted-thread", [path]);
  assert.deepEqual(overlapping, { cleared: [], pending: [path] });
  assert.equal(upstream.filter(frame => frame.method === "thread/read").length, 1);

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "gateway/attachments/retain", params: { threadId: "deleted-thread", paths: [path] },
  }));
  assert.equal(owner.messages.at(-1).error.code, -32049, "retain during cleanup must not report a soon-to-be-deleted path as durable");
  assert.equal(broker.retainedAttachmentBindings.get(key), binding, "idempotent retain must preserve the in-flight binding object");
  assert.equal(binding.cleaning, true, "retain must not clear the active cleanup claim");

  respond(read, { error: { code: -32021, message: "persisted thread not found: deleted-thread" } });
  await new Promise(resolve => setImmediate(resolve));
  const deletion = upstream.at(-1);
  assert.equal(deletion.method, "attachment/delete");
  assert.equal(deletion.params.path, path);
  assert.equal(upstream.filter(frame => frame.method === "attachment/delete").length, 1);
  respond(deletion, { result: { removed: true } });
  assert.deepEqual(await first, { cleared: [path], pending: [] });
  assert.equal(binding.cleared, true);
  assert.equal(binding.cleaning, false);

  // A cleared path is a tombstone: a delayed/replayed retain cannot replace it.
  broker.resourceOwners.set(key, owner);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "gateway/attachments/retain", params: { threadId: "deleted-thread", paths: [path] },
  }));
  assert.equal(owner.messages.at(-1).error.code, -32048);
  assert.equal(broker.retainedAttachmentBindings.get(key), binding);
  broker.clearTransientState();
});

test("reconnected owners cannot bypass scoped discard with direct attachment/delete", async () => {
  const { broker, upstream, respond, attach } = scopedCleanupFixture();
  const owner = attach("family");
  const sameFamily = attach("family");
  const foreignFamily = attach("foreign-family");
  const path = "/attachments/review-reconnected.png";
  broker.resourceOwners.set(`attachment\0${path}`, owner);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "gateway/attachments/retain", params: { threadId: "deleted-thread", paths: [path] },
  }));
  assert.equal(owner.messages.at(-1).result.retained, true);
  broker.detach(owner);

  const before = upstream.length;
  broker.receive(sameFamily, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "attachment/delete", params: { path } }));
  assert.equal(sameFamily.messages.at(-1).error.code, -32048);
  broker.receive(foreignFamily, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "attachment/delete", params: { path } }));
  assert.equal(foreignFamily.messages.at(-1).error.code, -32048);
  assert.equal(upstream.length, before, "direct deletion by either reconnected owner must not reach app-server");

  const cleanup = broker.discardRetainedAttachments(sameFamily, "deleted-thread", [path]);
  const read = upstream.at(-1);
  assert.equal(read.method, "thread/read");
  respond(read, { error: { code: -32021, message: "persisted thread not found: deleted-thread" } });
  await new Promise(resolve => setImmediate(resolve));
  const deletion = upstream.at(-1);
  assert.equal(deletion.method, "attachment/delete", "only the scoped discard path may delete for a reconnected client");
  respond(deletion, { result: { removed: true } });
  assert.deepEqual(await cleanup, { cleared: [path], pending: [] });
  broker.clearTransientState();
});
