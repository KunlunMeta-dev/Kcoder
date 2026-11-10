import assert from "node:assert/strict";

const observedCursorPattern = /^tp1:ob1-([a-f0-9]{64}):([1-9]\d{0,19})$/;

/**
 * Validate the actual indexed first/older-page pair used by the Mobile fixture.
 * Callers pass real Gateway RPC responses; this helper never manufactures pages.
 */
export function assertIndexedTranscriptPageBoundary({
  firstPage,
  olderPage,
  olderPageRequestedBeforeCursor,
  expectedMessageCount,
  pageLimit,
}) {
  assert.ok(Number.isSafeInteger(expectedMessageCount) && expectedMessageCount > 0);
  assert.ok(Number.isSafeInteger(pageLimit) && pageLimit > 0);
  assert.ok(firstPage && typeof firstPage === "object", "indexed first page must be a response object");
  assert.ok(olderPage && typeof olderPage === "object", "indexed older page must be a response object");
  assert.ok(Array.isArray(firstPage.messages), "indexed first page must contain actual message rows");
  assert.ok(Array.isArray(olderPage.messages), "indexed older page must contain actual message rows");
  assert.equal(firstPage.transcriptSnapshotV1?.status, "available", "first page must carry an available indexed transcript snapshot");
  assert.equal(olderPage.transcriptSnapshotV1?.status, "available", "older page must carry an available indexed transcript snapshot");
  assert.equal(firstPage.messages.length, pageLimit, "first page must fill the configured page limit");
  assert.equal(firstPage.rangeStart, expectedMessageCount - pageLimit, "first page must start at the expected boundary");
  assert.equal(firstPage.rangeEnd, expectedMessageCount, "first page must end at the full seeded history length");
  assert.equal(firstPage.hasMoreBefore, true, "first page must report a real older page");
  assert.match(firstPage.beforeCursor ?? "", /^tp1:[^:]+:\d+$/, "first page must return an opaque indexed cursor");
  assert.equal(olderPageRequestedBeforeCursor, firstPage.beforeCursor, "older page request must use the first page's real cursor");
  assert.equal(olderPage.messages.length, expectedMessageCount - pageLimit, "older page must contain the remainder of the seeded history");
  assert.equal(olderPage.rangeStart, 0, "older page must reach the start of the seeded history");
  assert.equal(olderPage.rangeEnd, firstPage.rangeStart, "older and first page ranges must be contiguous");
  assert.equal(olderPage.hasMoreBefore, false, "the oldest page must end the indexed history");
  assert.equal(olderPage.beforeCursor ?? null, null, "the oldest page must not return another cursor");

  const messageIds = [...firstPage.messages, ...olderPage.messages].map((message) => message?.id);
  assert.ok(messageIds.every((id) => typeof id === "string" && id.length > 0), "all indexed rows must retain real message identities");
  assert.equal(new Set(messageIds).size, expectedMessageCount, "indexed page pair must contain every seeded message exactly once");

  return {
    expectedMessageCount,
    pageLimit,
    totalRows: messageIds.length,
    uniqueMessageIds: true,
    firstPage: {
      rangeStart: firstPage.rangeStart,
      rangeEnd: firstPage.rangeEnd,
      messageCount: firstPage.messages.length,
      hasMoreBefore: firstPage.hasMoreBefore,
      cursorClass: "opaque-tp1",
      snapshotStatus: firstPage.transcriptSnapshotV1.status,
    },
    olderPage: {
      rangeStart: olderPage.rangeStart,
      rangeEnd: olderPage.rangeEnd,
      messageCount: olderPage.messages.length,
      hasMoreBefore: olderPage.hasMoreBefore,
      requestedBeforeCursor: olderPageRequestedBeforeCursor,
      snapshotStatus: olderPage.transcriptSnapshotV1.status,
    },
  };
}

/**
 * Validate the actual no-refresh observation first/older-page pair used by the
 * Mobile fixture. This is deliberately separate from the committed snapshot
 * contract above: an observation is read identity, not an activated index.
 */
export function assertObservedTranscriptPageBoundary({
  firstPage,
  olderPage,
  olderPageRequestedBeforeCursor,
  expectedMessageCount,
  pageLimit,
}) {
  assert.ok(Number.isSafeInteger(expectedMessageCount) && expectedMessageCount > 0);
  assert.ok(Number.isSafeInteger(pageLimit) && pageLimit > 0);
  assert.ok(firstPage && typeof firstPage === "object", "observed first page must be a response object");
  assert.ok(olderPage && typeof olderPage === "object", "observed older page must be a response object");
  assert.ok(Array.isArray(firstPage.messages), "observed first page must contain actual message rows");
  assert.ok(Array.isArray(olderPage.messages), "observed older page must contain actual message rows");

  const firstObservation = firstPage.transcriptObservationV1;
  const olderObservation = olderPage.transcriptObservationV1;
  assert.match(firstObservation?.observationId ?? "", /^[a-f0-9]{64}$/, "first page must carry a real transcript observation identity");
  assert.match(firstObservation?.viewKey ?? "", /^[a-f0-9]{64}$/, "first page must carry a real transcript observation view key");
  assert.match(olderObservation?.observationId ?? "", /^[a-f0-9]{64}$/, "older page must carry a real transcript observation identity");
  assert.match(olderObservation?.viewKey ?? "", /^[a-f0-9]{64}$/, "older page must carry a real transcript observation view key");
  assert.equal(firstPage.transcriptSnapshotV1?.status, "unavailable", "default observation first page must remain outside an activated snapshot");
  assert.equal(firstPage.transcriptSnapshotV1?.code, "legacyReader", "default observation first page must record the legacy-reader snapshot state");
  assert.equal(olderPage.transcriptSnapshotV1?.status, "unavailable", "default observation older page must remain outside an activated snapshot");
  assert.equal(olderPage.transcriptSnapshotV1?.code, "legacyReader", "default observation older page must record the legacy-reader snapshot state");
  assert.equal(firstPage.messages.length, pageLimit, "observed first page must fill the configured page limit");
  assert.equal(firstPage.rangeStart, expectedMessageCount - pageLimit, "observed first page must start at the expected boundary");
  assert.equal(firstPage.rangeEnd, expectedMessageCount, "observed first page must end at the full seeded history length");
  assert.equal(firstPage.hasMoreBefore, true, "observed first page must report a real older page");

  const firstCursor = (firstPage.beforeCursor ?? "").match(observedCursorPattern);
  assert.ok(firstCursor, "first page must return a typed observation cursor");
  assert.equal(firstCursor[1], firstObservation.observationId, "first cursor must bind the actual observation identity");
  assert.equal(Number(firstCursor[2]), firstPage.rangeStart, "first cursor ordinal must match the page boundary");
  assert.equal(olderPageRequestedBeforeCursor, firstPage.beforeCursor, "older page request must use the first page's real observation cursor");
  assert.equal(olderObservation.observationId, firstObservation.observationId, "older page must preserve the first page's source observation");
  assert.equal(olderObservation.viewKey, firstObservation.viewKey, "older page must preserve the first page's read-view identity");
  assert.equal(olderPage.messages.length, expectedMessageCount - pageLimit, "observed older page must contain the remainder of the seeded history");
  assert.equal(olderPage.rangeStart, 0, "observed oldest page must reach the start of the seeded history");
  assert.equal(olderPage.rangeEnd, firstPage.rangeStart, "observed older and first page ranges must be contiguous");
  assert.equal(olderPage.hasMoreBefore, false, "observed oldest page must end the seeded history");
  assert.equal(olderPage.beforeCursor ?? null, null, "observed oldest page must not return another cursor");

  const messageIds = [...firstPage.messages, ...olderPage.messages].map((message) => message?.id);
  assert.ok(messageIds.every((id) => typeof id === "string" && id.length > 0), "all observed rows must retain real message identities");
  assert.equal(new Set(messageIds).size, expectedMessageCount, "observed page pair must contain every seeded message exactly once");

  return {
    expectedMessageCount,
    pageLimit,
    totalRows: messageIds.length,
    uniqueMessageIds: true,
    sourceKind: "transcript-observation",
    firstPage: {
      rangeStart: firstPage.rangeStart,
      rangeEnd: firstPage.rangeEnd,
      messageCount: firstPage.messages.length,
      hasMoreBefore: firstPage.hasMoreBefore,
      cursorClass: "observed-tp1",
      cursorOrdinalMatchesRangeStart: true,
      observationIdentityPresent: true,
      snapshotStatus: firstPage.transcriptSnapshotV1.status,
      snapshotCode: firstPage.transcriptSnapshotV1.code,
    },
    olderPage: {
      rangeStart: olderPage.rangeStart,
      rangeEnd: olderPage.rangeEnd,
      messageCount: olderPage.messages.length,
      hasMoreBefore: olderPage.hasMoreBefore,
      requestedCursorMatchesFirstPage: true,
      sameObservationIdentity: true,
      snapshotStatus: olderPage.transcriptSnapshotV1.status,
      snapshotCode: olderPage.transcriptSnapshotV1.code,
    },
  };
}
