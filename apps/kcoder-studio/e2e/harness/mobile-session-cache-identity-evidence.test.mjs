import assert from "node:assert/strict";
import test from "node:test";
import {
  projectClientMessageIdEvidence,
  projectMessageIdentityTuples,
  projectProtocolRpcRequests,
} from "./mobile-session-cache-identity-evidence.mjs";

const runKey = Buffer.alloc(32, 0x5a);

test("projects equal explicit Mobile IDs to one per-run HMAC without retaining text", () => {
  const start = projectClientMessageIdEvidence("mobile-run-owned-id", runKey);
  const [message] = projectMessageIdentityTuples([{
    id: "canonical-user-message",
    role: "user",
    turnId: "turn-1",
    attemptId: "turn-1",
    clientMessageId: "mobile-run-owned-id",
    content: "private prompt text",
    credential: "private credential",
  }], runKey);

  assert.deepEqual(start, {
    clientMessageIdHmacSha256: message.clientMessageIdHmacSha256,
    clientMessageIdExplicit: true,
  });
  assert.match(start.clientMessageIdHmacSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(message).includes("mobile-run-owned-id"), false);
  assert.equal(JSON.stringify(message).includes("private prompt text"), false);
  assert.equal(JSON.stringify(message).includes("private credential"), false);
});

test("marks missing, invalid and overlong IDs as not explicit without hashing them", () => {
  for (const value of [undefined, null, "", 17, "x".repeat(4097)]) {
    assert.deepEqual(projectClientMessageIdEvidence(value, runKey), {
      clientMessageIdHmacSha256: null,
      clientMessageIdExplicit: false,
    });
  }
  assert.notEqual(
    projectClientMessageIdEvidence("same-id", runKey).clientMessageIdHmacSha256,
    projectClientMessageIdEvidence("same-id", Buffer.alloc(32, 0x6b)).clientMessageIdHmacSha256,
  );
});

test("RPC evidence retains only bounded routing fields and turn/start identity projection", () => {
  const evidence = projectProtocolRpcRequests([
    {
      method: "turn/start",
      threadId: "thread-1",
      socketOrdinal: 3,
      ...projectClientMessageIdEvidence("mobile-id", runKey),
      clientPromptMarkerPresent: true,
      params: { content: "private prompt", token: "private token" },
    },
    { method: "initialize", threadId: null, socketOrdinal: 2, token: "private token" },
  ]);

  assert.deepEqual(evidence[0], {
    method: "turn/start",
    threadId: "thread-1",
    socketOrdinal: 3,
    ...projectClientMessageIdEvidence("mobile-id", runKey),
    clientPromptMarkerPresent: true,
  });
  assert.deepEqual(evidence[1], { method: "initialize", threadId: null, socketOrdinal: 2 });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("mobile-id"), false);
  assert.equal(serialized.includes("private prompt"), false);
  assert.equal(serialized.includes("private token"), false);
});
