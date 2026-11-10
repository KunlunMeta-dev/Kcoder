import assert from "node:assert/strict";
import test from "node:test";
import {
  buildColdProcessAnchorPrompt,
  prepareUserReadingAnchorViewport,
  resolveUniqueTurnUserAnchorIdentity,
  turnStartIncludesPromptMarker,
} from "./mobile-session-cache-user-anchor.mjs";

const promptMarker = "SESSION_CACHE_PROMPT_TEST";
const clientMessageIdHmacSha256 = "a".repeat(64);

test("cold-process prompt adds ordinary visible text while retaining one exact identity marker", () => {
  const prompt = buildColdProcessAnchorPrompt(promptMarker);
  const paragraphs = prompt.split(/\n\s*\n/);

  assert.equal(paragraphs[0], promptMarker);
  assert.equal(prompt.split(promptMarker).length - 1, 1);
  assert.equal(paragraphs.length, 3);
  assert.ok(paragraphs.slice(1).every(paragraph => paragraph.length >= 100));
  assert.ok(prompt.length >= 350 && prompt.length < 500,
    "the initial prompt must add bounded content without creating a viewport-sized user row");
  assert.equal(prompt.includes("SESSION_CACHE_AUTHORITY_"), false);
});

function evidence(overrides = {}) {
  const start = {
    method: "turn/start",
    threadId: "thread-fixture",
    socketOrdinal: 7,
    clientPromptMarkerPresent: true,
    clientMessageIdExplicit: true,
    clientMessageIdHmacSha256,
    ...overrides.start,
  };
  const indexedHistoryRead = {
    success: true,
    threadId: "thread-fixture",
    responseThreadId: "thread-fixture",
    requestSocketOrdinal: 7,
    responseSocketOrdinal: 7,
    messageIdentities: [{
      id: "canonical-user-1",
      role: "user",
      turnId: "turn-fixture-1",
      clientMessageIdExplicit: true,
      clientMessageIdHmacSha256,
    }],
    ...overrides.indexedHistoryRead,
  };
  const turnCompletions = [{
    threadId: "thread-fixture",
    socketOrdinal: 7,
    status: "completed",
    turnId: "turn-fixture-1",
  }, ...(overrides.extraCompletions ?? [])];
  return {
    anchor: { messageId: "canonical-user-1", offset: 42, followsLatest: false, ...overrides.anchor },
    threadId: "thread-fixture",
    activeSocketOrdinal: 7,
    requests: [start, ...(overrides.extraRequests ?? [])],
    indexedHistoryRead,
    turnCompletions,
  };
}

test("checks the fixture marker only in turn/start text input fields", () => {
  assert.equal(turnStartIncludesPromptMarker({ input: [{ type: "text", text: `prefix ${promptMarker}` }] }, promptMarker), true);
  assert.equal(turnStartIncludesPromptMarker({ input: [{ type: "image", text: promptMarker }] }, promptMarker), false);
  assert.equal(turnStartIncludesPromptMarker({ input: [{ type: "text", text: "other" }] }, promptMarker), false);
});

test("selects one prompt-containing user text element and measures the scoped marker", async () => {
  const calls = [];
  const textQueries = [];
  const messageTextNode = buildColdProcessAnchorPrompt(promptMarker);
  const promptRow = {
    count: async () => 1,
    getByText: (value, options) => {
      textQueries.push({ value, options });
      const matchCount = options.exact ? Number(messageTextNode === value) : Number(messageTextNode.includes(value));
      return {
        count: async () => matchCount,
        scrollIntoViewIfNeeded: async () => { calls.push("scroll-marker-containing-user-text"); },
      };
    },
  };
  assert.equal(await promptRow.getByText(promptMarker, { exact: true }).count(), 0,
    "one user Text node containing a longer message does not exactly equal the short marker");
  const page = { getByTestId: id => {
    assert.equal(id, "message-user");
    return { filter: options => {
      assert.deepEqual(options, { hasText: promptMarker });
      return promptRow;
    } };
  } };
  const geometry = {
    listFound: true, rowMatchCount: 1, markerTextMatchCount: 1, markerVisible: true,
    markerIntersectsWindow: true, markerIntersectsList: true, rowIntersectsList: true,
    rowDomId: "message-live-user-row", row: { offsetFromHost: 42 },
  };
  const result = await prepareUserReadingAnchorViewport({
    page,
    promptMarker,
    readTranscriptViewport: async (receivedPage, options) => {
      assert.strictEqual(receivedPage, page);
      assert.deepEqual(options, { markerText: promptMarker, rowTestId: "message-user" });
      calls.push("measure-user-row");
      return geometry;
    },
  });

  assert.deepEqual(calls, ["scroll-marker-containing-user-text", "measure-user-row"]);
  assert.deepEqual(textQueries.at(-1), { value: promptMarker, options: { exact: false } });
  assert.strictEqual(result.geometry, geometry);
  assert.equal(result.rowDomId, "message-live-user-row");
});

test("fails closed when the prompt row or text marker is ambiguous", async t => {
  await t.test("multiple user rows", async () => {
    const page = { getByTestId: () => ({ filter: () => ({ count: async () => 2 }) }) };
    await assert.rejects(prepareUserReadingAnchorViewport({ page, promptMarker, readTranscriptViewport: async () => null }),
      /exactly one rendered user row/);
  });
  await t.test("multiple matching user text elements", async () => {
    const page = { getByTestId: () => ({ filter: () => ({
      count: async () => 1,
      getByText: () => ({ count: async () => 2 }),
    }) }) };
    await assert.rejects(prepareUserReadingAnchorViewport({ page, promptMarker, readTranscriptViewport: async () => null }),
      /one user text element containing that substring/);
  });
});

test("binds detached anchor to a unique canonical user row through one owned turn", () => {
  const resolved = resolveUniqueTurnUserAnchorIdentity(evidence());
  assert.deepEqual(resolved, {
    canonicalId: "canonical-user-1",
    role: "user",
    threadId: "thread-fixture",
    socketOrdinal: 7,
    turnId: "turn-fixture-1",
    clientMessageIdHmacSha256,
    identityMode: "unique initial turn/start CID HMAC mapped to one canonical user row; visible row selected by unique prompt marker",
  });
});

test("rejects missing, duplicated, mismatched, or wrong-owner user identity evidence", async t => {
  const cases = [
    ["duplicate starts", () => evidence({ extraRequests: [{ ...evidence().requests[0] }] }), /exactly one observed turn\/start/],
    ["start on another socket", () => evidence({ start: { socketOrdinal: 8 } }), /active Mobile RPC socket/],
    ["start without marker witness", () => evidence({ start: { clientPromptMarkerPresent: false } }), /prompt marker/],
    ["implicit client ID", () => evidence({ start: { clientMessageIdExplicit: false } }), /explicit clientMessageId/],
    ["indexed read from another socket", () => evidence({ indexedHistoryRead: { responseSocketOrdinal: 8 } }), /active task socket/],
    ["wrong response thread", () => evidence({ indexedHistoryRead: { responseThreadId: "other-thread" } }), /exact fixture thread/],
    ["canonical message has different CID", () => evidence({ indexedHistoryRead: { messageIdentities: [{
      id: "canonical-user-1", role: "user", turnId: "turn-fixture-1", clientMessageIdExplicit: true,
      clientMessageIdHmacSha256: "b".repeat(64),
    }] } }), /exactly one canonical user row/],
    ["canonical message belongs to another turn", () => evidence({ indexedHistoryRead: { messageIdentities: [{
      id: "canonical-user-1", role: "user", turnId: "turn-other", clientMessageIdExplicit: true,
      clientMessageIdHmacSha256,
    }] } }), /exact completed turn/],
    ["duplicate canonical user CID", () => evidence({ indexedHistoryRead: { messageIdentities: [
      ...evidence().indexedHistoryRead.messageIdentities,
      { ...evidence().indexedHistoryRead.messageIdentities[0], id: "canonical-user-duplicate" },
    ] } }), /exactly one canonical user row/],
    ["duplicate completion on owner socket", () => evidence({ extraCompletions: [{
      threadId: "thread-fixture", socketOrdinal: 7, status: "completed", turnId: "turn-fixture-2",
    }] }), /exactly one completed turn/],
    ["anchor points elsewhere", () => evidence({ anchor: { messageId: "other-message" } }), /canonical user message/],
  ];
  for (const [name, makeInput, expected] of cases) {
    await t.test(name, () => assert.throws(() => resolveUniqueTurnUserAnchorIdentity(makeInput()), expected));
  }
});
