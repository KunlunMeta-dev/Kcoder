import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIndexedTranscriptPageBoundary,
  assertObservedTranscriptPageBoundary,
} from "./mobile-transcript-pagination-preflight.mjs";

const rows = (start, end) => Array.from({ length: end - start }, (_, offset) => ({
  id: `message-${start + offset}`,
  role: (start + offset) % 2 === 0 ? "user" : "assistant",
  content: `fixture row ${start + offset}`,
}));

const availableSnapshot = { status: "available" };

test("52-message fixture boundary is a contiguous 50-row first page plus two older rows", () => {
  const boundary = assertIndexedTranscriptPageBoundary({
    expectedMessageCount: 52,
    pageLimit: 50,
    firstPage: {
      rangeStart: 2,
      rangeEnd: 52,
      hasMoreBefore: true,
      beforeCursor: "tp1:opaque-snapshot:2",
      transcriptSnapshotV1: availableSnapshot,
      messages: rows(2, 52),
    },
    olderPage: {
      rangeStart: 0,
      rangeEnd: 2,
      hasMoreBefore: false,
      beforeCursor: null,
      transcriptSnapshotV1: availableSnapshot,
      messages: rows(0, 2),
    },
    olderPageRequestedBeforeCursor: "tp1:opaque-snapshot:2",
  });

  assert.deepEqual(boundary, {
    expectedMessageCount: 52,
    pageLimit: 50,
    totalRows: 52,
    uniqueMessageIds: true,
    firstPage: {
      rangeStart: 2,
      rangeEnd: 52,
      messageCount: 50,
      hasMoreBefore: true,
      cursorClass: "opaque-tp1",
      snapshotStatus: "available",
    },
    olderPage: {
      rangeStart: 0,
      rangeEnd: 2,
      messageCount: 2,
      hasMoreBefore: false,
      requestedBeforeCursor: "tp1:opaque-snapshot:2",
      snapshotStatus: "available",
    },
  });
});

test("pagination preflight rejects a legacy numeric cursor or a missing snapshot", () => {
  const firstPage = {
    rangeStart: 2,
    rangeEnd: 52,
    hasMoreBefore: true,
    beforeCursor: "2",
    transcriptSnapshotV1: availableSnapshot,
    messages: rows(2, 52),
  };
  const olderPage = {
    rangeStart: 0,
    rangeEnd: 2,
    hasMoreBefore: false,
    beforeCursor: null,
    transcriptSnapshotV1: availableSnapshot,
    messages: rows(0, 2),
  };

  assert.throws(
    () => assertIndexedTranscriptPageBoundary({ firstPage, olderPage, olderPageRequestedBeforeCursor: "tp1:opaque-snapshot:2", expectedMessageCount: 52, pageLimit: 50 }),
    /opaque indexed cursor/,
  );
  assert.throws(
    () => assertIndexedTranscriptPageBoundary({
      firstPage: { ...firstPage, beforeCursor: "tp1:opaque-snapshot:2", transcriptSnapshotV1: { status: "unavailable", code: "legacyReader" } },
      olderPage,
      olderPageRequestedBeforeCursor: "tp1:opaque-snapshot:2",
      expectedMessageCount: 52,
      pageLimit: 50,
    }),
    /available indexed transcript snapshot/,
  );
});

test("pagination preflight rejects gaps and duplicate message identities", () => {
  const firstPage = {
    rangeStart: 2,
    rangeEnd: 52,
    hasMoreBefore: true,
    beforeCursor: "tp1:opaque-snapshot:2",
    transcriptSnapshotV1: availableSnapshot,
    messages: rows(2, 52),
  };
  const olderPage = {
    rangeStart: 0,
    rangeEnd: 2,
    hasMoreBefore: false,
    beforeCursor: null,
    transcriptSnapshotV1: availableSnapshot,
    messages: rows(0, 2),
  };

  assert.throws(
    () => assertIndexedTranscriptPageBoundary({
      firstPage,
      olderPage: { ...olderPage, rangeEnd: 1 },
      olderPageRequestedBeforeCursor: "tp1:opaque-snapshot:2",
      expectedMessageCount: 52,
      pageLimit: 50,
    }),
    /ranges must be contiguous/,
  );
  assert.throws(
    () => assertIndexedTranscriptPageBoundary({
      firstPage,
      olderPage,
      olderPageRequestedBeforeCursor: "tp1:another-snapshot:2",
      expectedMessageCount: 52,
      pageLimit: 50,
    }),
    /first page's real cursor/,
  );
  assert.throws(
    () => assertIndexedTranscriptPageBoundary({
      firstPage,
      olderPage: { ...olderPage, messages: [{ ...olderPage.messages[0], id: firstPage.messages[0].id }, olderPage.messages[1]] },
      olderPageRequestedBeforeCursor: "tp1:opaque-snapshot:2",
      expectedMessageCount: 52,
      pageLimit: 50,
    }),
    /exactly once/,
  );
});

test("default observation boundary binds the real 50+2 pages to one source and view identity", () => {
  const observation = { observationId: "a".repeat(64), viewKey: "b".repeat(64) };
  const cursor = `tp1:ob1-${observation.observationId}:2`;
  const legacyReader = { status: "unavailable", code: "legacyReader" };
  const boundary = assertObservedTranscriptPageBoundary({
    expectedMessageCount: 52,
    pageLimit: 50,
    firstPage: {
      rangeStart: 2,
      rangeEnd: 52,
      hasMoreBefore: true,
      beforeCursor: cursor,
      transcriptSnapshotV1: legacyReader,
      transcriptObservationV1: observation,
      messages: rows(2, 52),
    },
    olderPage: {
      rangeStart: 0,
      rangeEnd: 2,
      hasMoreBefore: false,
      beforeCursor: null,
      transcriptSnapshotV1: legacyReader,
      transcriptObservationV1: observation,
      messages: rows(0, 2),
    },
    olderPageRequestedBeforeCursor: cursor,
  });

  assert.deepEqual(boundary, {
    expectedMessageCount: 52,
    pageLimit: 50,
    totalRows: 52,
    uniqueMessageIds: true,
    sourceKind: "transcript-observation",
    firstPage: {
      rangeStart: 2,
      rangeEnd: 52,
      messageCount: 50,
      hasMoreBefore: true,
      cursorClass: "observed-tp1",
      cursorOrdinalMatchesRangeStart: true,
      observationIdentityPresent: true,
      snapshotStatus: "unavailable",
      snapshotCode: "legacyReader",
    },
    olderPage: {
      rangeStart: 0,
      rangeEnd: 2,
      messageCount: 2,
      hasMoreBefore: false,
      requestedCursorMatchesFirstPage: true,
      sameObservationIdentity: true,
      snapshotStatus: "unavailable",
      snapshotCode: "legacyReader",
    },
  });
});

test("observation boundary rejects changed identity, stale cursor, gaps and duplicate rows", () => {
  const observation = { observationId: "a".repeat(64), viewKey: "b".repeat(64) };
  const cursor = `tp1:ob1-${observation.observationId}:2`;
  const legacyReader = { status: "unavailable", code: "legacyReader" };
  const firstPage = {
    rangeStart: 2,
    rangeEnd: 52,
    hasMoreBefore: true,
    beforeCursor: cursor,
    transcriptSnapshotV1: legacyReader,
    transcriptObservationV1: observation,
    messages: rows(2, 52),
  };
  const olderPage = {
    rangeStart: 0,
    rangeEnd: 2,
    hasMoreBefore: false,
    beforeCursor: null,
    transcriptSnapshotV1: legacyReader,
    transcriptObservationV1: observation,
    messages: rows(0, 2),
  };
  const args = { firstPage, olderPage, olderPageRequestedBeforeCursor: cursor, expectedMessageCount: 52, pageLimit: 50 };

  assert.throws(
    () => assertObservedTranscriptPageBoundary({ ...args, olderPage: { ...olderPage, transcriptObservationV1: { ...observation, viewKey: "c".repeat(64) } } }),
    /read-view identity/,
  );
  assert.throws(
    () => assertObservedTranscriptPageBoundary({ ...args, firstPage: { ...firstPage, beforeCursor: `tp1:ob1-${"c".repeat(64)}:2` } }),
    /bind the actual observation identity/,
  );
  assert.throws(
    () => assertObservedTranscriptPageBoundary({ ...args, olderPage: { ...olderPage, rangeEnd: 3 } }),
    /ranges must be contiguous/,
  );
  assert.throws(
    () => assertObservedTranscriptPageBoundary({ ...args, olderPage: { ...olderPage, messages: [{ ...olderPage.messages[0], id: firstPage.messages[0].id }, olderPage.messages[1]] } }),
    /exactly once/,
  );
});
