import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { inspectOfficialMobileStaticDist } from "./mobile-static-dist-input.mjs";
import { dispatchTrustedTouchDrag } from "./browser-touch-input.mjs";
import { waitFor } from "./run-context.mjs";

/** Owned cursor-page protocol and touch diagnostic; source pins, route operations, and redaction stay caller-owned. */
export function createMobileSessionsCursorDiagnostic({
  CURSOR_TOUCH_MAX_Y,
  MATCHED_992_CURSOR_DIAGNOSTIC,
  MOBILE_PAGE_OPTIONS,
  PINNED_CURSOR_INPUT_DIAGNOSTIC,
  connectThroughWelcome,
  enterSessions,
  installTouchProbe,
  readActualChromiumProcess,
  readProfileIdentity,
  readScrollport,
  readTouchProbe,
  resetTouchProbe,
  safeDiagnosticMessage,
  safeErrorName,
  safePath,
  sha256,
  touchGates,
  waitForStableScroll,
}) {
function createCursorPaginationFixture(workspace, ledger) {
  const baseUpdatedAt = Date.now();
  const threadById = new Map();
  const gates = new Map([
    ["cursor-page-2", createCursorResponseGate("cursor-page-2")],
    ["cursor-page-3", createCursorResponseGate("cursor-page-3")],
  ]);
  let sessionsCursorlessRequests = 0;
  let freshOwnerRequested = false;
  let freshOwnerFirstPageSeen = false;
  let freshOwnerFirstPagePrepared = false;
  let freshOwnerFirstPageSent = false;
  const recordRpc = (kind, fields = {}) => {
    if (ledger.paginationEvents.length >= 128) { ledger.paginationEventOverflow += 1; return; }
    ledger.paginationEvents.push({ kind, atNodeMs: performance.now(), ...fields });
  };
  const makeThreads = (page, count, updatedAtOffset) => Array.from({ length: count }, (_value, index) => {
    const id = `cursor-${page}-${String(index).padStart(2, "0")}`;
    const thread = {
      id,
      title: `Cursor ${page.toUpperCase()} row ${String(index).padStart(2, "0")}`,
      cwd: workspace,
      status: "idle",
      model: "mock-mobile",
      createdAt: baseUpdatedAt - updatedAtOffset - index * 1000 - 60_000,
      updatedAt: baseUpdatedAt - updatedAtOffset - index * 1000,
    };
    threadById.set(id, thread);
    return thread;
  });
  const pages = {
    home: makeThreads("home", 1, 0),
    p1: makeThreads("p1", 16, 0),
    p2: makeThreads("p2", 16, 120_000),
    p3: makeThreads("p3", 8, 240_000),
  };
  return {
    routeKind(rawUrl) {
      const path = new URL(rawUrl).pathname;
      if (/\/sessions\/?$/.test(path)) return "sessions";
      if (/\/task\/[^/]+\/[^/]+\/?$/.test(path)) return "task";
      if (path.startsWith("/mobile/")) return "home";
      return "other";
    },
    pageFor(routeKind, params) {
      const cursor = typeof params.cursor === "string" ? params.cursor : null;
      if (routeKind !== "sessions") {
        return { page: "home", requestCursor: cursor, threads: pages.home, nextCursor: null };
      }
      if (!cursor) {
        sessionsCursorlessRequests += 1;
        if (freshOwnerRequested) {
          freshOwnerRequested = false;
          freshOwnerFirstPageSeen = true;
          recordRpc("fresh-owner-first-page", { routeKind, sessionsPageOrdinal: sessionsCursorlessRequests, rowCount: pages.p1.length });
          return { page: "p1", ownerEpoch: 2, requestCursor: null, threads: pages.p1, nextCursor: null };
        }
        return { page: "p1", ownerEpoch: 1, requestCursor: null, threads: pages.p1, nextCursor: "cursor-page-2" };
      }
      if (cursor === "cursor-page-2") return { page: "p2", ownerEpoch: 1, requestCursor: cursor, threads: pages.p2, nextCursor: "cursor-page-3" };
      if (cursor === "cursor-page-3") return { page: "p3", ownerEpoch: 1, requestCursor: cursor, threads: pages.p3, nextCursor: null };
      recordRpc("unexpected-cursor", { routeKind, cursorLength: cursor.length, cursorFingerprint: sha256(Buffer.from(cursor)).slice(0, 16) });
      return null;
    },
    recordResponsePrepared(request, pageResult) {
      if (pageResult.ownerEpoch === 2) freshOwnerFirstPagePrepared = true;
      recordRpc("thread-list-response-prepared", {
        routeKind: request.routeKind,
        requestCursor: typeof request.params.cursor === "string" ? request.params.cursor : null,
        requestedLimit: Number.isSafeInteger(request.params.limit) ? request.params.limit : null,
        page: pageResult.page,
        ownerEpoch: pageResult.ownerEpoch ?? 1,
        cursor: pageResult.requestCursor,
        nextCursor: pageResult.nextCursor,
        rowCount: pageResult.threads.length,
        connectionOrdinal: request.connectionOrdinal,
        requestIdFingerprint: request.idFingerprint,
      });
    },
    recordResponseSent(request, pageResult) {
      if (pageResult.requestCursor) gates.get(pageResult.requestCursor)?.markSent();
      if (pageResult.ownerEpoch === 2) freshOwnerFirstPageSent = true;
      recordRpc("thread-list-response-sent", {
        routeKind: request.routeKind,
        requestCursor: typeof request.params.cursor === "string" ? request.params.cursor : null,
        requestedLimit: Number.isSafeInteger(request.params.limit) ? request.params.limit : null,
        page: pageResult.page,
        ownerEpoch: pageResult.ownerEpoch ?? 1,
        cursor: pageResult.requestCursor,
        nextCursor: pageResult.nextCursor,
        rowCount: pageResult.threads.length,
        connectionOrdinal: request.connectionOrdinal,
        requestIdFingerprint: request.idFingerprint,
      });
    },
    recordRpc,
    threadFor(id) { return threadById.get(id) ?? null; },
    async holdResponse(cursor, requestSummary, isSocketClosed) {
      const gate = gates.get(cursor);
      if (!gate) return "not-held";
      const state = gate.snapshot();
      if (state.status !== "armed") {
        ledger.duplicateCursorRequestCount += 1;
        recordRpc("duplicate-cursor-request-blocked", {
          cursor,
          priorStatus: state.status,
          connectionOrdinal: requestSummary.connectionOrdinal,
          requestIdFingerprint: requestSummary.requestIdFingerprint,
        });
        return "not-sent";
      }
      return gate.hold(requestSummary, isSocketClosed);
    },
    release(cursor, action) { return gates.get(cursor)?.release(action) ?? false; },
    gate(cursor) { return gates.get(cursor)?.snapshot() ?? null; },
    socketClosed(connectionOrdinal) {
      for (const gate of gates.values()) gate.socketClosed(connectionOrdinal);
    },
    expectFreshOwner() { freshOwnerRequested = true; },
    get freshOwnerFirstPageSeen() { return freshOwnerFirstPageSeen; },
    get freshOwnerFirstPagePrepared() { return freshOwnerFirstPagePrepared; },
    get freshOwnerFirstPageSent() { return freshOwnerFirstPageSent; },
    get sessionsCursorlessRequests() { return sessionsCursorlessRequests; },
    releaseAll() { for (const gate of gates.values()) gate.release("cleanup"); },
  };
}

function createCursorResponseGate(cursor) {
  const state = { cursor, status: "armed", responseSummary: null, connectionClosed: false, releaseAction: null };
  let resolveRelease = null;
  return {
    async hold(request, isSocketClosed) {
      if (state.status !== "armed") return "not-held";
      state.status = "held";
      state.responseSummary = request;
      const actionPromise = new Promise(resolveAction => { resolveRelease = resolveAction; });
      const action = await actionPromise;
      state.releaseAction = action;
      if (["send-page", "send-late"].includes(action) && !isSocketClosed()) {
        state.status = "released-for-send";
        return "send";
      }
      state.status = state.connectionClosed || isSocketClosed() ? "transport-closed" : "released-without-send";
      return state.status === "transport-closed" ? "socket-closed" : "not-sent";
    },
    release(action) {
      if (state.status !== "held" || !resolveRelease) return false;
      const resolve = resolveRelease;
      resolveRelease = null;
      resolve(action);
      return true;
    },
    socketClosed(connectionOrdinal) {
      if (state.status !== "held" || state.responseSummary?.connectionOrdinal !== connectionOrdinal) return;
      state.connectionClosed = true;
      this.release("socket-closed");
    },
    markSent() { if (state.status === "released-for-send") state.status = "sent"; },
    snapshot() { return { ...state }; },
  };
}

async function runCursorPaginationDiagnostic(context, {
  chromium, page, gateway, workspace, ledger, paginationFixture, sourceBoundaryBefore,
  verifySourceBoundary, expectedDistManifestSha256, sourceDist, distRoot,
  latencyHelpers, gatewayRuntime, browserTouchInputPath, browserTouchInputSha256,
}) {
  const listSelector = '[data-testid="sessions-list"]';
  const firstPageRowId = "cursor-p1-00";
  const pageTwoTaskRowId = "cursor-p2-08";
  const pageThreeRowPrefix = "cursor-p3-";
  const result = {
    schemaVersion: 1,
    classification: "FUNCTIONAL_BROWSER_DIAGNOSTIC_ONLY",
    claimScope: MATCHED_992_CURSOR_DIAGNOSTIC
      ? "matched Git 992 Mobile Web bundle adapted to a deploy-mounted Gateway static manifest; shared current Gateway snapshot; KCODER_STUDIO_MOCK=1 and app-facing WebSocket thread/list response fixture; trusted touch drives actual Sessions FlatList; Browser evidence is owner-close prevention of late-frame delivery, while late-answer consumer behavior is separate unit evidence; not an official Expo receipt, Rust, Provider, Relay, public-service, native-device, or performance evidence"
      : "current official Mobile Web dist on an owned Gateway snapshot; KCODER_STUDIO_MOCK=1 and app-facing WebSocket thread/list response fixture; trusted touch drives actual Sessions FlatList; Browser evidence is owner-close prevention of late-frame delivery, while late-answer consumer behavior is separate unit evidence; not Rust, Provider, Relay, public-service, native-device, or performance evidence",
    input: { selector: MATCHED_992_CURSOR_DIAGNOSTIC ? "--matched-992-cursor-pagination-diagnostic" : "--cursor-pagination-diagnostic",
      sourceMode: MATCHED_992_CURSOR_DIAGNOSTIC ? "matched-git-992-export-bundle-derived-deploy-mount" : "official-mobile-export-receipt",
      browserWindowSize: { width: 390, height: 844 }, scrollOffsetWrites: 0, directRpcCalls: 0 },
    browser: null,
    stages: {},
    heldCursorResponses: [],
    gestures: [],
    taskClick: null,
    ownerCancellation: null,
    lateAnswerUnitEvidence: {
      status: "separate-unit-contract-reference-not-executed-by-browser",
      scope: "separate unit contract; not demonstrated by a late frame in this browser run",
      source: "apps/kcoder-studio/mobile/src/runtime/task-runtime/thread-list-incremental.review.test.ts",
      test: "invalidation after a first page prevents the held response and settled callback from publishing",
    },
    gates: {},
    postflight: {},
    failure: null,
  };
  let stage = "verify-owned-browser-window-size";
  let primaryError = null;
  const chromiumProcess = await readActualChromiumProcess(chromium, context);
  const actualWindowSizeCaptured = chromiumProcess.status === "captured"
    && chromiumProcess.windowSizeArguments?.length === 1
    && chromiumProcess.windowSizeArguments[0] === "--window-size=390,844";
  result.browser = {
    launch: chromiumProcess,
    viewport: MOBILE_PAGE_OPTIONS.viewport,
    deviceScaleFactor: MOBILE_PAGE_OPTIONS.deviceScaleFactor,
    isMobile: MOBILE_PAGE_OPTIONS.isMobile,
    hasTouch: MOBILE_PAGE_OPTIONS.hasTouch,
    exactWindowSizeFlagCaptured: actualWindowSizeCaptured,
  };
  const recordCursorGesture = async gesture => {
    const ordinal = result.gestures.length + 1;
    result.gestures.push(gesture);
    await context.writeArtifactJson(`cursor-pagination-gesture-${String(ordinal).padStart(2, "0")}.json`, {
      schemaVersion: 1,
      classification: result.classification,
      ordinal,
      stage,
      gesture,
    });
  };
  try {
    assert.equal(actualWindowSizeCaptured, true, "cursor pagination must use the owned Chromium window sized to the mobile viewport");
    stage = "welcome";
    await connectThroughWelcome(page, gateway);
    stage = "open-sessions";
    await enterSessions(page);
    const profile = await readProfileIdentity(page, gateway.baseUrl);
    await waitFor(() => isOwnedSessionsRoute(page.url(), gateway.baseUrl, profile.id), 15_000,
      "exact current official Sessions route and profile owner", 50, context.abortSignal);
    await installTouchProbe(page, listSelector);
    await page.locator(`[data-testid="session-${firstPageRowId}"]`).waitFor({ state: "visible", timeout: 20_000 });
    await waitFor(() => paginationFixture.sessionsCursorlessRequests >= 1
      && ledger.paginationEvents.some(event => event.kind === "thread-list-response-sent" && event.page === "p1" && event.ownerEpoch === 1),
    15_000, "first Sessions cursor page response", 40, context.abortSignal);
    const firstPageResponse = ledger.paginationEvents.find(event => event.kind === "thread-list-response-sent" && event.page === "p1" && event.ownerEpoch === 1);
    const initial = await readCursorListSnapshot(page);
    result.stages.firstPage = {
      routeMatch: true,
      profileIdentityPresent: Boolean(profile.id),
      responseObserved: true,
      protocolResponseRowCount: firstPageResponse?.rowCount ?? null,
      connectionOrdinal: firstPageResponse?.connectionOrdinal ?? null,
      visibleFirstPageRow: initial.visibleTestIds.includes(`session-${firstPageRowId}`),
      viewport: initial.viewport,
      scrollport: initial.scrollport,
      visibleTestIds: initial.visibleTestIds,
      listCount: initial.allFixtureRowCount,
    };
    assert.equal(result.stages.firstPage.protocolResponseRowCount, 16, "the first real thread/list fixture response must contain the full 16-row page");
    assert.equal(firstPageResponse?.requestCursor, null, "the first Sessions page must be requested without a cursor");
    assert.equal(firstPageResponse?.requestedLimit, 50, "the actual first Sessions request must use the 50-row page limit");
    assert.equal(result.stages.firstPage.visibleFirstPageRow, true, "the actual first cursor page must render an actionable visible row");

    stage = "load-cursor-page-two-by-touch";
    const cursorTwo = await driveTouchUntilCursor(context, page, paginationFixture, ledger, "cursor-page-2", "toward-list-end", 5, recordCursorGesture);
    result.stages.cursorTwoHeld = cursorTwo.gate;
    assert.equal(cursorTwo.gate?.status, "held", "an actual trusted list gesture must trigger the app's cursor-page-2 thread/list request");
    assert.equal(cursorTwo.gate.responseSummary?.rowCount, 16, "the held second page must contain exactly 16 fixture rows");
    assert.equal(cursorTwo.gate.responseSummary?.method, "thread/list", "page two must be held for the actual thread/list RPC");
    assert.equal(cursorTwo.gate.responseSummary?.routeKind, "sessions", "page two must belong to the actual Sessions route");
    assert.equal(cursorTwo.gate.responseSummary?.cursor, "cursor-page-2", "the held response must match the actual requested cursor");
    assert.equal(cursorTwo.gate.responseSummary?.limit, 50, "the actual second-page request must retain its 50-row limit");
    assert.equal(cursorTwo.gate.responseSummary?.connectionOrdinal, firstPageResponse?.connectionOrdinal,
      "the cursor page must stay on the original first-page Gateway RPC connection");
    result.heldCursorResponses.push(cursorTwo.gate.responseSummary);

    stage = "first-page-usable-while-page-two-held";
    const backTowardFirstPage = await driveTouchUntilVisibleRow(page, paginationFixture, firstPageRowId, "toward-list-start", 5, context.abortSignal);
    result.gestures.push(...backTowardFirstPage.gestures);
    const heldPageTwoSnapshot = await readCursorListSnapshot(page);
    const heldFirstPageRowHit = await readCursorRowHit(page, firstPageRowId);
    result.stages.firstPageWhileCursorTwoHeld = {
      cursorTwoStillHeld: paginationFixture.gate("cursor-page-2")?.status === "held",
      touchBudget: backTowardFirstPage.budget,
      firstPageRowVisible: heldPageTwoSnapshot.visibleTestIds.includes(`session-${firstPageRowId}`),
      firstPageRowHitMatches: heldFirstPageRowHit.hitTargetMatchesRow,
      pageTwoRowCountBeforeRelease: await page.locator(`[data-testid^="session-cursor-p2-"]`).count(),
      scrollport: heldPageTwoSnapshot.scrollport,
      visibleTestIds: heldPageTwoSnapshot.visibleTestIds,
    };
    assert.equal(result.stages.firstPageWhileCursorTwoHeld.cursorTwoStillHeld, true, "page two must remain pending while verifying the first page");
    assert.equal(result.stages.firstPageWhileCursorTwoHeld.firstPageRowVisible, true, "the already-loaded first page must remain visible while its next cursor response is held");
    assert.equal(result.stages.firstPageWhileCursorTwoHeld.firstPageRowHitMatches, true, "the first-page row must remain a real hit target while its next response is held");
    assert.equal(result.stages.firstPageWhileCursorTwoHeld.pageTwoRowCountBeforeRelease, 0, "page-two rows must not appear before their correlated held response is released");

    stage = "release-and-verify-page-two-append";
    assert.equal(paginationFixture.release("cursor-page-2", "send-page"), true, "the held page-two response must be released exactly once");
    await waitFor(() => paginationFixture.gate("cursor-page-2")?.status === "sent", 10_000, "correlated page-two response delivered", 40, context.abortSignal);
    const pageTwoResponse = ledger.paginationEvents.find(event => event.kind === "thread-list-response-sent" && event.page === "p2");
    const appended = await readCursorListSnapshot(page);
    result.stages.pageTwoAppend = {
      responseSent: true,
      protocolResponseRowCount: pageTwoResponse?.rowCount ?? null,
      firstPageRowVisibleAfterAppendBeforeCursorThree: false,
      firstPageRowHitAfterAppendBeforeCursorThree: false,
      cursorThreeStatusBeforeTrigger: null,
      pageTwoRepresentativeVisibleAfterCursorThreeTrigger: false,
      visibleTestIds: appended.visibleTestIds,
      scrollport: appended.scrollport,
    };
    assert.equal(result.stages.pageTwoAppend.protocolResponseRowCount, 16, "the sent second page must contain exactly 16 fixture rows");
    assert.equal(pageTwoResponse?.requestCursor, "cursor-page-2", "the delivered page-two response must match its actual request cursor");

    stage = "verify-page-two-append-keeps-first-page-actionable-before-cursor-page-three";
    const firstPageAfterAppend = await readCursorListSnapshot(page);
    const firstPageHitAfterAppend = await readCursorRowHit(page, firstPageRowId);
    const cursorThreeStatusBeforeTrigger = paginationFixture.gate("cursor-page-3")?.status ?? "NOT_OBSERVED";
    result.stages.pageTwoAppend.firstPageRowVisibleAfterAppendBeforeCursorThree = firstPageAfterAppend.visibleTestIds.includes(`session-${firstPageRowId}`);
    result.stages.pageTwoAppend.firstPageRowHitAfterAppendBeforeCursorThree = firstPageHitAfterAppend.hitTargetMatchesRow;
    result.stages.pageTwoAppend.cursorThreeStatusBeforeTrigger = cursorThreeStatusBeforeTrigger;
    assert.equal(result.stages.pageTwoAppend.firstPageRowVisibleAfterAppendBeforeCursorThree, true,
      "the first page must remain visible after page two is appended and before the next cursor is triggered");
    assert.equal(result.stages.pageTwoAppend.firstPageRowHitAfterAppendBeforeCursorThree, true,
      "the first-page row must remain a real hit target after page two is appended and before the next cursor is triggered");
    assert.equal(cursorThreeStatusBeforeTrigger, "armed", "page three must not be requested before checking the appended page's first-page row");

    stage = "load-cursor-page-three-by-touch";
    const cursorThree = await driveTouchUntilCursor(context, page, paginationFixture, ledger, "cursor-page-3", "toward-list-end", 10, recordCursorGesture);
    result.stages.cursorThreeHeld = cursorThree.gate;
    const cursorThreeHeldAtNodeMs = performance.now();
    result.stages.cursorThreeHeldAtNodeMs = cursorThreeHeldAtNodeMs;
    assert.equal(cursorThree.gate?.status, "held", "continued trusted list gestures must trigger the actual page-three cursor request");
    assert.equal(cursorThree.gate.responseSummary?.rowCount, 8, "the held final page must contain exactly eight fixture rows");
    assert.equal(cursorThree.gate.responseSummary?.method, "thread/list", "page three must be held for the actual thread/list RPC");
    assert.equal(cursorThree.gate.responseSummary?.routeKind, "sessions", "page three must belong to the actual Sessions route");
    assert.equal(cursorThree.gate.responseSummary?.cursor, "cursor-page-3", "the held response must match the actual requested cursor");
    assert.equal(cursorThree.gate.responseSummary?.limit, 50, "the actual third-page request must retain its 50-row limit");
    assert.equal(cursorThree.gate.responseSummary?.connectionOrdinal, firstPageResponse?.connectionOrdinal,
      "the later cursor page must stay on the original first-page Gateway RPC connection");
    result.heldCursorResponses.push(cursorThree.gate.responseSummary);

    stage = "click-visible-page-two-row-while-page-three-pending";
    const p3GateAtNavigation = paginationFixture.gate("cursor-page-3");
    assert.equal(p3GateAtNavigation?.status, "held", "page three must still be held when navigation begins");
    const clickable = await readCursorRowHit(page, pageTwoTaskRowId);
    assert.equal(clickable.visible, true, "a real page-two row must be visible when cursor three is pending");
    assert.equal(clickable.hitTargetMatchesRow, true, "the visible row click point must hit the actual page-two row");
    result.stages.pageTwoAppend.pageTwoRepresentativeVisibleAfterCursorThreeTrigger = clickable.visible;
    result.stages.pageTwoAppend.pageTwoRepresentativeTestId = clickable.testId;
    const title = `Cursor P2 row 08`;
    const profileId = profile.id;
    const threadId = pageTwoTaskRowId;
    const expectedTaskPath = `/mobile/h/${encodeURIComponent(profileId)}/task/touch-local/${encodeURIComponent(threadId)}`;
    await page.locator(`[data-testid="session-${threadId}"]`).click({ timeout: 2_500 });
    const remainingNavigationBudgetMs = Math.max(1, 5_000 - (performance.now() - cursorThreeHeldAtNodeMs));
    const route = await waitFor(() => {
      try {
        const url = new URL(page.url());
        return url.origin === new URL(gateway.baseUrl).origin
          && url.pathname === expectedTaskPath
          && url.searchParams.get("cwd") === workspace
          && url.searchParams.get("title") === title
          ? { pathnameMatches: true, cwdMatches: true, titleMatches: true }
          : false;
      } catch { return false; }
    }, remainingNavigationBudgetMs, "clicked Sessions row to exact task route within the held-cursor budget", 35, context.abortSignal);
    const cursorThreeHeldToTaskRouteElapsedMs = performance.now() - cursorThreeHeldAtNodeMs;
    assert.ok(cursorThreeHeldToTaskRouteElapsedMs < 5_000,
      "the currently visible page-two row must navigate to Task within five seconds of page three becoming held");
    stage = "verify-owner-close-cancels-held-page-three-transport";
    await waitFor(() => paginationFixture.gate("cursor-page-3")?.status === "transport-closed", 5_000,
      "page-three owner transport closed after leaving Sessions", 35, context.abortSignal);
    const pageThreeAfterTaskRoute = paginationFixture.gate("cursor-page-3");
    const cursorThreeHeldToConnectionCloseElapsedMs = performance.now() - cursorThreeHeldAtNodeMs;
    assert.equal(p3GateAtNavigation?.status, "held", "the route transition must begin with page three held");
    assert.equal(pageThreeAfterTaskRoute?.status, "transport-closed", "leaving Sessions must close its owned page-three transport");
    assert.equal(pageThreeAfterTaskRoute?.connectionClosed, true, "the held cursor's original Gateway connection must be closed by owner cleanup");
    assert.ok(cursorThreeHeldToConnectionCloseElapsedMs < 5_000,
      "the page-three owner connection must close within five seconds of its held response");
    const pageThreeResponseBeforeFreshOwner = ledger.paginationEvents.find(event => event.kind === "thread-list-response-sent"
      && event.page === "p3" && event.cursor === "cursor-page-3");
    assert.equal(pageThreeResponseBeforeFreshOwner, undefined, "owner cleanup must close the held request without sending a page-three frame");
    result.ownerCancellation = {
      heldResponseSummary: p3GateAtNavigation?.responseSummary ?? null,
      pageThreeStatusAtNavigation: p3GateAtNavigation?.status ?? "NOT_OBSERVED",
      pageThreeStatusAfterTaskRoute: pageThreeAfterTaskRoute?.status ?? "NOT_OBSERVED",
      p3HeldToConnectionCloseElapsedMs: cursorThreeHeldToConnectionCloseElapsedMs,
      originalConnectionClosedAfterLeavingSessions: pageThreeAfterTaskRoute?.connectionClosed === true,
      pageThreeFrameSentBeforeFreshOwner: false,
      lateDelivery: "awaiting-fresh-owner-check",
      lateResponseReleaseAttempted: false,
      lateResponseReleaseAccepted: null,
      lateResponseFrameSent: false,
    };
    await page.locator('[data-testid="task-header"]').waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => ledger.paginationEvents.some(event => event.kind === "thread-read-response" && event.threadId === threadId),
      10_000, "correlated thread/read response for clicked page-two row", 40, context.abortSignal);
    result.taskClick = {
      selectedRowTestId: `session-${threadId}`,
      visibleBeforeClick: clickable.visible,
      hitTargetMatchesRow: clickable.hitTargetMatchesRow,
      p3HeldAtNodeMs: cursorThreeHeldAtNodeMs,
      p3HeldToTaskRouteElapsedMs: cursorThreeHeldToTaskRouteElapsedMs,
      route,
      taskHeaderVisible: true,
      threadReadCorrelated: true,
    };

    stage = "return-to-sessions-and-check-owner-isolation";
    paginationFixture.expectFreshOwner();
    await page.locator('[data-testid="task-header"] button[aria-label="返回"]').click();
    const returnedToSessions = await waitFor(() => {
      try {
        const url = new URL(page.url());
        return isOwnedSessionsRoute(url, gateway.baseUrl, profile.id);
      } catch { return false; }
    }, 20_000, "visible Task back action returns to the same Sessions owner route", 50, context.abortSignal);
    await page.locator(listSelector).waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(`[data-testid="session-${firstPageRowId}"]`).waitFor({ state: "visible", timeout: 20_000 });
    await waitFor(() => paginationFixture.freshOwnerFirstPageSent, 10_000,
      "fresh Sessions owner first-page response delivered", 40, context.abortSignal);
    const freshOwnerFirstPageResponse = ledger.paginationEvents.find(event => event.kind === "thread-list-response-sent" && event.page === "p1" && event.ownerEpoch === 2);
    assert.equal(freshOwnerFirstPageResponse?.rowCount, 16, "the returned owner must receive its own 16-row first page");
    const pageThreeBeforeLateReleaseAttempt = paginationFixture.gate("cursor-page-3");
    assert.equal(pageThreeBeforeLateReleaseAttempt?.status, "transport-closed", "the original page-three request must remain transport-closed when the fresh owner is ready");
    assert.equal(pageThreeBeforeLateReleaseAttempt?.connectionClosed, true, "the original page-three connection must remain closed before attempting a late fixture release");
    const lateResponseReleaseAttempted = true;
    const lateResponseReleaseAttemptAtNodeMs = performance.now();
    const lateResponseReleaseAccepted = paginationFixture.release("cursor-page-3", "send-late");
    await waitForStableScroll(page, listSelector);
    const pageThreeAfterFreshOwner = paginationFixture.gate("cursor-page-3");
    const pageThreeResponseEvent = ledger.paginationEvents.find(event => event.kind === "thread-list-response-sent"
      && event.page === "p3" && event.cursor === "cursor-page-3");
    const lateDeliveryPrevented = lateResponseReleaseAttempted
      && lateResponseReleaseAccepted === false
      && pageThreeAfterFreshOwner?.status === "transport-closed"
      && pageThreeAfterFreshOwner?.connectionClosed === true
      && pageThreeResponseEvent === undefined;
    assert.equal(lateResponseReleaseAccepted, false,
      "the fixture must reject a send-late release after the owner has closed the held response transport");
    assert.equal(pageThreeAfterFreshOwner?.status, "transport-closed", "the fresh-owner check must not reopen the old page-three transport");
    assert.equal(pageThreeAfterFreshOwner?.connectionClosed, true, "the late-release attempt must leave the original owner connection closed");
    assert.equal(pageThreeResponseEvent, undefined, "no page-three response frame may be sent after the owner connection closes");
    Object.assign(result.ownerCancellation, {
      pageThreeStatusAtFreshOwnerFirstPage: pageThreeBeforeLateReleaseAttempt?.status ?? "NOT_OBSERVED",
      pageThreeStatusAfterLateReleaseAttempt: pageThreeAfterFreshOwner?.status ?? "NOT_OBSERVED",
      freshOwnerFirstPageResponseAtNodeMs: freshOwnerFirstPageResponse?.atNodeMs ?? null,
      originalConnectionClosedAfterLeavingSessions: Boolean(pageThreeAfterFreshOwner?.connectionClosed),
      lateResponseReleaseAttemptAtNodeMs,
      lateResponseReleaseAttempted,
      lateResponseReleaseAccepted,
      lateResponseFrameSent: pageThreeResponseEvent !== undefined,
      lateDelivery: lateDeliveryPrevented ? "prevented-by-owner-close" : "NOT_OBSERVED",
      lateDeliveryPrevented,
    });
    const returnedPage = await readCursorListSnapshot(page);
    const returnedFreshOwner = paginationFixture.freshOwnerFirstPageSent;
    const p3InitiallyAbsent = !returnedPage.allTestIds.some(testId => testId.startsWith(`session-${pageThreeRowPrefix}`));
    const p2InitiallyAbsent = !returnedPage.allTestIds.some(testId => testId.startsWith("session-cursor-p2-"));
    assert.equal(p2InitiallyAbsent, true, "the fresh owner's initial projection must not contain the old page-two rows");
    assert.equal(p3InitiallyAbsent, true, "the fresh owner's initial projection must not contain the held page-three rows");
    const returnToFreshFirstPage = await driveTouchUntilVisibleRow(
      page, paginationFixture, firstPageRowId, "toward-list-start", 20, context.abortSignal,
    );
    result.gestures.push(...returnToFreshFirstPage.gestures);
    const returnedFirstPage = await readCursorListSnapshot(page);
    const returnedFirstPageHit = await readCursorRowHit(page, firstPageRowId);
    const firstPageVisibleAtFreshOwner = returnedFirstPage.visibleTestIds.includes(`session-${firstPageRowId}`);
    const firstPageHitAtFreshOwner = returnedFirstPageHit.hitTargetMatchesRow;
    assert.equal(firstPageVisibleAtFreshOwner, true, "the fresh owner must make its first-page row visible after bounded trusted navigation");
    assert.equal(firstPageHitAtFreshOwner, true, "the fresh owner's first-page row must be a real hit target after bounded trusted navigation");
    const returnGestures = await driveTouchUntilListEnd(page, 5, context.abortSignal);
    result.gestures.push(...returnGestures.gestures);
    assert.ok(returnToFreshFirstPage.gestures.length + returnGestures.gestures.length > 0,
      "verify fresh-owner isolation with trusted touch when the list is restored at either end");
    const listEndAfterReturn = await readCursorListSnapshot(page);
    const pageThreeAbsentAfterScrollingReturnedList = !listEndAfterReturn.allTestIds.some(testId => testId.startsWith(`session-${pageThreeRowPrefix}`));
    const pageTwoAbsentAfterScrollingReturnedList = !listEndAfterReturn.allTestIds.some(testId => testId.startsWith("session-cursor-p2-"));
    result.stages.returnedOwner = {
      routeReturnedByVisibleTaskBack: returnedToSessions,
      freshOwnerFirstPageRequested: paginationFixture.freshOwnerFirstPageSeen,
      freshOwnerFirstPagePrepared: paginationFixture.freshOwnerFirstPagePrepared,
      freshOwnerFirstPageSent: returnedFreshOwner,
      firstPageVisible: firstPageVisibleAtFreshOwner,
      firstPageHitMatchesAfterBoundedTouch: firstPageHitAtFreshOwner,
      pageTwoAbsentBeforeFurtherScroll: p2InitiallyAbsent,
      pageThreeAbsentBeforeFurtherScroll: p3InitiallyAbsent,
      returnToFirstPageTouchBudget: returnToFreshFirstPage.budget,
      returnToFirstPageScrolls: returnToFreshFirstPage.gestures.map(item => ({ before: item.before?.scrollTop, after: item.after?.scrollTop, delta: item.scrollDelta })),
      pageTwoAbsentAfterTrustedScrollToReturnedListEnd: pageTwoAbsentAfterScrollingReturnedList,
      pageThreeAbsentAfterTrustedScrollToReturnedListEnd: pageThreeAbsentAfterScrollingReturnedList,
      trustedTouchToListEndObserved: returnGestures.gestures.length > 0
        && returnGestures.gestures.every(item => item.gates.trustedTouchSequence === true && item.gates.trustedScrollEvent === true),
      scrolls: returnGestures.gestures.map(item => ({ before: item.before?.scrollTop, after: item.after?.scrollTop, delta: item.scrollDelta })),
      firstPageScrollport: returnedFirstPage.scrollport,
      visibleTestIdsAtListEnd: listEndAfterReturn.visibleTestIds,
      scrollportAtListEnd: listEndAfterReturn.scrollport,
    };
  } catch (error) {
    primaryError = error;
    result.failure = { stage, errorName: safeErrorName(error), message: safeDiagnosticMessage(error) };
    try {
      const failedUrl = new URL(page.url());
      result.failure.routeEvidence = {
        ownedGatewayOrigin: failedUrl.origin === new URL(gateway.baseUrl).origin,
        pathname: safePath(failedUrl.pathname),
        profileIdQueryCount: failedUrl.searchParams.getAll("profileId").length,
      };
    } catch { result.failure.routeEvidence = { urlParseFailed: true }; }
    try {
      const sameOwnedOrigin = new URL(page.url()).origin === new URL(gateway.baseUrl).origin;
      const credentialFieldVisible = await page.locator('input[type="password"]:visible, input[name="token"]:visible, [data-testid="gateway-token"]:visible').count() > 0;
      const welcomeVisible = await page.locator('[data-testid="welcome-direct-connection"]:visible').count() > 0;
      if (sameOwnedOrigin && !credentialFieldVisible && !welcomeVisible) {
        const screenshot = "cursor-pagination-failure.png";
        await page.screenshot({ path: context.pathInArtifacts(screenshot), fullPage: false });
        result.failure.screenshot = screenshot;
      } else result.failure.screenshot = "skipped-sensitive-or-foreign-page";
    } catch (screenshotError) {
      result.failure.screenshotErrorName = safeErrorName(screenshotError);
    }
  } finally {
    paginationFixture.releaseAll();
    const lateDeliveryPreventedByOwnerClose = result.ownerCancellation?.lateDelivery === "prevented-by-owner-close"
      && result.ownerCancellation?.originalConnectionClosedAfterLeavingSessions === true
      && result.ownerCancellation?.lateResponseReleaseAttempted === true
      && result.ownerCancellation?.lateResponseReleaseAccepted === false
      && result.ownerCancellation?.lateResponseFrameSent === false
      && result.stages.returnedOwner?.freshOwnerFirstPageSent === true
      && result.stages.returnedOwner?.trustedTouchToListEndObserved === true
      && result.stages.returnedOwner?.pageTwoAbsentAfterTrustedScrollToReturnedListEnd === true
      && result.stages.returnedOwner?.pageThreeAbsentAfterTrustedScrollToReturnedListEnd === true;
    result.gates = {
      actualChromiumWindowSizeCaptured: actualWindowSizeCaptured,
      firstPageVisible: result.stages.firstPage?.visibleFirstPageRow === true,
      cursorTwoRequestedAndHeld: result.stages.cursorTwoHeld?.status === "held",
      firstPageUsableWhileHeld: result.stages.firstPageWhileCursorTwoHeld?.firstPageRowVisible === true
        && result.stages.firstPageWhileCursorTwoHeld?.firstPageRowHitMatches === true
        && result.stages.firstPageWhileCursorTwoHeld?.pageTwoRowCountBeforeRelease === 0,
      pageTwoResponseDelivered: result.stages.pageTwoAppend?.responseSent === true,
      pageTwoAppendedWithoutReplacingPageOne: result.stages.pageTwoAppend?.firstPageRowVisibleAfterAppendBeforeCursorThree === true
        && result.stages.pageTwoAppend?.firstPageRowHitAfterAppendBeforeCursorThree === true
        && result.stages.pageTwoAppend?.cursorThreeStatusBeforeTrigger === "armed"
        && result.stages.pageTwoAppend?.pageTwoRepresentativeVisibleAfterCursorThreeTrigger === true,
      cursorThreeRequestedAndHeld: result.stages.cursorThreeHeld?.status === "held",
      cursorThreeHeldPageTwoHitNavigatedWithinFiveSeconds: result.taskClick?.visibleBeforeClick === true
        && result.taskClick?.hitTargetMatchesRow === true
        && Number.isFinite(result.taskClick?.p3HeldToTaskRouteElapsedMs)
        && result.taskClick.p3HeldToTaskRouteElapsedMs < 5_000,
      clickedPageTwoRowOpenedTask: result.taskClick?.route?.pathnameMatches === true
        && result.taskClick?.route?.cwdMatches === true
        && result.taskClick?.route?.titleMatches === true
        && result.taskClick?.threadReadCorrelated === true,
      taskRouteCleanupObserved: result.ownerCancellation?.originalConnectionClosedAfterLeavingSessions === true,
      returnedToSameSessionsOwner: result.stages.returnedOwner?.routeReturnedByVisibleTaskBack === true,
      freshOwnerFirstPageResponseSent: result.stages.returnedOwner?.freshOwnerFirstPageSent === true,
      returnedOwnerHasOnlyFreshFirstPage: result.stages.returnedOwner?.firstPageVisible === true
        && result.stages.returnedOwner?.firstPageHitMatchesAfterBoundedTouch === true
        && result.stages.returnedOwner?.pageTwoAbsentAfterTrustedScrollToReturnedListEnd === true
        && result.stages.returnedOwner?.pageThreeAbsentAfterTrustedScrollToReturnedListEnd === true
        && result.stages.returnedOwner?.trustedTouchToListEndObserved === true,
      pageThreeNotProjectedIntoReturnedList: result.stages.returnedOwner?.pageThreeAbsentAfterTrustedScrollToReturnedListEnd === true,
      lateDeliveryPreventedByOwnerClose,
      lateDelivery: lateDeliveryPreventedByOwnerClose ? "prevented-by-owner-close" : "NOT_OBSERVED",
    };
    result.protocol = {
      websocketConnections: ledger.websocketConnections,
      websocketRejected: ledger.websocketRejected,
      websocketFixtureErrors: ledger.websocketFixtureErrors,
      requestCount: ledger.requestCount,
      threadListRequests: ledger.threadListRequests,
      threadListReplies: ledger.threadListReplies,
      duplicateCursorRequestCount: ledger.duplicateCursorRequestCount,
      forbiddenMutationRequests: ledger.forbiddenMutationRequests,
      paginationEvents: ledger.paginationEvents,
      paginationEventOverflow: ledger.paginationEventOverflow,
      freshOwnerFirstPageSeen: paginationFixture.freshOwnerFirstPageSeen,
    };
    try {
      const sourceDistAfter = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256: expectedDistManifestSha256 });
      result.postflight.sourceDistStable = sourceDistAfter.resourceTableSha256 === sourceDist.resourceTableSha256;
      result.postflight.sourceDistManifestSha256 = sourceDistAfter.manifestSha256;
      result.postflight.sourceDistResourceCount = sourceDistAfter.resourceCount;
    } catch (error) {
      result.postflight.sourceDistStable = false;
      result.postflight.sourceDistErrorName = safeErrorName(error);
    }
    try {
      result.postflight.sourceBoundaryAfter = await verifySourceBoundary();
      result.postflight.sourceBoundaryStable = sourceBoundaryStable(sourceBoundaryBefore, result.postflight.sourceBoundaryAfter);
    } catch (error) {
      result.postflight.sourceBoundaryStable = false;
      result.postflight.sourceBoundaryErrorName = safeErrorName(error);
    }
    try {
      const gatewayAfter = await latencyHelpers.inspectGatewayRuntimeSnapshot(gatewayRuntime.root);
      result.postflight.gatewayRuntimeStable = gatewayAfter.sourceDigest === gatewayRuntime.manifest.sourceTreeSha256
        && gatewayAfter.dependencyDigest === gatewayRuntime.manifest.dependencyTreeSha256;
      result.postflight.gatewaySourceTreeSha256 = gatewayAfter.sourceDigest;
      result.postflight.gatewayDependencyTreeSha256 = gatewayAfter.dependencyDigest;
    } catch (error) {
      result.postflight.gatewayRuntimeStable = false;
      result.postflight.gatewayRuntimeErrorName = safeErrorName(error);
    }
    if (PINNED_CURSOR_INPUT_DIAGNOSTIC) {
      try {
        result.postflight.browserTouchInputSha256 = sha256(await readFile(browserTouchInputPath));
        result.postflight.browserTouchInputStable = result.postflight.browserTouchInputSha256 === browserTouchInputSha256;
      } catch (error) {
        result.postflight.browserTouchInputStable = false;
        result.postflight.browserTouchInputErrorName = safeErrorName(error);
      }
    }
    result.postflight.complete = result.postflight.sourceDistStable === true
      && result.postflight.sourceBoundaryStable === true && result.postflight.gatewayRuntimeStable === true
      && (!PINNED_CURSOR_INPUT_DIAGNOSTIC || result.postflight.browserTouchInputStable === true);
    const protocolClean = ledger.forbiddenMutationRequests.length === 0 && ledger.websocketRejected === 0
      && ledger.websocketFixtureErrors === 0 && ledger.foreignHttpBlocked === 0
      && ledger.httpResponseOverflow === 0 && ledger.pageErrors === 0 && ledger.consoleErrors === 0
      && ledger.paginationEventOverflow === 0 && ledger.duplicateCursorRequestCount === 0;
    result.gates.protocolClean = protocolClean;
    result.gates.postflightComplete = result.postflight.complete;
    const required = ["actualChromiumWindowSizeCaptured", "firstPageVisible", "cursorTwoRequestedAndHeld", "firstPageUsableWhileHeld", "pageTwoResponseDelivered",
      "pageTwoAppendedWithoutReplacingPageOne", "cursorThreeRequestedAndHeld", "clickedPageTwoRowOpenedTask",
      "cursorThreeHeldPageTwoHitNavigatedWithinFiveSeconds", "taskRouteCleanupObserved", "returnedToSameSessionsOwner", "freshOwnerFirstPageResponseSent",
      "returnedOwnerHasOnlyFreshFirstPage", "pageThreeNotProjectedIntoReturnedList", "lateDeliveryPreventedByOwnerClose"];
    const requiredCoreComplete = required.every(name => result.gates[name] === true);
    result.status = requiredCoreComplete && protocolClean && result.postflight.complete && !primaryError
      ? "observations-complete" : "partial";
    result.completion = { requiredCoreComplete, lateDeliveryPreventedByOwnerClose, protocolClean, postflightComplete: result.postflight.complete };
    await context.writeArtifactJson("cursor-pagination-result.json", result);
  }
  if (primaryError) throw primaryError;
  if (result.status !== "observations-complete") {
    throw new Error(`cursor pagination diagnostic incomplete: ${result.status}; see cursor-pagination-result.json`);
  }
  return { status: result.status, classification: result.classification, gateCount: Object.keys(result.gates).length };
}

async function driveTouchUntilCursor(context, page, paginationFixture, ledger, cursor, direction, maximumGestures, onGesture = null) {
  const gestures = [];
  for (let index = 0; index < maximumGestures; index += 1) {
    if (paginationFixture.gate(cursor)?.status === "held") break;
    const gesture = await performCursorListGesture(page, direction, `cursor-${cursor}-gesture-${index + 1}`, context.abortSignal, onGesture);
    gestures.push(gesture);
    assert.equal(gesture.gates.trustedTouchSequence, true, "cursor pagination must be driven by a trusted touch sequence inside the real Sessions list");
    assert.equal(gesture.gates.actualViewport, true, "cursor pagination must keep the actual 390x844 DPR3 mobile viewport");
    assert.equal(gesture.gates.trustedScrollEvent, true, "each cursor-pagination touch must produce a trusted Sessions scroll event");
    assert.equal(gesture.gates.scrollChanged, true, "cursor pagination may advance only after the actual list offset changes");
    assert.equal(gesture.pointGates.startWithinScrollport && gesture.pointGates.endWithinScrollport, true,
      "each cursor gesture must start and end on a hit-tested point inside the actual Sessions list");
    assert.equal(gesture.pointGates.bothAtOrAboveSafeBottom, true, "each cursor gesture must stay at y <= 550");
    assert.equal(gesture.gates.collectorsComplete, true, "bounded trusted input collectors must not drop events");
    assert.equal(gesture.expectedDirectionObserved, true, "the trusted touch must move the real Sessions list in the requested direction");
    if (paginationFixture.gate(cursor)?.status !== "held") {
      try {
        await waitFor(() => paginationFixture.gate(cursor)?.status === "held", 700,
          `actual ${cursor} request after trusted list scroll`, 35, context.abortSignal);
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        if (!String(error?.message ?? "").startsWith(`Timed out waiting for actual ${cursor} request`)) throw error;
      }
    }
  }
  return { gestures, gate: paginationFixture.gate(cursor) };
}

async function driveTouchUntilVisibleRow(page, paginationFixture, threadId, direction, gestureHardCap, signal) {
  const initialSnapshot = await readCursorListSnapshot(page);
  const scrollport = initialSnapshot.scrollport;
  const targetPosition = await page.locator(`[data-testid="session-${threadId}"]`).evaluate(row => {
    const port = document.querySelector('[data-testid="sessions-list"]');
    if (!port) throw new Error("Sessions scrollport missing while computing a bounded touch budget");
    const portRect = port.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return { top: rowRect.top - portRect.top, bottom: rowRect.bottom - portRect.top };
  });
  const distanceToVisiblePx = direction === "toward-list-start"
    ? Math.max(0, -targetPosition.bottom)
    : Math.max(0, targetPosition.top - scrollport.clientHeight);
  assert.ok(Number.isInteger(gestureHardCap) && gestureHardCap > 0 && gestureHardCap <= 20,
    "trusted row navigation has a hard cap of at most 20 gestures");
  const gestures = [];
  for (let index = 0; index < gestureHardCap; index += 1) {
    const snapshot = await readCursorListSnapshot(page);
    const rowIntersectsScrollport = snapshot.visibleTestIds.includes(`session-${threadId}`);
    const rowHit = rowIntersectsScrollport ? await readCursorRowHit(page, threadId) : null;
    if (rowHit?.visible === true && rowHit.hitTargetMatchesRow === true) break;
    const gesture = await performCursorListGesture(page, direction, `restore-${threadId}-gesture-${index + 1}`, signal);
    gestures.push(gesture);
    assert.equal(gesture.gates.trustedTouchSequence, true, "restoring the first page must use a trusted touch sequence");
    assert.equal(gesture.gates.trustedScrollEvent, true, "restoring the first page must produce a trusted Sessions scroll event");
    assert.equal(gesture.gates.collectorsComplete, true, "the first-page return gesture must not drop collected events");
    assert.equal(gesture.expectedDirectionObserved, true, "trusted return-to-first-page gesture must move the real list toward its first rows");
  }
  return {
    gestures,
    gate: paginationFixture.gate("cursor-page-2"),
    budget: {
      distanceToVisiblePx,
      gestureHardCap,
      actualGestureCount: gestures.length,
      actualProgressPx: gestures.map(gesture => gesture.scrollDelta),
    },
  };
}

async function driveTouchUntilListEnd(page, maximumGestures, signal) {
  const gestures = [];
  for (let index = 0; index < maximumGestures; index += 1) {
    const before = await readCursorListSnapshot(page);
    if (before.scrollport.scrollTop + before.scrollport.clientHeight >= before.scrollport.scrollHeight - 4) break;
    const gesture = await performCursorListGesture(page, "toward-list-end", `returned-list-end-${index + 1}`, signal);
    gestures.push(gesture);
    assert.equal(gesture.gates.trustedTouchSequence, true, "returned-owner scroll must use a trusted touch sequence");
    assert.equal(gesture.gates.trustedScrollEvent, true, "returned-owner scroll must produce a trusted Sessions scroll event");
    assert.equal(gesture.gates.collectorsComplete, true, "returned-owner touch collectors must not drop events");
    assert.equal(gesture.expectedDirectionObserved, true, "returned-owner verification must use real touch input to reach the list end");
  }
  return { gestures };
}

async function performCursorListGesture(page, direction, phase, signal, onGesture = null) {
  const selector = '[data-testid="sessions-list"]';
  const before = await readScrollport(page, selector);
  const gesture = cursorListGesture(before, direction);
  const hitTest = await readCursorGestureHitTest(page, selector, gesture);
  const pointGates = {
    startWithinViewport: hitTest.start?.withinViewport === true,
    endWithinViewport: hitTest.end?.withinViewport === true,
    startWithinScrollport: hitTest.start?.withinScrollportRect === true && hitTest.start?.hitWithinScrollport === true,
    endWithinScrollport: hitTest.end?.withinScrollportRect === true && hitTest.end?.hitWithinScrollport === true,
    bothAtOrAboveSafeBottom: Number.isFinite(hitTest.start?.y) && hitTest.start.y <= CURSOR_TOUCH_MAX_Y
      && Number.isFinite(hitTest.end?.y) && hitTest.end.y <= CURSOR_TOUCH_MAX_Y,
  };
  if (!Object.values(pointGates).every(Boolean)) {
    const setupEvidence = {
      phase, direction, setupStatus: "INVALID_SETUP", gesture, hitTest, pointGates,
      before: { viewport: before.viewport, scrollTop: before.scrollTop, scrollHeight: before.scrollHeight,
        clientHeight: before.clientHeight, box: before.box, overflowY: before.overflowY, touchAction: before.touchAction },
      gates: { ...pointGates, trustedTouchSequence: false, trustedScrollEvent: false, scrollChanged: false },
    };
    let evidenceError = null;
    try { await onGesture?.(setupEvidence); } catch (error) { evidenceError = error; }
    const setupError = new Error("cursor touch endpoints must hit inside the visible Sessions scrollport at y <= 550");
    throw evidenceError ? new AggregateError([setupError, evidenceError], "cursor input setup and evidence capture failed", { cause: setupError }) : setupError;
  }
  await resetTouchProbe(page, phase);
  let dispatchError = null;
  try {
    await dispatchTrustedTouchDrag(page, { ...gesture, force: 0.8, waitForAnimationFrame: true, animationFrameTimeoutMs: 1_000 }, signal);
  } catch (error) {
    dispatchError = error;
  }
  let settled = null;
  let settleError = null;
  try {
    settled = await waitForStableScroll(page, selector);
  } catch (error) {
    settleError = error;
  }
  let events = { touchEvents: [], scrollEvents: [], droppedTouchEvents: 0, droppedScrollEvents: 0 };
  let probeReadError = null;
  try { events = await readTouchProbe(page); } catch (error) { probeReadError = error; }
  let after = null;
  let afterReadError = null;
  try { after = await readScrollport(page, selector); } catch (error) { afterReadError = error; }
  const gates = touchGates(before, { ...settled, scrollport: after }, events, selector);
  const delta = after ? after.scrollTop - before.scrollTop : null;
  const record = {
    phase,
    direction,
    gesture,
    hitTest,
    pointGates,
    before: { viewport: before.viewport, scrollTop: before.scrollTop, scrollHeight: before.scrollHeight, clientHeight: before.clientHeight,
      box: before.box, overflowY: before.overflowY, touchAction: before.touchAction },
    after: after ? { viewport: after.viewport, scrollTop: after.scrollTop, scrollHeight: after.scrollHeight, clientHeight: after.clientHeight,
      box: after.box, overflowY: after.overflowY, touchAction: after.touchAction } : null,
    scrollDelta: delta,
    expectedDirectionObserved: Number.isFinite(delta) && (direction === "toward-list-end" ? delta > 1 : delta < -1),
    trustedTouchCount: events.touchEvents.filter(event => event.trusted && event.targetWithinScrollport).length,
    trustedScrollCount: events.scrollEvents.filter(event => event.trusted).length,
    touchEvents: events.touchEvents.slice(0, 32).map(event => ({ type: event.type, trusted: event.trusted, phase: event.phase,
      targetTag: event.targetTag, targetTestId: event.targetTestId, targetWithinScrollport: event.targetWithinScrollport,
      x: event.x, y: event.y, defaultPrevented: event.defaultPrevented, cancelable: event.cancelable })),
    scrollEvents: events.scrollEvents.slice(0, 16).map(event => ({ trusted: event.trusted, phase: event.phase,
      targetTag: event.targetTag, targetTestId: event.targetTestId, scrollportScrollTop: event.scrollportScrollTop,
      scrollportScrollHeight: event.scrollportScrollHeight, scrollportClientHeight: event.scrollportClientHeight })),
    capturedTouchEventCount: events.touchEvents.length,
    capturedScrollEventCount: events.scrollEvents.length,
    touchEvidenceTruncated: events.touchEvents.length > 32,
    scrollEvidenceTruncated: events.scrollEvents.length > 16,
    collectorDrops: { touch: events.droppedTouchEvents, scroll: events.droppedScrollEvents },
    stableFrames: settled?.stableFrames ?? null,
    settleElapsedMs: settled?.elapsedMs ?? null,
    gates,
  };
  if (dispatchError) record.dispatchError = { errorName: safeErrorName(dispatchError), message: safeDiagnosticMessage(dispatchError) };
  if (settleError) record.settleError = { errorName: safeErrorName(settleError), message: safeDiagnosticMessage(settleError) };
  if (probeReadError) record.probeReadErrorName = safeErrorName(probeReadError);
  if (afterReadError) record.afterReadErrorName = safeErrorName(afterReadError);
  let evidenceWriteError = null;
  try { await onGesture?.(record); } catch (error) { evidenceWriteError = error; }
  if (dispatchError || settleError || probeReadError || afterReadError || evidenceWriteError) {
    const errors = [dispatchError, settleError, probeReadError, afterReadError, evidenceWriteError].filter(Boolean);
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, "cursor touch gesture or evidence capture failed");
  }
  return record;
}

async function readCursorGestureHitTest(page, selector, gesture) {
  return page.evaluate(({ selector, gesture }) => {
    const port = document.querySelector(selector);
    const portRect = port?.getBoundingClientRect() ?? null;
    const describePoint = point => {
      const withinViewport = point.x >= 0 && point.x < innerWidth && point.y >= 0 && point.y < innerHeight;
      const hit = withinViewport ? document.elementFromPoint(point.x, point.y) : null;
      const path = [];
      for (let node = hit; node instanceof Element && path.length < 12; node = node.parentElement) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        path.push({ tag: node.tagName, testId: node.getAttribute("data-testid"),
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, touchAction: style.touchAction,
          pointerEvents: style.pointerEvents, overflowY: style.overflowY, scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight, clientHeight: node.clientHeight });
      }
      return { ...point, withinViewport,
        withinScrollportRect: Boolean(portRect && point.x >= portRect.left && point.x < portRect.right && point.y >= portRect.top && point.y < portRect.bottom),
        hitTag: hit?.tagName ?? null, hitTestId: hit?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        hitWithinScrollport: Boolean(port && hit && port.contains(hit)), path };
    };
    return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, maxTouchPoints: Number(navigator.maxTouchPoints) || 0 },
      scrollport: port && portRect ? { box: { x: portRect.x, y: portRect.y, width: portRect.width, height: portRect.height },
        scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight,
        overflowY: getComputedStyle(port).overflowY, touchAction: getComputedStyle(port).touchAction } : null,
      start: describePoint(gesture.start), end: describePoint(gesture.end) };
  }, { selector, gesture });
}

function cursorListGesture(scrollport, direction) {
  const viewport = scrollport.viewport;
  const box = scrollport.box;
  const left = Math.max(box.x, 0) + 12;
  const right = Math.min(box.x + box.width, viewport.width) - 12;
  const top = Math.max(box.y, 0) + 12;
  const bottom = Math.min(box.y + box.height, viewport.height, CURSOR_TOUCH_MAX_Y) - 12;
  assert.ok(right > left && bottom - top >= 48, "Sessions list must expose an interior touch target inside the actual viewport");
  const x = Math.min(Math.max(viewport.width / 2, left), right);
  const travel = Math.floor((bottom - top) * 0.88);
  assert.ok(travel >= 30, "Sessions list must expose enough measured interior height for a bounded touch gesture");
  let startY;
  let endY;
  if (direction === "toward-list-end") {
    startY = bottom;
    endY = Math.max(top, startY - travel);
  } else {
    startY = top;
    endY = Math.min(bottom, startY + travel);
  }
  assert.ok(Math.abs(endY - startY) >= 30, "the measured list interior must permit a meaningful bounded trusted gesture");
  return { start: { x, y: startY }, end: { x, y: endY }, moves: 12 };
}

async function readCursorListSnapshot(page) {
  return page.locator('[data-testid="sessions-list"]').evaluate(list => {
    const rect = list.getBoundingClientRect();
    const all = [...list.querySelectorAll('[data-testid^="session-cursor-"]')];
    const visibleTestIds = [];
    const allTestIds = [];
    for (const row of all.slice(0, 64)) {
      const testId = row.getAttribute("data-testid");
      if (!testId) continue;
      allTestIds.push(testId);
      const rowRect = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      if (style.display !== "none" && style.visibility !== "hidden" && rowRect.width > 0 && rowRect.height > 0
        && rowRect.right > rect.left && rowRect.left < rect.right && rowRect.bottom > rect.top && rowRect.top < rect.bottom
        && rowRect.right > 0 && rowRect.left < innerWidth && rowRect.bottom > 0 && rowRect.top < innerHeight) visibleTestIds.push(testId);
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, maxTouchPoints: Number(navigator.maxTouchPoints) || 0 },
      scrollport: { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } },
      allTestIds, visibleTestIds, allFixtureRowCount: allTestIds.length,
    };
  });
}

async function readCursorRowHit(page, threadId) {
  return page.locator(`[data-testid="session-${threadId}"]`).evaluate(row => {
    const rect = row.getBoundingClientRect();
    const list = document.querySelector('[data-testid="sessions-list"]');
    const listRect = list?.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      testId: row.getAttribute("data-testid"),
      visible: Boolean(listRect && rect.width > 0 && rect.height > 0 && rect.right > listRect.left && rect.left < listRect.right
        && rect.bottom > listRect.top && rect.top < listRect.bottom && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight),
      hitTargetMatchesRow: Boolean(hit && (hit === row || row.contains(hit))),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
}

function sourceBoundaryStable(before, after) {
  if (!before.mobileTree) return JSON.stringify(before) === JSON.stringify(after);
  const { currentHead: beforeHead, ...beforeScope } = before;
  const { currentHead: afterHead, ...afterScope } = after;
  return JSON.stringify(beforeScope) === JSON.stringify(afterScope);
}

function isOwnedSessionsRoute(candidate, gatewayBaseUrl, profileId) {
  try {
    const url = candidate instanceof URL ? candidate : new URL(candidate);
    return url.origin === new URL(gatewayBaseUrl).origin && url.pathname === "/mobile/sessions"
      && url.searchParams.getAll("profileId").length === 1 && url.searchParams.get("profileId") === profileId;
  } catch { return false; }
}

  return { createCursorPaginationFixture, createCursorResponseGate, runCursorPaginationDiagnostic, driveTouchUntilCursor, driveTouchUntilVisibleRow, driveTouchUntilListEnd, performCursorListGesture, readCursorGestureHitTest, cursorListGesture, readCursorListSnapshot, readCursorRowHit, sourceBoundaryStable, isOwnedSessionsRoute };
}
