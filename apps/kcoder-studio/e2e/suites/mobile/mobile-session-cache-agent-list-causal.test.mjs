import assert from "node:assert/strict";
import test from "node:test";
import { createAgentListRequestGateV1 } from "./mobile-session-cache-agent-list-causal.mjs";

test("holds only the original agent/list request on the exact resumed socket, then forwards once", () => {
  const forwarded = [];
  const rootRestore = { threadId: "thread-a", request: { id: "1", method: "thread/resume", threadId: "thread-a", socketOrdinal: 7 } };
  const gate = createAgentListRequestGateV1({ rootRestore, threadId: "thread-a" });
  let lastRequest = null;
  const offer = (id, method, socketOrdinal, threadId = "thread-a", raw = JSON.stringify({ jsonrpc: "2.0", id, method,
    params: { threadId } })) => {
    lastRequest = { id: String(id), method, threadId, socketOrdinal };
    return gate.capture({ raw, frame: JSON.parse(raw), request: lastRequest,
      socketOrdinal, forward: () => forwarded.push(raw) });
  };

  assert.equal(offer(2, "agent/list", 8), false, "another socket is outside the owned thread route");
  assert.equal(offer(3, "initialize", 7), false);
  assert.equal(offer(4, "agent/list", 7, "thread-b"), false, "a peer thread must pass unchanged");
  const original = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "agent/list", params: { threadId: "thread-a" } });
  assert.equal(offer(5, "agent/list", 7, "thread-a", original), true);
  assert.equal(gate.snapshot().held, true);
  assert.equal(forwarded.length, 0, "holding a request must precede upstream.send");
  assert.equal(gate.release(), true);
  assert.deepEqual(forwarded, [original]);
  assert.equal(gate.release(), false);
  const response = JSON.stringify({ jsonrpc: "2.0", id: 5, result: { threadId: "thread-a", agents: [] } });
  assert.equal(gate.observeResponse({ raw: response, frame: JSON.parse(response), request: lastRequest,
    socketOrdinal: 7 }), true);
  assert.equal(gate.snapshot().responseSucceeded, true);
  assert.equal(gate.snapshot().requestForwarded, true);
  assert.equal(gate.snapshot().requestId, 5);
});

test("strict numeric ID, same socket and original request record reject misleading responses", () => {
  let forwards = 0;
  const gate = createAgentListRequestGateV1({ rootRestore: { threadId: "thread-a",
    request: { id: "1", method: "thread/resume", threadId: "thread-a", socketOrdinal: 7 },
  }, threadId: "thread-a" });
  const raw = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "agent/list", params: { threadId: "thread-a" } });
  const request = { id: "2", method: "agent/list", threadId: "thread-a", socketOrdinal: 7 };
  assert.equal(gate.capture({ raw, frame: JSON.parse(raw), request,
    socketOrdinal: 7, forward: () => { forwards += 1; } }), true);
  assert.equal(gate.release(), true);
  assert.equal(forwards, 1);
  for (const [id, socketOrdinal, responseRequest] of [["2", 7, request], [2, 8, request],
    [2, 7, { ...request }]]) {
    const response = JSON.stringify({ jsonrpc: "2.0", id, result: [] });
    assert.equal(gate.observeResponse({ raw: response, frame: JSON.parse(response), request: responseRequest,
      socketOrdinal }), false);
  }
  const matching = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { threadId: "thread-a", agents: [] } });
  assert.equal(gate.observeResponse({ raw: matching, frame: JSON.parse(matching), request, socketOrdinal: 7 }), true);
  assert.equal(gate.snapshot().responseSucceeded, true);
});

for (const [name, result] of [["wrong thread", { threadId: "thread-b", agents: [] }],
  ["missing agents", { threadId: "thread-a" }], ["missing thread", { agents: [] }]]) {
  test(`same-socket agent/list response with ${name} cannot pass the thread contract`, () => {
    const gate = createAgentListRequestGateV1({ rootRestore: { threadId: "thread-a",
      request: { id: "1", method: "thread/resume", threadId: "thread-a", socketOrdinal: 7 },
    }, threadId: "thread-a" });
    const request = { id: "2", method: "agent/list", threadId: "thread-a", socketOrdinal: 7 };
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "agent/list", params: { threadId: "thread-a" } });
    assert.equal(gate.capture({ raw, frame: JSON.parse(raw), request, socketOrdinal: 7,
      forward: () => {} }), true);
    assert.equal(gate.release(), true);
    const response = JSON.stringify({ jsonrpc: "2.0", id: 2, result });
    assert.equal(gate.observeResponse({ raw: response, frame: JSON.parse(response), request, socketOrdinal: 7 }), true);
    assert.equal(gate.snapshot().responseSucceeded, false);
  });
}

test("discarding an unforwarded request never replays it", () => {
  let forwards = 0;
  const gate = createAgentListRequestGateV1({ rootRestore: { threadId: "thread-a",
    request: { id: "1", method: "thread/resume", threadId: "thread-a", socketOrdinal: 7 },
  }, threadId: "thread-a" });
  const raw = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "agent/list", params: { threadId: "thread-a" } });
  assert.equal(gate.capture({ raw, frame: JSON.parse(raw),
    request: { id: "2", method: "agent/list", threadId: "thread-a", socketOrdinal: 7 },
    socketOrdinal: 7, forward: () => { forwards += 1; } }), true);
  assert.equal(gate.discard(), true);
  assert.equal(gate.release(), false);
  assert.equal(forwards, 0);
  assert.equal(gate.snapshot().discarded, true);
});
