import assert from "node:assert/strict";
import test from "node:test";
import { confirmedCompletedTurnRows, createOwnerHandoffResumeGate, projectFullIdleRollbackAuthority,
  projectSafeOwnerHandoffFailure } from "./mobile-session-cache-owner-handoff-gate.mjs";

test("a post-completion same-socket indexed read confirms both exact canonical IDs", () => {
  const exact = { requestId: "7", threadId: "target", responseThreadId: "target",
    requestSocketOrdinal: 4, responseSocketOrdinal: 4, success: true,
    requestedAtMs: 21, receivedAtMs: 22,
    messageIdentities: [{ id: "u2", role: "user", turnId: "turn2" },
      { id: "a2", role: "assistant", turnId: "turn2" }] };
  const scope = { threadId: "target", socketOrdinal: 4, turnId: "turn2", completedAtMs: 20 };
  assert.deepEqual(confirmedCompletedTurnRows([exact], scope), {
    userId: "u2", assistantId: "a2", requestId: "7", requestedAtMs: 21 });
  for (const changed of [
    { requestedAtMs: 19 }, { success: false }, { responseThreadId: "peer" },
    { responseSocketOrdinal: 5 }, { receivedAtMs: 21 },
    { messageIdentities: [{ id: "u2", role: "user", turnId: "turn2" }] },
    { messageIdentities: [{ id: "u2", role: "user", turnId: "turn2" },
      { id: "u2", role: "assistant", turnId: "turn2" }] },
  ]) assert.equal(confirmedCompletedTurnRows([{ ...exact, ...changed }], scope), null);
});

test("failure evidence reports fixed actor step and source only, never private assertion operands", () => {
  const privateValue = "PRIVATE_PROMPT_AND_TOKEN_SENTINEL";
  const error = { name: "AssertionError", message: `actual: ${privateValue}`,
    stack: `AssertionError: ${privateValue}\n at run (mobile-session-cache-owner-handoff-rollback.mjs:166:5)`,
    actual: privateValue, expected: privateValue };
  const projected = projectSafeOwnerHandoffFailure(error, "legal-actor-rollback",
    "check-canonical-turn2-assistant-and-identity", { held: true });
  assert.equal(projected.sourceRef, "mobile-session-cache-owner-handoff-rollback.mjs:166:5");
  assert.equal(projected.safeActual, null);
  assert.equal(JSON.stringify(projected).includes(privateValue), false);
  assert.equal(projectSafeOwnerHandoffFailure({ ...error, actual: 2 }, "legal-actor-rollback",
    "check-canonical-turn2-row-count", null).safeActual, 2);
});

test("only an armed later socket's exact original resume is withheld and released once", () => {
  const gate = createOwnerHandoffResumeGate({ threadId: "target" });
  const request = { id: "3", method: "thread/resume", threadId: "target", socketOrdinal: 5 };
  const frame = { jsonrpc: "2.0", id: 3, method: "thread/resume", params: { threadId: "target" } };
  let forwarded = 0;
  const candidate = { raw: JSON.stringify(frame), frame, request, socketOrdinal: 5, forward: () => { forwarded++; } };
  assert.equal(gate.capture(candidate), false);
  gate.arm(5);
  assert.equal(gate.capture({ ...candidate, socketOrdinal: 4, request: { ...request, socketOrdinal: 4 } }), false);
  assert.equal(gate.capture({ ...candidate, frame: { ...frame, params: { threadId: "peer" } } }), false);
  assert.equal(gate.capture(candidate), true);
  assert.equal(gate.capture(candidate), true);
  assert.equal(gate.snapshot().duplicateCount, 1);
  assert.equal(forwarded, 0);
  assert.equal(gate.snapshot().held, true);
  assert.equal(gate.release(), true);
  assert.equal(gate.release(), false);
  assert.equal(forwarded, 1);
  const response = { jsonrpc: "2.0", id: 3, result: { thread: { id: "target" } } };
  assert.equal(gate.observeResponse({ raw: JSON.stringify(response), frame: response,
    request: { ...request }, socketOrdinal: 5 }), false);
  assert.equal(gate.observeResponse({ raw: JSON.stringify(response), frame: response,
    request, socketOrdinal: 6 }), false);
  assert.equal(gate.observeResponse({ raw: JSON.stringify(response), frame: response,
    request, socketOrdinal: 5 }), true);
  assert.equal(gate.responseFrame(), response);
  assert.equal(gate.snapshot().responseSha256?.length, 64);
  assert.equal(Object.hasOwn(gate.snapshot(), "raw"), false);
});

test("discard never forwards held resume", () => {
  const gate = createOwnerHandoffResumeGate({ threadId: "target" });
  gate.arm(2);
  let forwarded = 0;
  assert.equal(gate.capture({ raw: "private", frame: { id: 2, params: { threadId: "target" } },
    request: { id: "2", method: "thread/resume", threadId: "target", socketOrdinal: 2 },
    socketOrdinal: 2, forward: () => { forwarded++; } }), true);
  assert.equal(gate.discard(), true);
  assert.equal(gate.release(), false);
  assert.equal(forwarded, 0);
  assert.equal(JSON.stringify(gate.snapshot()).includes("private"), false);
});

test("rollback authority requires exact complete idle page with both deleted turn rows absent", () => {
  const frame = { jsonrpc: "2.0", id: 3, result: { thread: { id: "target", status: "idle" },
    history: { status: "ready", page: { rangeStart: 0, rangeEnd: 2, hasMoreBefore: false,
      transcriptObservationV1: { observationId: "a".repeat(64), viewKey: "b".repeat(64) },
      messages: [{ id: "u1", role: "user", content: "TURN1" },
        { id: "a1", role: "assistant", content: "done" }] } } } };
  const options = { threadId: "target", turn1Marker: "TURN1", turn2Marker: "TURN2", turn1UserId: "u1",
    turn2UserId: "u2", turn2AssistantId: "a2", knownCount: 2 };
  const valid = projectFullIdleRollbackAuthority(frame, options);
  assert.equal(valid.complete, true);
  assert.equal(valid.turn1UserCount, 1);
  assert.equal(valid.turn1UserIdCount, 1);
  assert.equal(valid.turn2UserCount, 0);
  for (const changed of [
    { thread: { id: "target", status: "unknown" } },
    { thread: { id: "target", status: "idle", runSummary: { mainTurn: "idle", pendingApprovals: null } } },
    { history: { ...frame.result.history, page: { ...frame.result.history.page, hasMoreBefore: true } } },
    { history: { ...frame.result.history, page: { ...frame.result.history.page, rangeStart: 1 } } },
    { history: { ...frame.result.history, page: { ...frame.result.history.page, messages: [] } } },
    { history: { ...frame.result.history, page: { ...frame.result.history.page, transcriptObservationV1: undefined } } },
    { history: { ...frame.result.history, page: { ...frame.result.history.page, messages: [
      frame.result.history.page.messages[0], { id: "a2", role: "assistant", content: "same assistant body" }] } } },
  ]) assert.equal(projectFullIdleRollbackAuthority({ ...frame, result: { ...frame.result, ...changed } }, options).complete, false);
  assert.equal(projectFullIdleRollbackAuthority({ ...frame, result: { ...frame.result,
    history: { ...frame.result.history, page: { ...frame.result.history.page,
      messages: [frame.result.history.page.messages[0], { id: "u2", role: "user", content: "TURN2" }] } } } }, options).turn2UserCount, 1);
});
