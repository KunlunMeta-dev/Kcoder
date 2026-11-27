import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { brokerFixture, fakeClient, validInitializeParams } from './workspace-app-server-broker.test-support.js';

// Multiplexed ownership: request IDs, thread owners, staged and retained
// attachments, creation compensation, interactions, resource sessions and terminals.

test("multiplexes request ids, caches initialize, and routes thread requests to their owner", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  broker.attach(first);
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: validInitializeParams() }));
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
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: validInitializeParams() }));
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

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 33, method: "turn/receipt/read",
    params: { threadId: "thread-a", retryOperationId: "retry-a" },
  }));
  assert.equal(upstream.at(-1).method, "turn/receipt/read", "receipt lookup must not claim execution ownership");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: {
    receipt: { threadId: "thread-a", turnId: "turn-1", status: "completed" },
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.messages.at(-1).id, 33);
  assert.equal(second.messages.at(-1).result.receipt.status, "completed");
  assert.notEqual(first.messages.at(-1).id, 33);

  broker.receive(second, JSON.stringify({
    jsonrpc: "2.0", id: 331, method: "turn/steer/receipt/read",
    params: { threadId: "thread-a", clientMessageId: "steer-a" },
  }));
  assert.equal(upstream.at(-1).method, "turn/steer/receipt/read", "mailbox observation must not claim execution ownership");
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { receipt: null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.messages.at(-1).id, 331);

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
  assert.equal(intruder.messages.at(-1).error.code, -32048);

  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "attachment/upload/finish", params: { upload_id: "upload-owned" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { path: "/attachments/large.bin" } });
  broker.detach(owner);
  const cleanup = upstream.at(-1);
  assert.equal(cleanup.jsonrpc, "2.0");
  assert.notEqual(cleanup.id, undefined);
  assert.equal(cleanup.method, "attachment/delete");
  assert.deepEqual(cleanup.params, { path: "/attachments/large.bin" });
  assert.equal(broker.pending.get(cleanup.id)?.client, null);
  respond({ jsonrpc: "2.0", id: cleanup.id, result: {} });
  assert.equal(broker.pending.has(cleanup.id), false);
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
  assert.equal(intruder.messages.at(-1).error.code, -32048);
});

for (const method of ["turn/start", "turn/steer"]) test(`rejects ${method} that references another client's staged attachment`, () => {
  const { broker, upstream, respond } = brokerFixture();
  const owner = fakeClient();
  const intruder = fakeClient();
  broker.attach(owner);
  broker.attach(intruder);
  broker.receive(owner, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "attachment/save", params: { filename: "secret.txt", content_base64: "c2VjcmV0" },
  }));
  respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { path: "/attachments/private-secret.txt" } });

  const text = '<kcoder_attachments version="1">\n{"filename":"secret.txt","path":"/attachments/private-secret.txt"}\n</kcoder_attachments>';
  const before = upstream.length;
  broker.receive(intruder, JSON.stringify({
    jsonrpc: "2.0", id: 2, method,
    params: {
      threadId: "intruder-thread",
      ...(method === "turn/steer" ? { text, prompt: "ignored by Native steer" } : { input: [{ type: "text", text }] }),
    },
  }));
  assert.equal(upstream.length, before);
  assert.equal(intruder.messages.at(-1).error.code, -32048);
});

for (const binding of ["same-task", "another-task", "unclaimed"]) test(`steer durable attachment admission: ${binding}`, () => {
  const { broker, upstream } = brokerFixture();
  const client = fakeClient();
  client.authorizationOwner = "owned-device";
  broker.attach(client);
  const path = `/private/draft-attachments/d-${"a".repeat(64)}/content/photo.png`;
  const key = `attachment\0${path}`;
  if (binding !== "unclaimed") {
    broker.resourceOwners.set(key, client);
    broker.retainedAttachmentBindings.set(key, { threadId: binding === "same-task" ? "thread-a" : "thread-b", owner: client.authorizationOwner });
  }
  const before = upstream.length;
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/steer", params: {
    threadId: "thread-a", text: `<kcoder_attachments version="1">\n${JSON.stringify({ path })}\n</kcoder_attachments>`,
  } }));
  assert.equal(upstream.length - before, binding === "same-task" ? 1 : 0);
  if (binding !== "same-task") assert.equal(client.messages.at(-1).error.code, -32048);
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
  assert.equal(intruder.messages.at(-1).error.code, -32048);

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
  assert.equal(owner.messages.at(-1).error.code, -32048);
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
  assert.equal(intruder.messages.at(-1).error.code, -32048);
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

test("compensates successful thread and resource creation responses with identified internal requests", async () => {
  const cases = [
    {
      method: "thread/start",
      params: {},
      result: { thread: { id: "thread-orphan" } },
      cleanup: { method: "thread/delete", params: { threadId: "thread-orphan" } },
    },
    {
      method: "thread/fork",
      params: { threadId: "thread-source", lastTurnId: "turn-ephemeral" },
      result: { thread: { id: "thread-ephemeral-orphan" }, ephemeral: true },
      cleanup: { method: "thread/dispose", params: { threadId: "thread-ephemeral-orphan" } },
      cleanupResponse: { error: { code: -32004, message: "already disposed" } },
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
    {
      method: "knowledge/export",
      params: {},
      result: { path: "/attachments/export-orphan.md" },
      cleanup: { method: "attachment/delete", params: { path: "/attachments/export-orphan.md" } },
    },
    {
      method: "knowledge/markdown/export",
      params: {},
      result: { path: "/attachments/markdown-orphan.md" },
      cleanup: { method: "attachment/delete", params: { path: "/attachments/markdown-orphan.md" } },
    },
    {
      method: "knowledge/source/directoryStage",
      params: {},
      result: { items: [{ attachmentPath: "/attachments/directory-orphan.md" }] },
      cleanup: { method: "attachment/delete", params: { path: "/attachments/directory-orphan.md" } },
    },
    {
      method: "attachment/upload/start",
      params: { filename: "orphan.bin", size: 1 },
      result: { upload_id: "upload-orphan" },
      cleanup: { method: "attachment/upload/cancel", params: { upload_id: "upload-orphan" } },
    },
    {
      method: "attachment/upload/finish",
      params: { upload_id: "upload-finish-orphan" },
      prepare: ({ broker, client, upstream, respond }) => {
        broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 10,
          method: "attachment/upload/start", params: { filename: "finish.bin", size: 1 } }));
        respond({ jsonrpc: "2.0", id: upstream.at(-1).id, result: { upload_id: "upload-finish-orphan" } });
      },
      result: { path: "/attachments/upload-finish-orphan.bin" },
      cleanup: { method: "attachment/delete", params: { path: "/attachments/upload-finish-orphan.bin" } },
      cleanupOnDetach: { method: "attachment/upload/cancel", params: { upload_id: "upload-finish-orphan" } },
    },
  ];

  for (const testCase of cases) {
    const { broker, upstream, respond } = brokerFixture();
    const client = fakeClient(testCase.channel);
    broker.attach(client);
    testCase.prepare?.({ broker, client, upstream, respond });
    client.messages.length = 0;
    broker.receive(client, JSON.stringify({
      jsonrpc: "2.0", id: 1, method: testCase.method, params: testCase.params,
    }));
    const requestId = upstream.at(-1).id;

    const cleanupStart = upstream.length;
    broker.detach(client);
    assert.equal(broker.pending.has(requestId), true, `${testCase.method} must leave a tombstone`);
    respond({ jsonrpc: "2.0", id: requestId, result: testCase.result });
    await new Promise(resolve => setImmediate(resolve));

    const cleanupRequest = upstream.at(-1);
    assert.equal(cleanupRequest.jsonrpc, "2.0");
    assert.notEqual(cleanupRequest.id, undefined, `${testCase.cleanup.method} must be an identified request`);
    assert.notEqual(cleanupRequest.id, requestId, "cleanup uses its own upstream request ID");
    assert.equal(cleanupRequest.method, testCase.cleanup.method);
    assert.deepEqual(cleanupRequest.params, testCase.cleanup.params);
    const cleanupPending = broker.pending.get(cleanupRequest.id);
    assert.ok(cleanupPending, "the internal response must be tracked until completion");
    assert.equal(cleanupPending.client, null, "internal cleanup must not retain the disconnected client");
    assert.equal(cleanupPending.clientId, null, "internal cleanup must not route a client ID");
    assert.equal(cleanupPending.method, cleanupRequest.method);
    assert.deepEqual(cleanupPending.params, cleanupRequest.params);
    assert.equal(cleanupPending.internalRequestTimer.hasRef(), false,
      "internal requests must not keep the broker process alive");
    const expectedCleanup = [
      ...(testCase.cleanupOnDetach ? [testCase.cleanupOnDetach] : []),
      testCase.cleanup,
    ];
    const cleanupRequests = upstream.slice(cleanupStart);
    assert.deepEqual(cleanupRequests.map(({ method, params }) => ({ method, params })),
      expectedCleanup, `${testCase.method} must send each required cleanup request exactly once`);
    assert.equal(broker.pending.has(requestId), false);
    assert.equal(broker.threadOwners.size, 0);
    assert.equal(broker.resourceOwners.size, 0);
    assert.deepEqual(client.messages, []);

    for (const request of cleanupRequests) {
      const internalPending = broker.pending.get(request.id);
      assert.ok(internalPending);
      assert.equal(internalPending.client, null);
      assert.equal(internalPending.clientId, null);
      respond({ jsonrpc: "2.0", id: request.id,
        ...(request.id === cleanupRequest.id && testCase.cleanupResponse
          ? testCase.cleanupResponse : { result: {} }) });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(broker.pending.has(request.id), false, "cleanup response must be consumed internally");
      assert.equal(internalPending.internalRequestTimer, null, "response must clear the timeout handle");
    }
    assert.equal(broker.pending.has(requestId), false);
    assert.equal(broker.threadOwners.size, 0);
    assert.equal(broker.resourceOwners.size, 0);
    assert.deepEqual(client.messages, []);
  }
});

test("internal cleanup timeout releases pending work, reschedules idle, and ignores a late reply", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const idleStates = [];
  const { broker, upstream, respond } = brokerFixture({
    onIdleStateChange: current => idleStates.push(current.hasPendingWork),
  });
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "thread/start", params: {} }));
  const createId = upstream.at(-1).id;
  broker.detach(client);
  respond({ jsonrpc: "2.0", id: createId, result: { thread: { id: "thread-timeout-orphan" } } });

  const cleanupRequest = upstream.at(-1);
  const cleanupPending = broker.pending.get(cleanupRequest.id);
  assert.equal(cleanupRequest.method, "thread/delete");
  assert.equal(cleanupPending.client, null);
  assert.equal(broker.hasPendingWork, true);
  assert.deepEqual(idleStates, [true], "adding internal work must defer an idle release");

  t.mock.timers.tick(30_000);
  assert.equal(cleanupPending.internalRequestTimer, null);
  assert.equal(broker.pending.has(cleanupRequest.id), false);
  assert.equal(broker.hasPendingWork, false);
  assert.deepEqual(idleStates, [true, false], "timeout must make the broker idle-eligible again");

  respond({ jsonrpc: "2.0", id: cleanupRequest.id, result: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.pending.size, 0, "late cleanup replies must be ignored");
  assert.deepEqual(client.messages, [], "cleanup must never produce a disconnected-client response");
  assert.deepEqual(idleStates, [true, false]);
});

test("internal cleanup write failure and clearTransientState clear their timers", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { broker, child, upstream, respond } = brokerFixture();
  const client = fakeClient();
  broker.attach(client);
  broker.receive(client, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "attachment/save", params: {} }));
  const createId = upstream.at(-1).id;
  broker.detach(client);
  child.stdin.destroy();
  respond({ jsonrpc: "2.0", id: createId, result: { path: "/attachments/write-failed.png" } });
  assert.equal(upstream.length, 1, "a destroyed stdin must reject the cleanup write");
  assert.equal(broker.pending.size, 0, "failed writes must not leave pending requests");
  assert.equal(broker.hasPendingWork, false);
  assert.deepEqual(client.messages, []);

  child.stdin = new PassThrough();
  const id = broker.sendInternalRequest("attachment/delete", { path: "/attachments/cleared.png" });
  const pending = broker.pending.get(id);
  assert.ok(pending.internalRequestTimer);
  broker.clearTransientState();
  assert.equal(broker.pending.size, 0);
  assert.equal(pending.internalRequestTimer, null);
  t.mock.timers.tick(30_000);
  assert.equal(broker.pending.size, 0, "cleared timers must not recreate work");
});

test("late modern clients receive run summaries even when the first shared client was legacy", () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const legacy = fakeClient(); const modern = fakeClient(); broker.attach(legacy); broker.attach(modern);
  broker.receive(legacy, JSON.stringify({ id: 1, method: "initialize", params: validInitializeParams() }));
  assert.equal(upstream[0].params.capabilities.experimental.threadRunSummaryV1, true);
  respond({ id: upstream[0].id, result: { capabilities: { experimental: { residentThreads: true, threadRunSummaryV1: true } } } });
  broker.receive(modern, JSON.stringify({ id: 2, method: "initialize", params: { ...validInitializeParams(), capabilities: { experimental: { threadRunSummaryV1: true } } } }));
  const thread = { id: "thread-1", status: "waiting_for_approval", runSummary: { mainTurn: "running", pendingApprovals: 1, recentError: null } };
  for (const [client, id] of [[legacy, 10], [modern, 11]]) {
    broker.receive(client, JSON.stringify({ id, method: "thread/list", params: {} }));
    respond({ id: upstream.at(-1).id, result: { threads: [thread] } });
  }
  assert.deepEqual(modern.messages.at(-1).result.threads, [thread]);
  assert.deepEqual(legacy.messages.at(-1).result.threads, [{ id: "thread-1", status: "running" }]);
  assert.equal(thread.runSummary.pendingApprovals, 1, "per-client projection must not mutate the authoritative payload");
});

test("fans out one concurrent initialize and only broadcasts workspace-level notifications", async () => {
  const { broker, upstream, respond } = brokerFixture();
  const first = fakeClient();
  const second = fakeClient();
  broker.attach(first);
  broker.attach(second);
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: validInitializeParams() }));
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 8, method: "initialize", params: validInitializeParams() }));
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
  broker.receive(first, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: validInitializeParams() }));
  assert.equal(upstream.length, 1);
  broker.detach(first);

  const second = fakeClient();
  broker.attach(second);
  broker.receive(second, JSON.stringify({ jsonrpc: "2.0", id: 8, method: "initialize", params: validInitializeParams() }));
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

test("replays a completed interaction only for its owner without disturbing a later pending approval", async () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const owner = fakeClient(); const stranger = fakeClient();
  broker.attach(owner); broker.attach(stranger);
  broker.threadOwners.set("owned-thread", owner);
  respond({ jsonrpc: "2.0", id: 9001, method: "approval/request", params: { threadId: "owned-thread", turnId: "turn-1", approvalId: "first" } });
  const reply = { jsonrpc: "2.0", id: 9001, result: { decision: "accept", threadId: "owned-thread", turnId: "turn-1", approvalId: "first" } };
  broker.receive(owner, JSON.stringify(reply));
  respond({ jsonrpc: "2.0", id: 9002, method: "approval/request", params: { threadId: "owned-thread", turnId: "turn-2", approvalId: "second" } });
  assert.doesNotThrow(() => broker.receive(owner, JSON.stringify(reply)));
  assert.deepEqual(upstream.at(-1), reply, "backend receipt handles the same old interaction id");
  assert.equal(broker.serverRequests.get(9002), owner, "new approval remains pending");
  assert.equal(broker.requestLoad.total.inFlight, 0, "interaction responses are not outbound requests waiting for replies");
  assert.throws(() => broker.receive(stranger, JSON.stringify(reply)), /another client/);
  broker.detach(owner);
  assert.equal(broker.repliedServerRequests.size, 0, "connection release removes replay authority");
});

test("forwards approval and question resolved notifications unchanged to their thread owner", () => {
  const { broker, respond } = brokerFixture({ residentThreads: true });
  const owner = fakeClient(); const peer = fakeClient();
  broker.attach(owner); broker.attach(peer);
  broker.threadOwners.set("owned-thread", owner);
  const notifications = [
    {
      jsonrpc: "2.0",
      method: "approval/resolved",
      params: {
        requestId: 9001,
        approvalId: "approval-9001",
        threadId: "owned-thread",
        turnId: "turn-1",
        appServerEpoch: "epoch-1",
        decision: "accept",
        reason: "client_response",
      },
    },
    {
      jsonrpc: "2.0",
      method: "question/resolved",
      params: {
        requestId: 9002,
        questionId: "question-9002",
        threadId: "owned-thread",
        turnId: "turn-2",
        appServerEpoch: "epoch-1",
        reason: "client_response",
      },
    },
  ];

  for (const notification of notifications) {
    respond(notification);
    assert.deepEqual(owner.messages.at(-1), notification);
    assert.equal(Object.hasOwn(owner.messages.at(-1).params, "serverId"), false);
    assert.deepEqual(peer.messages, []);
  }
});

test("bounds replied interaction ownership and still rejects unknown replies", () => {
  const { broker, respond } = brokerFixture({ residentThreads: true });
  const owner = fakeClient(); broker.attach(owner); broker.threadOwners.set("bounded", owner);
  for (let id = 10000; id < 10513; id++) {
    respond({ jsonrpc: "2.0", id, method: "approval/request", params: { threadId: "bounded" } });
    broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id, result: { decision: "decline" } }));
  }
  assert.equal(broker.repliedServerRequests.size, 512);
  assert.equal(broker.repliedServerRequests.has(10000), false);
  assert.equal(broker.repliedServerRequests.has(10512), true);
  assert.equal(broker.requestLoad.total.inFlight, 0);
  assert.throws(() => broker.receive(owner, JSON.stringify({ jsonrpc: "2.0", id: 999999, result: {} })), /unsolicited/);
  broker.detach(owner);
  assert.equal(broker.repliedServerRequests.size, 0);
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
  assert.equal(second.messages.at(-1).error.code, -32048);
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
  const cleanup = upstream.at(-1);
  assert.equal(cleanup.jsonrpc, "2.0");
  assert.notEqual(cleanup.id, undefined);
  assert.equal(cleanup.method, "attachment/delete");
  assert.deepEqual(cleanup.params, { path: "/attachments/unsent.png" });
  assert.equal(broker.pending.get(cleanup.id)?.client, null);
  respond({ jsonrpc: "2.0", id: cleanup.id, result: {} });
  assert.equal(broker.pending.has(cleanup.id), false);
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
  assert.equal(competitor.messages.at(-1).error.code, -32049);

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
  assert.equal(competitor.messages.at(-1).error.code, -32048);

  const beforeDuplicateAttach = upstream.length;
  broker.receive(attaching, JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "terminal/attach", params: { session_id: "resident-terminal" },
  }));
  assert.equal(upstream.length, beforeDuplicateAttach, "even the claimant cannot overlap a second attach");
  assert.equal(attaching.messages.at(-1).error.code, -32048);

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
