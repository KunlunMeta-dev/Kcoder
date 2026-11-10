import assert from "node:assert/strict";
import test from "node:test";
import {
  projectResumeAssistantPageEvidence,
  resolveLatestCompletedAssistantIdentity,
} from "./mobile-cache-timing-latest-assistant.mjs";

function evidence(overrides = {}) {
  return {
    threadId: "thread-fixture",
    activeSocketOrdinal: 7,
    turnCompletions: [{ threadId: "thread-fixture", turnId: "turn-fixture-1", status: "completed", socketOrdinal: 7, at: 100 }],
    indexedHistoryRead: {
      threadId: "thread-fixture",
      responseThreadId: "thread-fixture",
      requestSocketOrdinal: 7,
      responseSocketOrdinal: 7,
      requestedAtMs: 101,
      receivedAtMs: 102,
      success: true,
      messageIdentities: [
        { id: "canonical-user-1", role: "user", turnId: "turn-fixture-1", attemptId: "turn-fixture-1" },
        { id: "canonical-assistant-1", role: "assistant", turnId: "turn-fixture-1", attemptId: "attempt-fixture-1" },
      ],
    },
    // The Web FlatList is inverted, so DOM order is newest assistant first.
    liveRows: [
      { id: "canonical-assistant-1", role: "assistant" },
      { id: "local-user-row", role: "user" },
    ],
    tailGeometry: {
      rowDomId: "message-canonical-assistant-1",
      rowMatchCount: 1,
      markerTextMatchCount: 1,
      markerIntersectsWindow: true,
      markerIntersectsList: true,
    },
    ...overrides,
  };
}

test("resolves the canonical live assistant row despite inverted DOM order", () => {
  const resolved = resolveLatestCompletedAssistantIdentity(evidence());
  assert.notEqual(resolved.canonicalMessageId, `assistant-${resolved.attemptId}`,
    "the fixture must keep the canonical message identity distinct from its pre-reconciliation synthetic ID");
  assert.deepEqual(resolved, {
    threadId: "thread-fixture",
    socketOrdinal: 7,
    turnId: "turn-fixture-1",
    attemptId: "attempt-fixture-1",
    canonicalMessageId: "canonical-assistant-1",
    displayRowId: "canonical-assistant-1",
    completionAtMs: 100,
    historyRequestedAtMs: 101,
    historyReceivedAtMs: 102,
    identityMode: "completed turn plus same-socket canonical history ID and unique inverted-DOM row/Range match",
  });
});

test("rejects stale, foreign, or non-assistant authority history", async t => {
  const cases = [
    ["history request predates completion", () => evidence({ indexedHistoryRead: {
      ...evidence().indexedHistoryRead, requestedAtMs: 99,
    } }), /after the real turn\/completed/],
    ["history belongs to another socket", () => evidence({ indexedHistoryRead: {
      ...evidence().indexedHistoryRead, responseSocketOrdinal: 8,
    } }), /active task socket/],
    ["history belongs to another thread", () => evidence({ indexedHistoryRead: {
      ...evidence().indexedHistoryRead, responseThreadId: "other-thread",
    } }), /exact fixture thread/],
    ["canonical history does not end at the completed assistant", () => evidence({ indexedHistoryRead: {
      ...evidence().indexedHistoryRead,
      messageIdentities: [
        ...evidence().indexedHistoryRead.messageIdentities,
        { id: "later-user", role: "user", turnId: "turn-fixture-1", attemptId: null },
      ],
    } }), /must end with an assistant/],
  ];
  for (const [name, makeInput, expected] of cases) {
    await t.test(name, () => assert.throws(() => resolveLatestCompletedAssistantIdentity(makeInput()), expected));
  }
});

test("rejects a row or tail geometry that does not identify the canonical message", async t => {
  const cases = [
    ["only the pre-reconciliation synthetic row is present", () => evidence({ liveRows: [{ id: "assistant-attempt-fixture-1", role: "assistant" }] }), /exactly one live assistant row/],
    ["another canonical UUID is present", () => evidence({ liveRows: [{ id: "canonical-other-assistant", role: "assistant" }] }), /exactly one live assistant row/],
    ["duplicate matching live rows", () => evidence({ liveRows: [
      ...evidence().liveRows,
      { id: "canonical-assistant-1", role: "assistant" },
    ] }), /exactly one live assistant row/],
    ["tail geometry points to another row", () => evidence({ tailGeometry: {
      ...evidence().tailGeometry, rowDomId: "message-canonical-other-assistant",
    } }), /canonical completed message/],
    ["attempt identity is missing", () => evidence({ indexedHistoryRead: {
      ...evidence().indexedHistoryRead,
      messageIdentities: [
        evidence().indexedHistoryRead.messageIdentities[0],
        { ...evidence().indexedHistoryRead.messageIdentities[1], attemptId: null },
      ],
    } }), /explicit attempt identity/],
  ];
  for (const [name, makeInput, expected] of cases) {
    await t.test(name, () => assert.throws(() => resolveLatestCompletedAssistantIdentity(makeInput()), expected));
  }
});

test("resume-page evidence requires a bounded exact-thread page and one canonical assistant containing the tail", async t => {
  const frame = {
    id: "resume-response-1",
    result: {
      thread: { id: "thread-fixture" },
      history: { status: "ready", page: {
        messages: [
          { id: "canonical-user-1", role: "user", content: "prompt" },
          { id: "canonical-assistant-1", role: "assistant", content: "answer tail-marker-fixture" },
        ],
        rangeStart: 0,
        rangeEnd: 2,
        hasMoreBefore: false,
      } },
    },
  };
  const projected = projectResumeAssistantPageEvidence(frame, {
    expectedThreadId: "thread-fixture",
    expectedAssistantMessageId: "canonical-assistant-1",
    tailMarker: "tail-marker-fixture",
  });
  assert.deepEqual(projected, {
    responseSucceeded: true,
    threadMatched: true,
    boundedInlinePage: true,
    pageMessageCount: 2,
    expectedAssistantMatchCount: 1,
    assistantTailMarkerMatchCount: 1,
    expectedAssistantContainsTailMarker: true,
    matched: true,
  });
  assert.equal(JSON.stringify(projected).includes("canonical-assistant-1"), false,
    "the evidence projection must not retain the canonical message ID");
  assert.equal(JSON.stringify(projected).includes("tail-marker-fixture"), false,
    "the evidence projection must not retain the marker text");

  const cases = [
    ["wrong response thread", { ...frame, result: { ...frame.result, thread: { id: "other-thread" } } }, "threadMatched"],
    ["wrong canonical assistant UUID", { ...frame, result: { ...frame.result, history: { ...frame.result.history, page: {
      ...frame.result.history.page,
      messages: frame.result.history.page.messages.map(message => message.role === "assistant"
        ? { ...message, id: "canonical-other-assistant" } : message),
    } } } }, "expectedAssistantMatchCount"],
    ["duplicate canonical assistant rows", { ...frame, result: { ...frame.result, history: { ...frame.result.history, page: {
      ...frame.result.history.page,
      messages: [...frame.result.history.page.messages, frame.result.history.page.messages[1]],
      rangeEnd: 3,
    } } } }, "expectedAssistantMatchCount"],
    ["tail exists on another assistant row only", { ...frame, result: { ...frame.result, history: { ...frame.result.history, page: {
      ...frame.result.history.page,
      messages: [
        ...frame.result.history.page.messages.map(message => message.role === "assistant"
          ? { ...message, content: "answer without marker" } : message),
        { id: "canonical-other-assistant", role: "assistant", content: "tail-marker-fixture" },
      ],
      rangeEnd: 3,
    } } } }, "expectedAssistantContainsTailMarker"],
    ["inconsistent bounded range", { ...frame, result: { ...frame.result, history: { ...frame.result.history, page: {
      ...frame.result.history.page, rangeEnd: 3,
    } } } }, "boundedInlinePage"],
    ["response error", { ...frame, error: { code: -1 } }, "responseSucceeded"],
  ];
  for (const [name, invalidFrame, expectedField] of cases) {
    await t.test(name, () => {
      const result = projectResumeAssistantPageEvidence(invalidFrame, {
        expectedThreadId: "thread-fixture",
        expectedAssistantMessageId: "canonical-assistant-1",
        tailMarker: "tail-marker-fixture",
      });
      assert.notEqual(result.matched, true);
      assert.equal(JSON.stringify(result).includes("canonical-assistant-1"), false);
      assert.equal(JSON.stringify(result).includes("tail-marker-fixture"), false);
      assert.ok(expectedField === "expectedAssistantMatchCount"
        ? result.expectedAssistantMatchCount !== 1
        : result[expectedField] === false,
        `${name} must identify the exact failed evidence field`);
    });
  }
});
