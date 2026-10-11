import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { AppServerStdioClient } from "./app-server-stdio.mjs";

function createFakeChild() {
  const sent = [];
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      sent.push(chunk.toString("utf8"));
      callback();
    },
  });
  child.stdout = new PassThrough();
  return { child, sent };
}

function closeFakeChild(child) {
  child.emit("close", 0, null);
  child.stdin.destroy();
  child.stdout.destroy();
}

test("app-server JSONL client correlates ordinary replies", async () => {
  const { child, sent } = createFakeChild();
  const client = new AppServerStdioClient("stdio-test", child, { defaultTimeoutMs: 500 });
  const pending = client.request("attachment/save", { filename: "note.txt" });
  await new Promise(resolve => setImmediate(resolve));
  const request = JSON.parse(sent[0]);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { path: "/owned/note.txt" } })}\n`);

  assert.deepEqual(await pending, {
    jsonrpc: "2.0",
    id: request.id,
    result: { path: "/owned/note.txt" },
  });
  assert.deepEqual(client.discardedResponseIds, []);
  client.closeReader();
  closeFakeChild(child);
});

test("app-server JSONL client records a response sent without a caller waiter", async () => {
  const { child, sent } = createFakeChild();
  const client = new AppServerStdioClient("stdio-drop-test", child, { defaultTimeoutMs: 500 });
  const id = await client.sendWithoutWaitingForResponse("attachment/delete", { path: "/owned/note.txt" });
  const discarded = client.waitForDiscardedResponse(id);
  await new Promise(resolve => setImmediate(resolve));
  const request = JSON.parse(sent[0]);
  assert.equal(request.id, id);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { removed: true } })}\n`);

  assert.deepEqual(await discarded, {
    jsonrpc: "2.0",
    id,
    result: { removed: true },
  });
  assert.deepEqual(client.discardedResponseIds, [id]);
  client.closeReader();
  closeFakeChild(child);
});

test("app-server JSONL client waits for a matching notification without classifying it as a response", async () => {
  const { child } = createFakeChild();
  const client = new AppServerStdioClient("stdio-notification-test", child, { defaultTimeoutMs: 500 });
  const notification = {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: "thread-fixture", turnId: "turn-fixture", turn: { status: "completed" } },
  };
  child.stdout.write(`${JSON.stringify(notification)}\n`);

  assert.deepEqual(
    await client.waitForNotification(
      frame => frame.method === "turn/completed" && frame.params?.turnId === "turn-fixture",
      500,
      "seed turn completion",
    ),
    notification,
  );
  assert.deepEqual(client.discardedResponseIds, []);
  client.closeReader();
  closeFakeChild(child);
});

test("app-server JSONL client preserves typed RPC errors for the suite assertion", async () => {
  const { child, sent } = createFakeChild();
  const client = new AppServerStdioClient("stdio-error-test", child, { defaultTimeoutMs: 500 });
  const pending = client.request("attachment/delete", { path: "/foreign/path.txt" });
  await new Promise(resolve => setImmediate(resolve));
  const request = JSON.parse(sent[0]);
  const error = { code: -32602, message: "attachment was not staged by this app-server connection" };
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error })}\n`);

  assert.deepEqual((await pending).error, error);
  assert.deepEqual(client.discardedResponseIds, []);
  client.closeReader();
  closeFakeChild(child);
});

test("app-server JSONL client rejects malformed stdout frames", async () => {
  const { child, sent } = createFakeChild();
  const client = new AppServerStdioClient("stdio-malformed-test", child, { defaultTimeoutMs: 500 });
  const pending = client.request("initialize", {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  child.stdout.write("not-json\n");

  await assert.rejects(pending, /wrote a non-JSON frame to stdout/);
  client.closeReader();
  closeFakeChild(child);
});
