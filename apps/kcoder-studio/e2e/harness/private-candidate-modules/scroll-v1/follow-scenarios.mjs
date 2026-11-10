// Private historical candidate mechanisms; construction starts no resources.
export function createPrivateScrollV1FollowScenarios({
  areNotificationBatchesOrdered,
  assert,
  fixturePageSize,
  installTranscriptFollowGestureInputTrace,
  measuredTranscriptLatestDistance,
  normalizeStableReaderAnchorWithTrustedInput,
  performProductTouchStroke,
  performProductTouchToOlderHistory,
  performProductWheelToOlderHistoryControl,
  performance,
  prepareProductTouchStroke,
  readProductHistoryViewport,
  readTranscriptFollowGestureInputTrace,
  readTranscriptViewport,
  safeSeedErrorMessage,
  safeSeedErrorStack,
  scrollTranscriptToLatest,
  serverId,
  threadId,
  transcriptInputEventsSince,
  transcriptVirtualizationTraceLimits,
  waitFor,
  waitForStableProductHistoryAnchor,
  waitForStableProductHistoryWindow,
  waitForTwoFrames,
}) {
function summarizeSeedDispatchEvidence(state, marker, result, frames = []) {
  const frameResults = Array.isArray(result?.frameResults) ? result.frameResults : [];
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  const observedMethods = frameResults.map((frame) => frame.method);
  const sequences = frameResults.map((frame) => frame.sequence);
  const expectedFrames = frames.map((frame) => ({
    method: frame.method,
    sequence: frame.params?.sequence ?? null,
    serverId: frame.params?.serverId ?? null,
    threadId: frame.params?.threadId ?? null,
    turnId: frame.params?.turnId ?? null,
  }));
  const browserMockIds = [...new Set(frameResults.map((frame) => frame.browserMockId).filter(Boolean))];
  const turnId = expectedFrames[0]?.turnId ?? null;
  const dispatchOrderValid = frameResults.length === expectedMethods.length
    && frames.length === expectedMethods.length
    && result?.delivered === expectedMethods.length
    && observedMethods.every((method, index) => method === expectedMethods[index])
    && frameResults.every((frame, index) => frame.serverId === expectedFrames[index]?.serverId
      && frame.threadId === expectedFrames[index]?.threadId
      && frame.turnId === expectedFrames[index]?.turnId)
    && browserMockIds.length === 1
    && frameResults.every((frame) => frame.browserMockId === result?.browserMockId)
    && sequences.every((value, index) => Number.isSafeInteger(value)
      && value === expectedFrames[index]?.sequence
      && (index === 0 || value > sequences[index - 1]));
  const route = state.activeSocketRoute;
  const durations = frameResults.map((frame) => frame.dispatchHandlerSyncMs).filter(Number.isFinite);
  return {
    marker,
    turnId,
    attemptId: expectedFrames[0] ? frames[0].params?.attemptId ?? null : null,
    itemId: expectedFrames[1] ? frames[1].params?.item?.id ?? null : null,
    serverId,
    channel: "runtime",
    workspaceLabel: `run-owned/workspace-${state.source}`,
    threadId,
    threadReadRequestId: state.activeThreadReadRequestId,
    route: route ? {
      routeOrdinal: route.routeOrdinal,
      server: route.server,
      channel: route.channel,
      workspaceMatchesFixture: route.workspaceMatchesFixture,
      threadReadRequestId: route.threadReadRequestId,
    } : null,
    deliveryReturned: result?.delivered ?? 0,
    dispatchStartedAtPageTimeMs: Number.isFinite(result?.dispatchStartedAt) ? result.dispatchStartedAt : null,
    expectedFrameCount: frames.length,
    eligibleSocketCount: result?.eligibleSocketCount ?? (frameResults.length ? 1 : 0),
    socketCopies: result?.socketCopies ?? null,
    browserMockId: result?.browserMockId ?? browserMockIds[0] ?? null,
    expectedFrames,
    observedMethods,
    observedSequences: sequences,
    dispatchOrderValid,
    dispatchTaskDurationsMs: result?.dispatchTaskDurationsMs ?? frameResults.map((frame) => frame.dispatchHandlerSyncMs),
    maximumDispatchHandlerSyncMs: durations.length ? Math.max(...durations) : null,
    frameResults: frameResults.map((frame) => ({
      method: frame.method,
      sequence: frame.sequence,
      serverId: frame.serverId,
      threadId: frame.threadId,
      turnId: frame.turnId,
      browserMockId: frame.browserMockId,
      dispatchHandlerSyncMs: frame.dispatchHandlerSyncMs,
      pageDispatchStartedAtMs: frame.pageDispatchStartedAtMs ?? null,
      pageDispatchCompletedAtMs: frame.pageDispatchCompletedAtMs ?? null,
      domRowCountBefore: frame.domRowCountBefore ?? null,
      domRowCountAfter: frame.domRowCountAfter ?? null,
    })),
    terminalNotificationStatus: frames.find((frame) => frame.method === "turn/completed")?.params?.turn?.status ?? null,
    fileChangesStatus: frames.find((frame) => frame.method === "turn/completed")?.params?.fileChanges?.status ?? null,
    evidenceBoundary: "test-side app-facing Playwright WebSocketMock dispatch and handler synchrony; does not alone prove reducer state, rendered row, queue state, or task submission",
  };
}

async function beginTranscriptVirtualizationScrollTrace(page, traceKey) {
  return page.evaluate(({ key, maxEvents, limits }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { status: "NO_MESSAGE_LIST" };
    const observedHost = list.querySelector("[data-phone-ux-scroll-host]");
    let host = observedHost instanceof HTMLElement ? observedHost : null;
    let largestOverflow = host ? host.scrollHeight - host.clientHeight : -1;
    let visitedNodes = 0;
    const queue = [{ element: list, depth: 0 }];
    const rowSelector = '[data-testid="message-user"], [data-testid="message-assistant"]';
    while (!host && queue.length > 0 && visitedNodes < limits.maxWalkNodesPerSample) {
      const current = queue.shift();
      const element = current?.element;
      if (!(element instanceof HTMLElement) || element.matches(rowSelector)) continue;
      visitedNodes += 1;
      const overflow = element.scrollHeight - element.clientHeight;
      if (overflow > 16 && overflow > largestOverflow) {
        host = element;
        largestOverflow = overflow;
      }
      if (current.depth >= limits.maxDepth) continue;
      const children = element.children;
      for (let index = 0; index < Math.min(children.length, limits.maxChildrenPerNode); index += 1) {
        const child = children[index];
        if (!child.matches(rowSelector)) queue.push({ element: child, depth: current.depth + 1 });
      }
    }
    if (!host) host = list;
    if (!(host instanceof HTMLElement)) return { status: "NO_SCROLL_HOST" };
    const state = { events: [], nextOrdinal: 1, recordedCount: 0, droppedCount: 0 };
    const listener = (event) => {
      const ordinal = state.nextOrdinal++;
      if (state.recordedCount >= maxEvents) {
        state.droppedCount += 1;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      state.events.push({
        ordinal,
        pageTimeMs: Number(performance.now().toFixed(3)),
        isTrusted: event.isTrusted === true,
        targetTag: target?.tagName?.slice(0, 16) ?? null,
        targetTestId: target?.getAttribute("data-testid")?.slice(0, limits.maxTestIdLength) ?? null,
        scrollTop: Number(host.scrollTop.toFixed(2)),
      });
      state.recordedCount += 1;
    };
    const traces = window.__phoneRenderTranscriptVirtualizationTraces instanceof Map
      ? window.__phoneRenderTranscriptVirtualizationTraces
      : new Map();
    window.__phoneRenderTranscriptVirtualizationTraces = traces;
    traces.set(key, { host, listener, state });
    host.addEventListener("scroll", listener, { capture: true, passive: true });
    return {
      status: "ATTACHED",
      hostTestId: host.getAttribute("data-testid")?.slice(0, limits.maxTestIdLength) ?? null,
      startedAtPageTimeMs: Number(performance.now().toFixed(3)),
      initialScrollTop: Number(host.scrollTop.toFixed(2)),
      initialScrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      hostSearchVisitedNodes: visitedNodes,
    };
  }, { key: traceKey, maxEvents: transcriptVirtualizationTraceLimits.maxScrollEvents, limits: transcriptVirtualizationTraceLimits });
}

async function stopTranscriptVirtualizationScrollTrace(page, trace) {
  if (trace.finished) return trace.summary;
  trace.finished = true;
  let stopped;
  try {
    stopped = await page.evaluate(({ key, maxEvents }) => {
      const traces = window.__phoneRenderTranscriptVirtualizationTraces;
      const entry = traces instanceof Map ? traces.get(key) : null;
      if (!entry) return { status: "TRACE_NOT_FOUND", pendingScrollEvents: [] };
      entry.host.removeEventListener("scroll", entry.listener, true);
      traces.delete(key);
      if (traces.size === 0) delete window.__phoneRenderTranscriptVirtualizationTraces;
      return {
        status: "DETACHED",
        totalEventsSeen: entry.state.nextOrdinal - 1,
        totalEventsRecorded: entry.state.recordedCount,
        totalEventsDropped: entry.state.droppedCount,
        pendingScrollEvents: entry.state.events.splice(0, maxEvents),
      };
    }, { key: trace.key, maxEvents: transcriptVirtualizationTraceLimits.maxScrollEvents });
  } catch (error) {
    stopped = { status: "STOP_FAILED", error: safeSeedErrorMessage(error), pendingScrollEvents: [] };
  }
  trace.summary = {
    schemaVersion: 1,
    status: stopped.status === "DETACHED" ? "CAPTURED" : "PARTIAL",
    evidenceBoundary: "bounded test-side DOM geometry and trusted scroll-event timing; no React internals or message body capture",
    limits: transcriptVirtualizationTraceLimits,
    start: trace.startEvidence,
    viewportSamplesCaptured: trace.viewportSamplesCaptured,
    viewportSamplesOmitted: trace.viewportSamplesOmitted,
    totalScrollEventsSeen: stopped.totalEventsSeen ?? null,
    totalScrollEventsRecorded: stopped.totalEventsRecorded ?? null,
    totalScrollEventsDropped: stopped.totalEventsDropped ?? null,
    trailingScrollEvents: stopped.pendingScrollEvents ?? [],
    stopStatus: stopped.status,
    stopError: stopped.error ?? null,
  };
  return trace.summary;
}

async function scrollTranscriptToLatestCore(page, expectedTailMarker, options = {}, geometryTrace = null) {
  const requireMarkerVisible = options.requireMarkerVisible === true;
  const readViewport = async () => {
    const captureGeometry = geometryTrace !== null
      && geometryTrace.viewportSamplesCaptured < transcriptVirtualizationTraceLimits.maxViewportSamples;
    if (captureGeometry) geometryTrace.viewportSamplesCaptured += 1;
    else if (geometryTrace !== null) geometryTrace.viewportSamplesOmitted += 1;
    const viewport = await readTranscriptViewport(page, expectedTailMarker, requireMarkerVisible, {
      captureVirtualizedGeometry: captureGeometry,
      captureScrollportTransform: true,
      scrollTraceKey: geometryTrace?.key ?? null,
    });
    return {
      ...viewport,
      logicalLatestDistance: viewport.listFound ? measuredTranscriptLatestDistance(viewport) : null,
    };
  };
  const before = await readViewport();
  const jumpToLatest = page.getByTestId("jump-to-latest");
  const actions = [];
  const pollSamples = [before];
  const pollDeadline = Date.now() + 10_000;
  let previous = null;
  let stableSamples = 0;
  let pollCount = 0;
  let last = before;
  try {
    await waitFor(async () => {
      if (Date.now() >= pollDeadline) return null;
      pollCount += 1;
      const current = await readViewport();
      pollSamples.push({ ...current, observationSource: "bounded-poll", poll: pollCount });
      const currentLogicalDistancePx = current.logicalLatestDistance?.pixels ?? null;
      const previousLogicalDistance = previous?.logicalLatestDistance ?? null;
      const jumpButtonVisible = await jumpToLatest.isVisible().catch(() => false);
      const requiredTargetVisible = requireMarkerVisible
        ? current.targetMarkerVisibleWithinMessageList
        : current.targetVisibleWithinMessageList;
      const alreadyAttempted = actions.some((entry) => entry.action === "jump-to-latest-touch-attempt");
      const alreadyTouched = actions.some((entry) => entry.action === "actual-touch-on-jump-to-latest");
      const tapBudgetMs = pollDeadline - Date.now();
      if (jumpButtonVisible && !requiredTargetVisible && !alreadyAttempted && !alreadyTouched && tapBudgetMs > 0) {
        const attempt = {
          action: "jump-to-latest-touch-attempt",
          attemptNumber: 1,
          atPoll: pollCount,
          startedAtPageTimeMs: current.sampledAtPageTimeMs ?? null,
          timeoutMs: Math.max(1, Math.min(750, tapBudgetMs)),
          outcome: "pending",
          viewport: current,
        };
        actions.push(attempt);
        try {
          await jumpToLatest.tap({ timeout: attempt.timeoutMs });
          if (geometryTrace) {
            try { attempt.completedAtPageTimeMs = await page.evaluate(() => Number(performance.now().toFixed(3))); }
            catch { attempt.completedAtPageTimeMs = null; }
          }
          attempt.outcome = "completed";
          actions.push({
            action: "actual-touch-on-jump-to-latest",
            atPoll: pollCount,
            viewport: current,
          });
          previous = null;
          stableSamples = 0;
          last = current;
          return null;
        } catch (error) {
          if (geometryTrace) {
            try { attempt.completedAtPageTimeMs = await page.evaluate(() => Number(performance.now().toFixed(3))); }
            catch { attempt.completedAtPageTimeMs = null; }
          }
          const message = String(error?.message || error);
          const detachedOrHiddenActionabilityFailure = /(?:element|node) was detached from (?:the )?DOM|not attached to (?:the )?DOM|not visible|hidden from layout/i.test(message);
          const afterFailedAttempt = await readViewport();
          const locatorVisibleAfterFailedAttempt = await jumpToLatest.isVisible().catch(() => false);
          const buttonGoneAfterFailedAttempt = !locatorVisibleAfterFailedAttempt && !afterFailedAttempt.jumpToLatestVisible;
          const recheckObservation = {
            ...afterFailedAttempt,
            observationSource: "jump-to-latest-attempt-recheck",
            poll: pollCount,
          };
          pollSamples.push(recheckObservation);
          if (detachedOrHiddenActionabilityFailure && buttonGoneAfterFailedAttempt) {
            attempt.outcome = "abandoned-after-detached-or-hidden-rerender";
            attempt.errorKind = /detached|not attached/i.test(message) ? "detached-during-actionability" : "hidden-during-actionability";
            attempt.recheck = {
              viewport: recheckObservation,
              locatorVisible: locatorVisibleAfterFailedAttempt,
              buttonGone: buttonGoneAfterFailedAttempt,
            };
            previous = null;
            stableSamples = 0;
            last = recheckObservation;
            return null;
          }
          attempt.outcome = "failed";
          attempt.errorKind = detachedOrHiddenActionabilityFailure
            ? "button-still-visible-after-detach-or-hidden-error"
            : "unexpected-tap-error";
          attempt.errorMessage = message.slice(0, 1200);
          attempt.recheck = {
            viewport: recheckObservation,
            locatorVisible: locatorVisibleAfterFailedAttempt,
            buttonGone: buttonGoneAfterFailedAttempt,
          };
          throw error;
        }
      }
      if (
        requiredTargetVisible
        && currentLogicalDistancePx !== null
        && currentLogicalDistancePx <= 64
        && !current.jumpToLatestVisible
        && previous
        && previousLogicalDistance?.orientation === current.logicalLatestDistance?.orientation
        && Math.abs(current.scrollTop - previous.scrollTop) <= 1
        && current.scrollHeight === previous.scrollHeight
        && current.clientHeight === previous.clientHeight
      ) {
        stableSamples += 1;
      } else {
        stableSamples = 0;
      }
      previous = current;
      last = current;
      return stableSamples >= 2 ? current : null;
    }, 10_000, `latest transcript row ${expectedTailMarker} to become visible and settle`, 50);
  } catch (error) {
    error.transcriptViewport = { expectedTailMarker, before, last, actions, pollSamples, stableSamples, pollCount };
    throw error;
  }
  await waitForTwoFrames(page);
  const afterTwoFrames = await readViewport();
  const geometryStableAfterTwoFrames = Math.abs(afterTwoFrames.scrollTop - last.scrollTop) <= 1
    && afterTwoFrames.scrollHeight === last.scrollHeight
    && afterTwoFrames.clientHeight === last.clientHeight
    && afterTwoFrames.logicalLatestDistance?.orientation === last.logicalLatestDistance?.orientation;
  const requiredTargetVisibleAfterTwoFrames = requireMarkerVisible
    ? afterTwoFrames.targetMarkerVisibleWithinMessageList
    : afterTwoFrames.targetVisibleWithinMessageList;
  if (
    !requiredTargetVisibleAfterTwoFrames
    || afterTwoFrames.logicalLatestDistance?.pixels == null
    || afterTwoFrames.logicalLatestDistance.pixels > 64
    || afterTwoFrames.jumpToLatestVisible
    || !geometryStableAfterTwoFrames
  ) {
    const error = new Error(`latest transcript target ${expectedTailMarker} lost visibility or stable tail geometry after two animation frames`);
    error.transcriptViewport = { expectedTailMarker, before, last, afterTwoFrames, actions, pollSamples, stableSamples, pollCount, geometryStableAfterTwoFrames };
    throw error;
  }
  const firstTargetVisiblePollIndex = pollSamples.findIndex((sample) => requireMarkerVisible
    ? sample.targetMarkerVisibleWithinMessageList === true
    : sample.targetVisibleWithinMessageList === true);
  const firstTargetVisiblePoll = firstTargetVisiblePollIndex < 0 ? null : {
    source: pollSamples[firstTargetVisiblePollIndex].observationSource
      ?? (firstTargetVisiblePollIndex === 0 ? "before-bounded-poll" : "bounded-poll"),
    poll: pollSamples[firstTargetVisiblePollIndex].poll ?? (firstTargetVisiblePollIndex === 0 ? null : firstTargetVisiblePollIndex),
    sampledAtPageTimeMs: pollSamples[firstTargetVisiblePollIndex].sampledAtPageTimeMs,
    markerVisibleWithinMessageList: pollSamples[firstTargetVisiblePollIndex].targetMarkerVisibleWithinMessageList ?? null,
    rowVisibleWithinMessageList: pollSamples[firstTargetVisiblePollIndex].targetVisibleWithinMessageList ?? false,
  };
  const targetVisibleBeforePoll = requireMarkerVisible
    ? before.targetMarkerVisibleWithinMessageList === true
    : before.targetVisibleWithinMessageList === true;
  const actualTouch = actions.find((entry) => entry.action === "actual-touch-on-jump-to-latest") ?? null;
  return {
    action: actualTouch?.action ?? (targetVisibleBeforePoll
      ? "tail-already-visible"
      : "became-visible-without-manual-jump"),
    expectedTailMarker,
    before,
    after: afterTwoFrames,
    afterTwoFrames: true,
    afterPageTimeMs: afterTwoFrames.sampledAtPageTimeMs,
    firstTargetVisiblePoll,
    actions,
    pollSamples,
    stableSamples,
    pollCount,
    boundary: requireMarkerVisible
      ? "exact final marker's last-character DOM Range intersects the message-list; real jump-to-latest touch when needed; measured scrollport transform selects normal bottom-gap or inverted raw-top distance-to-latest; stable metrics across bounded samples and two RAF opportunities"
      : "target message row geometry inside message-list; real jump-to-latest touch when needed; measured scrollport transform selects normal bottom-gap or inverted raw-top distance-to-latest; stable metrics across bounded samples and two RAF opportunities",
  };
}

async function waitForProductTailMarkerWithoutAction(page, marker, startPageTimeMs, phase, options = {}) {
  const evidence = {
    phase,
    marker,
    action: "none-inside-tail-gate",
    startPageTimeMs: Number.isFinite(startPageTimeMs) ? startPageTimeMs : null,
    deadlineMs: 10_000,
    observations: [],
    lastVisibilityChecks: null,
    lastVisibilityDiagnostics: null,
    status: "WAITING",
  };
  let previous = null;
  try {
    assert.ok(Number.isFinite(startPageTimeMs), `${phase}: tail settlement needs the actual page-clock start of the notification or Jump action`);
    for (let poll = 0; poll < 220; poll += 1) {
      const current = await readTranscriptViewport(page, marker, true, {
        captureMarkerVisibilityDiagnostics: options.captureVisibilityDiagnostics === true,
      });
      evidence.lastVisibilityChecks = current.targetMarkerVisibilityChecks ?? null;
      evidence.lastVisibilityDiagnostics = current.targetMarkerVisibilityDiagnostics ?? null;
      evidence.observations.push({
        sampledAtPageTimeMs: current.sampledAtPageTimeMs ?? null,
        scrollTop: current.scrollTop ?? null,
        scrollHeight: current.scrollHeight ?? null,
        clientHeight: current.clientHeight ?? null,
        rowFound: current.targetRowFound ?? false,
        markerRangeCount: current.targetMarkerLastCharacterRangeCount ?? null,
        markerVisible: current.targetMarkerVisibleWithinMessageList ?? null,
        markerVisibilityChecks: current.targetMarkerVisibilityChecks ?? null,
        jumpVisible: current.jumpToLatestVisible ?? null,
      });
      const elapsedMs = Number.isFinite(current.sampledAtPageTimeMs)
        ? current.sampledAtPageTimeMs - startPageTimeMs
        : Infinity;
      assert.ok(elapsedMs <= evidence.deadlineMs, `${phase}: natural tail marker settlement exceeded the existing 10-second visible-tail deadline`);
      const visible = current.targetMarkerVisibleWithinMessageList === true
        && Number(current.targetMarkerLastCharacterRangeCount) > 0
        && current.targetMarkerLastCharacterRect?.width > 0
        && current.targetMarkerLastCharacterRect?.height > 0
        && current.jumpToLatestVisible === false;
      const stableWithPrevious = visible && previous !== null
        && Math.abs(current.scrollTop - previous.scrollTop) <= 0.5
        && current.scrollHeight === previous.scrollHeight
        && current.clientHeight === previous.clientHeight
        && Math.abs(current.targetMarkerLastCharacterRect.top - previous.targetMarkerLastCharacterRect.top) <= 0.5
        && Math.abs(current.targetMarkerLastCharacterRect.left - previous.targetMarkerLastCharacterRect.left) <= 0.5;
      if (stableWithPrevious) {
        const beforeTwoFrames = previous;
        await waitForTwoFrames(page);
        const afterTwoFrames = await readTranscriptViewport(page, marker, true, {
          captureMarkerVisibilityDiagnostics: options.captureVisibilityDiagnostics === true,
        });
        evidence.lastVisibilityChecks = afterTwoFrames.targetMarkerVisibilityChecks ?? null;
        evidence.lastVisibilityDiagnostics = afterTwoFrames.targetMarkerVisibilityDiagnostics ?? null;
        evidence.observations.push({
          sampledAtPageTimeMs: afterTwoFrames.sampledAtPageTimeMs ?? null,
          scrollTop: afterTwoFrames.scrollTop ?? null,
          scrollHeight: afterTwoFrames.scrollHeight ?? null,
          clientHeight: afterTwoFrames.clientHeight ?? null,
          rowFound: afterTwoFrames.targetRowFound ?? false,
          markerRangeCount: afterTwoFrames.targetMarkerLastCharacterRangeCount ?? null,
          markerVisible: afterTwoFrames.targetMarkerVisibleWithinMessageList ?? null,
          markerVisibilityChecks: afterTwoFrames.targetMarkerVisibilityChecks ?? null,
          jumpVisible: afterTwoFrames.jumpToLatestVisible ?? null,
          sampleBoundary: "after-two-requestAnimationFrame-opportunities",
        });
        const afterElapsedMs = Number.isFinite(afterTwoFrames.sampledAtPageTimeMs)
          ? afterTwoFrames.sampledAtPageTimeMs - startPageTimeMs
          : Infinity;
        const stillVisible = afterTwoFrames.targetMarkerVisibleWithinMessageList === true
          && Number(afterTwoFrames.targetMarkerLastCharacterRangeCount) > 0
          && afterTwoFrames.targetMarkerLastCharacterRect?.width > 0
          && afterTwoFrames.targetMarkerLastCharacterRect?.height > 0
          && afterTwoFrames.jumpToLatestVisible === false;
        const stillStable = Math.abs(afterTwoFrames.scrollTop - current.scrollTop) <= 0.5
          && afterTwoFrames.scrollHeight === current.scrollHeight
          && afterTwoFrames.clientHeight === current.clientHeight
          && Math.abs(afterTwoFrames.targetMarkerLastCharacterRect.top - current.targetMarkerLastCharacterRect.top) <= 0.5
          && Math.abs(afterTwoFrames.targetMarkerLastCharacterRect.left - current.targetMarkerLastCharacterRect.left) <= 0.5;
        assert.ok(afterElapsedMs <= evidence.deadlineMs, `${phase}: natural tail marker settlement exceeded the existing 10-second visible-tail deadline`);
        if (stillVisible && stillStable) {
          evidence.status = "PASS";
          evidence.elapsedFromStartMs = Number(afterElapsedMs.toFixed(3));
          evidence.before = beforeTwoFrames;
          evidence.after = current;
          evidence.afterTwoFrames = afterTwoFrames;
          evidence.tailBoundary = "actual last-character Range intersects the scrollport client clip, message-list, and visual viewport; its center hit-tests to the target row without Jump/composer coverage, then remains stable after two RAF opportunities; raw bottom-gap is not used for this inverted Web candidate";
          return evidence;
        }
      }
      previous = current;
      await page.waitForTimeout(50);
    }
    throw new Error(`${phase}: no stable visible last-character Range was observed before the bounded poll completed`);
  } catch (error) {
    evidence.status = "FAIL";
    evidence.error = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    error.productTailGateEvidence = evidence;
    throw error;
  }
}

function assertProductHistoryAnchorPreserved(before, after, state, label) {
  assert.ok(before?.fixtureMessageId && after?.fixtureMessageId, `${label}: both anchor observations need a real visible fixture message`);
  assert.ok(state.historyMessageIds.has(before.fixtureMessageId), `${label}: anchor ID must belong to an actual history message returned by the fixture route`);
  assert.ok(state.historyMessageIds.has(after.fixtureMessageId), `${label}: retained anchor ID must still belong to loaded history`);
  assert.equal(after.fixtureMessageId, before.fixtureMessageId, `${label}: preserve the exact same visible history message ID`);
  assert.equal(after.marker, before.marker, `${label}: preserve the unique body marker mapped to the same history ID`);
  const rowRect = after.rect;
  const listRect = after.listRect;
  const intersectsMessageList = rowRect.left < listRect.right
    && rowRect.right > listRect.left
    && rowRect.top < listRect.bottom
    && rowRect.bottom > listRect.top;
  assert.ok(intersectsMessageList, `${label}: retained row rectangle must intersect the message-list viewport`);
  const displacementPx = Math.abs(after.viewportOffsetPx - before.viewportOffsetPx);
  assert.ok(displacementPx <= 2, `${label}: the same row top must remain within 2 CSS px of its pre-update viewport offset; actual=${displacementPx.toFixed(3)}px`);
  return { messageId: before.fixtureMessageId, marker: before.marker, beforeOffsetPx: before.viewportOffsetPx, afterOffsetPx: after.viewportOffsetPx, displacementPx };
}

function assertProductVisibleHistoryOrder(viewport, label) {
  const visualIndexes = viewport?.visualHistoryIndexes ?? [];
  assert.ok(visualIndexes.length > 0, `${label}: visible history rows must be backed by unique fixture markers`);
  for (let index = 1; index < visualIndexes.length; index += 1) {
    assert.ok(visualIndexes[index] >= visualIndexes[index - 1],
      `${label}: top-to-bottom MessageBubble order must remain chronological; visible=${visualIndexes.join(",")}`);
  }
  return { visualHistoryIndexes: visualIndexes, chronologicalTopToBottom: true };
}

function chooseVisibleProductCodeAnchor(viewport) {
  const visibleAssistantsWithCollapsedCode = (viewport?.visibleRows ?? [])
    .filter((row) => row.role === "assistant" && row.collapsedCodeDisclosureCount > 0)
    .sort((left, right) => {
      const center = viewport.listRect.top + viewport.listRect.height / 2;
      const leftCenter = (left.rect.top + left.rect.bottom) / 2;
      const rightCenter = (right.rect.top + right.rect.bottom) / 2;
      return Math.abs(leftCenter - center) - Math.abs(rightCenter - center);
    });
  return visibleAssistantsWithCollapsedCode[0] ?? null;
}

function makeLongTailWindowAppendDelta(marker) {
  const prose = "The retained Mobile history reader must stay on the same message while a completed Assistant turn grows the inverted transcript. ".repeat(5);
  const code = Array.from({ length: 20 }, (_, index) => `export const tail_window_stream_${index} = (value: number) => value + ${index};`).join("\n");
  return [
    `\n\n## ${marker} live Markdown update\n\n`,
    prose,
    "\n\n| phase | state | detail |\n| --- | --- | --- |\n| stream | complete | deterministic WebSocketMock fixture |\n\n",
    "```typescript\n",
    code,
    "\n```\n\n",
    `${marker}\n`,
  ].join("");
}

async function expandProductHistoryCodeDisclosure(page, anchor, state) {
  assert.ok(state.historyMessageIds.has(anchor.fixtureMessageId), "code expansion anchor must be a message returned by the fixture history route");
  const rowTestId = anchor.role === "assistant" ? "message-assistant" : "message-user";
  const row = page.getByTestId(rowTestId).filter({ hasText: anchor.marker });
  assert.equal(await row.count(), 1, "unique visible HISTORY marker must resolve to exactly one real MessageBubble row");
  const disclosure = row.getByTestId("code-disclosure").locator('[role="button"][aria-expanded="false"]').first();
  assert.ok(await disclosure.count() > 0, `history row ${anchor.fixtureMessageId} must contain a real collapsed CodeDisclosure`);
  await disclosure.waitFor({ state: "visible", timeout: 5_000 });
  const traceBefore = await readTranscriptFollowGestureInputTrace(page);
  await disclosure.click({ timeout: 5_000 });
  await page.waitForFunction(({ marker, rowTestId, token }) => {
    const message = [...document.querySelectorAll(`[data-testid="${rowTestId}"]`)]
      .find((element) => (element.textContent ?? "").includes(marker));
    const toggle = message?.querySelector('[data-testid="code-disclosure"] [role="button"]');
    return toggle?.getAttribute("aria-expanded") === "true" && (message?.textContent ?? "").includes(token);
  }, { marker: anchor.marker, rowTestId, token: `fixture_${anchor.historyIndex}_0` }, { timeout: 5_000 });
  await waitForTwoFrames(page);
  const traceAfter = await readTranscriptFollowGestureInputTrace(page);
  const inputEvents = transcriptInputEventsSince(traceAfter, traceBefore?.latestOrdinal ?? 0);
  const trustedDisclosureClick = inputEvents.find((event) => event.type === "click"
    && event.isTrusted && event.insideMessageList && event.targetTestId === "code-disclosure") ?? null;
  assert.ok(trustedDisclosureClick, "the existing CodeDisclosure must expand through a trusted browser click inside the real message list");
  return {
    messageId: anchor.fixtureMessageId,
    marker: anchor.marker,
    codeToken: `fixture_${anchor.historyIndex}_0`,
    trustedClick: trustedDisclosureClick,
    ariaExpanded: true,
    expandedCodeTokenVisible: true,
  };
}

async function runTailWindowProductRegression(page, state, source, count, seed, stage = "combined") {
  const evidence = {
    schemaVersion: 1,
    status: "RUNNING",
    diagnosticOnly: true,
    performanceSample: false,
    source,
    requestedMessages: count,
    panelState: "unmounted",
    evidenceClass: "isolated Mobile Web TaskTranscript and production MessageBubble UI with deterministic history pages, ordered app-facing Playwright WebSocketMock notifications, and trusted Chromium input; not a Rust app-server/model turn and not Android/iOS Native validation",
    notificationInjectionBoundary: "the existing active Mobile runtime WebSocketMock._apiSendToPage fixture path; initial history is loaded by the isolated fixture route and synthetic Assistant notification frames are test-side only; older-page UI pagination is a separate diagnostic selector",
    scenario: stage === "stable-reader"
      ? "manual-history-preload-500-explicit-follow-reset-stable-reader-code-append-return"
      : "manual-history-preload-500-explicit-follow-reset-core-follow-code-append-interruption-return",
    stage,
    interruptionStatus: stage === "stable-reader" ? "NOT_RUN_SEPARATE_CASE" : "PENDING",
    pagingStatus: "NOT_RUN_SEPARATE_SCENARIO",
    nativeValidation: "NOT_RUN",
    rawBottomGapUsedAsAcceptance: false,
    rowAnchorContract: "same fixture history message ID, mapped from its unique visible HISTORY body marker, and same MessageBubble row top relative to message-list within 2 CSS px after stable two-RAF observations",
    tailContract: "initial first-page newest history marker must naturally tail before manual preload; after manual preload one real Jump action explicitly restores follow; then seed and final tail must pass the existing 10-second gate without helper scrolling/clicking, with the last-character Range clipped to scrollport/list/visual viewport and center-hit-tested to its row across two RAF opportunities",
    historyRowsAtSeed: state.historyRowsDelivered,
    reservedOlderRows: state.fixtureShape.reservedOlderHistoryRows,
    historySetup: {
      boundary: "500 total messages are reached by manually loading 499 heterogeneous fixture history rows, after separately verifying initial-page entry tail and explicitly restoring follow with the visible Jump control; this is not direct 500-row entry behavior",
      initialEntryNaturalTail: state.initialEntryTailEvidence ?? null,
      manualHistoryPreloadFollowReset: state.manualHistoryFollowResetEvidence ?? null,
    },
    phases: [],
  };
  let failureStage = "validating-natural-seed-tail";
  let cdp = null;
  let inputTraceInstalled = false;
  let primaryError = null;
  try {
    assert.equal(count, 500, "product tail/window regression is pinned to the existing heterogeneous 500-message fixture");
    assert.equal(state.historyRowsDelivered, 499, "the initial history page sequence must deliver exactly 499 rows before the completed seed turn");
    assert.equal(state.historyMessageIds.size, 499, "initial history message IDs must be unique before the seed turn");
    assert.equal(state.initialEntryTailEvidence?.status, "PASS", "the actual initial history page must pass the natural-tail gate before any manual history preload");
    assert.equal(state.manualHistoryFollowResetEvidence?.status, "PASS", "the 499-row manual history preload must restore follow through the real Jump control before the seed turn");
    assert.equal(state.manualHistoryFollowResetEvidence?.actionCompleted, true, "the real Jump control action must complete before the seed turn");
    assert.equal(state.manualHistoryFollowResetEvidence?.gate?.status, "PASS", "the same history tail must settle after the explicit follow reset");
    assert.equal(seed?.ok, true, "product tail/window regression requires the actual four-frame seed delivery to complete");
    assert.equal(seed?.seedDispatch?.dispatchOrderValid, true, "seed must pass the real active WebSocketMock four-frame/sequence gate");
    assert.equal(seed?.transcriptViewport?.status, "PASS", "seed must pass the natural final-character Range/two-RAF tail gate without helper scrolling");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames?.targetMarkerVisibleWithinMessageList, true, "seed's last-character Range must intersect the message-list after two RAF opportunities");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames?.jumpToLatestVisible, false, "seed must naturally settle at latest with Jump hidden");
    evidence.seedTailGate = seed.transcriptViewport;
    evidence.seedNotification = seed.seedDispatch;
    assert.equal(state.activeSocketRoute?.server, serverId, "the seed must have a real active fixture runtime route for the expected server");
    assert.equal(state.activeSocketRoute?.channel, "runtime", "the seed must use the Runtime WebSocketMock route, not a directory socket");
    assert.equal(state.activeSocketRoute?.workspaceMatchesFixture, true, "the active thread/read route must match this RunContext-owned workspace");
    evidence.activeFixtureRoute = {
      routeOrdinal: state.activeSocketRoute.routeOrdinal,
      server: state.activeSocketRoute.server,
      channel: state.activeSocketRoute.channel,
      workspaceMatchesFixture: state.activeSocketRoute.workspaceMatchesFixture,
      threadReadRequestId: state.activeThreadReadRequestId,
    };

    failureStage = "installing-trusted-input-observer";
    evidence.inputObserver = await installTranscriptFollowGestureInputTrace(page, 4096);
    inputTraceInstalled = true;
    assert.equal(evidence.inputObserver.installed, true, "passive trusted-input observation must be installed on the actual message-list");
    cdp = await page.context().newCDPSession(page);

    failureStage = "trusted-touch-reaches-older-history-window";
    const touchToHistory = await performProductTouchToOlderHistory(page, cdp);
    evidence.touchToHistory = touchToHistory;
    const touchOrder = assertProductVisibleHistoryOrder(touchToHistory.finalViewport, "trusted touch older-history window");
    touchToHistory.chronologicalOrder = touchOrder;
    evidence.phases.push({ id: "trusted-touch-to-older-history", ...touchToHistory });

    failureStage = "selecting-history-row-and-starting-real-jump";
    const historyViewportAfterTouch = await waitForStableProductHistoryWindow(page, "history window after trusted touch");
    assert.ok(historyViewportAfterTouch.visibleRows.length > 0, "trusted touch must leave actual history MessageBubble rows in the viewport");
    const anchorCandidate = chooseVisibleProductCodeAnchor(historyViewportAfterTouch);
    assert.ok(anchorCandidate, "the trusted-touch history viewport must expose an actual Assistant MessageBubble with a collapsed CodeDisclosure");
    assert.ok(state.historyMessageIds.has(anchorCandidate.fixtureMessageId), "visible body marker must map to an immutable history ID returned by the fixture route");
    let readerAnchor;
    if (stage === "stable-reader") {
      failureStage = "normalizing-stable-reader-anchor-with-trusted-input";
      const beforeNormalize = await waitForStableProductHistoryAnchor(page, anchorCandidate.marker, "stable-reader anchor before normalization");
      try {
        evidence.stableReaderNormalization = await normalizeStableReaderAnchorWithTrustedInput(
          page, cdp, beforeNormalize, "stable-reader same-ID anchor normalization",
        );
      } catch (error) {
        evidence.stableReaderNormalization = error.productStableReaderNormalizationEvidence ?? {
          status: "FAIL_WITHOUT_NORMALIZATION_EVIDENCE", before: beforeNormalize, exactAnchorTolerancePx: 2,
        };
        throw error;
      }
      readerAnchor = evidence.stableReaderNormalization.after;
      assert.equal(readerAnchor.fixtureMessageId, beforeNormalize.fixtureMessageId, "normalization must retain the same immutable message ID");
      assert.equal(readerAnchor.marker, beforeNormalize.marker, "normalization must retain the same unique body marker");
      assert.ok(readerAnchor.viewportOffsetPx >= -2 && readerAnchor.viewportOffsetPx <= readerAnchor.listRect.height + 2,
        "stable-reader anchor top must be in the actual viewport within the unchanged 2px anchor contract");
      assert.ok(["PASS_TRUSTED_INPUT_NORMALIZED", "PASS_ALREADY_WITHIN_2PX"].includes(evidence.stableReaderNormalization.status),
        "stable-reader normalization can pass only after the same clipped row reaches the existing 2px top contract");
      evidence.interruptionStatus = "NOT_RUN_SEPARATE_CASE";
      evidence.phases.push({ id: "stable-reader-anchor-normalization", ...evidence.stableReaderNormalization });
    } else {
    const jumpAnchor = await waitForStableProductHistoryAnchor(page, anchorCandidate.marker, "pre-jump message anchor");
    assert.equal(jumpAnchor.fixtureMessageId, anchorCandidate.fixtureMessageId, "stable anchor must retain the same fixture message ID");
    const tailMarker = `seed-${source}-${count}-unmounted`;
    const armedRaceAnchor = await page.evaluate(({ marker, fixtureMessageId, tailMarker }) =>
      window.__phoneFollowGestureInputTrace?.armAnchor(marker, fixtureMessageId, tailMarker) ?? false,
      { marker: jumpAnchor.marker, fixtureMessageId: jumpAnchor.fixtureMessageId, tailMarker });
    assert.equal(armedRaceAnchor, true, "race timing trace must arm the exact fixture message before Jump starts");
    const preparedTouchPlan = await prepareProductTouchStroke(page, "interrupt-in-flight-jump-toward-older-history", { pointCount: 8, preparedBeforeJump: true });
    const jumpButton = page.getByTestId("jump-to-latest");
    assert.equal(await jumpButton.isVisible(), true, "manual reader must have the actual Jump-to-latest control before the follow-interruption race");
    await jumpButton.tap({ timeout: 5_000 });
    failureStage = "waiting-in-page-for-active-jump-before-touch";
    const jumpMotionReadiness = await page.evaluate((timeoutMs) =>
      window.__phoneFollowGestureInputTrace?.waitForActiveJump(timeoutMs) ?? { status: "OBSERVER_UNAVAILABLE" }, 3_000);
    evidence.jumpMotionReadiness = jumpMotionReadiness;
    if (jumpMotionReadiness?.status !== "READY_ACTIVE_JUMP") {
      const timingError = new Error("trusted interrupt plan did not reach the bounded page-side active-Jump readiness gate");
      timingError.code = "INVALID_TIMING";
      timingError.productFollowMotionEvidence = jumpMotionReadiness;
      throw timingError;
    }
    failureStage = "trusted-touch-interrupts-in-flight-jump";
    const touchInterrupt = await performProductTouchStroke(page, cdp, "interrupt-in-flight-jump-toward-older-history", {
      pointCount: 8,
      interMoveDelayMs: 8,
      preparedPlan: preparedTouchPlan,
      afterOrdinal: preparedTouchPlan.latestOrdinal,
      inputAfterOrdinal: jumpMotionReadiness.latestOrdinal,
      requireActiveJumpAtTouchStart: true,
    });
    const jumpClicks = touchInterrupt.events.filter((event) => event.type === "click" && event.isTrusted && event.insideJumpButton);
    assert.equal(jumpClicks.length, 1, "the race variant must begin with exactly one real trusted Jump button click");
    const lastMotionSample = touchInterrupt.touchStartRaceEvidence?.recentJumpScrolls?.at(-1)?.anchorSample;
    assert.ok(lastMotionSample, "touchstart timing evidence must include the same real history row during active Jump motion");
    const programmaticMotion = { anchor: lastMotionSample, latestOrdinal: touchInterrupt.eventStartOrdinal, sampledAtTouchStart: true };
    evidence.phases.push({ id: "animated-jump-motion-at-touchstart", jumpClick: jumpClicks[0],
      activeMotionReadiness: jumpMotionReadiness, visibleHistoryAnchorBeforeJump: jumpAnchor, firstObservedFollowMotion: programmaticMotion });
    evidence.activeTouchInterruptInput = touchInterrupt;
    const interruptedAnchor = await waitForStableProductHistoryAnchor(page, jumpAnchor.marker, "history anchor after follow interruption");
    evidence.activeTouchInterruptSettledAnchor = interruptedAnchor;
    const interruptTrace = await readTranscriptFollowGestureInputTrace(page);
    const interruptEvents = transcriptInputEventsSince(interruptTrace, touchInterrupt.eventStartOrdinal);
    const interruptTouchStart = interruptEvents.find((event) => event.type === "touchstart" && event.insideMessageList && event.isTrusted);
    const interruptTouchMove = interruptEvents.find((event) => event.type === "touchmove" && event.insideMessageList && event.isTrusted);
    const interruptTouchEnd = interruptEvents.find((event) => event.type === "touchend" && event.insideMessageList && event.isTrusted);
    const interruptListScroll = interruptEvents.find((event) => event.type === "scroll" && event.insideMessageList && event.isTrusted);
    touchInterrupt.events = interruptEvents;
    touchInterrupt.inputTraceDropped = interruptTrace?.dropped ?? null;
    touchInterrupt.trustedEventCounts.listScroll = interruptEvents.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList).length;
    touchInterrupt.gestureComplete = {
      touchEndSent: touchInterrupt.touchEndSent,
      trustedTouchstartObserved: Boolean(interruptTouchStart),
      trustedTouchmoveObserved: Boolean(interruptTouchMove),
      trustedTouchendObserved: Boolean(interruptTouchEnd),
      trustedListScrollObserved: Boolean(interruptListScroll),
      stableHistoryAnchorAfterTouchend: interruptedAnchor.stableAfterTwoFrames === true,
      settledHistoryAnchor: interruptedAnchor,
    };
    assert.ok(interruptTouchStart && interruptTouchMove && interruptTouchEnd, "trusted list touch must complete start/move/end before follow-interruption assertions");
    assert.ok(interruptListScroll, "trusted interrupt gesture must produce actual browser scroll inside message-list before stable-state assertions");
    const interruptedTail = await readTranscriptViewport(page, `seed-${source}-${count}-unmounted`, true);
    assert.equal(interruptedAnchor.fixtureMessageId, jumpAnchor.fixtureMessageId, "interrupted follow must keep the same history MessageBubble visible");
    assert.ok(interruptedAnchor.viewportOffsetPx > programmaticMotion.anchor.viewportOffsetPx + 1,
      "the trusted toward-old touch must reverse visible row motion after the active follow has started");
    assert.equal(interruptedTail.targetMarkerVisibleWithinMessageList, false, "the interrupted tail must remain outside the actual viewport");
    assert.equal(interruptedTail.jumpToLatestVisible, true, "canceled follow must expose Jump again after the user takes over");
    evidence.phases.push({
      id: "trusted-touch-interrupts-in-flight-jump",
      input: touchInterrupt,
      touchStartAfterMotion: interruptTouchStart,
      touchMoveAfterMotion: interruptTouchMove,
      touchEndAfterStable: interruptTouchEnd,
      trustedListScrollAfterStable: interruptListScroll,
      historyAnchorAtMotion: programmaticMotion.anchor,
      historyAnchorAfterInterrupt: interruptedAnchor,
      tailMarkerAfterInterrupt: interruptedTail,
      inputTrace: interruptEvents,
    });
    readerAnchor = interruptedAnchor;
    evidence.interruptionStatus = touchInterrupt.touchStartRaceEvidence?.classification ?? "UNVERIFIED";
    }

    failureStage = "expanding-real-history-code-disclosure-with-stable-anchor";
    const codeAnchorBefore = await waitForStableProductHistoryAnchor(page, readerAnchor.marker, "history anchor before code disclosure expansion");
    const codeDisclosure = await expandProductHistoryCodeDisclosure(page, codeAnchorBefore, state);
    await page.waitForTimeout(120);
    const codeAnchorAfter = await waitForStableProductHistoryAnchor(page, codeAnchorBefore.marker, "history anchor after code disclosure and delayed layout");
    const codeAnchorDelta = assertProductHistoryAnchorPreserved(codeAnchorBefore, codeAnchorAfter, state, "CodeDisclosure expansion");
    assert.equal(codeAnchorAfter.expandedCodeDisclosureCount > 0, true, "the same visible MessageBubble must show its expanded real CodeDisclosure");
    assert.equal(codeAnchorAfter.expandedCodeTokenVisible, true, "expanded code from the existing history fixture must be present in that row");
    evidence.phases.push({ id: "code-disclosure-layout", disclosure: codeDisclosure, anchorBefore: codeAnchorBefore, anchorAfter: codeAnchorAfter, anchor: codeAnchorDelta, postLayoutWaitMs: 120 });

    failureStage = "app-facing-stream-growth-does-not-pull-reader";
    const appendedMarker = `tail-window-${source}-${count}-completed-assistant`;
    const beforeAppend = await waitForStableProductHistoryAnchor(page, codeAnchorAfter.marker, "history anchor before appended Assistant turn");
    const beforeAppendViewport = await readTranscriptViewport(page, appendedMarker, true);
    assert.equal(beforeAppendViewport.targetRowFound, false, "the new Assistant marker must not exist before its actual fixture notification batch");
    assert.equal(beforeAppendViewport.jumpToLatestVisible, true, "manual reading state must expose Jump before the appended turn");
    const appendDelivery = await emitSyntheticTaskSnapshot(page, state, appendedMarker, {
      artifactId: "tail-window-append-artifact",
      workspacePath: state.workspacePath,
      fileCount: 4,
      additions: 23,
      deletions: 2,
      files: Array.from({ length: 4 }, (_, index) => `${state.workspacePath}/src/tail-window-append-${index}.ts`),
      status: "active",
      revertible: true,
    }, { deltaText: makeLongTailWindowAppendDelta(appendedMarker) });
    assert.equal(appendDelivery.dispatchOrderValid, true, "the appended turn must dispatch one ordered four-frame batch on the active fixture runtime socket");
    assert.equal(appendDelivery.observedFrames.length, 4, "the appended completed turn must use exactly the real WebSocketMock four-frame fixture sequence");
    assert.deepEqual(appendDelivery.observedFrames.map((frame) => frame.method), ["turn/started", "item/started", "item/delta", "turn/completed"]);
    const appendCommit = await waitForProductAppendCommit(page, appendedMarker, beforeAppendViewport);
    await page.waitForTimeout(120);
    const afterAppend = await waitForStableProductHistoryAnchor(page, beforeAppend.marker, "history anchor after long Markdown/code append and delayed layout");
    const appendAnchorDelta = assertProductHistoryAnchorPreserved(beforeAppend, afterAppend, state, "completed Assistant stream append");
    const appendTailViewport = await readTranscriptViewport(page, appendedMarker, true);
    assert.equal(appendTailViewport.targetMarkerVisibleWithinMessageList, false, "completed append must not pull the user away from the retained old-history row");
    assert.equal(appendTailViewport.jumpToLatestVisible, true, "Jump must remain visible after the completed append while the reader is paused");
    evidence.phases.push({
      id: "completed-markdown-code-append-without-reader-pull",
      notification: summarizeFollowGestureNotification(appendDelivery),
      deltaByteLength: Buffer.byteLength(makeLongTailWindowAppendDelta(appendedMarker)),
      layoutCommit: appendCommit,
      viewportBefore: beforeAppendViewport,
      anchorBefore: beforeAppend,
      anchorAfter: afterAppend,
      anchor: appendAnchorDelta,
      tailViewportAfterAppend: appendTailViewport,
      postLayoutWaitMs: 120,
    });

    failureStage = "explicit-jump-to-completed-tail-marker";
    const finalJumpTraceBefore = await readTranscriptFollowGestureInputTrace(page);
    const finalJumpStartPageTimeMs = await page.evaluate(() => performance.now());
    await page.getByTestId("jump-to-latest").tap({ timeout: 5_000 });
    const finalJumpTraceAfterTap = await readTranscriptFollowGestureInputTrace(page);
    const finalJumpClicks = trustedJumpClickEventsSince(finalJumpTraceBefore, finalJumpTraceAfterTap);
    assert.equal(finalJumpClicks.length, 1, "final return to the appended tail must use exactly one actual trusted Jump click");
    const finalTailGate = await waitForProductTailMarkerWithoutAction(page, appendedMarker, finalJumpStartPageTimeMs, "final-explicit-jump", { captureVisibilityDiagnostics: true });
    const completedUi = await readCompletedAssistantMarkerUi(page, appendedMarker);
    assert.equal(completedUi.rowFound, true, "the final completed Assistant message must be mounted in the real MessageBubble list");
    assert.equal(completedUi.markerPresent, true, "the final long-delta marker must remain in its completed Assistant row");
    assert.equal(completedUi.runtimeTerminalUi, true, "the visible message must correspond to a terminal UI state after turn/completed");
    assert.equal(areNotificationBatchesOrdered(state.notificationBatches), true, "seed and appended turn batches must retain globally increasing ordered sequence numbers");
    assert.equal(state.notificationBatches.length, 2, "this UI diagnostic must send one seed and one completed appended Assistant turn");
    assert.deepEqual(state.notificationBatches.map((batch) => batch.marker), [`seed-${source}-${count}-unmounted`, appendedMarker]);
    assert.equal(state.syntheticNotificationFramesSent, 8, "the seed and append each send exactly one four-frame batch");
    assert.equal(state.historyRowsDelivered + state.notificationBatches.length, count + 1, "loaded history, seed and the appended turn must account for exact logical message growth without a paging action in this scenario");
    const finalInputTrace = await readTranscriptFollowGestureInputTrace(page);
    assert.equal(finalInputTrace?.dropped, 0, "trusted input event evidence must remain complete rather than exceeding its explicit trace bound");
    evidence.finalInputTraceEventCount = finalInputTrace?.events?.length ?? 0;
    evidence.phases.push({
      id: "explicit-jump-to-latest-after-interrupted-follow-append",
      trustedJumpClick: finalJumpClicks[0],
      finalTailGate,
      completedAssistantUi: completedUi,
    });
    evidence.historyPages = state.historyPages;
    evidence.notificationBatches = state.notificationBatches.map((batch) => ({
      marker: batch.marker,
      turnId: batch.turnId,
      attemptId: batch.attemptId,
      itemId: batch.itemId,
      methods: batch.methods,
      sequences: batch.sequences,
      threadId: batch.threadId,
      serverId: batch.serverId,
      browserMockId: batch.browserMockId,
      threadReadRequestId: batch.threadReadRequestId,
      routeOrdinal: batch.routeOrdinal,
      dispatchOrderValid: batch.dispatchOrderValid,
      maximumDispatchTaskMs: batch.maximumDispatchTaskMs,
    }));
    evidence.finalUniqueHistoryRows = state.historyRowsDelivered;
    evidence.finalLogicalMessageCount = state.historyRowsDelivered + state.notificationBatches.length;
    evidence.pagingStatus = "NOT_RUN_SEPARATE_SCENARIO";
    evidence.evidenceLimit = "one isolated Mobile Web core UI functional run using test-only app-facing WebSocketMock notifications; pagination has a separate diagnostic selector; no Android/iOS Native, physical-phone, Rust Engine, or Provider execution claim";
    evidence.status = "PASS_WEB_DIAGNOSTIC";
  } catch (error) {
    primaryError = error;
    evidence.status = "FAIL";
    evidence.failureStage = failureStage;
    evidence.error = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    evidence.historyPages = state.historyPages;
    if (evidence.interruptionStatus === "PENDING" && error?.productTouchStrokeEvidence) {
      evidence.interruptionStatus = error.productTouchStrokeEvidence.touchStartRaceEvidence?.classification ?? error.productTouchStrokeEvidence.status ?? "UNVERIFIED";
    }
    evidence.notificationBatches = state.notificationBatches.map((batch) => ({
      marker: batch.marker,
      turnId: batch.turnId,
      itemId: batch.itemId,
      methods: batch.methods,
      sequences: batch.sequences,
      threadId: batch.threadId,
      browserMockId: batch.browserMockId,
      threadReadRequestId: batch.threadReadRequestId,
      routeOrdinal: batch.routeOrdinal,
      dispatchOrderValid: batch.dispatchOrderValid,
    }));
    if (error?.appendCommitEvidence) evidence.appendCommitFailure = error.appendCommitEvidence;
    if (error?.historyAnchorEvidence) evidence.historyAnchorFailure = error.historyAnchorEvidence;
    if (error?.productHistoryViewportEvidence) evidence.historyViewportFailure = error.productHistoryViewportEvidence;
    if (error?.productTouchStrokeEvidence) evidence.touchStrokeFailure = error.productTouchStrokeEvidence;
    if (error?.productTouchEvidence) evidence.touchToHistoryFailure = error.productTouchEvidence;
    if (error?.productWheelEvidence) evidence.wheelToOlderControlFailure = error.productWheelEvidence;
    if (error?.productFollowMotionEvidence) evidence.followMotionFailure = error.productFollowMotionEvidence;
    evidence.lastHistoryViewport = await readProductHistoryViewport(page).catch((viewportError) => ({ readError: safeSeedErrorMessage(viewportError) }));
    evidence.lastTranscriptViewport = await readTranscriptViewport(page, null, false).catch((viewportError) => ({ readError: safeSeedErrorMessage(viewportError) }));
    evidence.inputTrace = inputTraceInstalled
      ? await readTranscriptFollowGestureInputTrace(page).catch((traceError) => ({ readError: safeSeedErrorMessage(traceError) }))
      : null;
    error.tailWindowProductEvidence = evidence;
  }

  const cleanupErrors = [];
  evidence.cleanup = {
    inputObserver: { status: inputTraceInstalled ? "pending" : "not-installed" },
    cdpSession: { status: cdp ? "pending" : "not-created" },
  };
  if (inputTraceInstalled) {
    try {
      await disposeTranscriptFollowGestureInputTrace(page);
      evidence.cleanup.inputObserver = { status: "disposed" };
    } catch (error) {
      evidence.cleanup.inputObserver = { status: "failed", error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) } };
      cleanupErrors.push({ operation: "dispose-input-observer", error });
    }
  }
  if (cdp) {
    try {
      await cdp.detach();
      evidence.cleanup.cdpSession = { status: "detached" };
    } catch (error) {
      evidence.cleanup.cdpSession = { status: "failed", error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) } };
      cleanupErrors.push({ operation: "detach-cdp-session", error });
    }
  }
  if (cleanupErrors.length > 0) {
    evidence.status = "FAIL";
    evidence.cleanup.status = "failed";
    if (primaryError) {
      const combinedError = new AggregateError([primaryError, ...cleanupErrors.map((entry) => entry.error)], "tail-window product diagnostic failed and cleanup also failed", { cause: primaryError });
      combinedError.tailWindowProductEvidence = evidence;
      throw combinedError;
    }
    const cleanupError = new AggregateError(cleanupErrors.map((entry) => entry.error), "tail-window product diagnostic cleanup failed", { cause: cleanupErrors[0].error });
    cleanupError.tailWindowProductEvidence = evidence;
    throw cleanupError;
  }
  evidence.cleanup.status = "completed";
  if (primaryError) throw primaryError;
  return evidence;
}

async function runTailWindowPaginationRegression(page, state, source, count, seed) {
  const evidence = {
    schemaVersion: 1,
    status: "RUNNING",
    diagnosticOnly: true,
    performanceSample: false,
    scenario: "trusted-wheel-older-page-prepend-anchor",
    coreStatus: "NOT_RUN_SEPARATE_SCENARIO",
    source,
    requestedMessages: count,
    panelState: "unmounted",
    evidenceClass: "isolated Mobile Web TaskTranscript/MessageBubble with a deterministic paged history fixture and trusted Chromium wheel/click; no Rust app-server/model turn and no Android/iOS Native validation",
    notificationInjectionBoundary: "seed uses the app-facing WebSocketMock._apiSendToPage fixture path; thread/read pagination is requested by the real load-older UI control and answered by the isolated Gateway fixture route",
    pagingContract: "one trusted negative-delta wheel sequence must expose the real older-page control; one real click must cause exactly one thread/read prepend; preserve the same immutable visible history message ID and MessageBubble row top within 2 CSS px after stable two-RAF observations",
    touchStatus: "NOT_RUN_SEPARATE_CORE_SCENARIO",
    seedTailGate: seed?.transcriptViewport ?? null,
    phases: [],
  };
  let failureStage = "validating-natural-seed-tail";
  let cdp = null;
  let inputTraceInstalled = false;
  let primaryError = null;
  try {
    assert.equal(count, 500, "pagination diagnostic is pinned to the existing heterogeneous 500-message fixture");
    assert.equal(state.fixtureShape.reservedOlderHistoryRows, fixturePageSize, "pagination diagnostic must reserve exactly one 50-row older page");
    assert.equal(state.historyRowsDelivered, 499, "initial paged history must deliver exactly 499 rows before the seed notification");
    assert.equal(state.historyMessageIds.size, 499, "initial history message IDs must be unique before the paging interaction");
    assert.equal(seed?.ok, true, "pagination diagnostic requires the real four-frame seed delivery to complete");
    assert.equal(seed?.seedDispatch?.dispatchOrderValid, true, "seed must pass the app-facing WebSocketMock four-frame/sequence gate");
    assert.equal(seed?.transcriptViewport?.status, "PASS", "seed must pass the natural final-character Range/two-RAF tail gate before paging");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames?.targetMarkerVisibleWithinMessageList, true, "seed's last-character Range must intersect the message-list after two RAF opportunities");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames?.jumpToLatestVisible, false, "seed must naturally settle at latest with Jump hidden before paging");
    assert.equal(state.notificationBatches.length, 1, "pagination scenario starts with exactly one completed seed turn and no appended stream");
    assert.equal(state.activeSocketRoute?.server, serverId, "paging must use the expected active fixture runtime route");
    assert.equal(state.activeSocketRoute?.channel, "runtime", "paging fixture must use the Runtime WebSocketMock route");
    assert.equal(state.activeSocketRoute?.workspaceMatchesFixture, true, "paging route must match this RunContext-owned workspace");
    evidence.activeFixtureRoute = {
      routeOrdinal: state.activeSocketRoute.routeOrdinal,
      server: state.activeSocketRoute.server,
      channel: state.activeSocketRoute.channel,
      workspaceMatchesFixture: state.activeSocketRoute.workspaceMatchesFixture,
      threadReadRequestId: state.activeThreadReadRequestId,
    };
    evidence.seedNotification = seed.seedDispatch;

    failureStage = "installing-passive-trusted-input-observer";
    evidence.inputObserver = await installTranscriptFollowGestureInputTrace(page, 4096);
    inputTraceInstalled = true;
    assert.equal(evidence.inputObserver.installed, true, "passive trusted-input observation must attach to the actual message-list");
    cdp = await page.context().newCDPSession(page);

    failureStage = "trusted-wheel-reaches-real-older-page-control";
    const wheelToOlderControl = await performProductWheelToOlderHistoryControl(page);
    evidence.wheelToOlderControl = wheelToOlderControl;
    wheelToOlderControl.chronologicalOrder = assertProductVisibleHistoryOrder(
      wheelToOlderControl.finalViewport,
      "trusted wheel older-history page boundary",
    );
    evidence.phases.push({ id: "trusted-wheel-to-real-older-page-control", ...wheelToOlderControl });
    assert.equal(wheelToOlderControl.finalViewport.olderHistoryControl.visibleWithinMessageList, true, "the real older-page control must be visible before paging");
    assert.equal(wheelToOlderControl.finalViewport.olderHistoryControl.disabled, false, "the visible older-page control must be enabled before paging");

    failureStage = "capturing-stable-visible-history-anchor-before-prepend";
    const beforeViewport = await waitForStableProductHistoryWindow(page, "older-page viewport before prepend");
    const anchorCandidate = [...beforeViewport.visibleRows].sort((left, right) => left.rect.top - right.rect.top)[0];
    assert.ok(anchorCandidate, "the actual viewport at the older-page boundary must contain a mounted history MessageBubble");
    assert.ok(state.historyMessageIds.has(anchorCandidate.fixtureMessageId), "the visible row must map to an immutable ID returned by the real thread/read fixture route");
    const beforeAnchor = await waitForStableProductHistoryAnchor(page, anchorCandidate.marker, "history anchor before older-page prepend");
    assert.equal(beforeAnchor.fixtureMessageId, anchorCandidate.fixtureMessageId, "the stable row anchor must keep the same fixture message ID");
    const controlBefore = await readProductHistoryViewport(page);
    assert.equal(controlBefore.olderHistoryControl.visibleWithinMessageList, true, "the real Load Earlier Messages control must remain visible at the anchored boundary");
    assert.equal(controlBefore.olderHistoryControl.disabled, false, "the older page must be available before the trusted control click");

    failureStage = "real-load-older-click-and-thread-read-prepend";
    const previousPageCount = state.historyPages.length;
    const previousUniqueRows = state.historyRowsDelivered;
    const clickTraceBefore = await readTranscriptFollowGestureInputTrace(page);
    await page.getByTestId("load-older-messages").click({ timeout: 5_000 });
    await waitFor(() => Promise.resolve(state.historyPages.length > previousPageCount), 10_000, "real Mobile load-older thread/read response", 20);
    await waitForTwoFrames(page);
    await page.waitForTimeout(120);
    const pageResponse = state.historyPages.at(-1);
    assert.equal(state.historyPages.length, previousPageCount + 1, "one real older-page click must cause exactly one additional thread/read request");
    assert.equal(pageResponse.cursor, "ux:51", "the control must request the next cursor behind the initially loaded 499 rows");
    assert.equal(pageResponse.start, 1, "the route must return the immediately older fixture range");
    assert.equal(pageResponse.end, 51, "the returned older page must end at the previous beginning cursor");
    assert.equal(pageResponse.count, fixturePageSize, "the route must return exactly one bounded 50-row history page");
    assert.equal(state.historyRowsDelivered, previousUniqueRows + fixturePageSize, "the prepend must add 50 unique history messages without duplicate IDs");
    const clickTraceAfter = await readTranscriptFollowGestureInputTrace(page);
    const trustedPageClicks = transcriptInputEventsSince(clickTraceAfter, clickTraceBefore?.latestOrdinal ?? 0)
      .filter((event) => event.type === "click" && event.isTrusted && event.insideMessageList && event.targetTestId === "load-older-messages");
    assert.equal(trustedPageClicks.length, 1, "the page request must come from exactly one real trusted click on the visible control");

    failureStage = "verifying-prepend-keeps-the-same-visible-row-anchor";
    const afterAnchor = await waitForStableProductHistoryAnchor(page, beforeAnchor.marker, "history anchor after older-page prepend");
    const anchorDelta = assertProductHistoryAnchorPreserved(beforeAnchor, afterAnchor, state, "older-page prepend");
    const afterViewport = await readProductHistoryViewport(page);
    const chronologicalOrder = assertProductVisibleHistoryOrder(afterViewport, "older-page-prepended MessageBubble order");
    assert.equal(afterViewport.jumpToLatestVisible, true, "older-page prepend must preserve paused reading and keep Jump visible");
    assert.equal(afterViewport.olderHistoryControl.disabled, false, "the next older page must remain available after the prepend");
    assert.equal(state.historyRowsDelivered + state.notificationBatches.length, count + fixturePageSize, "initial history, seed, and one older prepend must account for the fixture's exact logical message count");
    const finalTrace = await readTranscriptFollowGestureInputTrace(page);
    assert.equal(finalTrace?.dropped, 0, "trusted input evidence must stay within the explicit observer bound");
    evidence.inputTraceDropped = finalTrace?.dropped ?? null;
    evidence.inputTraceEventCount = finalTrace?.events?.length ?? 0;
    evidence.phases.push({
      id: "actual-older-page-prepend-with-stable-anchor",
      trustedControlClick: trustedPageClicks[0],
      pageResponse,
      previousPageCount,
      pageCountAfter: state.historyPages.length,
      uniqueRowsBefore: previousUniqueRows,
      uniqueRowsAfter: state.historyRowsDelivered,
      anchorBefore: beforeAnchor,
      anchorAfter: afterAnchor,
      anchor: anchorDelta,
      viewportBefore: beforeViewport,
      viewportAfter: afterViewport,
      chronologicalOrder,
      postLayoutWaitMs: 120,
    });
    evidence.historyPages = state.historyPages;
    evidence.notificationBatches = state.notificationBatches.map((batch) => ({
      marker: batch.marker,
      turnId: batch.turnId,
      attemptId: batch.attemptId,
      itemId: batch.itemId,
      methods: batch.methods,
      sequences: batch.sequences,
      threadId: batch.threadId,
      serverId: batch.serverId,
      browserMockId: batch.browserMockId,
      threadReadRequestId: batch.threadReadRequestId,
      routeOrdinal: batch.routeOrdinal,
      dispatchOrderValid: batch.dispatchOrderValid,
      maximumDispatchTaskMs: batch.maximumDispatchTaskMs,
    }));
    evidence.finalUniqueHistoryRows = state.historyRowsDelivered;
    evidence.finalLogicalMessageCount = state.historyRowsDelivered + state.notificationBatches.length;
    evidence.status = "PASS_WEB_DIAGNOSTIC";
  } catch (error) {
    primaryError = error;
    evidence.status = "FAIL";
    evidence.failureStage = failureStage;
    evidence.error = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    evidence.historyPages = state.historyPages;
    evidence.notificationBatches = state.notificationBatches.map(summarizeFollowGestureNotification);
    if (error?.productWheelEvidence) evidence.wheelToOlderControlFailure = error.productWheelEvidence;
    if (error?.productHistoryViewportEvidence) evidence.historyViewportFailure = error.productHistoryViewportEvidence;
    evidence.lastHistoryViewport = await readProductHistoryViewport(page).catch((viewportError) => ({ readError: safeSeedErrorMessage(viewportError) }));
    evidence.inputTrace = inputTraceInstalled
      ? await readTranscriptFollowGestureInputTrace(page).catch((traceError) => ({ readError: safeSeedErrorMessage(traceError) }))
      : null;
    error.tailWindowPaginationEvidence = evidence;
  }

  const cleanupErrors = [];
  evidence.cleanup = {
    inputObserver: { status: inputTraceInstalled ? "pending" : "not-installed" },
    cdpSession: { status: cdp ? "pending" : "not-created" },
  };
  if (inputTraceInstalled) {
    try {
      await disposeTranscriptFollowGestureInputTrace(page);
      evidence.cleanup.inputObserver = { status: "disposed" };
    } catch (error) {
      evidence.cleanup.inputObserver = { status: "failed", error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) } };
      cleanupErrors.push({ operation: "dispose-input-observer", error });
    }
  }
  if (cdp) {
    try {
      await cdp.detach();
      evidence.cleanup.cdpSession = { status: "detached" };
    } catch (error) {
      evidence.cleanup.cdpSession = { status: "failed", error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) } };
      cleanupErrors.push({ operation: "detach-cdp-session", error });
    }
  }
  evidence.cleanup.status = cleanupErrors.length === 0 ? "completed" : "failed";
  if (cleanupErrors.length > 0) {
    evidence.status = "FAIL";
    const cleanupErrorObjects = cleanupErrors.map((entry) => entry.error);
    const combined = primaryError
      ? new AggregateError([primaryError, ...cleanupErrorObjects], "pagination diagnostic failed and cleanup also failed", { cause: primaryError })
      : new AggregateError(cleanupErrorObjects, "pagination diagnostic cleanup failed", { cause: cleanupErrorObjects[0] });
    combined.tailWindowPaginationEvidence = evidence;
    throw combined;
  }
  if (primaryError) throw primaryError;
  return evidence;
}

async function runTranscriptFollowGestureRegression(page, state, source, count, seed) {
  const seedMarker = `seed-${source}-${count}-unmounted`;
  const settledAppendMarker = `follow-${source}-${count}-settled-append`;
  const interruptedAppendMarker = `follow-${source}-${count}-interrupted-append`;
  const evidence = {
    schemaVersion: 1,
    status: "RUNNING",
    diagnosticOnly: true,
    performanceSample: false,
    source,
    requestedMessages: count,
    panelState: "unmounted",
    evidenceClass: "isolated Mobile Web UI follow-state regression using a synthetic history and ordered app-facing WebSocketMock notifications; no Provider, model turn, Rust app-server turn, or native measurement",
    notificationInjectionBoundary: "test-only Playwright app-facing WebSocketMock._apiSendToPage fixture dispatch on the exact active socket; not a network RPC, Runtime handler call, or Rust app-server receipt",
    historyAnchorTolerancePx: 48,
    historyAnchorGateMeaning: "the selected visible HISTORY row must remain within 48px vertical displacement after append; this detects a tail pull and does not assert zero scroll movement",
    seedTailGate: seed.transcriptViewport ?? null,
    startingHistoryRows: state.historyRowsDelivered,
    startingLogicalMessageCount: state.historyRowsDelivered + 1,
    phases: [],
  };
  let failureStage = "installing-passive-trusted-input-observer";
  let cdp = null;
  let primaryError = null;
  try {
    assert.equal(state.historyRowsDelivered + 1, count, "follow regression must start from the exact requested history count plus its completed seed Agent message");
    assert.equal(seed?.ok, true, "follow regression requires the normal seed delivery gate to pass");
    assert.equal(seed?.transcriptViewport?.after?.targetMarkerVisibleWithinMessageList, true, "initial exact last-character marker must intersect the actual Mobile message-list viewport");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames, true, "initial seed marker must remain visible after two requestAnimationFrame opportunities");
    const observerSetup = await installTranscriptFollowGestureInputTrace(page);
    evidence.inputObserver = observerSetup;
    cdp = await page.context().newCDPSession(page);

    failureStage = "trusted-touch-to-older-history-after-seed-tail-gate";
    const firstOlder = await performTrustedTranscriptTouch(page, cdp, "older", "settled-follow-scroll-to-history");
    const firstAnchor = await readVisibleHistoryAnchor(page);
    assert.ok(firstAnchor?.marker, "trusted scroll must expose a concrete earlier HISTORY row as the retained viewport anchor");
    assert.ok(firstOlder.after.scrollTop < firstOlder.before.scrollTop - 96, "trusted touch must move the real message-list scroll position toward older history");
    assert.ok(firstOlder.after.bottomGapPx > 96 && firstOlder.after.jumpToLatestVisible, "scrolling away from latest must leave the real list away from its 96px follow threshold and show jump-to-latest");
    evidence.phases.push({
      id: "settled-follow-user-scroll",
      input: firstOlder,
      visibleHistoryAnchorBeforeAppend: firstAnchor,
    });

    failureStage = "settled-follow-append-does-not-pull-user-viewport-to-tail";
    const settledAppendBefore = firstOlder.after;
    const settledDelivery = await emitSyntheticTaskSnapshot(page, state, settledAppendMarker, {
      artifactId: settledAppendMarker,
      workspacePath: state.workspacePath,
      fileCount: 1,
      additions: 1,
      deletions: 0,
      files: [`${state.workspacePath}/src/${settledAppendMarker}.ts`],
      status: "active",
      revertible: true,
    });
    const settledAppend = await waitForFollowAppendLayout(page, settledAppendBefore, settledAppendMarker, "settled-scroll appended Assistant message to affect the real transcript");
    const settledAnchorAfter = await readVisibleHistoryAnchor(page, firstAnchor.marker);
    assertNoFollowPull(settledAppendBefore, settledAppend, firstAnchor, settledAnchorAfter, "settled-scroll append");
    evidence.phases.push({
      id: "settled-follow-append-without-pull",
      notification: summarizeFollowGestureNotification(settledDelivery),
      viewportBefore: settledAppendBefore,
      viewportAfter: settledAppend,
      visibleHistoryAnchorBefore: firstAnchor,
      visibleHistoryAnchorAfter: settledAnchorAfter,
      newMarkerVisibleBeforeExplicitJump: settledAppend.targetMarkerVisibleWithinMessageList,
      logicalMessageCountAfterAppend: count + 1,
    });

    failureStage = "explicit-jump-after-settled-user-scroll";
    const firstJumpTraceStart = await readTranscriptFollowGestureInputTrace(page);
    const settledTailGate = await scrollTranscriptToLatest(page, settledAppendMarker, { requireMarkerVisible: true });
    const firstJumpTraceEnd = await readTranscriptFollowGestureInputTrace(page);
    const firstJumpTouchEvents = trustedJumpClickEventsSince(firstJumpTraceStart, firstJumpTraceEnd);
    assert.equal(settledTailGate.before.targetMarkerVisibleWithinMessageList, false, "new appended marker must be outside the old viewport before the explicit return-to-latest action");
    assert.equal(settledTailGate.before.jumpToLatestVisible, true, "the real jump-to-latest control must be visible before the first return action");
    assert.equal(settledTailGate.actions.filter((entry) => entry.action === "actual-touch-on-jump-to-latest").length, 1, "the first return must use exactly one real jump-to-latest touch");
    assert.equal(firstJumpTouchEvents.length, 1, "the page must record exactly one trusted click on jump-to-latest for the first return");
    assert.equal(settledTailGate.after.targetMarkerVisibleWithinMessageList, true, "the first explicit jump must expose the appended marker's final character in the real list viewport");
    assert.ok(settledTailGate.after.targetMarkerLastCharacterRangeCount > 0, "the first appended marker must have measurable last-character Range geometry");
    assert.equal(settledTailGate.afterTwoFrames, true, "the first appended marker must remain visible after two animation-frame opportunities");
    const settledTerminalUi = await readCompletedAssistantMarkerUi(page, settledAppendMarker);
    assert.equal(settledTerminalUi.rowFound, true, "the first completed Assistant marker must exist in the rendered transcript");
    assert.equal(settledTerminalUi.markerPresent, true, "the first completed Assistant row must retain its unique fixture marker");
    assert.equal(settledTerminalUi.runtimeTerminalUi, true, "the first appended Assistant turn must be terminal before the regression continues");
    evidence.phases.push({
      id: "settled-follow-explicit-jump",
      userInput: firstJumpTouchEvents,
      tailGate: settledTailGate,
      completedAssistantUi: settledTerminalUi,
    });

    failureStage = "trusted-touch-to-older-history-before-interrupt-race";
    const secondOlder = await performTrustedTranscriptTouch(page, cdp, "older", "prepare-programmatic-follow-interruption");
    const secondAnchor = await readVisibleHistoryAnchor(page);
    assert.ok(secondAnchor?.marker, "interruption variant must first return to a real visible HISTORY row");
    assert.ok(secondOlder.after.scrollTop < secondOlder.before.scrollTop - 96, "interruption variant must leave the actual list away from latest before pressing jump");
    assert.ok(secondOlder.after.bottomGapPx > 96 && secondOlder.after.jumpToLatestVisible, "interruption variant requires a visible jump control before starting animated follow");

    failureStage = "interrupting-observed-programmatic-follow-with-trusted-touch";
    const beforeInterruptJump = await readTranscriptViewport(page, settledAppendMarker, true);
    const interruptJumpTraceStart = await readTranscriptFollowGestureInputTrace(page);
    await page.getByTestId("jump-to-latest").tap({ timeout: 5_000 });
    const interruptJumpTraceAfterTap = await readTranscriptFollowGestureInputTrace(page);
    const interruptJumpClick = trustedJumpClickEventsSince(interruptJumpTraceStart, interruptJumpTraceAfterTap);
    assert.equal(interruptJumpClick.length, 1, "the interrupt variant must begin with one trusted jump button click");
    const firstMovingScroll = await waitForProgrammaticFollowScrollEvent(
      page,
      interruptJumpTraceStart.latestOrdinal,
      beforeInterruptJump.scrollTop,
    );
    assert.ok(firstMovingScroll.scrollTop > beforeInterruptJump.scrollTop + 1, "jump-to-latest must begin moving the actual list toward the tail before the interrupt gesture");
    assert.ok(firstMovingScroll.bottomGapPx > 96, "the interrupt must occur while the scroll is still in flight, before the latest threshold is reached");
    const interruptedOlder = await performTrustedTranscriptTouch(page, cdp, "older", "interrupt-active-programmatic-follow");
    const interruptTrace = await readTranscriptFollowGestureInputTrace(page);
    const interruptEvents = transcriptInputEventsSince(interruptTrace, interruptedOlder.eventStartOrdinal);
    const interruptTouchStart = interruptEvents.find((event) => event.type === "touchstart" && event.insideMessageList);
    const programmaticMotionBeforeTouch = interruptTrace.events.find((event) =>
      event.ordinal > interruptJumpTraceStart.latestOrdinal
      && event.type === "scroll"
      && event.insideMessageList
      && event.scrollTop > beforeInterruptJump.scrollTop + 1
      && event.bottomGapPx > 96
      && event.ordinal < (interruptTouchStart?.ordinal ?? Infinity),
    );
    assert.ok(programmaticMotionBeforeTouch, "recorded scroll geometry must prove that the trusted user touch began after animated latest-follow motion started and before it settled");
    assert.ok(interruptTouchStart?.isTrusted, "the mid-flight list touchstart must be a trusted browser event");
    assert.ok(interruptTouchStart.bottomGapPx > 96, "the active-follow interrupt must begin before the real message-list reaches the latest threshold");
    assert.ok(interruptTouchStart.scrollTop > beforeInterruptJump.scrollTop + 1, "the active-follow interrupt must begin after the programmatic scroll has advanced toward latest");
    assert.ok(interruptedOlder.after.scrollTop < interruptedOlder.before.scrollTop - 96, "the trusted interrupt must move the real list back toward older history");
    assert.ok(interruptedOlder.after.bottomGapPx > 96 && interruptedOlder.after.jumpToLatestVisible, "the interrupted list must settle away from latest with jump-to-latest visible");
    const interruptAnchorAfter = await readVisibleHistoryAnchor(page, secondAnchor.marker);
    assert.ok(interruptAnchorAfter?.visibleWithinMessageList, "the interruption gesture must leave its prior visible history anchor in the list");
    evidence.phases.push({
      id: "interrupt-programmatic-follow",
      visibleHistoryAnchorBeforeJump: secondAnchor,
      viewportBeforeJump: beforeInterruptJump,
      jumpButtonClick: interruptJumpClick[0],
      firstProgrammaticScrollEvent: firstMovingScroll,
      touchAfterMotionStarted: interruptTouchStart,
      programmaticMotionBeforeTouch,
      input: interruptedOlder,
      visibleHistoryAnchorAfterInterrupt: interruptAnchorAfter,
    });

    failureStage = "append-during-interrupted-follow-does-not-pull-user-viewport-to-tail";
    const interruptAppendBefore = interruptedOlder.after;
    const interruptDelivery = await emitSyntheticTaskSnapshot(page, state, interruptedAppendMarker, {
      artifactId: interruptedAppendMarker,
      workspacePath: state.workspacePath,
      fileCount: 1,
      additions: 2,
      deletions: 0,
      files: [`${state.workspacePath}/src/${interruptedAppendMarker}.ts`],
      status: "active",
      revertible: true,
    });
    const interruptAppend = await waitForFollowAppendLayout(page, interruptAppendBefore, interruptedAppendMarker, "interrupted-follow appended Assistant message to affect the real transcript");
    const interruptAnchorAfterAppend = await readVisibleHistoryAnchor(page, secondAnchor.marker);
    assertNoFollowPull(interruptAppendBefore, interruptAppend, secondAnchor, interruptAnchorAfterAppend, "interrupted-follow append");
    evidence.phases.push({
      id: "interrupted-follow-append-without-pull",
      notification: summarizeFollowGestureNotification(interruptDelivery),
      viewportBefore: interruptAppendBefore,
      viewportAfter: interruptAppend,
      visibleHistoryAnchorBefore: secondAnchor,
      visibleHistoryAnchorAfter: interruptAnchorAfterAppend,
      newMarkerVisibleBeforeExplicitJump: interruptAppend.targetMarkerVisibleWithinMessageList,
      logicalMessageCountAfterAppends: count + 2,
    });

    failureStage = "explicit-jump-after-interrupted-follow";
    const finalJumpTraceStart = await readTranscriptFollowGestureInputTrace(page);
    const interruptedTailGate = await scrollTranscriptToLatest(page, interruptedAppendMarker, { requireMarkerVisible: true });
    const finalJumpTraceEnd = await readTranscriptFollowGestureInputTrace(page);
    const finalJumpTouchEvents = trustedJumpClickEventsSince(finalJumpTraceStart, finalJumpTraceEnd);
    assert.equal(interruptedTailGate.before.targetMarkerVisibleWithinMessageList, false, "the second appended marker must be outside the retained old-history viewport before its explicit jump");
    assert.equal(interruptedTailGate.before.jumpToLatestVisible, true, "the jump control must remain available after the interrupted-follow append");
    assert.equal(interruptedTailGate.actions.filter((entry) => entry.action === "actual-touch-on-jump-to-latest").length, 1, "the final return must use exactly one real jump-to-latest touch");
    assert.equal(finalJumpTouchEvents.length, 1, "the page must record exactly one trusted click on jump-to-latest for the final return");
    assert.equal(interruptedTailGate.after.targetMarkerVisibleWithinMessageList, true, "the final explicit jump must expose the newest marker's last character in the actual list viewport");
    assert.ok(interruptedTailGate.after.targetMarkerLastCharacterRangeCount > 0, "the newest marker must have measurable last-character Range geometry");
    assert.equal(interruptedTailGate.afterTwoFrames, true, "the newest marker must remain visible after two animation-frame opportunities");
    const interruptedTerminalUi = await readCompletedAssistantMarkerUi(page, interruptedAppendMarker);
    assert.equal(interruptedTerminalUi.rowFound, true, "the newest completed Assistant marker must exist in the rendered transcript");
    assert.equal(interruptedTerminalUi.markerPresent, true, "the newest completed Assistant row must retain its unique fixture marker");
    assert.equal(interruptedTerminalUi.runtimeTerminalUi, true, "the newest appended Assistant turn must be terminal in the visible UI");
    assert.equal(areNotificationBatchesOrdered(state.notificationBatches), true, "seed and appended synthetic notification batches must keep one ordered sequence on the same active thread fixture");
    assert.equal(state.notificationBatches.length, 3, "the seed and both append phases must each use one complete notification batch");
    assert.deepEqual(state.notificationBatches.map((batch) => batch.marker), [seedMarker, settledAppendMarker, interruptedAppendMarker], "all three completed turns must have unique expected markers in order");
    assert.equal(state.syntheticNotificationFramesSent, 12, "the seed and two append phases must each dispatch the four ordered task frames exactly once");
    assert.equal(state.historyRowsDelivered + state.notificationBatches.length, count + 2, "fixture history plus seed and two appended Assistant turns must preserve the reported logical message growth");
    evidence.phases.push({
      id: "interrupted-follow-explicit-jump",
      userInput: finalJumpTouchEvents,
      tailGate: interruptedTailGate,
      completedAssistantUi: interruptedTerminalUi,
    });
    evidence.notificationBatches = state.notificationBatches.map(summarizeFollowGestureNotification);
    evidence.finalLogicalMessageCount = count + 2;
    evidence.status = "PASS_WEB_DIAGNOSTIC";
    evidence.inputTrace = await readTranscriptFollowGestureInputTrace(page);
    return evidence;
  } catch (error) {
    primaryError = error;
    evidence.status = "FAIL";
    evidence.failureStage = failureStage;
    evidence.notificationBatches = state.notificationBatches.map(summarizeFollowGestureNotification);
    evidence.error = {
      name: error?.name ?? "Error",
      message: safeSeedErrorMessage(error),
      stack: safeSeedErrorStack(error),
    };
    evidence.inputTrace = await readTranscriptFollowGestureInputTrace(page).catch((traceError) => ({
      readError: safeSeedErrorMessage(traceError),
    }));
    evidence.lastViewport = await readTranscriptViewport(page, interruptedAppendMarker, true).catch((viewportError) => ({
      readError: safeSeedErrorMessage(viewportError),
    }));
    error.followGestureEvidence = evidence;
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = {
      observerDispose: { status: "pending" },
      cdpDetach: { status: cdp ? "pending" : "not-created" },
    };
    try {
      await disposeTranscriptFollowGestureInputTrace(page);
      cleanup.observerDispose = { status: "completed" };
    } catch (error) {
      cleanup.observerDispose = {
        status: "failed",
        error: {
          name: error?.name ?? "Error",
          message: safeSeedErrorMessage(error),
          stack: safeSeedErrorStack(error),
        },
      };
      cleanupErrors.push({ operation: "observer-dispose", error });
    }
    if (cdp) {
      try {
        await cdp.detach();
        cleanup.cdpDetach = { status: "completed" };
      } catch (error) {
        cleanup.cdpDetach = {
          status: "failed",
          error: {
            name: error?.name ?? "Error",
            message: safeSeedErrorMessage(error),
            stack: safeSeedErrorStack(error),
          },
        };
        cleanupErrors.push({ operation: "cdp-detach", error });
      }
    }
    evidence.cleanup = {
      status: cleanupErrors.length === 0 ? "completed" : "failed",
      ...cleanup,
    };
    if (cleanupErrors.length > 0) {
      evidence.status = "FAIL";
      evidence.failureStage = primaryError ? failureStage : "gesture-diagnostic-cleanup";
      if (!primaryError) {
        evidence.error = {
          name: "FollowGestureCleanupError",
          message: "follow-gesture diagnostic cleanup failed",
          cleanupErrors: cleanupErrors.map(({ operation, error }) => ({
            operation,
            name: error?.name ?? "Error",
            message: safeSeedErrorMessage(error),
            stack: safeSeedErrorStack(error),
          })),
        };
      }
      const cleanupErrorObjects = cleanupErrors.map(({ error }) => error);
      const aggregateError = primaryError
        ? new AggregateError([primaryError, ...cleanupErrorObjects], "follow-gesture diagnostic failed and cleanup also failed", { cause: primaryError })
        : new AggregateError(cleanupErrorObjects, "follow-gesture diagnostic cleanup failed", { cause: cleanupErrorObjects[0] });
      aggregateError.followGestureEvidence = evidence;
      throw aggregateError;
    }
  }
}

async function disposeTranscriptFollowGestureInputTrace(page) {
  await page.evaluate(() => window.__phoneFollowGestureInputTrace?.dispose());
}

async function waitForProductAppendCommit(page, marker, beforeViewport) {
  const observations = [];
  const startedAt = performance.now();
  while (performance.now() - startedAt <= 5_000) {
    const viewport = await readTranscriptViewport(page, marker, true);
    const history = await readProductHistoryViewport(page);
    const assistant = await readCompletedAssistantMarkerUi(page, marker);
    const signal = viewport.targetRowFound
      ? "new-assistant-messagebubble-row-mounted"
      : viewport.scrollHeight !== beforeViewport.scrollHeight
        ? "message-list-scroll-height-changed-after-notification"
        : null;
    observations.push({
      pageTimeMs: viewport.sampledAtPageTimeMs,
      signal,
      targetRowFound: viewport.targetRowFound,
      targetMarkerVisible: viewport.targetMarkerVisibleWithinMessageList,
      scrollHeight: viewport.scrollHeight,
      visibleHistoryIndexes: history.visibleHistoryIndexes,
      runtimeTerminalUi: assistant.runtimeTerminalUi,
    });
    if (signal) {
      await waitForTwoFrames(page);
      const afterTwoFrames = await readTranscriptViewport(page, marker, true);
      return {
        signal,
        observations: observations.slice(-12),
        afterTwoFrames,
        terminalUiAtCommit: await readCompletedAssistantMarkerUi(page, marker),
      };
    }
    await page.waitForTimeout(50);
  }
  const error = new Error(`completed Assistant notification did not produce a visible-row or list-extent commit for ${marker}`);
  error.appendCommitEvidence = { marker, beforeViewport, observations: observations.slice(-20) };
  throw error;
}

async function performTrustedTranscriptTouch(page, cdp, direction, label) {
  assert.ok(direction === "older" || direction === "latest", "transcript touch direction must be older or latest");
  const list = page.getByTestId("message-list");
  const bounds = await list.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, "trusted touch must begin inside a visible message-list hitbox");
  const x = Math.round(bounds.x + bounds.width / 2);
  const fromY = direction === "older"
    ? Math.round(bounds.y + Math.min(88, bounds.height * 0.2))
    : Math.round(bounds.y + bounds.height - Math.min(72, bounds.height * 0.15));
  const toY = direction === "older"
    ? Math.round(bounds.y + bounds.height - 24)
    : Math.round(bounds.y + 24);
  assert.ok(Math.abs(toY - fromY) >= 96, "trusted touch path must be long enough to leave the 96px latest-follow threshold");
  const hitTest = await page.evaluate(({ pointX, pointY }) => {
    const listRoot = document.querySelector('[data-testid="message-list"]');
    const target = document.elementFromPoint(pointX, pointY);
    return {
      hit: Boolean(target),
      insideMessageList: Boolean(listRoot && target && listRoot.contains(target)),
      targetTag: target?.tagName ?? null,
      targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
    };
  }, { pointX: x, pointY: fromY });
  assert.equal(hitTest.insideMessageList, true, "real touch start point must hit inside the actual message-list DOM subtree");
  const before = await readTranscriptViewport(page, null, false);
  const traceBefore = await readTranscriptFollowGestureInputTrace(page);
  const eventStartOrdinal = traceBefore?.latestOrdinal ?? 0;
  const pointCount = 12;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: fromY, id: 71 }],
  });
  for (let index = 1; index <= pointCount; index += 1) {
    const y = fromY + ((toY - fromY) * index) / pointCount;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: 71 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const settled = await waitForTranscriptTouchSettled(page, before, direction, eventStartOrdinal, label);
  const afterTwoFrames = await readTranscriptViewport(page, null, false);
  const traceAfter = await readTranscriptFollowGestureInputTrace(page);
  const events = transcriptInputEventsSince(traceAfter, eventStartOrdinal);
  const touchEvents = events.filter((event) => ["touchstart", "touchmove", "touchend"].includes(event.type));
  assert.ok(touchEvents.some((event) => event.type === "touchstart"), `${label}: a touchstart must reach the Mobile message-list`);
  assert.ok(touchEvents.some((event) => event.type === "touchmove"), `${label}: a touchmove must reach the Mobile message-list`);
  assert.ok(touchEvents.some((event) => event.type === "touchend"), `${label}: a touchend must reach the Mobile message-list`);
  assert.ok(touchEvents.every((event) => event.isTrusted && event.insideMessageList), `${label}: all captured touch events must be trusted and inside message-list`);
  assert.ok(events.some((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList), `${label}: a trusted browser scroll event must follow the touch within message-list`);
  assert.equal(afterTwoFrames.bottomGapPx > 96, true, `${label}: viewport must remain away from the latest-follow threshold after two frames`);
  assert.equal(afterTwoFrames.jumpToLatestVisible, true, `${label}: jump-to-latest must be visible after scrolling to older history`);
  return {
    label,
    direction,
    boundary: "Chromium CDP touch input; actual hit-test and trusted DOM touch/scroll events are required",
    hitTest,
    start: { x, y: fromY },
    end: { x, y: toY },
    pointCount: pointCount + 2,
    eventStartOrdinal,
    before,
    after: settled.viewport,
    afterTwoFrames,
    stableViewportPollCount: settled.pollCount,
    events,
  };
}

async function waitForTranscriptTouchSettled(page, before, direction, eventStartOrdinal, label) {
  let previous = null;
  let stableSamples = 0;
  let pollCount = 0;
  let last = before;
  const settled = await waitFor(async () => {
    pollCount += 1;
    const viewport = await readTranscriptViewport(page, null, false);
    const trace = await readTranscriptFollowGestureInputTrace(page);
    const events = transcriptInputEventsSince(trace, eventStartOrdinal);
    const trustedScrollObserved = events.some((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList);
    const movedAsRequested = direction === "older"
      ? viewport.scrollTop < before.scrollTop - 96
      : viewport.scrollTop > before.scrollTop + 96;
    const remainedAwayFromLatest = viewport.bottomGapPx > 96 && viewport.jumpToLatestVisible;
    const stable = previous !== null
      && Math.abs(viewport.scrollTop - previous.scrollTop) <= 1
      && viewport.scrollHeight === previous.scrollHeight
      && viewport.clientHeight === previous.clientHeight;
    if (trustedScrollObserved && movedAsRequested && remainedAwayFromLatest && stable) stableSamples += 1;
    else stableSamples = 0;
    previous = viewport;
    last = viewport;
    return stableSamples >= 2 ? viewport : null;
  }, 10_000, `${label}: trusted transcript scroll to settle away from latest`, 50);
  await waitForTwoFrames(page);
  const afterTwoFrames = await readTranscriptViewport(page, null, false);
  assert.ok(Math.abs(afterTwoFrames.scrollTop - settled.scrollTop) <= 1 && afterTwoFrames.scrollHeight === settled.scrollHeight, `${label}: list geometry must remain stable after two additional animation frames`);
  return { viewport: afterTwoFrames, last, stableSamples, pollCount, settled };
}

async function waitForProgrammaticFollowScrollEvent(page, afterOrdinal, startingScrollTop) {
  const handle = await page.waitForFunction(({ ordinal, startTop }) => {
    const trace = window.__phoneFollowGestureInputTrace?.snapshot();
    return trace?.events.find((event) => event.ordinal > ordinal
      && event.type === "scroll"
      && event.insideMessageList
      && event.scrollTop > startTop + 1
      && event.bottomGapPx > 96) ?? null;
  }, { ordinal: afterOrdinal, startTop: startingScrollTop }, { timeout: 10_000, polling: "raf" });
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}

async function waitForFollowAppendLayout(page, before, marker, label) {
  const commit = await waitFor(async () => {
    const viewport = await readTranscriptViewport(page, marker, true);
    const layoutSignal = viewport.scrollHeight > before.scrollHeight
      ? "message-list-scroll-height-increased"
      : viewport.targetRowFound ? "new-assistant-marker-row-mounted" : null;
    return layoutSignal ? { viewport, layoutSignal } : null;
  }, 10_000, label, 50);
  await waitForTwoFrames(page);
  return {
    ...await readTranscriptViewport(page, marker, true),
    layoutSignal: commit.layoutSignal,
    commitViewport: commit.viewport,
    afterTwoFrames: true,
  };
}

function assertNoFollowPull(before, after, anchorBefore, anchorAfter, label) {
  assert.ok(after.scrollHeight > before.scrollHeight || after.layoutSignal === "new-assistant-marker-row-mounted", `${label}: UI must expose the appended message through list extent or its rendered Agent row`);
  assert.ok(after.bottomGapPx > 96, `${label}: content arrival must not return the user to the latest-follow threshold`);
  assert.equal(after.jumpToLatestVisible, true, `${label}: jump-to-latest must remain visible after content arrival`);
  assert.ok(anchorAfter?.visibleWithinMessageList, `${label}: the previously visible old-history anchor must remain in the message-list viewport`);
  assert.equal(anchorAfter.marker, anchorBefore.marker, `${label}: content arrival must preserve the same visible old-history anchor`);
  assert.ok(Math.abs(anchorAfter.rect.top - anchorBefore.rect.top) <= 48, `${label}: old-history anchor must not be displaced by an automatic tail pull`);
}

async function readVisibleHistoryAnchor(page, requiredMarker = null) {
  return page.evaluate((marker) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return null;
    const listRect = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
    const candidates = rows.map((row) => {
      const rect = row.getBoundingClientRect();
      const historyMarker = (row.textContent ?? "").match(/HISTORY-\d{4}/)?.[0] ?? null;
      return {
        marker: historyMarker,
        rowTestId: row.getAttribute("data-testid"),
        rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
        visibleWithinMessageList: Boolean(historyMarker)
          && rect.width > 0 && rect.height > 0
          && rect.right > listRect.left && rect.left < listRect.right
          && rect.bottom > listRect.top && rect.top < listRect.bottom,
      };
    }).filter((row) => row.visibleWithinMessageList && (!marker || row.marker === marker));
    return candidates[0] ?? null;
  }, requiredMarker);
}

async function readCompletedAssistantMarkerUi(page, marker) {
  return page.evaluate((expectedMarker) => {
    const row = [...document.querySelectorAll('[data-testid="message-assistant"]')]
      .find((element) => (element.textContent ?? "").includes(expectedMarker)) ?? null;
    return {
      rowFound: Boolean(row),
      markerPresent: Boolean(row && (row.textContent ?? "").includes(expectedMarker)),
      failureMarkerPresent: Boolean(row?.querySelector('[data-testid="message-attempt-failure"]')),
      unknownMarkerPresent: Boolean(row?.querySelector('[data-testid="message-attempt-unknown"]')),
      runtimeTerminalUi: !document.querySelector('[data-testid="stop-turn"]')
        && Boolean(document.querySelector('[data-testid="send-message"]'))
        && !Boolean(document.querySelector('[data-testid="queue-message"]')),
    };
  }, marker);
}

function trustedJumpClickEventsSince(beforeTrace, afterTrace) {
  return transcriptInputEventsSince(afterTrace, beforeTrace?.latestOrdinal ?? 0)
    .filter((event) => event.type === "click" && event.insideJumpButton && event.isTrusted);
}

function summarizeFollowGestureNotification(delivery) {
  if (!delivery) return null;
  return {
    delivered: delivery.delivered,
    dispatchOrderValid: delivery.dispatchOrderValid,
    methods: delivery.observedFrames?.map((frame) => frame.method) ?? [],
    sequences: delivery.observedFrames?.map((frame) => frame.sequence) ?? [],
    threadId: delivery.observedFrames?.[0]?.threadId ?? null,
    turnId: delivery.observedFrames?.[0]?.turnId ?? null,
    itemId: delivery.itemId ?? null,
    browserMockId: delivery.browserMockId ?? null,
    routeOrdinal: delivery.observedFrames?.[0]?.routeOrdinal ?? null,
  };
}

async function emitSyntheticTaskSnapshot(page, state, marker, fileChanges, options = {}) {
  const safeMarker = marker.replace(/[^A-Za-z0-9_-]/g, "_");
  const turnId = `ux-profile-turn-${safeMarker}`;
  const attemptId = `ux-profile-attempt-${safeMarker}`;
  const itemId = `ux-profile-item-${safeMarker}`;
  const common = { serverId, threadId, turnId, attemptId };
  const frames = [
    { jsonrpc: "2.0", method: "turn/started", params: { ...common, sequence: state.nextSequence++, turn: { id: turnId, attemptId, threadId, status: "running" } } },
    { jsonrpc: "2.0", method: "item/started", params: { ...common, sequence: state.nextSequence++, item: { id: itemId, type: "agentMessage" } } },
    { jsonrpc: "2.0", method: "item/delta", params: { ...common, sequence: state.nextSequence++, itemId, delta: { text: options.deltaText ?? `\n\n${marker} synchronous task fixture update.` } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { ...common, sequence: state.nextSequence++, turn: { id: turnId, attemptId, threadId, status: "completed" }, fileChanges } },
  ];
  assert.ok(state.activeSocketRoute, "synthetic runtime notifications require the active fixture thread/read connection");
  const result = await page.evaluate((payload) => window.__phoneRenderDeliverFrames(payload.frames, payload.server, payload.channel, payload.workspace, payload.threadId, payload.threadReadId, payload.captureDispatchDetails), {
    frames,
    server: serverId,
    channel: "runtime",
    workspace: state.workspacePath,
    threadId,
    threadReadId: state.activeThreadReadRequestId,
    captureDispatchDetails: state.seedDispatchCaptureActive === true,
  });
  const seedDispatchEvidence = state.seedDispatchCaptureActive === true ? summarizeSeedDispatchEvidence(state, marker, result, frames) : null;
  if (seedDispatchEvidence) state.lastSeedDispatchEvidence = seedDispatchEvidence;
  assert.equal(result.delivered, frames.length, `exactly one open Mobile runtime socket must have sent thread/read for the fixture thread/workspace before synthetic notifications; routeEvidence=${JSON.stringify(state.activeSocketRoute)}, delivery=${JSON.stringify(result)}`);
  const observedFrames = result.frameResults;
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  const observedMethods = observedFrames.map((frame) => frame.method);
  const sequences = observedFrames.map((frame) => frame.sequence);
  const dispatchOrderValid = observedFrames.length === frames.length
    && observedMethods.every((method, index) => method === expectedMethods[index])
    && observedFrames.every((frame) => frame.serverId === serverId && frame.threadId === threadId && frame.turnId === turnId)
    && observedFrames.every((frame) => frame.browserMockId === result.browserMockId)
    && sequences.every((sequence, index) => Number.isSafeInteger(sequence) && (index === 0 || sequence > sequences[index - 1]));
  assert.equal(dispatchOrderValid, true, `synthetic notification dispatch must preserve its ordered thread/turn sequence: ${JSON.stringify({ observedMethods, sequences })}`);
  state.notificationBatches.push({
    marker,
    turnId,
    attemptId,
    itemId,
    methods: observedMethods,
    sequences,
    serverId,
    threadId,
    browserMockId: result.browserMockId,
    threadReadRequestId: state.activeThreadReadRequestId,
    routeOrdinal: state.activeSocketRoute.routeOrdinal,
    dispatchOrderValid,
  });
  state.syntheticNotificationFramesSent = (state.syntheticNotificationFramesSent ?? 0) + frames.length;
  state.syntheticNotificationCopiesSent = (state.syntheticNotificationCopiesSent ?? 0) + frames.length * result.socketCopies;
  const observedTaskMockIds = [...new Set(observedFrames.map((frame) => frame.browserMockId))];
  state.notificationBatches.at(-1).dispatchTaskDurationsMs = result.dispatchTaskDurationsMs;
  state.notificationBatches.at(-1).maximumDispatchTaskMs = Math.max(...result.dispatchTaskDurationsMs);
  return {
    ...result,
    observedFrames,
    turnId,
    attemptId,
    itemId,
    dispatchOrderValid,
    observedTaskMockIds,
    maximumDispatchTaskMs: Math.max(...result.dispatchTaskDurationsMs),
    ...(seedDispatchEvidence ? { seedDispatchEvidence } : {}),
  };
}

return { summarizeSeedDispatchEvidence, beginTranscriptVirtualizationScrollTrace, stopTranscriptVirtualizationScrollTrace, scrollTranscriptToLatestCore, waitForProductTailMarkerWithoutAction, assertProductHistoryAnchorPreserved, assertProductVisibleHistoryOrder, chooseVisibleProductCodeAnchor, makeLongTailWindowAppendDelta, expandProductHistoryCodeDisclosure, runTailWindowProductRegression, runTailWindowPaginationRegression, runTranscriptFollowGestureRegression, disposeTranscriptFollowGestureInputTrace, waitForProductAppendCommit, performTrustedTranscriptTouch, waitForTranscriptTouchSettled, waitForProgrammaticFollowScrollEvent, waitForFollowAppendLayout, assertNoFollowPull, readVisibleHistoryAnchor, readCompletedAssistantMarkerUi, trustedJumpClickEventsSince, summarizeFollowGestureNotification, emitSyntheticTaskSnapshot };
}
