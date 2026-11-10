import assert from "node:assert/strict";
import test from "node:test";
import {
  observeTranscriptPageResponse,
  projectTranscriptPageObservation,
  transcriptRpcResponseMatchesRequest,
} from "./mobile-transcript-pagination-observation.mjs";

test("resume inline history is observed with its actual source and returned cursor", () => {
  const request = {
    id: "resume-1",
    method: "thread/resume",
    threadId: "thread-A",
    beforeCursor: null,
    requestOrdinal: 4,
    rawRequest: "resume-frame",
  };
  const rpcResponse = {
    requestId: "resume-1",
    request,
    success: true,
    errorCode: null,
    errorMessage: null,
    result: {
      thread: { id: "thread-A" },
      history: {
        status: "ready",
        page: {
          rangeStart: 2,
          rangeEnd: 4,
          hasMoreBefore: true,
          beforeCursor: "tp1:opaque:2",
          transcriptSnapshotV1: { status: "available", snapshotId: "a".repeat(64), viewKey: "b".repeat(64) },
          messages: [
            { role: "user", content: "TRANSCRIPT_SENTINEL_02" },
            { role: "assistant", content: "reply" },
          ],
        },
      },
    },
    rawResponse: "resume-result",
    responseOrdinal: 5,
  };

  const observed = observeTranscriptPageResponse(request, rpcResponse);
  assert.equal(observed.sourceMethod, "thread/resume");
  assert.equal(observed.historyStatus, "ready");
  assert.equal(observed.success, true);
  assert.equal(observed.requestBeforeCursor, null);
  assert.equal(observed.beforeCursor, "tp1:opaque:2");
  assert.equal(observed.transcriptSnapshotStatus, "available");
  assert.equal(observed.transcriptSnapshotCode, null);
  assert.deepEqual(observed.userMarkers, ["TRANSCRIPT_SENTINEL_02"]);
  assert.deepEqual(projectTranscriptPageObservation(observed), {
    requestId: "resume-1",
    sourceMethod: "thread/resume",
    historyStatus: "ready",
    threadId: "thread-A",
    requestBeforeCursor: null,
    beforeCursor: "tp1:opaque:2",
    transcriptSnapshotStatus: "available",
    transcriptSnapshotCode: null,
    transcriptObservationPresent: false,
    transcriptObservationIdPresent: false,
    transcriptObservationViewKeyPresent: false,
    requestedObservationCursorMatchesObservationId: false,
    returnedObservationCursorMatchesObservationId: false,
    observationCursorOrdinal: null,
    historyRequestLimit: null,
    historyRequestIndexed: null,
    hasMoreBefore: true,
    rangeStart: 2,
    rangeEnd: 4,
    requestOrdinal: 4,
    requestOrdinalAtResponse: null,
    success: true,
    errorCode: null,
    errorMessage: null,
    messageCount: 2,
    userMarkers: ["TRANSCRIPT_SENTINEL_02"],
    responseOrdinal: 5,
    rawRequest: "resume-frame",
    rawResponse: "resume-result",
  });
});

test("indexed fallback keeps the requested cursor separate from the returned cursor", () => {
  const request = {
    id: "indexed-2",
    method: "thread/read/indexed",
    threadId: "thread-A",
    beforeCursor: "tp1:opaque:2",
    requestOrdinal: 8,
    rawRequest: "indexed-frame",
  };
  const observed = observeTranscriptPageResponse(request, {
    requestId: "indexed-2",
    request,
    success: true,
    result: {
      rangeStart: 0,
      rangeEnd: 2,
      hasMoreBefore: false,
      beforeCursor: null,
      messages: [
        { role: "user", content: "TRANSCRIPT_SENTINEL_00" },
        { role: "assistant", content: "older reply" },
      ],
    },
  });

  assert.equal(observed.sourceMethod, "thread/read/indexed");
  assert.equal(observed.requestBeforeCursor, "tp1:opaque:2");
  assert.equal(observed.beforeCursor, null);
  assert.equal(observed.success, true);
  assert.deepEqual(observed.userMarkers, ["TRANSCRIPT_SENTINEL_00"]);
  assert.equal(observed.transcriptSnapshotStatus, null);
  assert.equal(observed.transcriptObservationPresent, false);
});

test("unavailable inline history is recorded as unavailable, not an indexed page", () => {
  const observed = observeTranscriptPageResponse({
    method: "thread/resume",
    threadId: "thread-A",
    beforeCursor: null,
  }, {
    success: true,
    result: {
      thread: { id: "thread-A" },
      history: { status: "unavailable", code: "readFailed" },
    },
  });

  assert.equal(observed.sourceMethod, "thread/resume");
  assert.equal(observed.historyStatus, "unavailable");
  assert.equal(observed.success, false);
  assert.equal(observed.messageCount, 0);
  assert.equal(observed.transcriptSnapshotStatus, null);
  assert.equal(observeTranscriptPageResponse({ method: "thread/read" }, { success: true }), null);
});

test("legacy-reader inline page records real observation cursor and negotiated history request without digest values", () => {
  const observation = { observationId: "a".repeat(64), viewKey: "b".repeat(64) };
  const observed = observeTranscriptPageResponse({
    id: "resume-observed",
    method: "thread/resume",
    threadId: "thread-A",
    beforeCursor: null,
    params: { history: { limit: 50, indexed: true } },
    requestOrdinal: 12,
  }, {
    requestId: "resume-observed",
    success: true,
    result: {
      thread: { id: "thread-A" },
      history: {
        status: "ready",
        page: {
          rangeStart: 2,
          rangeEnd: 52,
          hasMoreBefore: true,
          beforeCursor: `tp1:ob1-${observation.observationId}:2`,
          transcriptSnapshotV1: { status: "unavailable", code: "legacyReader" },
          transcriptObservationV1: observation,
          messages: [{ role: "user", content: "TRANSCRIPT_SENTINEL_02" }],
        },
      },
    },
  });

  assert.equal(observed.sourceMethod, "thread/resume");
  assert.equal(observed.historyStatus, "ready");
  assert.equal(observed.transcriptSnapshotStatus, "unavailable");
  assert.equal(observed.transcriptSnapshotCode, "legacyReader");
  assert.equal(observed.transcriptObservationPresent, true);
  assert.equal(observed.transcriptObservationIdPresent, true);
  assert.equal(observed.transcriptObservationViewKeyPresent, true);
  assert.equal(observed.returnedObservationCursorMatchesObservationId, true);
  assert.equal(observed.observationCursorOrdinal, 2);
  assert.equal(observed.historyRequestLimit, 50);
  assert.equal(observed.historyRequestIndexed, true);
  const projected = projectTranscriptPageObservation(observed);
  assert.equal(projected.transcriptObservationPresent, true);
  assert.equal(projected.returnedObservationCursorMatchesObservationId, true);
  assert.equal(projected.historyRequestIndexed, true);
  assert.equal(Object.hasOwn(projected, "transcriptObservationV1"), false, "projection must not retain digest values");
});

test("observed older-page response is bound to the cursor sent by Mobile", () => {
  const observation = { observationId: "c".repeat(64), viewKey: "d".repeat(64) };
  const request = {
    id: "observed-older",
    method: "thread/read/indexed",
    threadId: "thread-A",
    beforeCursor: `tp1:ob1-${observation.observationId}:2`,
    requestOrdinal: 13,
  };
  const observed = observeTranscriptPageResponse(request, {
    requestId: request.id,
    request,
    success: true,
    result: {
      rangeStart: 0,
      rangeEnd: 2,
      hasMoreBefore: false,
      beforeCursor: null,
      transcriptSnapshotV1: { status: "unavailable", code: "legacyReader" },
      transcriptObservationV1: observation,
      messages: [{ role: "user", content: "TRANSCRIPT_SENTINEL_00" }],
    },
  });

  assert.equal(observed.requestBeforeCursor, request.beforeCursor);
  assert.equal(observed.beforeCursor, null);
  assert.equal(observed.requestedObservationCursorMatchesObservationId, true);
  assert.equal(observed.returnedObservationCursorMatchesObservationId, false);
  assert.equal(observed.transcriptObservationPresent, true);
  assert.equal(observed.transcriptSnapshotStatus, "unavailable");
});

test("resume page for a different thread is not treated as the requested page", () => {
  const observed = observeTranscriptPageResponse({
    method: "thread/resume",
    threadId: "thread-A",
    beforeCursor: null,
  }, {
    success: true,
    result: {
      thread: { id: "thread-B" },
      history: {
        status: "ready",
        page: {
          rangeStart: 0,
          rangeEnd: 1,
          hasMoreBefore: false,
          transcriptSnapshotV1: { status: "unavailable", code: "legacyReader" },
          messages: [{ role: "user", content: "TRANSCRIPT_SENTINEL_00" }],
        },
      },
    },
  });

  assert.equal(observed.sourceMethod, "thread/resume");
  assert.equal(observed.success, false);
  assert.equal(observed.messageCount, 1, "raw response evidence remains visible for diagnosis");
  assert.equal(observed.transcriptSnapshotStatus, "unavailable");
  assert.equal(observed.transcriptSnapshotCode, "legacyReader");
});

test("reused request IDs and cursors cannot match a response from an earlier WebSocket", () => {
  const cursor = `tp1:ob1-${"e".repeat(64)}:2`;
  const heldRequest = {
    id: "4",
    method: "thread/read/indexed",
    threadId: "thread-A",
    beforeCursor: cursor,
    requestOrdinal: 16,
    socketOrdinal: 5,
  };
  const earlierSuccess = {
    requestId: "4",
    request: {
      ...heldRequest,
      requestOrdinal: 12,
      socketOrdinal: 4,
    },
    success: true,
    result: { rangeStart: 0, rangeEnd: 2 },
  };
  const heldStaleResponse = {
    requestId: "4",
    request: { ...heldRequest },
    success: false,
    errorCode: -32041,
  };
  const wrongOrdinal = {
    ...earlierSuccess,
    request: { ...heldRequest, requestOrdinal: 12 },
  };
  const wrongSocket = {
    ...earlierSuccess,
    request: { ...heldRequest, socketOrdinal: 4 },
  };
  const wrongThread = {
    ...heldStaleResponse,
    request: { ...heldRequest, threadId: "thread-B" },
  };
  const wrongCursor = {
    ...heldStaleResponse,
    request: { ...heldRequest, beforeCursor: `${cursor}:other` },
  };

  assert.equal(transcriptRpcResponseMatchesRequest(earlierSuccess, heldRequest), false);
  assert.equal(transcriptRpcResponseMatchesRequest(wrongOrdinal, heldRequest), false);
  assert.equal(transcriptRpcResponseMatchesRequest(wrongSocket, heldRequest), false);
  assert.equal(transcriptRpcResponseMatchesRequest(wrongThread, heldRequest), false);
  assert.equal(transcriptRpcResponseMatchesRequest(wrongCursor, heldRequest), false);
  assert.equal(transcriptRpcResponseMatchesRequest(heldStaleResponse, heldRequest), true);
});
