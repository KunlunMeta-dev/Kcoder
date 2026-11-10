import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

/** Transcript geometry and trusted gestures, with the original trace readers and redaction callbacks bound explicitly. */
export function createMobileTranscriptGestureHelpers({
  readProductHistoryAnchor,
  readTranscriptFollowGestureInputTrace,
  safeSeedErrorMessage,
  safeSeedErrorStack,
  transcriptInputEventsSince,
  waitForTwoFrames,
}) {
async function readFocusState(page, step) {
  return page.evaluate((stepName) => {
    const describe = (element) => element instanceof Element ? {
      tag: element.tagName,
      testId: element.getAttribute("data-testid"),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaExpanded: element.getAttribute("aria-expanded"),
      ariaSelected: element.getAttribute("aria-selected"),
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.hasAttribute("inert"),
      className: element instanceof HTMLElement ? String(element.className).slice(0, 100) : null,
      text: String(element.textContent ?? "").trim().slice(0, 80),
    } : null;
    const active = document.activeElement;
    const ancestors = [];
    let current = active instanceof Element ? active : null;
    for (let index = 0; current && index < 6; index += 1, current = current.parentElement) {
      const style = getComputedStyle(current);
      ancestors.push({ ...describe(current), display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents });
    }
    const overlays = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"], [data-testid*="menu"], [data-testid*="dialog"]')]
      .filter((element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== "none")
      .slice(0, 12)
      .map(describe);
    const tabs = [...document.querySelectorAll('[role="tab"], [data-testid^="workspace-tab-"]')].slice(0, 12).map(describe);
    return {
      step: stepName,
      at: Number(performance.now().toFixed(3)),
      active: describe(active),
      ancestors,
      overlays,
      tabs,
      focusEvents: window.__phoneRenderFocusEvents?.() ?? [],
    };
  }, step);
}

async function installTranscriptFollowGestureInputTrace(page, maxEvents = 256) {
  assert.ok(Number.isSafeInteger(maxEvents) && maxEvents >= 256 && maxEvents <= 4096, "follow input trace bound must be between 256 and 4096 events");
  return page.evaluate((eventLimit) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) throw new Error("follow regression could not find the visible message-list");
    const candidates = [list, ...list.querySelectorAll("*")].filter((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    );
    const host = candidates.sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight),
    )[0] ?? list;
    const trace = { nextOrdinal: 1, dropped: 0, events: [], maxEvents: eventLimit, anchorMarker: null, tailMarker: null,
      jumpClickOrdinal: null, raceEvidence: null, readinessEvidence: null };
    const sampleRow = (row, marker, fixtureMessageId = null) => {
      if (!(row instanceof HTMLElement) || !row.isConnected) return { marker, found: false, visibleInClip: false };
      const rowRect = row.getBoundingClientRect(), listRect = list.getBoundingClientRect(), hostRect = host.getBoundingClientRect();
      const visual = window.visualViewport;
      const clip = {
        left: Math.max(visual?.offsetLeft ?? 0, listRect.left, hostRect.left + host.clientLeft),
        top: Math.max(visual?.offsetTop ?? 0, listRect.top, hostRect.top + host.clientTop),
        right: Math.min((visual?.offsetLeft ?? 0) + (visual?.width ?? innerWidth), listRect.right, hostRect.left + host.clientLeft + host.clientWidth),
        bottom: Math.min((visual?.offsetTop ?? 0) + (visual?.height ?? innerHeight), listRect.bottom, hostRect.top + host.clientTop + host.clientHeight),
      };
      const visibleInClip = rowRect.width > 0 && rowRect.height > 0
        && rowRect.right > clip.left && rowRect.left < clip.right
        && rowRect.bottom > clip.top && rowRect.top < clip.bottom;
      const rawTop = Number(host.scrollTop.toFixed(2));
      const maximumRawTop = Math.max(0, host.scrollHeight - host.clientHeight);
      return { marker, found: true, fixtureMessageId,
        rowTop: Number(rowRect.top.toFixed(2)), rowBottom: Number(rowRect.bottom.toFixed(2)),
        viewportOffsetPx: Number((rowRect.top - listRect.top).toFixed(2)), clip, visibleInClip,
        rawTop, logicalTop: Number((maximumRawTop - rawTop).toFixed(2)), maximumRawTop, pageTimeMs: Number(performance.now().toFixed(3)) };
    };
    const sampleAnchor = () => {
      if (!(trace.anchorElement instanceof HTMLElement) || !trace.anchorElement.isConnected
        || !(trace.anchorElement.textContent ?? "").includes(trace.anchorMarker ?? "")) {
        return { marker: trace.anchorMarker, fixtureMessageId: trace.anchorFixtureId, found: false, visibleInClip: false, recycledOrDetached: true };
      }
      return sampleRow(trace.anchorElement, trace.anchorMarker, trace.anchorFixtureId);
    };
    const sampleTail = () => {
      if (!(trace.tailElement instanceof HTMLElement) || !trace.tailElement.isConnected
        || !(trace.tailElement.textContent ?? "").includes(trace.tailMarker ?? "")) {
        return { marker: trace.tailMarker, found: false, visibleInClip: false, recycledOrDetached: true };
      }
      return sampleRow(trace.tailElement, trace.tailMarker);
    };
    const activeJumpState = (currentEvent = null) => {
      const clickOrdinal = trace.jumpClickOrdinal ?? Number.MAX_SAFE_INTEGER;
      const jumpScrolls = trace.events.filter((prior) => prior.type === "scroll" && prior.isTrusted
        && prior.insideMessageList && prior.ordinal > clickOrdinal && prior.anchorSample?.found).slice(-2);
      const [prior, latest] = jumpScrolls;
      const anchorNow = sampleAnchor();
      const tailNow = sampleTail();
      const nowMs = currentEvent?.pageTimeMs ?? Number(performance.now().toFixed(3));
      const currentScrollTop = currentEvent?.scrollTop ?? Number(host.scrollTop.toFixed(2));
      const conditions = {
        trustedJumpClick: trace.jumpClickOrdinal !== null,
        twoRecentJumpScrolls: jumpScrolls.length === 2,
        sameFixtureAnchor: Boolean(prior && latest && prior.anchorSample.fixtureMessageId === trace.anchorFixtureId
          && latest.anchorSample.fixtureMessageId === trace.anchorFixtureId && anchorNow.fixtureMessageId === trace.anchorFixtureId),
        recent: Boolean(latest && nowMs - latest.pageTimeMs <= 200),
        clippedAnchor: anchorNow.visibleInClip === true,
        tailOutsideClip: tailNow.visibleInClip === false && latest?.tailSample?.visibleInClip === false,
        rawAdvancingToLatest: Boolean(prior && latest && latest.scrollTop < prior.scrollTop - 0.5
          && currentScrollTop <= latest.scrollTop + 0.5),
        anchorAdvancingToLatest: Boolean(prior && latest
          && latest.anchorSample.viewportOffsetPx < prior.anchorSample.viewportOffsetPx - 0.5
          && anchorNow.viewportOffsetPx <= latest.anchorSample.viewportOffsetPx + 0.5),
      };
      return { conditions, recentJumpScrolls: jumpScrolls, anchorNow, tailNow, currentScrollTop,
        currentLogicalTop: anchorNow.logicalTop ?? null, sampledAtPageTimeMs: nowMs };
    };
    const waitForActiveJump = (timeoutMs) => new Promise((resolve) => {
      const boundedTimeoutMs = Math.min(3_000, Math.max(0, Number(timeoutMs) || 0));
      const startedAt = performance.now();
      const observations = [];
      const poll = () => {
        const state = activeJumpState();
        observations.push({ sampledAtPageTimeMs: state.sampledAtPageTimeMs, conditions: state.conditions,
          latestOrdinal: trace.events.at(-1)?.ordinal ?? 0, anchorNow: state.anchorNow, tailNow: state.tailNow,
          recentJumpScrolls: state.recentJumpScrolls });
        if (observations.length > 32) observations.shift();
        if (Object.values(state.conditions).every(Boolean)) {
          trace.readinessEvidence = { status: "READY_ACTIVE_JUMP", ...state,
            jumpClickOrdinal: trace.jumpClickOrdinal, latestOrdinal: trace.events.at(-1)?.ordinal ?? 0,
            observations: [...observations] };
          resolve(trace.readinessEvidence);
        } else if (performance.now() - startedAt >= boundedTimeoutMs) {
          trace.readinessEvidence = { status: "INVALID_TIMING", ...state,
            jumpClickOrdinal: trace.jumpClickOrdinal, latestOrdinal: trace.events.at(-1)?.ordinal ?? 0,
            observations: [...observations] };
          resolve(trace.readinessEvidence);
        } else {
          requestAnimationFrame(poll);
        }
      };
      poll();
    });
    const record = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const target = event.target instanceof Element ? event.target : null;
      const insideMessageList = path.includes(list) || Boolean(target && list.contains(target));
      const jumpButton = path.find((node) => node instanceof HTMLElement && node.getAttribute("data-testid") === "jump-to-latest")
        ?? target?.closest('[data-testid="jump-to-latest"]')
        ?? null;
      if (!insideMessageList && !jumpButton) return;
      if (trace.events.length >= trace.maxEvents) {
        trace.dropped += 1;
        return;
      }
      const entry = {
        ordinal: trace.nextOrdinal++,
        type: event.type,
        isTrusted: event.isTrusted === true,
        insideMessageList,
        insideJumpButton: Boolean(jumpButton),
        targetTag: target?.tagName ?? null,
        targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        pointerType: "pointerType" in event ? event.pointerType : null,
        deltaX: typeof event.deltaX === "number" ? Number(event.deltaX.toFixed(3)) : null,
        deltaY: typeof event.deltaY === "number" ? Number(event.deltaY.toFixed(3)) : null,
        pageTimeMs: Number(performance.now().toFixed(3)),
        scrollTop: Number(host.scrollTop.toFixed(2)),
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        bottomGapPx: Math.max(0, Number((host.scrollHeight - host.clientHeight - host.scrollTop).toFixed(2))),
      };
      if (event.type === "click" && jumpButton && entry.isTrusted) trace.jumpClickOrdinal = entry.ordinal;
      if (event.type === "scroll" && insideMessageList && trace.anchorMarker) {
        entry.anchorSample = sampleAnchor();
        entry.tailSample = sampleTail();
      }
      if (event.type === "touchstart" && insideMessageList && trace.anchorMarker) {
        const state = activeJumpState(entry);
        const conditions = { trustedTouchstart: entry.isTrusted, ...state.conditions };
        const activeMotion = Object.values(conditions).every(Boolean);
        trace.raceEvidence = {
          classification: activeMotion ? "VALID_ACTIVE_JUMP" : "INVALID_TIMING",
          conditions, jumpClickOrdinal: trace.jumpClickOrdinal, recentJumpScrolls: state.recentJumpScrolls,
          readinessEvidence: trace.readinessEvidence, anchorAtTouchStart: state.anchorNow, tailAtTouchStart: state.tailNow,
          currentRawTop: entry.scrollTop, currentLogicalTop: state.currentLogicalTop,
        };
        entry.anchorAtTouchStart = state.anchorNow;
        entry.tailAtTouchStart = state.tailNow;
        entry.raceClassification = trace.raceEvidence.classification;
        trace.anchorMarker = null;
        trace.anchorElement = null;
        trace.tailMarker = null;
        trace.tailElement = null;
      }
      trace.events.push(entry);
    };
    const inputTypes = ["touchstart", "touchmove", "touchend", "pointerdown", "pointermove", "pointerup", "wheel", "click"];
    for (const type of inputTypes) document.addEventListener(type, record, true);
    list.addEventListener("scroll", record, true);
    window.__phoneFollowGestureInputTrace = {
      armAnchor: (marker, fixtureMessageId, tailMarker) => {
        trace.anchorMarker = typeof marker === "string" ? marker : null;
        trace.anchorFixtureId = typeof fixtureMessageId === "string" ? fixtureMessageId : null;
        trace.tailMarker = typeof tailMarker === "string" ? tailMarker : null;
        const rows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
        trace.anchorElement = rows.find((element) => (element.textContent ?? "").includes(trace.anchorMarker)) ?? null;
        trace.tailElement = rows.find((element) => trace.tailMarker && (element.textContent ?? "").includes(trace.tailMarker)) ?? null;
        trace.jumpClickOrdinal = null;
        trace.raceEvidence = null;
        trace.readinessEvidence = null;
        return Boolean(trace.anchorMarker && trace.anchorFixtureId && trace.anchorElement && trace.tailMarker);
      },
      snapshot: () => ({
        schemaVersion: 1,
        maxEvents: trace.maxEvents,
        dropped: trace.dropped,
        latestOrdinal: trace.events.at(-1)?.ordinal ?? 0,
        raceEvidence: trace.raceEvidence,
        readinessEvidence: trace.readinessEvidence,
        events: [...trace.events],
      }),
      waitForActiveJump,
      dispose: () => {
        for (const type of inputTypes) document.removeEventListener(type, record, true);
        list.removeEventListener("scroll", record, true);
        delete window.__phoneFollowGestureInputTrace;
      },
    };
    const listRect = list.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      installed: true,
      source: "passive DOM event capture plus bounded read-only requestAnimationFrame readiness sampling; no DOM scroll writes, synthetic DOM events, React state, Runtime handler calls, or observers",
      listTestId: list.getAttribute("data-testid"),
      hostTag: host.tagName,
      hostTestId: host.getAttribute("data-testid"),
      hostOverflowY: getComputedStyle(host).overflowY,
      listRect: { top: listRect.top, bottom: listRect.bottom, left: listRect.left, right: listRect.right },
      hostRect: { top: hostRect.top, bottom: hostRect.bottom, left: hostRect.left, right: hostRect.right },
      initialScrollTop: Number(host.scrollTop.toFixed(2)),
      initialScrollHeight: host.scrollHeight,
      initialClientHeight: host.clientHeight,
    };
  }, maxEvents);
}

async function readProductHistoryViewport(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { listFound: false, visibleRows: [] };
    const listRect = list.getBoundingClientRect();
    const hostCandidate = list.querySelector("[data-phone-ux-scroll-host]");
    const scrollableCandidates = [list, ...list.querySelectorAll("*")].filter((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    ).sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight),
    );
    const host = hostCandidate instanceof HTMLElement ? hostCandidate : scrollableCandidates[0] ?? list;
    const rectValue = (rect) => ({
      top: Number(rect.top.toFixed(3)),
      bottom: Number(rect.bottom.toFixed(3)),
      left: Number(rect.left.toFixed(3)),
      right: Number(rect.right.toFixed(3)),
      width: Number(rect.width.toFixed(3)),
      height: Number(rect.height.toFixed(3)),
    });
    const visibleRows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')]
      .map((row) => {
        const marker = /HISTORY-(\d{4})/.exec(row.textContent ?? "")?.[0] ?? null;
        if (!marker) return null;
        const historyIndex = Number(marker.slice("HISTORY-".length));
        const rect = row.getBoundingClientRect();
        const visibleWithinMessageList = rect.width > 0 && rect.height > 0
          && rect.right > listRect.left && rect.left < listRect.right
          && rect.bottom > listRect.top && rect.top < listRect.bottom;
        if (!visibleWithinMessageList) return null;
        const disclosures = [...row.querySelectorAll('[data-testid="code-disclosure"] [role="button"]')];
        const collapsedCodeDisclosureCount = disclosures.filter((button) => button.getAttribute("aria-expanded") === "false").length;
        const expandedCodeDisclosureCount = disclosures.filter((button) => button.getAttribute("aria-expanded") === "true").length;
        return {
          marker,
          historyIndex,
          fixtureMessageId: `history-${historyIndex}`,
          role: row.getAttribute("data-testid") === "message-assistant" ? "assistant" : "user",
          rect: rectValue(rect),
          viewportOffsetPx: Number((rect.top - listRect.top).toFixed(3)),
          collapsedCodeDisclosureCount,
          expandedCodeDisclosureCount,
          expandedCodeTokenVisible: (row.textContent ?? "").includes(`fixture_${historyIndex}_0`),
        };
      })
      .filter(Boolean)
      .slice(0, 32);
    const control = document.querySelector('[data-testid="load-older-messages"]');
    const controlRect = control instanceof HTMLElement ? control.getBoundingClientRect() : null;
    const jump = document.querySelector('[data-testid="jump-to-latest"]');
    const jumpRect = jump instanceof HTMLElement ? jump.getBoundingClientRect() : null;
    const jumpStyle = jump instanceof HTMLElement ? getComputedStyle(jump) : null;
    const visibleControl = Boolean(controlRect && controlRect.width > 0 && controlRect.height > 0
      && controlRect.right > listRect.left && controlRect.left < listRect.right
      && controlRect.bottom > listRect.top && controlRect.top < listRect.bottom);
    return {
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      listFound: true,
      listRect: rectValue(listRect),
      scrollHost: {
        testId: host.getAttribute("data-testid"),
        scrollTop: Number(host.scrollTop.toFixed(3)),
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        scrollTopIsRawWebGeometryOnly: true,
      },
      visibleRows,
      visibleHistoryIndexes: visibleRows.map((row) => row.historyIndex),
      visualHistoryIndexes: [...visibleRows].sort((left, right) => left.rect.top - right.rect.top).map((row) => row.historyIndex),
      minimumVisibleHistoryIndex: visibleRows.length ? Math.min(...visibleRows.map((row) => row.historyIndex)) : null,
      maximumVisibleHistoryIndex: visibleRows.length ? Math.max(...visibleRows.map((row) => row.historyIndex)) : null,
      olderHistoryControl: {
        present: Boolean(control),
        visibleWithinMessageList: visibleControl,
        disabled: control instanceof HTMLButtonElement ? control.disabled : control?.getAttribute("aria-disabled") === "true",
        rect: controlRect ? rectValue(controlRect) : null,
      },
      jumpToLatestVisible: Boolean(jumpRect && jumpRect.width > 0 && jumpRect.height > 0
        && jumpStyle?.display !== "none" && jumpStyle?.visibility !== "hidden"),
    };
  });
}

async function waitForStableProductHistoryAnchor(page, marker, label, timeoutMs = 5_000) {
  const startedAt = performance.now();
  const samples = [];
  let previous = null;
  while (performance.now() - startedAt <= timeoutMs) {
    await waitForTwoFrames(page);
    const current = await readProductHistoryAnchor(page, marker);
    samples.push({
      pageTimeMs: current.viewport.sampledAtPageTimeMs,
      anchor: current.anchor,
      scrollHost: current.viewport.scrollHost,
    });
    assert.equal(current.viewport.listFound, true, `${label}: actual message-list must remain mounted`);
    assert.ok(current.anchor?.fixtureMessageId, `${label}: the same visible fixture history row must remain mounted`);
    if (previous?.anchor?.fixtureMessageId === current.anchor.fixtureMessageId
      && Math.abs(previous.anchor.viewportOffsetPx - current.anchor.viewportOffsetPx) <= 0.5
      && Math.abs(previous.viewport.scrollHost.scrollTop - current.viewport.scrollHost.scrollTop) <= 0.5
      && previous.viewport.scrollHost.scrollHeight === current.viewport.scrollHost.scrollHeight
      && previous.viewport.scrollHost.clientHeight === current.viewport.scrollHost.clientHeight) {
      return {
        ...current.anchor,
        listRect: current.viewport.listRect,
        sampledAtPageTimeMs: current.viewport.sampledAtPageTimeMs,
        stableAfterTwoFrames: true,
        stabilityPair: [previous, samples.at(-1)],
        observations: samples.slice(-8),
      };
    }
    previous = current;
    await page.waitForTimeout(25);
  }
  const error = new Error(`${label}: visible row geometry did not settle within ${timeoutMs}ms`);
  error.historyAnchorEvidence = { marker, observations: samples.slice(-12) };
  throw error;
}

async function waitForStableProductHistoryWindow(page, label, timeoutMs = 5_000) {
  const startedAt = performance.now();
  const observations = [];
  let previous = null;
  while (performance.now() - startedAt <= timeoutMs) {
    await waitForTwoFrames(page);
    const current = await readProductHistoryViewport(page);
    observations.push(current);
    assert.equal(current.listFound, true, `${label}: actual Mobile message-list must remain mounted`);
    const sameVisibleRows = previous !== null
      && previous.visibleRows.length === current.visibleRows.length
      && previous.visibleRows.every((row, index) => row.marker === current.visibleRows[index].marker
        && Math.abs(row.viewportOffsetPx - current.visibleRows[index].viewportOffsetPx) <= 0.5);
    const sameExtent = previous !== null
      && Math.abs(previous.scrollHost.scrollTop - current.scrollHost.scrollTop) <= 0.5
      && previous.scrollHost.scrollHeight === current.scrollHost.scrollHeight
      && previous.scrollHost.clientHeight === current.scrollHost.clientHeight;
    if (sameVisibleRows && sameExtent) {
      return {
        ...current,
        stableAfterTwoFrames: true,
        stabilityPair: [previous, current],
        observations: observations.slice(-8),
      };
    }
    previous = current;
    await page.waitForTimeout(25);
  }
  const error = new Error(`${label}: visible history window and actual scroll geometry did not settle within ${timeoutMs}ms`);
  error.productHistoryViewportEvidence = { observations: observations.slice(-12) };
  throw error;
}

async function prepareProductTouchStroke(page, label, options = {}) {
  const bounds = await page.getByTestId("message-list").boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `${label}: pre-jump message-list hitbox must be visible`);
  const x = Math.round(bounds.x + bounds.width * 0.55);
  const direction = options.direction === "toward-latest" ? "toward-latest" : "toward-older";
  const fromY = Math.round(bounds.y + bounds.height * (direction === "toward-latest" ? 0.78 : 0.24));
  const toY = Math.round(bounds.y + bounds.height * (direction === "toward-latest" ? 0.24 : 0.78));
  assert.ok(Math.abs(toY - fromY) >= 96, `${label}: prepared touch path must move at least 96 CSS px`);
  const [hitTest, trace] = await Promise.all([
    page.evaluate(({ x, y }) => {
      const list = document.querySelector('[data-testid="message-list"]');
      const target = document.elementFromPoint(x, y);
      return { insideMessageList: Boolean(list && target && list.contains(target)), targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null };
    }, { x, y: fromY }),
    readTranscriptFollowGestureInputTrace(page),
  ]);
  assert.equal(hitTest.insideMessageList, true, `${label}: prevalidated touch point must hit the actual message-list`);
  return { preparedBeforeAction: true, preparedBeforeJump: options.preparedBeforeJump === true,
    direction, start: { x, y: fromY }, end: { x, y: toY }, hitTest,
    latestOrdinal: trace?.latestOrdinal ?? 0, requestedPointCount: options.pointCount ?? 12 };
}

async function performProductTouchStroke(page, cdp, label, options = {}) {
  const evidence = {
    label,
    status: "RUNNING",
    inputBoundary: "Chromium CDP Input.dispatchTouchEvent; the page must observe trusted DOM touchstart/move/end and trusted list scroll events",
    intent: options.direction === "toward-latest"
      ? "finger moves toward the visual latest edge to normalize the same reader anchor; no programmatic scroll assignment or list API call"
      : "finger moves toward the visual older-history edge; no programmatic scroll assignment or list API call",
    requestedPointCount: options.pointCount ?? 12,
    interMoveDelayMs: options.interMoveDelayMs ?? 16,
    startedAtHostMonotonicMs: Number(performance.now().toFixed(3)),
    hitTest: null,
    start: null,
    end: null,
    eventStartOrdinal: null,
    beforeViewport: null,
    touchEndSent: false,
    touchEndPageTimeMs: null,
    afterTwoFramesViewport: null,
    events: [],
    trustedEventCounts: { touchstart: 0, touchmove: 0, touchend: 0, listScroll: 0 },
  };
  try {
    const plan = options.preparedPlan ?? await prepareProductTouchStroke(page, label, {
      pointCount: evidence.requestedPointCount, direction: options.direction,
    });
    assert.equal(plan.preparedBeforeAction, true, `${label}: touch coordinates and hit test must be prepared before the action under test`);
    const { x, y: fromY } = plan.start;
    const toY = plan.end.y;
    evidence.hitTest = plan.hitTest;
    const eventStartOrdinal = options.afterOrdinal ?? plan.latestOrdinal;
    evidence.preparedPlan = { preparedBeforeAction: true, preparedBeforeJump: plan.preparedBeforeJump, latestOrdinal: plan.latestOrdinal, dispatchedAfterOrdinal: eventStartOrdinal };
    evidence.start = { x, y: fromY };
    evidence.end = { x, y: toY };
    evidence.eventStartOrdinal = eventStartOrdinal;
    const pointCount = evidence.requestedPointCount;
    const interMoveDelayMs = evidence.interMoveDelayMs;
    const pointId = 71;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY, id: pointId }] });
    for (let index = 1; index <= pointCount; index += 1) {
      const y = fromY + ((toY - fromY) * index) / pointCount;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: pointId }] });
      if (interMoveDelayMs > 0) await page.waitForTimeout(interMoveDelayMs);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    evidence.touchEndSent = true;
    evidence.touchEndPageTimeMs = await page.evaluate(() => Number(performance.now().toFixed(3)));
    await waitForTwoFrames(page);
    evidence.afterTwoFramesViewport = await readProductHistoryViewport(page);
    const traceAfter = await readTranscriptFollowGestureInputTrace(page);
    evidence.touchStartRaceEvidence = traceAfter?.raceEvidence ?? null;
    evidence.events = transcriptInputEventsSince(traceAfter, eventStartOrdinal);
    const touchEvents = evidence.events.filter((event) => event.ordinal > (options.inputAfterOrdinal ?? eventStartOrdinal) && ["touchstart", "touchmove", "touchend"].includes(event.type));
    const trustedListScrolls = evidence.events.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList);
    evidence.trustedEventCounts = {
      touchstart: touchEvents.filter((event) => event.type === "touchstart" && event.isTrusted && event.insideMessageList).length,
      touchmove: touchEvents.filter((event) => event.type === "touchmove" && event.isTrusted && event.insideMessageList).length,
      touchend: touchEvents.filter((event) => event.type === "touchend" && event.isTrusted && event.insideMessageList).length,
      listScroll: trustedListScrolls.length,
    };
    evidence.status = "CAPTURED_TRUSTED_TOUCH_SEQUENCE";
    assert.ok(evidence.trustedEventCounts.touchstart > 0, `${label}: real browser trusted touchstart must reach the message-list`);
    assert.ok(evidence.trustedEventCounts.touchmove > 0, `${label}: real browser trusted touchmove must reach the message-list`);
    assert.ok(evidence.trustedEventCounts.touchend > 0, `${label}: real browser trusted touchend must reach the message-list`);
    assert.ok(touchEvents.every((event) => event.isTrusted && event.insideMessageList), `${label}: every captured touch event must be trusted and inside the message-list`);
    if (options.requireActiveJumpAtTouchStart && evidence.touchStartRaceEvidence?.classification !== "VALID_ACTIVE_JUMP") {
      evidence.status = "INVALID_TIMING";
      const timingError = new Error(`${label}: trusted touchstart did not coincide with a clipped anchor and recent active Jump motion`);
      timingError.code = "INVALID_TIMING";
      timingError.productTouchStrokeEvidence = evidence;
      throw timingError;
    }
    evidence.status = "PASS_TRUSTED_TOUCH_SEQUENCE";
    return {
      ...evidence,
      beforeViewport: evidence.beforeViewport,
      afterViewport: evidence.afterTwoFramesViewport,
      pointCount: evidence.requestedPointCount + 2,
    };
  } catch (error) {
    evidence.status = error?.code === "INVALID_TIMING" ? "INVALID_TIMING" : "FAIL";
    evidence.failure = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    try {
      const traceAfter = await readTranscriptFollowGestureInputTrace(page);
      evidence.events = transcriptInputEventsSince(traceAfter, evidence.eventStartOrdinal ?? 0);
      evidence.inputTraceDropped = traceAfter?.dropped ?? null;
      const touchEvents = evidence.events.filter((event) => event.ordinal > (options.inputAfterOrdinal ?? (evidence.eventStartOrdinal ?? 0)) && ["touchstart", "touchmove", "touchend"].includes(event.type));
      evidence.trustedEventCounts = {
        touchstart: touchEvents.filter((event) => event.type === "touchstart" && event.isTrusted && event.insideMessageList).length,
        touchmove: touchEvents.filter((event) => event.type === "touchmove" && event.isTrusted && event.insideMessageList).length,
        touchend: touchEvents.filter((event) => event.type === "touchend" && event.isTrusted && event.insideMessageList).length,
        listScroll: evidence.events.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList).length,
      };
      evidence.currentViewport = await readProductHistoryViewport(page);
    } catch (evidenceError) {
      evidence.evidenceReadError = { name: evidenceError?.name ?? "Error", message: safeSeedErrorMessage(evidenceError) };
    }
    error.productTouchStrokeEvidence = evidence;
    throw error;
  }
}

async function normalizeStableReaderAnchorWithTrustedInput(page, cdp, initialAnchor, label) {
  const evidence = {
    status: "RUNNING",
    fixtureMessageId: initialAnchor.fixtureMessageId,
    marker: initialAnchor.marker,
    before: initialAnchor,
    after: initialAnchor,
    exactAnchorTolerancePx: 2,
    direction: "toward-latest",
    inputBoundary: "trusted Chromium CDP touch strokes only; no DOM scroll writes, list API calls, or anchor substitution",
    inputBudgetMs: 5_000,
    settleBudgetMs: 5_000,
    maximumStrokeCount: 8,
    cumulativeInputMs: 0,
    cumulativeSettleMs: 0,
    strokes: [],
  };
  let anchor = initialAnchor;
  const startedAt = performance.now();
  try {
    assert.ok(anchor?.fixtureMessageId && anchor.marker, `${label}: normalization needs one mounted history row with its immutable ID`);
    while (anchor.viewportOffsetPx < -2) {
      assert.ok(evidence.strokes.length < evidence.maximumStrokeCount,
        `${label}: the same row did not reach the 2px top contract within eight trusted strokes`);
      const remainingInputMs = evidence.inputBudgetMs - evidence.cumulativeInputMs;
      const previousInputMs = evidence.strokes.at(-1)?.inputDurationMs ?? 0;
      const remainingSettleMs = evidence.settleBudgetMs - evidence.cumulativeSettleMs;
      const previousSettleMs = evidence.strokes.at(-1)?.settleDurationMs ?? 0;
      assert.ok(remainingInputMs > previousInputMs,
        `${label}: no next trusted stroke fits the original shared five-second input budget`);
      assert.ok(remainingSettleMs > previousSettleMs,
        `${label}: no next anchor-settle check fits the original shared five-second settle budget`);

      const strokeNumber = evidence.strokes.length + 1;
      const strokeBefore = anchor;
      const inputStartedAt = performance.now();
      let stroke;
      try {
        stroke = await performProductTouchStroke(page, cdp, `${label}-toward-latest-${strokeNumber}`, {
          direction: "toward-latest",
          pointCount: 26,
          interMoveDelayMs: 12,
        });
      } catch (error) {
        const partialStroke = error.productTouchStrokeEvidence ?? { status: "FAIL_WITHOUT_STROKE_EVIDENCE" };
        partialStroke.strokeNumber = strokeNumber;
        partialStroke.inputDurationMs = Number((performance.now() - inputStartedAt).toFixed(3));
        evidence.cumulativeInputMs += partialStroke.inputDurationMs;
        partialStroke.cumulativeInputMs = Number(evidence.cumulativeInputMs.toFixed(3));
        partialStroke.anchorBefore = strokeBefore;
        evidence.strokes.push(partialStroke);
        error.productStableReaderNormalizationEvidence = evidence;
        throw error;
      }
      stroke.strokeNumber = strokeNumber;
      stroke.inputDurationMs = Number((performance.now() - inputStartedAt).toFixed(3));
      evidence.cumulativeInputMs += stroke.inputDurationMs;
      stroke.cumulativeInputMs = Number(evidence.cumulativeInputMs.toFixed(3));
      stroke.anchorBefore = strokeBefore;
      evidence.strokes.push(stroke);
      assert.ok(stroke.trustedEventCounts?.touchstart > 0 && stroke.trustedEventCounts?.touchmove > 0
        && stroke.trustedEventCounts?.touchend > 0 && stroke.trustedEventCounts?.listScroll > 0,
      `${label}: each normalization step needs trusted touchstart/move/end and a real message-list scroll`);
      assert.ok(evidence.cumulativeInputMs <= evidence.inputBudgetMs,
        `${label}: trusted normalization exceeded the original five-second input budget`);

      const remainingSettleBudgetMs = evidence.settleBudgetMs - evidence.cumulativeSettleMs;
      assert.ok(remainingSettleBudgetMs > 0, `${label}: stable same-ID geometry exhausted the original five-second settle budget`);
      const settleStartedAt = performance.now();
      try {
        anchor = await waitForStableProductHistoryAnchor(page, strokeBefore.marker, `${label} settles after trusted stroke ${strokeNumber}`,
          Math.max(1, Math.ceil(remainingSettleBudgetMs)));
      } catch (error) {
        stroke.settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
        evidence.cumulativeSettleMs += stroke.settleDurationMs;
        stroke.cumulativeSettleMs = Number(evidence.cumulativeSettleMs.toFixed(3));
        stroke.anchorAfterFailure = error.historyAnchorEvidence ?? null;
        error.productStableReaderNormalizationEvidence = evidence;
        throw error;
      }
      stroke.settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
      evidence.cumulativeSettleMs += stroke.settleDurationMs;
      stroke.cumulativeSettleMs = Number(evidence.cumulativeSettleMs.toFixed(3));
      stroke.anchorAfter = anchor;
      stroke.sameFixtureMessageId = anchor.fixtureMessageId === evidence.fixtureMessageId;
      stroke.sameUniqueMarker = anchor.marker === evidence.marker;
      stroke.anchorTopProgressPx = Number((anchor.viewportOffsetPx - strokeBefore.viewportOffsetPx).toFixed(3));
      assert.equal(anchor.fixtureMessageId, evidence.fixtureMessageId, `${label}: trusted input must retain the original fixture message ID`);
      assert.equal(anchor.marker, evidence.marker, `${label}: trusted input must retain the original unique marker`);
      assert.ok(stroke.anchorTopProgressPx > 0.5,
        `${label}: trusted toward-latest stroke made no same-row top progress toward the unchanged 2px contract`);
      assert.ok(evidence.cumulativeSettleMs <= evidence.settleBudgetMs,
        `${label}: stable anchor checks exceeded the original five-second settle budget`);
    }
    assert.equal(anchor.fixtureMessageId, evidence.fixtureMessageId, `${label}: normalized row ID must be unchanged`);
    assert.equal(anchor.marker, evidence.marker, `${label}: normalized row marker must be unchanged`);
    assert.ok(anchor.viewportOffsetPx >= -2 && anchor.viewportOffsetPx <= anchor.listRect.height + 2,
      `${label}: same row must be clipped within the actual message-list viewport`);
    evidence.after = anchor;
    evidence.status = evidence.strokes.length ? "PASS_TRUSTED_INPUT_NORMALIZED" : "PASS_ALREADY_WITHIN_2PX";
    evidence.wallDurationMs = Number((performance.now() - startedAt).toFixed(3));
    return evidence;
  } catch (error) {
    evidence.status = "FAIL";
    evidence.after = anchor;
    evidence.wallDurationMs = Number((performance.now() - startedAt).toFixed(3));
    error.productStableReaderNormalizationEvidence = evidence;
    throw error;
  }
}

async function performProductTouchToOlderHistory(page, cdp) {
  const initial = await waitForStableProductHistoryWindow(page, "latest history window before trusted touch");
  assert.ok(Number.isSafeInteger(initial.minimumVisibleHistoryIndex), "latest viewport must show at least one actual visible HISTORY row");
  const targetIndex = Math.max(0, initial.minimumVisibleHistoryIndex - 1);
  assert.ok(targetIndex < initial.minimumVisibleHistoryIndex, "trusted touch target must be older than the currently visible window");
  const inputBudgetMs = 5_000;
  const settleBudgetMs = 5_000;
  const maximumStrokeCount = 8;
  const wallStartedAt = performance.now();
  let cumulativeInputMs = 0;
  let cumulativeSettleMs = 0;
  let settled = initial;
  let stopReason = "maximum-strokes-reached";
  const strokes = [];
  const strokeBudgetDecisions = [];
  const trustedTouchDurationMs = (stroke) => {
    const events = stroke.events ?? [];
    const touchStart = events.find((event) => event.type === "touchstart" && event.isTrusted && event.insideMessageList);
    const touchEnd = [...events].reverse().find((event) => event.type === "touchend" && event.isTrusted && event.insideMessageList);
    return Number.isFinite(touchStart?.pageTimeMs) && Number.isFinite(touchEnd?.pageTimeMs)
      ? Number(Math.max(0, touchEnd.pageTimeMs - touchStart.pageTimeMs).toFixed(3))
      : null;
  };
  const summarize = () => {
    const gestureEvents = strokes.flatMap((stroke) => stroke.events ?? []);
    const trustedTouchEvents = gestureEvents.filter((event) => ["touchstart", "touchmove", "touchend"].includes(event.type)
      && event.isTrusted && event.insideMessageList);
    const trustedScrolls = gestureEvents.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList);
    const gestureComplete = {
      touchEndSent: strokes.length > 0 && strokes.every((stroke) => stroke.touchEndSent === true),
      trustedTouchendObserved: strokes.length > 0 && strokes.every((stroke) => stroke.trustedEventCounts?.touchend > 0),
      trustedListScrollObserved: strokes.length > 0 && strokes.every((stroke) => stroke.trustedEventCounts?.listScroll > 0),
      stableHistoryWindowAfterTouchend: settled?.stableAfterTwoFrames === true,
      finalTwoFrameObservation: strokes.at(-1)?.afterTwoFramesViewport ?? null,
      settledHistoryObservation: settled,
      postGestureSettleMs: Number(cumulativeSettleMs.toFixed(3)),
    };
    return {
      initialViewport: initial,
      targetHistoryIndex: targetIndex,
      finalViewport: settled,
      inputDurationMs: Number(cumulativeInputMs.toFixed(3)),
      trustedTouchEventDurationMs: Number(strokes.reduce((total, stroke) => total + (stroke.trustedTouchDurationMs ?? 0), 0).toFixed(3)),
      inputDurationBoundary: "shared five-second budget charges host elapsed around each unchanged performProductTouchStroke call, including that helper's two-RAF observation; trusted touchstart-to-touchend event time is reported separately",
      inputBudgetMs,
      settleDurationMs: Number(cumulativeSettleMs.toFixed(3)),
      settleBudgetMs,
      wallDurationMs: Number((performance.now() - wallStartedAt).toFixed(3)),
      gestureCount: strokes.length,
      maximumStrokeCount,
      stopReason,
      strokeBudgetDecisions,
      gestureComplete,
      gestureEvidence: strokes,
      actualHistoryProgress: {
        initialMinimumVisibleHistoryIndex: initial.minimumVisibleHistoryIndex,
        finalMinimumVisibleHistoryIndex: settled?.minimumVisibleHistoryIndex ?? null,
        movedOlderByAtLeast: Number.isSafeInteger(settled?.minimumVisibleHistoryIndex)
          ? initial.minimumVisibleHistoryIndex - settled.minimumVisibleHistoryIndex
          : null,
        immediatelyOlderTargetHistoryIndex: targetIndex,
        immediatelyOlderTargetVisible: settled?.visibleHistoryIndexes?.includes(targetIndex) === true,
        trustedScrollEventCount: trustedScrolls.length,
        trustedTouchEventCount: trustedTouchEvents.length,
      },
    };
  };

  try {
    for (let strokeIndex = 0; strokeIndex < maximumStrokeCount; strokeIndex += 1) {
      if (settled.visibleHistoryIndexes.includes(targetIndex)) {
        stopReason = "immediately-older-row-visible-and-stable";
        break;
      }
      const remainingInputBudgetMs = inputBudgetMs - cumulativeInputMs;
      const estimatedNextStrokeMs = strokes.length === 0
        ? 0
        : Math.max(...strokes.map((stroke) => stroke.inputDurationMs ?? 0));
      const remainingSettleBudgetBeforeStrokeMs = settleBudgetMs - cumulativeSettleMs;
      const estimatedNextSettleMs = strokes.length === 0
        ? 0
        : Math.max(...strokes.map((stroke) => stroke.settleDurationMs ?? 0));
      const mayStartStroke = remainingInputBudgetMs > 0
        && remainingSettleBudgetBeforeStrokeMs > 0
        && (strokes.length === 0 || remainingInputBudgetMs > estimatedNextStrokeMs)
        && (strokes.length === 0 || remainingSettleBudgetBeforeStrokeMs > estimatedNextSettleMs);
      strokeBudgetDecisions.push({
        strokeNumber: strokeIndex + 1,
        remainingInputBudgetMs: Number(Math.max(0, remainingInputBudgetMs).toFixed(3)),
        estimatedNextStrokeMs: Number(estimatedNextStrokeMs.toFixed(3)),
        remainingSettleBudgetMs: Number(Math.max(0, remainingSettleBudgetBeforeStrokeMs).toFixed(3)),
        estimatedNextSettleMs: Number(estimatedNextSettleMs.toFixed(3)),
        mayStartStroke,
      });
      if (!mayStartStroke) {
        stopReason = remainingInputBudgetMs <= estimatedNextStrokeMs
          ? "input-budget-does-not-reserve-the-last-observed-stroke-duration"
          : "settle-budget-does-not-reserve-the-last-observed-settle-duration";
        break;
      }

      const strokeStartedAt = performance.now();
      let stroke;
      try {
        stroke = await performProductTouchStroke(page, cdp, `toward-old-history-touch-${strokeIndex + 1}`, {
          pointCount: 26,
          interMoveDelayMs: 12,
        });
      } catch (error) {
        stroke = error.productTouchStrokeEvidence ?? {
          label: `toward-old-history-touch-${strokeIndex + 1}`,
          status: "FAIL_WITHOUT_STROKE_EVIDENCE",
        };
        stroke.strokeNumber = strokeIndex + 1;
        stroke.inputDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
        stroke.wallDurationMs = stroke.inputDurationMs;
        stroke.trustedTouchDurationMs = trustedTouchDurationMs(stroke);
        cumulativeInputMs += stroke.inputDurationMs;
        stroke.cumulativeInputDurationMs = Number(cumulativeInputMs.toFixed(3));
        strokes.push(stroke);
        stopReason = "trusted-stroke-failed";
        error.productTouchEvidence = summarize();
        throw error;
      }
      stroke.strokeNumber = strokeIndex + 1;
      stroke.inputDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
      stroke.trustedTouchDurationMs = trustedTouchDurationMs(stroke);
      cumulativeInputMs += stroke.inputDurationMs;
      stroke.cumulativeInputDurationMs = Number(cumulativeInputMs.toFixed(3));
      stroke.previousSettledViewport = settled;

      const remainingSettleBudgetMs = settleBudgetMs - cumulativeSettleMs;
      if (remainingSettleBudgetMs <= 0) {
        stroke.wallDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
        strokes.push(stroke);
        stopReason = "post-gesture-settle-budget-exhausted";
        throw new Error("trusted touch sequence exhausted the shared five-second post-gesture settle budget");
      }
      const settleStartedAt = performance.now();
      try {
        settled = await waitForStableProductHistoryWindow(
          page,
          `trusted touch ${strokeIndex + 1} settles on older visible history`,
          Math.max(1, Math.ceil(remainingSettleBudgetMs)),
        );
      } catch (error) {
        stroke.settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
        cumulativeSettleMs += stroke.settleDurationMs;
        stroke.cumulativeSettleDurationMs = Number(cumulativeSettleMs.toFixed(3));
        stroke.wallDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
        stroke.settleFailure = error.productHistoryViewportEvidence ?? null;
        strokes.push(stroke);
        stopReason = "history-window-did-not-settle-within-shared-budget";
        error.productTouchEvidence = summarize();
        throw error;
      }
      stroke.settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
      cumulativeSettleMs += stroke.settleDurationMs;
      stroke.cumulativeSettleDurationMs = Number(cumulativeSettleMs.toFixed(3));
      stroke.wallDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
      stroke.settledViewport = settled;
      const previousViewport = stroke.previousSettledViewport;
      const rawScrollTopDelta = settled.scrollHost.scrollTop - previousViewport.scrollHost.scrollTop;
      const olderIndexProgress = settled.minimumVisibleHistoryIndex < previousViewport.minimumVisibleHistoryIndex;
      stroke.progress = {
        rawScrollTopDelta: Number(rawScrollTopDelta.toFixed(3)),
        rawScrollTopIsGeometryOnly: true,
        visibleHistoryIndexBefore: previousViewport.minimumVisibleHistoryIndex,
        visibleHistoryIndexAfter: settled.minimumVisibleHistoryIndex,
        olderIndexProgress,
        progressedTowardOlderHistory: rawScrollTopDelta > 0.5 || olderIndexProgress,
      };
      strokes.push(stroke);

      assert.ok(cumulativeInputMs <= inputBudgetMs,
        "trusted touch strokes must stay within the original shared five-second input budget");
      assert.ok(cumulativeSettleMs <= settleBudgetMs,
        "trusted touch strokes must stay within the original shared five-second post-gesture settle budget");
      assert.ok(stroke.trustedEventCounts?.listScroll > 0,
        `trusted touch stroke ${strokeIndex + 1} must cause a real message-list scroll event`);
      assert.ok(stroke.progress.progressedTowardOlderHistory,
        `trusted touch stroke ${strokeIndex + 1} made no measurable progress toward older history`);
      if (settled.visibleHistoryIndexes.includes(targetIndex)) {
        stopReason = "immediately-older-row-visible-and-stable";
        break;
      }
    }
  } catch (error) {
    if (!error.productTouchEvidence) error.productTouchEvidence = summarize();
    throw error;
  }

  const evidence = summarize();
  try {
    assert.ok(evidence.inputDurationMs <= inputBudgetMs, "trusted touch input must stay within the existing shared five-second gesture budget");
    assert.ok(evidence.settleDurationMs <= settleBudgetMs, "trusted touch settling must stay within the existing shared five-second post-gesture budget");
    assert.ok(evidence.gestureCount > 0, "trusted touch must include at least one completed stroke");
    assert.ok(evidence.gestureComplete.touchEndSent && evidence.gestureComplete.trustedTouchendObserved && evidence.gestureComplete.stableHistoryWindowAfterTouchend,
      "trusted touch must deliver touchend and reach a stable history window afterward");
    assert.equal(evidence.gestureComplete.trustedListScrollObserved, true, "every settled trusted stroke must cause a real browser scroll event inside the message-list");
    assert.ok(evidence.finalViewport.minimumVisibleHistoryIndex <= targetIndex,
      `trusted touch must expose at least one older rendered history row; target<=${targetIndex}, actual=${evidence.finalViewport.minimumVisibleHistoryIndex}`);
    assert.ok(evidence.finalViewport.visibleHistoryIndexes.includes(targetIndex),
      `trusted touch must preserve the immediately older consecutive history row ${targetIndex} in the viewport; visible=${evidence.finalViewport.visibleHistoryIndexes.join(",")}`);
    assert.equal(evidence.finalViewport.jumpToLatestVisible, true, "moving away from latest must expose the real Jump-to-latest control");
    assert.ok(evidence.finalViewport.visibleRows.every((row) => Number.isSafeInteger(row.historyIndex)), "visible history rows must retain their fixture IDs and order markers");
  } catch (error) {
    error.productTouchEvidence = evidence;
    throw error;
  }
  return {
    ...evidence,
    beforeViewport: initial,
    afterViewport: evidence.finalViewport,
    pointCountPerStroke: 28,
    inputTraceDropped: (await readTranscriptFollowGestureInputTrace(page))?.dropped ?? null,
  };
}

async function performProductWheelToOlderHistoryControl(page) {
  const initial = await waitForStableProductHistoryWindow(page, "history window before trusted wheel");
  const bounds = await page.getByTestId("message-list").boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, "trusted wheel must target the visible message-list");
  const x = Math.round(bounds.x + Math.min(28, bounds.width / 4));
  const y = Math.round(bounds.y + bounds.height / 2);
  const hitTest = await page.evaluate(({ pointX, pointY }) => {
    const root = document.querySelector('[data-testid="message-list"]');
    const target = document.elementFromPoint(pointX, pointY);
    return { insideMessageList: Boolean(root && target && root.contains(target)), targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null };
  }, { pointX: x, pointY: y });
  assert.equal(hitTest.insideMessageList, true, "trusted wheel pointer must be over the actual message-list");
  const traceBefore = await readTranscriptFollowGestureInputTrace(page);
  const eventStartOrdinal = traceBefore?.latestOrdinal ?? 0;
  await page.mouse.move(x, y);
  const maximumWheelEvents = 32;
  const inputBudgetMs = 5_000;
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  assert.ok(Number.isFinite(devicePixelRatio) && devicePixelRatio >= 1, "trusted wheel calibration requires a real positive browser devicePixelRatio");
  assert.equal(initial.olderHistoryControl.present, true, "reserved older history must expose the actual Load Earlier Messages control in the DOM");
  assert.ok(initial.olderHistoryControl.rect, "the real older-page control must have measurable geometry before trusted wheel input");
  const controlDistanceToViewport = (viewport) => {
    const list = viewport.listRect;
    const controlRect = viewport.olderHistoryControl.rect;
    if (!list || !controlRect) return null;
    if (controlRect.bottom <= list.top) return Math.max(0, list.top - controlRect.bottom);
    if (controlRect.top >= list.bottom) return Math.max(0, controlRect.top - list.bottom);
    return 0;
  };
  const scrollRange = (viewport) => Math.max(0, viewport.scrollHost.scrollHeight - viewport.scrollHost.clientHeight);
  const initialControlGapPx = controlDistanceToViewport(initial);
  assert.ok(Number.isFinite(initialControlGapPx), "the real older-page control and list must provide finite target geometry");
  const initialScrollRangePx = scrollRange(initial);
  const initialTravelEstimateCssPx = Math.max(initialControlGapPx, initialScrollRangePx);
  let estimatedCssPixelsPerWheelDelta = 1 / devicePixelRatio;
  let wheelEventCount = 0;
  let currentViewport = initial;
  let control = currentViewport.olderHistoryControl;
  let batchRequestedMagnitude = 0;
  let batchInitialGapPx = initialControlGapPx;
  const requestedDeltaYs = [];
  const wheelCalibrationBatches = [];
  const inputStartedAt = performance.now();
  let lastDispatchFinishedAt = inputStartedAt;
  for (let index = 0; index < maximumWheelEvents && !control.visibleWithinMessageList
    && performance.now() - inputStartedAt <= inputBudgetMs; index += 1) {
    const remainingEventsIncludingThis = maximumWheelEvents - wheelEventCount;
    const measuredGapPx = controlDistanceToViewport(currentViewport);
    const remainingDistancePx = Number.isFinite(measuredGapPx) ? measuredGapPx : initialTravelEstimateCssPx;
    const useInitialScrollRangeEstimate = wheelEventCount === 0;
    const requestedMagnitude = Math.max(1, Math.ceil(
      ((useInitialScrollRangeEstimate ? initialTravelEstimateCssPx : remainingDistancePx) + 1)
      / Math.max(1, remainingEventsIncludingThis)
      / Math.max(0.0001, estimatedCssPixelsPerWheelDelta)
      * 1.12,
    ));
    await page.mouse.wheel(0, -requestedMagnitude);
    lastDispatchFinishedAt = performance.now();
    requestedDeltaYs.push(-requestedMagnitude);
    if (wheelEventCount === 0) batchInitialGapPx = remainingDistancePx;
    batchRequestedMagnitude += requestedMagnitude;
    wheelEventCount += 1;
    if (wheelEventCount % 4 === 0 || wheelEventCount === maximumWheelEvents) {
      await waitForTwoFrames(page);
      const previousViewport = currentViewport;
      currentViewport = await readProductHistoryViewport(page);
      control = currentViewport.olderHistoryControl;
      const beforeGapPx = controlDistanceToViewport(previousViewport);
      const afterGapPx = controlDistanceToViewport(currentViewport);
      const geometryProgressPx = Number.isFinite(beforeGapPx) && Number.isFinite(afterGapPx)
        ? beforeGapPx - afterGapPx
        : null;
      const rawScrollOffsetChangePx = Math.abs(currentViewport.scrollHost.scrollTop - previousViewport.scrollHost.scrollTop);
      const measuredProgressPx = geometryProgressPx !== null && geometryProgressPx > 0.5
        ? geometryProgressPx
        : rawScrollOffsetChangePx;
      const measuredCssPixelsPerWheelDelta = batchRequestedMagnitude > 0
        ? measuredProgressPx / batchRequestedMagnitude
        : null;
      wheelCalibrationBatches.push({
        eventCount: wheelEventCount,
        requestedMagnitude: batchRequestedMagnitude,
        beforeControlGapPx: batchInitialGapPx,
        afterControlGapPx: afterGapPx,
        geometryProgressTowardControlPx: geometryProgressPx,
        rawScrollOffsetChangePx,
        measuredProgressPx,
        measuredCssPixelsPerWheelDelta,
        scrollTopBefore: previousViewport.scrollHost.scrollTop,
        scrollTopAfter: currentViewport.scrollHost.scrollTop,
        scrollHeight: currentViewport.scrollHost.scrollHeight,
        clientHeight: currentViewport.scrollHost.clientHeight,
        controlVisible: control.visibleWithinMessageList,
      });
      if (measuredCssPixelsPerWheelDelta > 0) estimatedCssPixelsPerWheelDelta = measuredCssPixelsPerWheelDelta;
      batchRequestedMagnitude = 0;
      batchInitialGapPx = afterGapPx;
    }
  }
  const inputFinishedAt = lastDispatchFinishedAt;
  const inputDurationMs = Number((inputFinishedAt - inputStartedAt).toFixed(3));
  const postInputViewport = currentViewport;
  const settleStartedAt = inputFinishedAt;
  const settled = await waitForStableProductHistoryWindow(page, "trusted wheel settles at older-history page control", 5_000);
  const settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
  const traceAfter = await readTranscriptFollowGestureInputTrace(page);
  const events = transcriptInputEventsSince(traceAfter, eventStartOrdinal);
  const wheels = events.filter((event) => event.type === "wheel");
  const trustedOlderWheels = wheels.filter((event) => event.isTrusted && event.insideMessageList && event.deltaY < 0);
  const trustedScrolls = events.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList);
  const evidence = {
    initialViewport: initial,
    postInputViewport,
    finalViewport: settled,
    hitTest,
    devicePixelRatio,
    initialControlGapPx,
    initialScrollRangePx,
    initialTravelEstimateCssPx,
    requestedDeltaYs,
    observedTrustedDeltaY: trustedOlderWheels.map((event) => event.deltaY),
    wheelEventCount,
    inputBudgetMs,
    inputStartedAtMonotonicMs: Number(inputStartedAt.toFixed(3)),
    lastDispatchFinishedAtMonotonicMs: Number(inputFinishedAt.toFixed(3)),
    inputDurationMs,
    settleDurationMs,
    wheelCalibrationBatches,
    trustedWheelCount: trustedOlderWheels.length,
    trustedScrollEventCount: trustedScrolls.length,
    olderControl: settled.olderHistoryControl,
    inputTraceDropped: traceAfter?.dropped ?? null,
    noBottomGapGate: true,
  };
  try {
    assert.ok(wheelEventCount > 0 && trustedOlderWheels.length > 0, "older paging must be reached using real trusted negative-delta wheel events, not DOM/API scrolling");
    assert.ok(trustedScrolls.length > 0, "trusted wheel must produce actual browser scroll events inside the message-list");
    assert.ok(evidence.inputDurationMs <= inputBudgetMs, "trusted wheel sequence must stay within the existing bounded five-second input budget");
    assert.equal(settled.olderHistoryControl.visibleWithinMessageList, true, "the actual Load Earlier Messages control must intersect the message-list viewport after wheel navigation");
    assert.equal(settled.olderHistoryControl.disabled, false, "older history must still be available at the visible page boundary");
    assert.equal(settled.jumpToLatestVisible, true, "the reader must remain paused while navigating toward the older page");
  } catch (error) {
    error.productWheelEvidence = evidence;
    throw error;
  }
  return evidence;
}

  return { readFocusState, installTranscriptFollowGestureInputTrace, readProductHistoryViewport, waitForStableProductHistoryAnchor, waitForStableProductHistoryWindow, prepareProductTouchStroke, performProductTouchStroke, normalizeStableReaderAnchorWithTrustedInput, performProductTouchToOlderHistory, performProductWheelToOlderHistoryControl };
}
