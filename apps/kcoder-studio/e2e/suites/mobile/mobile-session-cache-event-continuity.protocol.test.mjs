import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptMessages,
  isExactTurnStartNotification,
  isCompletedTurnNotification,
  loadSharedTurnMessageStatusDecoder,
  matchesExactHistoryReadResponse,
  matchesExactResumeResponse,
  matchesExactTurnNotification,
  matchesPostTerminalHistoryAuthority,
  notificationServerIdFromInitializeResponse,
  parseRpcFrame,
  readPageMessages,
  resumePageMessages,
} from "./mobile-session-cache-event-continuity.protocol.mjs";

test("the shared turn-message decoder treats legacy omission and terminal aliases correctly", async () => {
  const decode = await loadSharedTurnMessageStatusDecoder();
  assert.deepEqual(decode(undefined), { status: "done" });
  assert.deepEqual(decode("complete"), { status: "done" });
  assert.deepEqual(decode("completed"), { status: "done" });
  assert.deepEqual(decode("done"), { status: "done" });
  assert.deepEqual(decode("unknown"), { status: "unknown", rawStatus: "unknown" });
  assert.deepEqual(decode("failed"), { status: "failed" });
  assert.deepEqual(decode("cancelled"), { status: "cancelled" });
});

test("resume response correlation requires the exact socket, request id, and thread", () => {
  const request = { id: "resume-7", method: "thread/resume", params: { threadId: "thread-a" } };
  const response = { jsonrpc: "2.0", id: "resume-7", result: { thread: { id: "thread-a" } } };
  const expected = { socketId: "rpc-2", expectedSocketId: "rpc-2", request, response, threadId: "thread-a" };

  assert.equal(matchesExactResumeResponse(expected), true);
  assert.equal(matchesExactResumeResponse({ ...expected, socketId: "rpc-3" }), false);
  assert.equal(matchesExactResumeResponse({ ...expected, response: { ...response, id: 7 } }), false);
  assert.equal(matchesExactResumeResponse({ ...expected, threadId: "thread-b" }), false);
  assert.equal(matchesExactResumeResponse({ ...expected, response: { ...response, result: { thread: { id: "thread-b" } } } }), false);
  assert.equal(matchesExactResumeResponse({ ...expected, response: { ...response, error: { code: -1 } } }), false);
});

test("stream and completion matching bind upstream identity and any supplied attempt on the exact held socket", () => {
  const routeServerId = "local";
  const notificationServerId = "server-session-a";
  const identity = {
    serverId: notificationServerId,
    threadId: "thread-a",
    turnId: "turn-4",
    attemptId: "attempt-4",
    socketId: "rpc-2",
    expectedSocketId: "rpc-2",
  };
  const completed = {
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      serverId: notificationServerId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      sequence: 27,
      turn: { id: identity.turnId, threadId: identity.threadId, status: "completed" },
    },
  };

  assert.notEqual(routeServerId, notificationServerId,
    "the Gateway route alias and Rust app-server notification identity are separate domains");
  assert.equal(matchesExactTurnNotification(completed, identity), true);
  assert.equal(isCompletedTurnNotification(completed, identity), true);
  assert.equal(matchesExactTurnNotification(completed, { ...identity, serverId: "peer" }), false);
  assert.equal(matchesExactTurnNotification(completed, { ...identity, threadId: "peer-thread" }), false);
  assert.equal(matchesExactTurnNotification(completed, { ...identity, turnId: "other-turn" }), false);
  assert.equal(matchesExactTurnNotification(completed, { ...identity, attemptId: "peer-attempt" }), false);
  assert.equal(matchesExactTurnNotification(completed, { ...identity, socketId: "rpc-peer" }), false);
  assert.equal(matchesExactTurnNotification({
    ...completed,
    params: { ...completed.params, attemptId: "peer-attempt" },
  }, identity), false, "a supplied attempt identity must match the acknowledged attempt");
  assert.equal(matchesExactTurnNotification({
    ...completed,
    params: {
      ...completed.params,
      turn: { ...completed.params.turn, attemptId: "peer-attempt" },
    },
  }, identity), false, "a nested supplied attempt identity must match the acknowledged attempt");
  assert.equal(isCompletedTurnNotification({
    ...completed,
    params: {
      ...completed.params,
      turn: { ...completed.params.turn, attemptId: "peer-attempt" },
    },
  }, identity), false, "a terminal with a mismatched nested attempt must be rejected");
  assert.equal(isCompletedTurnNotification({
    ...completed,
    params: {
      ...completed.params,
      turn: { ...completed.params.turn, attemptId: identity.attemptId },
    },
  }, identity), true, "a nested matching attempt remains valid when a terminal includes it");
  const eventWithoutAttemptField = {
    ...completed,
    method: "item/delta",
    params: Object.fromEntries(Object.entries(completed.params).filter(([key]) => key !== "attemptId")),
  };
  assert.equal(matchesExactTurnNotification(eventWithoutAttemptField, identity), true,
    "stream events without an attempt field still bind through exact server, thread, turn, and held socket");
  const completedWithoutAttempt = {
    ...completed,
    params: Object.fromEntries(Object.entries(completed.params).filter(([key]) => key !== "attemptId")),
  };
  assert.equal(isCompletedTurnNotification(completedWithoutAttempt, identity), true,
    "an ACK-bound terminal may correlate by exact turn identity when the current wire omits attemptId");
  assert.equal(isCompletedTurnNotification({ ...completed, params: { ...completed.params, turn: { ...completed.params.turn, status: "running" } } }, identity), false);

  const started = {
    jsonrpc: "2.0",
    method: "turn/started",
    params: {
      serverId: notificationServerId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      turn: { id: identity.turnId, threadId: identity.threadId, status: "running" },
    },
  };
  assert.equal(isExactTurnStartNotification(started, identity), true);
  assert.equal(isExactTurnStartNotification(started, { ...identity, socketId: "rpc-peer" }), false);
  assert.equal(isExactTurnStartNotification(started, { ...identity, threadId: "peer-thread" }), false);
  assert.equal(isExactTurnStartNotification(started, { ...identity, turnId: "other-turn" }), false);
  assert.equal(isExactTurnStartNotification(started, { ...identity, attemptId: "peer-attempt" }), false);
  assert.equal(isExactTurnStartNotification({
    ...started,
    params: { ...started.params, attemptId: "peer-attempt" },
  }, identity), false);
  assert.equal(isExactTurnStartNotification({ ...started, params: { ...started.params, serverId: "" } }, identity), false);
  assert.equal(isExactTurnStartNotification({ ...started, id: "unexpected-request" }, identity), false);
});

test("initialize response derives only the actual upstream notification identity", () => {
  assert.equal(notificationServerIdFromInitializeResponse({
    jsonrpc: "2.0",
    id: "initialize-1",
    result: { serverInfo: { sessionId: "session-a" } },
  }), "server-session-a");
  assert.equal(notificationServerIdFromInitializeResponse({
    jsonrpc: "2.0",
    id: "initialize-1",
    error: { code: -1 },
  }), null);
  assert.equal(notificationServerIdFromInitializeResponse({
    jsonrpc: "2.0",
    id: "initialize-1",
    result: { serverInfo: {} },
  }), null);
  assert.equal(notificationServerIdFromInitializeResponse({
    jsonrpc: "2.0",
    result: { serverInfo: { sessionId: "session-a" } },
  }), null);
});

test("terminal history authority requires the held runtime socket and exact server/workspace/thread response", () => {
  const socket = {
    socketId: "rpc-2",
    serverId: "local",
    channel: "runtime",
    workspace: "/owned/workspace",
  };
  const request = { id: 19, method: "thread/read/indexed", params: { threadId: "thread-a" } };
  const response = {
    jsonrpc: "2.0",
    id: 19,
    result: { thread: { id: "thread-a" }, messages: [] },
  };
  const expected = {
    socketId: "rpc-2",
    expectedSocketId: "rpc-2",
    socket,
    request,
    response,
    serverId: "local",
    workspace: "/owned/workspace",
    threadId: "thread-a",
  };

  assert.equal(matchesExactHistoryReadResponse(expected), true);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, socketId: "rpc-3" }), false);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, expectedSocketId: "rpc-3" }), false);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, socket: { ...socket, serverId: "peer" } }), false);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, socket: { ...socket, channel: "control" } }), false);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, socket: { ...socket, workspace: "/other/workspace" } }), false);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, response: { ...response, id: "19" } }), false);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, response: { ...response, result: { ...response.result, thread: { id: "peer-thread" } } } }), false);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, request: { ...request, params: { threadId: "peer-thread" } } }), false);
  assert.equal(matchesExactHistoryReadResponse({ ...expected, response: { ...response, error: { code: -1 } } }), false);
});

test("terminal authority must correlate to its own post-terminal read request", () => {
  const request = {
    id: "read-before-terminal",
    method: "thread/read/indexed",
    threadId: "thread-a",
    socketId: "rpc-2",
    serverId: "local",
    channel: "runtime",
    workspace: "/owned/workspace",
    sentAtMs: 90,
  };
  const unrelatedPostTerminalRequest = {
    ...request,
    id: "other-read-after-terminal",
    sentAtMs: 110,
  };
  const response = {
    requestId: request.id,
    responseId: request.id,
    responseIdMatched: true,
    method: request.method,
    socketId: request.socketId,
    serverId: request.serverId,
    channel: request.channel,
    workspace: request.workspace,
    responseThreadId: "thread-a",
    receivedAtMs: 120,
    containsActorAttempt: true,
    matchesHeldResumeSocketAndScope: true,
  };
  const expected = {
    response,
    requests: [request, unrelatedPostTerminalRequest],
    terminalAtMs: 100,
    socketId: "rpc-2",
    serverId: "local",
    workspace: "/owned/workspace",
    threadId: "thread-a",
  };

  assert.equal(matchesPostTerminalHistoryAuthority(expected), false,
    "a pre-terminal authority response cannot borrow an unrelated later read request to pass");
  assert.equal(matchesPostTerminalHistoryAuthority({
    ...expected,
    response: { ...response, requestId: unrelatedPostTerminalRequest.id, responseId: unrelatedPostTerminalRequest.id },
  }), true,
    "authority passes when its own exact request was sent after the terminal event");
  assert.equal(matchesPostTerminalHistoryAuthority({
    ...expected,
    response: { ...response, receivedAtMs: 99, requestId: unrelatedPostTerminalRequest.id, responseId: unrelatedPostTerminalRequest.id },
  }), false,
    "a same-id response arriving before the terminal event cannot count as post-terminal authority");
});

test("resume and terminal read pages preserve authority identity instead of guessing row ids", () => {
  const seed = { id: "seed-row", role: "user", content: "seed", turnId: "seed-turn", attemptId: "seed-attempt" };
  const user = { id: "actual-user-row", role: "user", content: "INJECTED_MARKER", turnId: "actual-turn", attemptId: "actual-attempt" };
  const assistant = { id: "actual-assistant-row", role: "assistant", content: "FINAL_BODY", turnId: "actual-turn", attemptId: "actual-attempt" };
  const staleResume = {
    result: { history: { status: "ready", page: { messages: [seed] } } },
  };
  const authoritativeRead = { result: { messages: [seed, user, assistant] } };

  assert.deepEqual(resumePageMessages(staleResume), [seed]);
  assert.deepEqual(readPageMessages(authoritativeRead), [seed, user, assistant]);
  assert.deepEqual(attemptMessages(readPageMessages(authoritativeRead), { turnId: "actual-turn", attemptId: "actual-attempt", role: "assistant" }), [assistant]);
  assert.deepEqual(attemptMessages(readPageMessages(authoritativeRead), { turnId: "actual-turn", attemptId: "wrong-attempt", role: "assistant" }), []);
  assert.equal(resumePageMessages({ result: { history: { status: "unavailable" } } }), null);
});

test("frame parser accepts wire text and bytes without retaining malformed or array frames", () => {
  const frame = { jsonrpc: "2.0", id: 3, method: "thread/resume", params: { threadId: "thread-a" } };
  const encoded = JSON.stringify(frame);
  assert.deepEqual(parseRpcFrame(encoded), frame);
  assert.deepEqual(parseRpcFrame(Buffer.from(encoded)), frame);
  assert.equal(parseRpcFrame("not-json"), null);
  assert.equal(parseRpcFrame("[]"), null);
});
