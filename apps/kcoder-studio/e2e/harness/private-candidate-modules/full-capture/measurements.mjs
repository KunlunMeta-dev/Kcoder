// Private historical candidate mechanisms; construction starts no resources.
export function createPrivateFullCaptureMeasurements({
  activeDeltaChunksPerStream,
  assert,
  beginSeedUiTraceInPage,
  captureSeedFailureDom,
  captureSeedUiDomTrace,
  collectLongTasks,
  configureRuntimeConsumerProbe,
  createRequire,
  disposeTranscriptFollowGestureInputTrace,
  emitSyntheticTaskSnapshot,
  endSeedUiTraceInPage,
  installTranscriptFollowGestureInputTrace,
  makeCompleteCpuProfileArtifact,
  manualHistoryLogicalDistanceFromLatest,
  mapGeneratedProfilePosition,
  moveAwayFromLatestWithTrustedWheel,
  performance,
  readTranscriptFollowGestureInputTrace,
  readTranscriptViewport,
  readVerifiedMobileExportFile,
  recordScriptUrlIdentity,
  repoRoot,
  resolve,
  resolveScriptMapBinding,
  resolveTranscriptScrollportTransform,
  runtimeConsumerDiagnostic,
  safePath,
  safeSeedErrorMessage,
  safeSeedErrorStack,
  scrollTranscriptToLatest,
  serverId,
  sha256,
  summarizeManualHistoryResetViewport,
  summarizeSeedDispatchEvidence,
  threadId,
  transcriptInputEventsSince,
  transcriptVirtualizationTraceLimits,
  validateProfileWindowBoundaries,
  waitForTwoFrames,
}) {
async function measureInputFeedback(page, pageState, source, count, panelState, samples) {
  const input = page.getByTestId("message-input");
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await waitForTwoFrames(page);
  const output = [];
  for (let index = 0; index < samples; index += 1) {
    await input.click();
    await input.fill("");
    await input.evaluate((element) => element.focus());
    await waitForTwoFrames(page);
    let focusState = await input.evaluate((element) => ({
      focused: document.activeElement === element,
      tag: element.tagName,
      disabled: "disabled" in element ? element.disabled : null,
      readOnly: "readOnly" in element ? element.readOnly : null,
      connected: element.isConnected,
      display: getComputedStyle(element).display,
      visibility: getComputedStyle(element).visibility,
      pointerEvents: getComputedStyle(element).pointerEvents,
      html: element.outerHTML.slice(0, 350),
      activeTag: document.activeElement?.tagName ?? null,
      activeTestId: document.activeElement?.getAttribute?.("data-testid") ?? null,
    }));
    if (!focusState.focused) {
      await input.click();
      await waitForTwoFrames(page);
      focusState = await input.evaluate((element) => ({
        focused: document.activeElement === element,
        tag: element.tagName,
        disabled: "disabled" in element ? element.disabled : null,
        readOnly: "readOnly" in element ? element.readOnly : null,
        connected: element.isConnected,
        display: getComputedStyle(element).display,
        visibility: getComputedStyle(element).visibility,
        pointerEvents: getComputedStyle(element).pointerEvents,
        html: element.outerHTML.slice(0, 350),
        activeTag: document.activeElement?.tagName ?? null,
        activeTestId: document.activeElement?.getAttribute?.("data-testid") ?? null,
      }));
    }
    const id = `input-${source}-${count}-${index}`;
    const startedAt = performance.now();
    let error = focusState.focused ? null : new Error("input focus did not remain on the textarea after a two-frame wait and a retry click");
    if (!error) {
      await page.evaluate((value) => window.__phoneRenderArmInput(value), id);
      try {
        await input.press("x");
        await page.waitForFunction((value) => Boolean(window.__phoneRenderInputResult(value)), id, { timeout: 5_000 });
      } catch (caught) { error = caught; }
    }
    const automationElapsedMs = Number((performance.now() - startedAt).toFixed(3));
    const result = await page.evaluate((value) => window.__phoneRenderInputResult(value), id).catch(() => null);
    const longTasks = result ? await collectLongTasks(page, result) : [];
    const diagnostic = error ? await page.evaluate(() => {
      const inputElement = document.querySelector('[data-testid="message-input"]');
      const active = document.activeElement;
      return {
        activeElementTag: active?.tagName ?? null,
        activeElementTestId: active?.getAttribute?.("data-testid") ?? null,
        inputConnected: inputElement?.isConnected ?? false,
        inputValueLength: "value" in (inputElement ?? {}) ? String(inputElement.value ?? "").length : null,
        inputDisplay: inputElement instanceof HTMLElement ? getComputedStyle(inputElement).display : null,
        inputParentDisplay: inputElement?.parentElement instanceof HTMLElement ? getComputedStyle(inputElement.parentElement).display : null,
        inputDisabled: inputElement instanceof HTMLTextAreaElement || inputElement instanceof HTMLInputElement ? inputElement.disabled : null,
        inputReadOnly: inputElement instanceof HTMLTextAreaElement || inputElement instanceof HTMLInputElement ? inputElement.readOnly : null,
        inputOuterHtml: inputElement?.outerHTML.slice(0, 500) ?? null,
        focusState,
        focusEvents: window.__phoneRenderFocusEvents?.() ?? [],
        activeState: document.activeElement instanceof Element ? {
          role: document.activeElement.getAttribute("role"),
          ariaExpanded: document.activeElement.getAttribute("aria-expanded"),
          ariaModal: document.activeElement.getAttribute("aria-modal"),
          ancestors: (() => {
            const values = [];
            let current = document.activeElement;
            for (let index = 0; current instanceof HTMLElement && index < 5; index += 1, current = current.parentElement) values.push({ tag: current.tagName, testId: current.getAttribute("data-testid"), role: current.getAttribute("role"), ariaHidden: current.getAttribute("aria-hidden"), inert: current.hasAttribute("inert"), display: getComputedStyle(current).display, pointerEvents: getComputedStyle(current).pointerEvents });
            return values;
          })(),
        } : null,
        visibleOverlays: [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"], [data-testid*="menu"], [data-testid*="dialog"]')].filter((element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== "none").slice(0, 8).map((element) => ({ testId: element.getAttribute("data-testid"), role: element.getAttribute("role"), ariaModal: element.getAttribute("aria-modal"), text: element.textContent?.trim().slice(0, 80) })),
      };
    }) : null;
    output.push({
      source,
      requestedMessages: count,
      scenario: "input-feedback",
      panelState,
      sample: index + 1,
      durationMs: result?.durationMs ?? null,
      automationElapsedMs,
      synchronousEventTaskMs: result?.synchronousEventTaskMs ?? null,
      focusState,
      tabModalDismiss: pageState.tabModalDismiss ?? null,
      longTasks,
      ok: Boolean(result) && !error && (panelState !== "mounted-hidden" || pageState.tabModalDismiss?.dismissed === true),
      timingSource: "browser keydown event through next animation frame with controlled TextInput value updated",
      ...(diagnostic ? { diagnostic } : {}),
      ...(error ? { error: String(error.message || error).slice(0, 400) } : {}),
    });
  }
  return output;
}

async function measureScrollFeedback(page, state, source, count, panelState, samples, context) {
  const hostInfo = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="message-list"]');
    if (!(root instanceof HTMLElement)) return null;
    const candidates = [root, ...root.querySelectorAll("*")].filter((element) => element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16);
    const host = candidates.sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0];
    if (!host) return null;
    host.setAttribute("data-phone-ux-scroll-host", "true");
    return { top: host.getBoundingClientRect().top, left: host.getBoundingClientRect().left, width: host.clientWidth, height: host.clientHeight, scrollHeight: host.scrollHeight, maxScrollTop: host.scrollHeight - host.clientHeight };
  });
  const output = [];
  for (let index = 0; index < samples; index += 1) {
    const sample = index + 1;
    const marker = `seed-${source}-${count}-${panelState}`;
    const artifact = {
      schemaVersion: 1,
      scenario: "scroll-feedback-causal-setup",
      evidenceClass: "isolated Mobile Web Chromium with app-facing WebSocketMock history and synthetic fixture input; not a real app-server turn, native measurement, or matched performance result",
      source,
      requestedMessages: count,
      panelState,
      sample,
      marker,
      boundary: "positioning uses trusted wheel input and measured scroll geometry; touch timing begins only after setup; no scrollTop writes are used",
      hostInfo,
      stage: "precondition",
      setup: { tailRestoreDurationMs: null, wheelSetupDurationMs: null, tailRestore: null, trustedWheel: null, beforeTouch: null, touchHitTest: null },
      touch: { inputTrace: null, result: null, afterViewport: null, waitError: null },
      cleanup: { inputTrace: "not-installed", cdpSession: "not-created" },
      cleanupErrors: [],
      primaryError: null,
      status: "RUNNING",
    };
    let primaryError = null;
    let artifactWriteError = null;
    let cdp = null;
    let inputObserverInstalled = false;
    let inputTraceStartOrdinal = 0;
    let inputTraceStartDropped = null;
    let touchResult = null;
    let touchWaitError = null;
    let touchBefore = null;
    let touchAfter = null;
    let touchLongTasks = [];
    let automationElapsedMs = null;
    let touchStartedAt = null;

    try {
      assert.ok(hostInfo && hostInfo.height > 0 && hostInfo.maxScrollTop > 0,
        "scroll host was not found or the transcript did not overflow");
      artifact.stage = "restore-real-tail";
      const tailRestoreStartedAt = performance.now();
      const entryTail = await scrollTranscriptToLatest(page, marker, { requireMarkerVisible: true });
      artifact.setup.tailRestoreDurationMs = Number((performance.now() - tailRestoreStartedAt).toFixed(3));
      artifact.setup.tailRestore = summarizeScrollCausalityTailGate(entryTail);

      artifact.stage = "trusted-wheel-to-old-history";
      const wheelSetupStartedAt = performance.now();
      try {
        const wheelEvidence = await moveAwayFromLatestWithTrustedWheel(page, marker, entryTail.after);
        artifact.setup.trustedWheel = summarizeScrollCausalityWheel(wheelEvidence);
        assert.equal(wheelEvidence.status, "TRUSTED_WHEEL_MOVED_AWAY_FROM_LATEST",
          "scroll feedback setup must use bounded trusted wheel input to move away from the real latest tail");
      } catch (error) {
        const wheelEvidence = error?.preTapNavigationEvidence ?? error?.cause?.preTapNavigationEvidence;
        if (wheelEvidence) artifact.setup.trustedWheel = summarizeScrollCausalityWheel(wheelEvidence);
        throw error;
      } finally {
        artifact.setup.wheelSetupDurationMs = Number((performance.now() - wheelSetupStartedAt).toFixed(3));
      }

      artifact.stage = "verify-off-tail-touch-target";
      touchBefore = await readTranscriptViewport(page, marker, true, {
        captureMarkerVisibilityDiagnostics: true,
        captureScrollportTransform: true,
      });
      const logicalDistanceBeforeTouch = manualHistoryLogicalDistanceFromLatest(touchBefore);
      artifact.setup.beforeTouch = {
        ...summarizeScrollCausalityViewport(touchBefore),
        logicalDistanceFromLatestPx: logicalDistanceBeforeTouch.pixels,
        logicalDistanceOrientation: logicalDistanceBeforeTouch.inverted ? "inverted" : "normal",
      };
      assert.ok(logicalDistanceBeforeTouch.pixels > 96,
        "trusted wheel setup must leave the measured touch away from the latest threshold");
      assert.equal(touchBefore.jumpToLatestVisible, true,
        "trusted wheel setup must expose the real Jump-to-latest control before the measured touch");

      const listBounds = await page.getByTestId("message-list").boundingBox();
      assert.ok(listBounds && listBounds.width > 0 && listBounds.height > 0,
        "measured touch must target the actual visible message-list hitbox");
      const x = Math.round(listBounds.x + listBounds.width / 2);
      const y = Math.round(listBounds.y + listBounds.height / 2);
      artifact.setup.touchHitTest = await page.evaluate(({ pointX, pointY }) => {
        const list = document.querySelector('[data-testid="message-list"]');
        const target = document.elementFromPoint(pointX, pointY);
        return {
          insideMessageList: Boolean(list && target && list.contains(target)),
          targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
          sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
        };
      }, { pointX: x, pointY: y });
      assert.equal(artifact.setup.touchHitTest.insideMessageList, true,
        "measured CDP touch point must hit the real message-list subtree");

      artifact.stage = "arm-measured-touch";
      const inputObserver = await installTranscriptFollowGestureInputTrace(page, 256);
      inputObserverInstalled = true;
      assert.equal(inputObserver.installed, true, "measured touch needs a bounded passive input trace");
      const traceBaseline = await readTranscriptFollowGestureInputTrace(page);
      assert.ok(Number.isSafeInteger(traceBaseline?.latestOrdinal) && Number.isSafeInteger(traceBaseline?.dropped),
        "measured touch trace must expose ordinal and dropped-event counters before input starts");
      inputTraceStartOrdinal = traceBaseline.latestOrdinal;
      inputTraceStartDropped = traceBaseline.dropped;
      artifact.touch.traceInstallBaseline = { latestOrdinal: inputTraceStartOrdinal, dropped: inputTraceStartDropped };
      cdp = await page.context().newCDPSession(page);
      const id = `scroll-${source}-${count}-${panelState}-${index}`;
      await page.evaluate((value) => window.__phoneRenderArmScroll(value), id);
      const measurementTraceBaseline = await readTranscriptFollowGestureInputTrace(page);
      assert.ok(Number.isSafeInteger(measurementTraceBaseline?.latestOrdinal) && Number.isSafeInteger(measurementTraceBaseline?.dropped),
        "measured touch interval must have valid trace counters immediately before dispatch");
      inputTraceStartOrdinal = measurementTraceBaseline.latestOrdinal;
      inputTraceStartDropped = measurementTraceBaseline.dropped;
      artifact.touch.traceBaseline = { latestOrdinal: inputTraceStartOrdinal, dropped: inputTraceStartDropped };

      artifact.stage = "measured-trusted-touch";
      touchStartedAt = performance.now();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 41 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 64, id: 41 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 128, id: 41 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      try {
        await page.waitForFunction((value) => Boolean(window.__phoneRenderInputResult(value)), id, { timeout: 5_000 });
      } catch (error) {
        touchWaitError = error;
      }
      touchResult = await page.evaluate((value) => window.__phoneRenderInputResult(value), id).catch(() => null);
      automationElapsedMs = Number((performance.now() - touchStartedAt).toFixed(3));
      touchAfter = await readTranscriptViewport(page, marker, true, {
        captureMarkerVisibilityDiagnostics: true,
        captureScrollportTransform: true,
      });
      touchLongTasks = touchResult ? await collectLongTasks(page, touchResult) : [];

      const touchTrace = await readTranscriptFollowGestureInputTrace(page);
      const events = transcriptInputEventsSince(touchTrace, inputTraceStartOrdinal);
      artifact.touch.inputTrace = summarizeScrollCausalityTouchTrace(touchTrace, events, inputTraceStartDropped);
      const logicalDistanceAfterTouch = manualHistoryLogicalDistanceFromLatest(touchAfter);
      const touchVerification = evaluateScrollCausalityTouchEvidence({
        result: touchResult,
        waitError: touchWaitError,
        trace: artifact.touch.inputTrace,
      });
      artifact.touch.result = {
        durationMs: touchResult?.durationMs ?? null,
        automationElapsedMs,
        synchronousEventTaskMs: touchResult?.scrollEventTaskMs ?? null,
        touchStartHandlerMs: touchResult?.synchronousEventTaskMs ?? null,
        scrollDeltaPx: touchResult?.scrollDeltaPx ?? null,
        beforeRawScrollTop: touchBefore.scrollTop,
        afterRawScrollTop: touchAfter.scrollTop,
        logicalDistanceBeforePx: logicalDistanceBeforeTouch.pixels,
        logicalDistanceAfterPx: logicalDistanceAfterTouch.pixels,
        logicalOrientation: logicalDistanceAfterTouch.inverted ? "inverted" : "normal",
        trustedInputCounts: artifact.touch.inputTrace.trustedCounts,
        traceDroppedDuringMeasurement: artifact.touch.inputTrace.droppedDuringMeasurement,
        verification: touchVerification,
        longTaskCount: touchLongTasks.length,
        longTasks: touchLongTasks.slice(0, 8).map((task) => ({
          startTimeMs: task.startTimeMs,
          durationMs: task.durationMs,
          name: String(task.name ?? "unknown").slice(0, 80),
        })),
      };
      artifact.touch.afterViewport = summarizeScrollCausalityViewport(touchAfter);
      artifact.touch.waitError = touchWaitError
        ? { name: touchWaitError?.name ?? "Error", message: safeSeedErrorMessage(touchWaitError).slice(0, 400) }
        : null;

      const outputEntry = {
        source,
        requestedMessages: count,
        scenario: "scroll-feedback",
        panelState,
        sample,
        durationMs: touchResult?.durationMs ?? null,
        automationElapsedMs,
        setupDurationMs: artifact.setup.wheelSetupDurationMs,
        setupWheelSteps: artifact.setup.trustedWheel?.steps?.length ?? null,
        synchronousEventTaskMs: touchResult?.scrollEventTaskMs ?? null,
        touchStartHandlerMs: touchResult?.synchronousEventTaskMs ?? null,
        scrollDeltaPx: touchResult?.scrollDeltaPx ?? null,
        trustedInputCounts: artifact.touch.inputTrace.trustedCounts,
        traceDroppedDuringMeasurement: artifact.touch.inputTrace.droppedDuringMeasurement,
        evidenceStatus: touchVerification.status,
        longTasks: touchLongTasks,
        ok: touchVerification.status === "PASS",
        timingSource: "CDP trusted mobile touchstart through first transcript scroll event and next animation frame; trusted wheel setup and any real tail Jump restoration are reported separately",
        ...(touchWaitError ? { error: safeSeedErrorMessage(touchWaitError).slice(0, 400) } : {}),
      };
      artifact.result = outputEntry;
      output.push(outputEntry);
    } catch (error) {
      primaryError = error;
      artifact.primaryError = {
        name: error?.name ?? "Error",
        message: safeSeedErrorMessage(error).slice(0, 1200),
        stack: safeSeedErrorStack(error)?.slice(0, 4000) ?? null,
      };
      if (error?.transcriptViewport) artifact.tailGateFailure = summarizeScrollCausalityTailGate(error.transcriptViewport);
      const wheelEvidence = error?.preTapNavigationEvidence ?? error?.cause?.preTapNavigationEvidence;
      if (wheelEvidence && artifact.setup.trustedWheel === null) artifact.setup.trustedWheel = summarizeScrollCausalityWheel(wheelEvidence);
    } finally {
      if (touchAfter === null) {
        try {
          touchAfter = await readTranscriptViewport(page, marker, true, {
            captureMarkerVisibilityDiagnostics: true,
            captureScrollportTransform: true,
          });
          artifact.touch.afterViewport = summarizeScrollCausalityViewport(touchAfter);
        } catch (error) {
          artifact.touch.afterViewportReadError = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error).slice(0, 400) };
        }
      }
      if (inputObserverInstalled) {
        try {
          const trace = await readTranscriptFollowGestureInputTrace(page);
          if (artifact.touch.inputTrace === null) {
            artifact.touch.inputTrace = summarizeScrollCausalityTouchTrace(
              trace,
              transcriptInputEventsSince(trace, inputTraceStartOrdinal),
              inputTraceStartDropped,
            );
          }
        } catch (error) {
          artifact.cleanupErrors.push({ operation: "read-input-trace", name: error?.name ?? "Error", message: safeSeedErrorMessage(error).slice(0, 400) });
        }
        try {
          await disposeTranscriptFollowGestureInputTrace(page);
          artifact.cleanup.inputTrace = "disposed";
        } catch (error) {
          artifact.cleanup.inputTrace = "failed";
          artifact.cleanupErrors.push({ operation: "dispose-input-trace", name: error?.name ?? "Error", message: safeSeedErrorMessage(error).slice(0, 400) });
        }
      }
      if (cdp) {
        try {
          await cdp.detach();
          artifact.cleanup.cdpSession = "detached";
        } catch (error) {
          artifact.cleanup.cdpSession = "failed";
          artifact.cleanupErrors.push({ operation: "detach-cdp-session", name: error?.name ?? "Error", message: safeSeedErrorMessage(error).slice(0, 400) });
        }
      }
      artifact.touch.verification ??= evaluateScrollCausalityTouchEvidence({
        result: touchResult,
        waitError: touchWaitError,
        trace: artifact.touch.inputTrace,
      });
      artifact.status = primaryError || touchWaitError || artifact.cleanupErrors.some((entry) => entry.name)
        ? "FAIL"
        : artifact.touch.verification.status;
      try {
        await context.writeArtifactJson(
          `phone-render-profile-scroll-causality-${source}-${count}-${panelState}-${sample}.json`,
          artifact,
        );
      } catch (error) {
        artifactWriteError = error;
      }
    }

    if (primaryError || artifactWriteError || artifact.cleanupErrors.some((entry) => entry.name)) {
      const cleanupFailures = artifact.cleanupErrors.filter((entry) => entry.name)
        .map((entry) => new Error(`${entry.operation}: ${entry.message}`));
      const errors = [primaryError, ...cleanupFailures, artifactWriteError].filter(Boolean);
      const failure = errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "scroll feedback causal measurement failed; primary and cleanup/artifact errors are retained", { cause: primaryError ?? errors[0] });
      failure.scrollCausalityEvidence = artifact;
      throw failure;
    }
  }
  return output;
}

function summarizeScrollCausalityViewport(viewport) {
  if (!viewport || typeof viewport !== "object") return null;
  const transformEvidence = resolveTranscriptScrollportTransform(viewport);
  const transform = transformEvidence.status === "captured" ? transformEvidence.transform : null;
  let logicalDistance = null;
  try {
    const measured = manualHistoryLogicalDistanceFromLatest(viewport);
    logicalDistance = { pixels: measured.pixels, orientation: measured.inverted ? "inverted" : "normal" };
  } catch (error) {
    logicalDistance = { error: safeSeedErrorMessage(error).slice(0, 200) };
  }
  return {
    sampledAtPageTimeMs: viewport.sampledAtPageTimeMs ?? null,
    scrollHostTestId: viewport.scrollHostTestId ?? null,
    scrollTop: viewport.scrollTop ?? null,
    scrollHeight: viewport.scrollHeight ?? null,
    clientHeight: viewport.clientHeight ?? null,
    rawBottomGapPx: viewport.bottomGapPx ?? null,
    scrollportTransform: transform,
    scrollportTransformEvidence: transformEvidence,
    logicalDistanceFromLatest: logicalDistance,
    targetRowFound: viewport.targetRowFound ?? null,
    targetRowRect: viewport.targetRowRect ?? null,
    targetMarkerLastCharacterRect: viewport.targetMarkerLastCharacterRect ?? null,
    targetMarkerVisibleWithinMessageList: viewport.targetMarkerVisibleWithinMessageList ?? null,
    jumpToLatestVisible: viewport.jumpToLatestVisible ?? null,
  };
}

function summarizeScrollCausalityTailGate(gate) {
  if (!gate || typeof gate !== "object") return gate ?? null;
  const actions = Array.isArray(gate.actions) ? gate.actions.slice(0, 2).map((action) => ({
    action: action.action ?? null,
    atPoll: action.atPoll ?? null,
    outcome: action.outcome ?? null,
    timeoutMs: action.timeoutMs ?? null,
  })) : [];
  return {
    action: gate.action ?? null,
    expectedTailMarker: gate.expectedTailMarker ?? null,
    before: summarizeScrollCausalityViewport(gate.before),
    after: summarizeScrollCausalityViewport(gate.after ?? gate.afterTwoFrames ?? gate.last),
    afterTwoFrames: gate.afterTwoFrames === true,
    firstTargetVisiblePoll: gate.firstTargetVisiblePoll ?? null,
    stableSamples: gate.stableSamples ?? null,
    pollCount: gate.pollCount ?? null,
    actions,
    geometryStableAfterTwoFrames: gate.geometryStableAfterTwoFrames ?? null,
  };
}

function summarizeScrollCausalityWheel(wheel) {
  if (!wheel || typeof wheel !== "object") return null;
  const summarizeEvents = (events) => {
    if (!Array.isArray(events)) return { count: 0, trustedInsideListCount: 0, firstOrdinal: null, lastOrdinal: null };
    const accepted = events.filter((event) => event?.isTrusted === true && event?.insideMessageList === true);
    return {
      count: events.length,
      trustedInsideListCount: accepted.length,
      firstOrdinal: events[0]?.ordinal ?? null,
      lastOrdinal: events.at(-1)?.ordinal ?? null,
      firstPageTimeMs: events[0]?.pageTimeMs ?? null,
      lastPageTimeMs: events.at(-1)?.pageTimeMs ?? null,
    };
  };
  const steps = Array.isArray(wheel.steps) ? wheel.steps.slice(0, 8).map((step) => ({
    index: step.index ?? null,
    requestedDeltaY: step.requestedDeltaY ?? null,
    before: summarizeManualHistoryResetViewport(step.before),
    after: summarizeManualHistoryResetViewport(step.after),
    logicalDistanceChangePx: step.logicalDistanceChangePx ?? null,
    wheelEvents: summarizeEvents(step.trustedWheelEvents),
    listScrollEvents: summarizeEvents(step.trustedListScrollEvents),
  })) : [];
  return {
    status: wheel.status ?? null,
    maximumWheelSteps: wheel.maximumWheelSteps ?? null,
    requestedDeltaYPerStep: wheel.requestedDeltaYPerStep ?? null,
    inputBudgetMs: wheel.inputBudgetMs ?? null,
    inputDurationMs: wheel.inputDurationMs ?? null,
    initialViewport: wheel.initialViewport ?? null,
    logicalDistance: wheel.logicalDistance ?? null,
    hitTest: wheel.hitTest ?? null,
    steps,
    trustedWheelEventCount: wheel.trustedWheelEventCount ?? null,
    trustedListScrollEventCount: wheel.trustedListScrollEventCount ?? null,
    finalViewport: wheel.finalViewport ?? null,
    cleanupErrors: Array.isArray(wheel.cleanupErrors) ? wheel.cleanupErrors.slice(0, 4) : [],
    error: wheel.error ? { name: wheel.error.name ?? null, message: String(wheel.error.message ?? "").slice(0, 400) } : null,
  };
}

function summarizeScrollCausalityTouchTrace(trace, events, droppedBefore) {
  const allEvents = Array.isArray(events) ? events : [];
  const droppedAfter = Number.isSafeInteger(trace?.dropped) ? trace.dropped : null;
  const droppedDuringMeasurement = Number.isSafeInteger(droppedBefore) && Number.isSafeInteger(droppedAfter) && droppedAfter >= droppedBefore
    ? droppedAfter - droppedBefore
    : null;
  const boundedEvents = allEvents.slice(0, 32).map((event) => ({
    ordinal: event.ordinal ?? null,
    type: event.type ?? null,
    pageTimeMs: event.pageTimeMs ?? null,
    isTrusted: event.isTrusted === true,
    insideMessageList: event.insideMessageList === true,
    insideJumpButton: event.insideJumpButton === true,
    targetTestId: event.targetTestId ?? null,
    deltaX: event.deltaX ?? null,
    deltaY: event.deltaY ?? null,
    scrollTop: event.scrollTop ?? null,
    scrollHeight: event.scrollHeight ?? null,
    clientHeight: event.clientHeight ?? null,
  }));
  const count = (type) => allEvents.filter((event) => event.type === type && event.isTrusted === true && event.insideMessageList === true).length;
  return {
    schemaVersion: trace?.schemaVersion ?? null,
    latestOrdinal: trace?.latestOrdinal ?? null,
    droppedBeforeMeasurement: Number.isSafeInteger(droppedBefore) ? droppedBefore : null,
    droppedAfterMeasurement: droppedAfter,
    droppedDuringMeasurement,
    recordedEventCountAfterStartOrdinal: allEvents.length,
    recordedTouchEventCount: allEvents.filter((event) => ["touchstart", "touchmove", "touchend"].includes(event.type)).length,
    trustedCounts: {
      touchstart: count("touchstart"),
      touchmove: count("touchmove"),
      touchend: count("touchend"),
      listScroll: count("scroll"),
    },
    events: boundedEvents,
    eventsOmittedCount: Math.max(0, allEvents.length - boundedEvents.length),
  };
}

function evaluateScrollCausalityTouchEvidence({ result, waitError, trace }) {
  const counts = trace?.trustedCounts;
  const requiredCounts = ["touchstart", "touchmove", "touchend", "listScroll"];
  const countsAvailable = requiredCounts.every((name) => Number.isSafeInteger(counts?.[name]) && counts[name] >= 0);
  const dropCountAvailable = Number.isSafeInteger(trace?.droppedDuringMeasurement) && trace.droppedDuringMeasurement >= 0;
  const scrollDeltaAvailable = typeof result?.scrollDeltaPx === "number" && Number.isFinite(result.scrollDeltaPx);
  const gates = {
    touchResultAvailable: Boolean(result),
    touchWaitCompleted: !waitError,
    trustedTouchstartInsideList: countsAvailable ? counts.touchstart > 0 : null,
    trustedTouchmoveInsideList: countsAvailable ? counts.touchmove > 0 : null,
    trustedTouchendInsideList: countsAvailable ? counts.touchend > 0 : null,
    trustedListScrollObserved: countsAvailable ? counts.listScroll > 0 : null,
    scrollDeltaGreaterThanOnePx: scrollDeltaAvailable ? Math.abs(result.scrollDeltaPx) > 1 : null,
    noTraceEventsDropped: dropCountAvailable ? trace.droppedDuringMeasurement === 0 : null,
  };
  const evidenceComplete = countsAvailable && dropCountAvailable && scrollDeltaAvailable;
  const passed = evidenceComplete && Object.values(gates).every((value) => value === true);
  return {
    status: passed ? "PASS" : evidenceComplete ? "FAIL" : "UNVERIFIED",
    gates,
    trustedCounts: countsAvailable ? counts : null,
    droppedDuringMeasurement: dropCountAvailable ? trace.droppedDuringMeasurement : null,
    scrollDeltaPx: scrollDeltaAvailable ? result.scrollDeltaPx : null,
    evidenceBoundary: "sample passes only when the measured interval contains trusted in-list touchstart/move/end, a trusted in-list scroll, >1px observed movement, and zero dropped trace events",
  };
}

async function measureActiveMarkdownDelta(page, state, source, count, panelState, samples, captureProfile, options = {}) {
  const sampleOffset = Number.isInteger(options.sampleOffset) ? options.sampleOffset : 0;
  const diagnosticOnly = options.diagnosticOnly === true;
  const safeVariant = panelState === "mounted-hidden" ? "mounted" : "unmounted";
  const firstTailMarker = options.initialTailMarker ?? (sampleOffset === 0
    ? samples > 0
      ? `UX-${source}-${count}-${safeVariant}-${samples - 1}`
      : `seed-${source}-${count}-${panelState}`
    : `ACTIVE-MD-${source}-${count}-${safeVariant}-burst-${sampleOffset}-chunk-${activeDeltaChunksPerStream}`);
  let previousTailMarker = firstTailMarker;
  const observations = [];
  const bursts = [];
  let totalDeltaBytes = 0;
  let currentStreamSample = sampleOffset + 1;
  let currentExpectedTailMarker = previousTailMarker;
  let currentExpectedFinalMarker = null;
  let currentStreamPhase = "initial-tail-follow";
  let currentTranscriptViewportBeforeBurst = null;
  const attachActiveStreamFailureEvidence = (error, failureStage) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.activeStreamFailureEvidence = {
      schemaVersion: 1,
      failureStage,
      source,
      requestedMessages: count,
      panelState,
      sampleOffset,
      expectedStreamCount: samples,
      completedStreamCount: bursts.length,
      totalDeltaBytes,
      completedBursts: [...bursts],
      completedObservations: [...observations],
      currentStream: {
        sample: currentStreamSample,
        expectedTailMarker: currentExpectedTailMarker,
        expectedFinalMarker: currentExpectedFinalMarker,
        phase: currentStreamPhase,
        transcriptViewportBeforeBurst: currentTranscriptViewportBeforeBurst,
        nextSequence: state.nextSequence,
      },
      helperViewport: failure.transcriptViewport ?? failure.cause?.transcriptViewport ?? null,
      error: {
        name: failure.name,
        message: String(failure.message || failure).slice(0, 2000),
        stack: typeof failure.stack === "string" ? failure.stack.slice(0, 8000) : null,
      },
    };
    return failure;
  };
  let initialTranscriptViewport;
  try {
    initialTranscriptViewport = await scrollTranscriptToLatest(page, previousTailMarker);
    currentTranscriptViewportBeforeBurst = initialTranscriptViewport;
    currentStreamPhase = "ready-for-first-stream";
  } catch (error) {
    throw attachActiveStreamFailureEvidence(error, "initial-tail-follow");
  }
  let profileSession = null;
  let cpuProfile = null;
  let rawCpuProfile = null;
  let rawCpuProfileArtifact = null;
  let cpuProfileError = null;
  const captureCompleteProfile = captureProfile && options.captureFullCpuProfile === true;
  if (captureCompleteProfile) {
    assert.equal(samples, 1, "complete CDP profile capture is restricted to one independent burst");
    assert.equal(diagnosticOnly, true, "complete CDP profile capture must remain diagnostic-only");
    assert.ok(Array.isArray(options.approvedBundlePaths) && options.approvedBundlePaths.length > 0, "complete CDP profile capture requires the pinned served bundle inventory");
  }
  const approvedBundlePaths = new Set(options.approvedBundlePaths ?? []);
  const approvedScriptBaseUrl = captureProfile ? page.url() : null;
  let profileStartedAt = null;
  let profileStartRequestedAtNodeMs = null;
  let profileStartAcknowledgedAtNodeMs = null;
  let profileStopRequestedAtNodeMs = null;
  let profileStopAcknowledgedAtNodeMs = null;
  let profileStarted = false;
  let profileStopAttempted = false;
  let profileStartClock = null;
  let profileEndClock = null;
  const profilePageBoundaries = {
    firstDeltaDispatchAtPageTimeMs: null,
    completionDispatchAtPageTimeMs: null,
    agentRowMutationObservedAtPageTimeMs: null,
    twoAnimationFrameOpportunityAtPageTimeMs: null,
    rowGeometryValidationAtPageTimeMs: null,
    tailValidationStartAtPageTimeMs: null,
    tailValidationEndAtPageTimeMs: null,
    tailValidationAction: null,
  };
  const stopProfileCapture = async () => {
    if (!profileSession || !profileStarted || profileStopAttempted) return;
    profileStopAttempted = true;
    profileStopRequestedAtNodeMs = performance.now();
    const { profile } = await profileSession.send("Profiler.stop");
    profileStopAcknowledgedAtNodeMs = performance.now();
    profileStarted = false;
    rawCpuProfile = profile;
    profileEndClock = await captureCdpClockAnchor(profileSession, page);
  };
  if (captureProfile) {
    try {
      profileSession = await page.context().newCDPSession(page);
      await profileSession.send("Performance.enable");
      await profileSession.send("Profiler.enable");
      await profileSession.send("Profiler.setSamplingInterval", { interval: 500 });
      if (!captureCompleteProfile) {
        await profileSession.send("Profiler.start");
        profileStarted = true;
        profileStartedAt = performance.now();
        profileStartClock = await captureCdpClockAnchor(profileSession, page);
      }
    } catch (error) {
      cpuProfileError = String(error.message || error).slice(0, 300);
      profileStarted = false;
      await profileSession?.detach().catch(() => {});
      profileSession = null;
    }
  }
  let activeStreamError = null;
  try {
    for (let streamIndex = 0; streamIndex < samples; streamIndex += 1) {
      const streamSample = sampleOffset + streamIndex + 1;
      currentStreamSample = streamSample;
      currentExpectedTailMarker = previousTailMarker;
      currentExpectedFinalMarker = `ACTIVE-MD-${source}-${count}-${safeVariant}-burst-${streamSample}-chunk-${activeDeltaChunksPerStream}`;
      currentStreamPhase = "tail-follow-before-stream";
      currentTranscriptViewportBeforeBurst = null;
      const transcriptViewportBeforeBurst = streamIndex === 0
        ? initialTranscriptViewport
        : await scrollTranscriptToLatest(page, previousTailMarker);
      currentTranscriptViewportBeforeBurst = transcriptViewportBeforeBurst;
      currentStreamPhase = "dispatching-stream-setup";
      const turnId = `ux-active-stream-turn-${source}-${count}-${safeVariant}-${streamSample}`;
      const attemptId = `ux-active-stream-attempt-${source}-${count}-${safeVariant}-${streamSample}`;
      const itemId = `ux-active-stream-item-${source}-${count}-${safeVariant}-${streamSample}`;
      const common = { serverId, threadId, turnId, attemptId };
      const setupFrames = [
        {
          jsonrpc: "2.0",
          method: "turn/started",
          params: { ...common, sequence: state.nextSequence++, turn: { id: turnId, attemptId, threadId, status: "running" } },
        },
        {
          jsonrpc: "2.0",
          method: "item/started",
          params: { ...common, sequence: state.nextSequence++, item: { id: itemId, type: "agentMessage" } },
        },
      ];
      const setupResults = [];
      for (const frame of setupFrames) {
        const delivery = await dispatchActiveFrame(page, state, frame);
        assert.equal(delivery.delivered, true, `active Markdown burst setup frame must reach the unique Mobile runtime socket: ${JSON.stringify(delivery)}`);
        setupResults.push({
          method: frame.method,
          sequence: frame.params.sequence,
          serverId,
          threadId,
          turnId,
          browserMockId: delivery.browserMockId,
          dispatchHandlerSyncMs: delivery.dispatchHandlerSyncMs,
        });
      }

      const finalMarker = currentExpectedFinalMarker;
      currentStreamPhase = "arming-stream-mutation-observer";
      const observerId = `active-md-${source}-${count}-${safeVariant}-burst-${streamSample}`;
      const armed = await page.evaluate(({ id, value }) => window.__phoneRenderArmMutation(id, value), { id: observerId, value: finalMarker });
      assert.equal(armed.observedRoot, true, "active Markdown stream observer must watch the Mobile transcript");

      const deltaFrames = [];
      const deltaMetadata = [];
      let burstDeltaBytes = 0;
      for (let chunkIndex = 0; chunkIndex < activeDeltaChunksPerStream; chunkIndex += 1) {
        const marker = `ACTIVE-MD-${source}-${count}-${safeVariant}-burst-${streamSample}-chunk-${chunkIndex + 1}`;
        const globalChunkIndex = (sampleOffset + streamIndex) * activeDeltaChunksPerStream + chunkIndex;
        const deltaText = makeLongMarkdownDelta(marker, globalChunkIndex);
        const deltaBytes = Buffer.byteLength(deltaText);
        burstDeltaBytes += deltaBytes;
        totalDeltaBytes += deltaBytes;
        deltaMetadata.push({ marker, deltaBytes, chunkIndex: chunkIndex + 1 });
        deltaFrames.push({
          jsonrpc: "2.0",
          method: "item/delta",
          params: {
            ...common,
            sequence: state.nextSequence++,
            itemId,
            delta: { text: deltaText },
          },
        });
      }
      const completionFrame = {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { ...common, sequence: state.nextSequence++, turn: { id: turnId, attemptId, threadId, status: "completed" } },
      };
      currentStreamPhase = "dispatching-stream-deltas-and-completion";
      if (captureCompleteProfile && profileSession && !profileStarted && !cpuProfileError) {
        try {
          // Clock bracketing and CDP setup are deliberately outside this profile window.
          profileStartClock = await captureCdpClockAnchor(profileSession, page);
          profileStartRequestedAtNodeMs = performance.now();
          await profileSession.send("Profiler.start");
          profileStartAcknowledgedAtNodeMs = performance.now();
          profileStartedAt = profileStartAcknowledgedAtNodeMs;
          profileStarted = true;
        } catch (error) {
          cpuProfileError = String(error.message || error).slice(0, 300);
          profileStarted = false;
        }
      }
      const delivery = await dispatchActiveStreamFrames(page, state, [...deltaFrames, completionFrame], finalMarker);
      assert.equal(delivery.delivered, activeDeltaChunksPerStream + 1, `all active Markdown chunks and their completion must reach the unique Mobile runtime socket: ${JSON.stringify(delivery)}`);
      profilePageBoundaries.firstDeltaDispatchAtPageTimeMs = delivery.firstDeltaDispatchAt;
      profilePageBoundaries.completionDispatchAtPageTimeMs = delivery.completionDispatchAt;
      let error = null;
      currentStreamPhase = "waiting-for-agent-row-and-two-raf";
      let result = null;
      try {
        if (captureCompleteProfile) {
          result = await page.evaluate(({ id, timeoutMs }) => window.__phoneRenderAwaitMutationResult(id, timeoutMs), {
            id: observerId,
            timeoutMs: 5_000,
          });
        } else {
          await page.waitForFunction((id) => Boolean(window.__phoneRenderMutationResult(id)), observerId, { timeout: 5_000 });
          result = await page.evaluate((id) => window.__phoneRenderMutationResult(id), observerId).catch(() => null);
        }
      } catch (caught) { error = caught; }
      if (captureCompleteProfile && profileStarted) {
        try {
          await stopProfileCapture();
        } catch (caught) {
          cpuProfileError = String(caught.message || caught).slice(0, 300);
        }
      }
      currentStreamPhase = "capturing-terminal-row";
      if (!captureCompleteProfile && !result) {
        result = await page.evaluate((id) => window.__phoneRenderMutationResult(id), observerId).catch(() => null);
      }
      profilePageBoundaries.agentRowMutationObservedAtPageTimeMs = result?.agentRevisionAt ?? null;
      profilePageBoundaries.twoAnimationFrameOpportunityAtPageTimeMs = result?.finishedAt ?? null;
      delivery.twoFrameOpportunityAt = result?.finishedAt ?? null;
      delivery.streamToTwoFrameOpportunityMs = result?.notificationDispatchToTwoFrameOpportunityMs ?? null;
      delivery.completionToTwoFrameOpportunityMs = Number.isFinite(result?.finishedAt)
        ? Number((result.finishedAt - delivery.completionDispatchAt).toFixed(3))
        : null;
      delivery.finalAssistantRow = await page.evaluate((marker) => {
        const rows = [...document.querySelectorAll('[data-testid="message-assistant"]')];
        const row = rows.find((element) => (element.textContent ?? "").includes(marker));
        const list = document.querySelector('[data-testid="message-list"]');
        return row ? {
          sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
          present: true,
          textLength: (row.textContent ?? "").length,
          finalMarkerPresent: (row.textContent ?? "").includes(marker),
          rowIntersectsMessageListAtAgentRevision: Boolean(list) && (() => {
            const rowRect = row.getBoundingClientRect();
            const listRect = list.getBoundingClientRect();
            return rowRect.width > 0 && rowRect.height > 0
              && rowRect.right > listRect.left && rowRect.left < listRect.right
              && rowRect.bottom > listRect.top && rowRect.top < listRect.bottom;
          })(),
          rowRect: (() => { const rect = row.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; })(),
          listRect: list ? (() => { const rect = list.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; })() : null,
          failureMarkerPresent: Boolean(row.querySelector('[data-testid="message-attempt-failure"]')),
          unknownMarkerPresent: Boolean(row.querySelector('[data-testid="message-attempt-unknown"]')),
          runtimeTerminalUi: !document.querySelector('[data-testid="stop-turn"]')
            && Boolean(document.querySelector('[data-testid="send-message"]'))
            && !Boolean(document.querySelector('[data-testid="queue-message"]')),
        } : { present: false, textLength: null, finalMarkerPresent: false };
      }, finalMarker).catch(() => ({ present: false, textLength: null, finalMarkerPresent: false }));
      profilePageBoundaries.rowGeometryValidationAtPageTimeMs = delivery.finalAssistantRow.sampledAtPageTimeMs ?? null;
      currentStreamPhase = "tail-following-final-marker";
      const finalMarkerVisibility = await scrollTranscriptToLatest(page, finalMarker, { requireMarkerVisible: true });
      profilePageBoundaries.tailValidationStartAtPageTimeMs = finalMarkerVisibility.before.sampledAtPageTimeMs ?? null;
      profilePageBoundaries.tailValidationEndAtPageTimeMs = finalMarkerVisibility.afterPageTimeMs ?? null;
      profilePageBoundaries.tailValidationAction = finalMarkerVisibility.action ?? null;
      delivery.finalMarkerVisibilityEvidence = {
        classification: "exact last-character DOM Range visibility after observed app-side layout/scroll movement or one real jump-to-latest touch, stable viewport samples, and two requestAnimationFrame opportunities",
        markerAlreadyVisibleBeforeTailFollow: finalMarkerVisibility.before.targetMarkerVisibleWithinMessageList,
        firstVisiblePoll: finalMarkerVisibility.firstTargetVisiblePoll,
        action: finalMarkerVisibility.action,
        pollCount: finalMarkerVisibility.pollCount,
        stableSamples: finalMarkerVisibility.stableSamples,
        startedAtPageTimeMs: finalMarkerVisibility.before.sampledAtPageTimeMs,
        completedAtPageTimeMs: finalMarkerVisibility.afterPageTimeMs,
        elapsedPageTimeMs: Number((finalMarkerVisibility.afterPageTimeMs - finalMarkerVisibility.before.sampledAtPageTimeMs).toFixed(3)),
        before: finalMarkerVisibility.before,
        afterTwoFrames: finalMarkerVisibility.after,
      };
      delivery.completionToFinalMarkerVisibleTwoFramesMs = Number((finalMarkerVisibility.afterPageTimeMs - delivery.completionDispatchAt).toFixed(3));
      delivery.finalAssistantRow.rowIntersectsMessageListAfterTailFollow = finalMarkerVisibility.after.targetVisibleWithinMessageList;
      delivery.finalAssistantRow.rowRectAfterTailFollow = finalMarkerVisibility.after.targetRowRect;
      delivery.finalAssistantRow.listRectAfterTailFollow = finalMarkerVisibility.after.messageListRect;
      delivery.finalAssistantRow.finalMarkerLastCharacterRect = finalMarkerVisibility.after.targetMarkerLastCharacterRect;
      delivery.finalAssistantRow.finalMarkerVisibleWithinMessageList = finalMarkerVisibility.after.targetMarkerVisibleWithinMessageList;
      delivery.finalAssistantRow.finalMarkerVisibleAfterTwoFrames = finalMarkerVisibility.afterTwoFrames === true;
      delivery.finalAssistantRow.tailFollowAction = finalMarkerVisibility.action;
      const longTasks = await page.evaluate((bounds) => window.__phoneRenderLongTasksBetween(bounds.start, bounds.end), {
        start: delivery.firstDeltaDispatchAt,
        end: delivery.twoFrameOpportunityAt,
      });
      const longAnimationFrames = await page.evaluate((bounds) => ({
        supported: window.__phoneRenderLongAnimationFrameSupport?.() === true,
        entries: window.__phoneRenderLongAnimationFramesBetween?.(bounds.start, bounds.end) ?? [],
      }), {
        start: delivery.firstDeltaDispatchAt,
        end: delivery.twoFrameOpportunityAt,
      });
      delivery.longAnimationFrames = longAnimationFrames;
      const observedFrames = [...setupResults, ...delivery.frameResults];
      const methods = observedFrames.map((frame) => frame.method);
      const sequences = observedFrames.map((frame) => frame.sequence);
      const expectedFrameCount = activeDeltaChunksPerStream + 3;
      const logicalMessageCountBeforeStream = count + (state.hiddenUpdateTurnsCompleted ?? 0) + streamIndex;
      const logicalMessageCountAfterStream = logicalMessageCountBeforeStream
        + (delivery.finalAssistantRow?.finalMarkerPresent === true ? 1 : 0);
      const dispatchOrderValid = observedFrames.length === expectedFrameCount
        && methods[0] === "turn/started"
        && methods[1] === "item/started"
        && methods.slice(2, -1).every((method) => method === "item/delta")
        && methods.at(-1) === "turn/completed"
        && observedFrames.every((frame) => frame.serverId === serverId && frame.threadId === threadId && frame.turnId === turnId)
        && sequences.every((sequence, index) => Number.isSafeInteger(sequence) && (index === 0 || sequence > sequences[index - 1]));
      const activeSocketIds = [...new Set(observedFrames.map((frame) => frame.browserMockId))];
      const deltaResults = delivery.frameResults.filter((frame) => frame.method === "item/delta");
      const completionResult = delivery.frameResults.find((frame) => frame.method === "turn/completed");
      const maximumDeltaHandlerSyncMs = deltaResults.length ? Math.max(...deltaResults.map((frame) => frame.dispatchHandlerSyncMs)) : null;
      const totalDeltaHandlerSyncMs = Number(deltaResults.reduce((sum, frame) => sum + frame.dispatchHandlerSyncMs, 0).toFixed(3));
      const maximumBrowserTaskWallMs = delivery.taskResults.length ? Math.max(...delivery.taskResults.map((task) => task.wallMs)) : null;
      const finalDeltaAndCompletionShareTask = delivery.taskResults.at(-1)?.frameMethods.join(",") === "item/delta,turn/completed";
      const finalFlushTimerWindowMs = 80;
      const finalFlushPendingAtCompletion = delivery.deltaBurstDispatchMs < finalFlushTimerWindowMs;
      currentStreamPhase = "validating-stream-success-gate";
      const streamOk = Boolean(result)
        && !error
        && dispatchOrderValid
        && activeSocketIds.length === 1
        && setupResults.every((frame) => frame.browserMockId === activeSocketIds[0])
        && delivery.browserMockId === activeSocketIds[0]
        && deltaResults.length === activeDeltaChunksPerStream
        && completionResult
        && finalDeltaAndCompletionShareTask
        && finalFlushPendingAtCompletion
        && result?.agentRevision?.fixtureMarkerPresent === true
        && delivery.finalAssistantRow?.finalMarkerPresent === true
        && delivery.finalAssistantRow?.finalMarkerVisibleWithinMessageList === true
        && delivery.finalAssistantRow?.finalMarkerVisibleAfterTwoFrames === true
        && delivery.finalAssistantRow?.runtimeTerminalUi === true
        && delivery.finalAssistantRow?.failureMarkerPresent === false
        && delivery.finalAssistantRow?.unknownMarkerPresent === false;
      currentStreamPhase = "recording-completed-stream-evidence";

      if (!diagnosticOnly) for (let chunkIndex = 0; chunkIndex < deltaResults.length; chunkIndex += 1) {
        const frame = deltaResults[chunkIndex];
        const metadata = deltaMetadata[chunkIndex];
        observations.push({
          source,
          requestedMessages: count,
          scenario: "active-markdown-delta-handler",
          panelState,
          sample: streamIndex * activeDeltaChunksPerStream + chunkIndex + 1,
          streamSample,
          chunkIndex: metadata.chunkIndex,
          durationMs: frame.dispatchHandlerSyncMs,
          synchronousEventTaskMs: frame.dispatchHandlerSyncMs,
          websocketDispatchHandlerSyncMs: [frame.dispatchHandlerSyncMs],
          deltaBytes: metadata.deltaBytes,
          cumulativeActiveMarkdownBytes: totalDeltaBytes - burstDeltaBytes + deltaMetadata.slice(0, chunkIndex + 1).reduce((sum, item) => sum + item.deltaBytes, 0),
          longTasks: [],
          ok: streamOk && frame.sequence === deltaFrames[chunkIndex].params.sequence,
          timingSource: "one item/delta MessageEvent handler on a separate MessageChannel browser task during a 30-delta active burst; handler sync time is a subsample and not a separate stream sample",
        });
      }

      if (!diagnosticOnly) observations.push({
        source,
        requestedMessages: count,
        scenario: "active-markdown-stream",
        panelState,
        sample: streamSample,
        deltaFrames: deltaResults.length,
        deltaBytes: burstDeltaBytes,
        totalActiveStreamBytes: totalDeltaBytes,
        deltaBurstDispatchMs: delivery.deltaBurstDispatchMs,
        finalFlushTimerWindowMs,
        finalFlushPendingAtCompletion,
        durationMs: result?.notificationDispatchToTwoFrameOpportunityMs ?? delivery.streamToTwoFrameOpportunityMs,
        notificationDispatchToAgentRevisionMs: result?.notificationDispatchToAgentRevisionMs ?? null,
        notificationDispatchToTwoFrameOpportunityMs: result?.notificationDispatchToTwoFrameOpportunityMs ?? null,
        websocketDispatchHandlerSyncMs: deltaResults.map((frame) => frame.dispatchHandlerSyncMs),
        totalDeltaHandlerSyncMs,
        maximumDeltaHandlerSyncMs,
        completionHandlerSyncMs: completionResult?.dispatchHandlerSyncMs ?? null,
        maximumBrowserTaskWallMs,
        agentRevision: result?.agentRevision ?? null,
        finalAssistantRow: delivery.finalAssistantRow,
        logicalMessageCountBeforeStream,
        logicalMessageCountAfterStream,
        transcriptViewportBeforeBurst,
        longTasks,
        longAnimationFrames,
        ok: streamOk,
        finalMarkerVisibilityEvidence: delivery.finalMarkerVisibilityEvidence,
        completionToFinalMarkerVisibleTwoFramesMs: delivery.completionToFinalMarkerVisibleTwoFramesMs,
        completionToAgentRevisionTwoFrameOpportunityMs: delivery.completionToTwoFrameOpportunityMs,
        timingSource: "one independent active turn with 30 long Markdown/table/code deltas on MessageChannel browser tasks; stream latency ends at Agent-row revision plus two requestAnimationFrame opportunities; exact final-marker last-character visibility after actual tail-follow is recorded separately, without Gateway transport or compositor timestamp",
        ...(error ? { error: String(error.message || error).slice(0, 300) } : {}),
      });
      const finalFlushDurationMs = delivery.completionToFinalMarkerVisibleTwoFramesMs;
      if (!diagnosticOnly) observations.push({
      source,
      requestedMessages: count,
      scenario: "active-markdown-final-flush",
      panelState,
      sample: streamSample,
      durationMs: finalFlushDurationMs,
      completionToFinalMarkerVisibleTwoFramesMs: finalFlushDurationMs,
      completionToAgentRevisionTwoFrameOpportunityMs: delivery.completionToTwoFrameOpportunityMs,
      websocketDispatchHandlerSyncMs: completionResult ? [completionResult.dispatchHandlerSyncMs] : [],
      synchronousEventTaskMs: completionResult?.dispatchHandlerSyncMs ?? null,
      finalAssistantRow: delivery.finalAssistantRow,
      finalMarkerVisibilityEvidence: delivery.finalMarkerVisibilityEvidence,
      finalMarker,
      finalFlushPendingAtCompletion,
      deltaBurstDispatchMs: delivery.deltaBurstDispatchMs,
      finalFlushTimerWindowMs,
      longTasks: [],
      ok: streamOk,
      timingSource: "terminal turn/completed synchronous handler after the final long delta in the same browser task; duration continues separately until the final marker's last-character DOM Range intersects the message-list viewport after actual tail-follow, stable viewport samples, and two requestAnimationFrame opportunities",
      });

      state.syntheticNotificationFramesSent = (state.syntheticNotificationFramesSent ?? 0) + setupFrames.length + delivery.delivered;
      bursts.push({
        streamSample,
        turnId,
        attemptId,
        itemId,
        deltaChunkCount: deltaResults.length,
        totalDeltaBytes: burstDeltaBytes,
        methods,
        sequences,
        serverId,
        threadId,
        browserMockIds: activeSocketIds,
        threadReadRequestId: state.activeThreadReadRequestId,
        setupFrames: setupResults,
        dispatchOrderValid,
        finalDeltaAndCompletionShareTask,
        deltaBurstDispatchMs: delivery.deltaBurstDispatchMs,
        finalFlushPendingAtCompletion,
        finalMarker,
        finalAssistantRow: delivery.finalAssistantRow,
        finalMarkerVisibilityEvidence: delivery.finalMarkerVisibilityEvidence,
        logicalMessageCountBeforeStream,
        logicalMessageCountAfterStream,
        transcriptViewportBeforeBurst,
        agentRevision: result?.agentRevision ?? null,
        streamToTwoFrameOpportunityMs: result?.notificationDispatchToTwoFrameOpportunityMs ?? delivery.streamToTwoFrameOpportunityMs,
        notificationDispatchToAgentRevisionMs: result?.notificationDispatchToAgentRevisionMs ?? null,
        completionToTwoFrameOpportunityMs: delivery.completionToTwoFrameOpportunityMs,
        completionToFinalMarkerVisibleTwoFramesMs: finalFlushDurationMs,
        completionToAgentRevisionTwoFrameOpportunityMs: delivery.completionToTwoFrameOpportunityMs,
        deltaHandlerSyncMs: deltaResults.map((frame) => frame.dispatchHandlerSyncMs),
        totalDeltaHandlerSyncMs,
        maximumDeltaHandlerSyncMs,
        completionHandlerSyncMs: completionResult?.dispatchHandlerSyncMs ?? null,
        maximumBrowserTaskWallMs,
        longTasks,
        longAnimationFrames,
        ok: streamOk,
      });
      if (streamOk) previousTailMarker = finalMarker;
      currentExpectedTailMarker = previousTailMarker;
      currentTranscriptViewportBeforeBurst = delivery.finalMarkerVisibilityEvidence?.afterTwoFrames ?? transcriptViewportBeforeBurst;
      currentStreamPhase = streamOk ? "completed-stream-gate-passed" : "completed-stream-gate-failed";
    }
    const allBurstsValid = bursts.length === samples && bursts.every((burst) => burst.ok && burst.dispatchOrderValid && burst.finalAssistantRow?.finalMarkerPresent === true && burst.finalAssistantRow?.finalMarkerVisibleWithinMessageList === true && burst.finalAssistantRow?.finalMarkerVisibleAfterTwoFrames === true && burst.finalAssistantRow?.runtimeTerminalUi === true && burst.finalAssistantRow?.failureMarkerPresent === false && burst.finalAssistantRow?.unknownMarkerPresent === false);
    state.activeStreamEvidence = {
      burstCount: bursts.length,
      deltaChunksPerBurst: activeDeltaChunksPerStream,
      deltaFrameCount: bursts.reduce((sum, burst) => sum + burst.deltaChunkCount, 0),
      totalDeltaBytes,
      activeAssistantTurnsAdded: bursts.filter((burst) => burst.ok).length,
      logicalMessageCountBeforeStreams: count + (state.hiddenUpdateTurnsCompleted ?? 0),
      expectedLogicalMessageCountAfterStreams: count + (state.hiddenUpdateTurnsCompleted ?? 0) + bursts.filter((burst) => burst.ok).length,
      bursts,
      serverId,
      threadId,
      threadReadRequestId: state.activeThreadReadRequestId,
      dispatchOrderValid: allBurstsValid,
      finalAssistantRow: bursts.at(-1)?.finalAssistantRow ?? null,
      finalFlushDurationMs: bursts.at(-1)?.completionToTwoFrameOpportunityMs ?? null,
      deltaSamplesSucceeded: diagnosticOnly
        ? bursts.reduce((total, burst) => total + (burst.ok ? burst.deltaChunkCount : 0), 0)
        : observations.filter((entry) => entry.scenario === "active-markdown-delta-handler" && entry.ok).length,
      deltaHandlerSampleCount: diagnosticOnly
        ? bursts.reduce((total, burst) => total + burst.deltaChunkCount, 0)
        : observations.filter((entry) => entry.scenario === "active-markdown-delta-handler").length,
      streamSampleCount: bursts.length,
    };
  } catch (error) {
    activeStreamError = attachActiveStreamFailureEvidence(error, currentStreamPhase);
  } finally {
    if (profileSession) {
      if (profileStarted && !profileStopAttempted) {
        try {
          await stopProfileCapture();
        } catch (error) {
          cpuProfileError = String(error.message || error).slice(0, 300);
        }
      }
      await profileSession.send("Profiler.disable").catch(() => {});
      await profileSession.detach().catch(() => {});
    }
  }
  if (rawCpuProfile) {
    try {
      const profileWindowScope = captureCompleteProfile
        ? "V8 Profiler starts after stream setup and immediately before the 30-delta/terminal-frame dispatch; it stops after the changed assistant-row text is observed and two animation-frame opportunities complete, before row geometry and tail-follow polling. The profile includes the app-facing mock dispatcher and bounded MutationObserver/two-RAF instrumentation; these timestamps mark observable task/mutation boundaries, not isolated React render cost, an internal React commit timestamp, or compositor presentation."
        : "V8 Profiler collection spans the broader diagnostic helper, including setup and visible-tail validation; it is not a render-duration measurement.";
      if (captureCompleteProfile) {
        rawCpuProfileArtifact = makeCompleteCpuProfileArtifact(rawCpuProfile, {
          source,
          requestedMessages: count,
          panelState,
          bundleSha256: options.bundleSha256,
          profileWindowScope,
          clockAlignment: null,
          profilePageBoundaries,
          profileControlNodeClock: {
            startRequestedAtPerformanceNowMs: profileStartRequestedAtNodeMs,
            startAcknowledgedAtPerformanceNowMs: profileStartAcknowledgedAtNodeMs,
            stopRequestedAtPerformanceNowMs: profileStopRequestedAtNodeMs,
            stopAcknowledgedAtPerformanceNowMs: profileStopAcknowledgedAtNodeMs,
            clockDomain: "Node process performance.now; not directly comparable with browser page timestamps",
          },
          externalValidation: bursts.at(-1)?.finalMarkerVisibilityEvidence ?? null,
          rowGeometryValidationAtPageTimeMs: profilePageBoundaries.rowGeometryValidationAtPageTimeMs,
        }, approvedScriptBaseUrl, [...approvedBundlePaths]);
      }
      cpuProfile = summarizeCpuProfile(rawCpuProfile, {
        source,
        requestedMessages: count,
        panelState,
        profileKind: options.profileKind ?? "separate diagnostic burst, excluded from core latency samples",
        profileWindowScope,
        diagnosticActiveMarkdownBursts: samples,
        deltaChunksPerStream: activeDeltaChunksPerStream,
        profilerSamplingIntervalUs: 500,
        profileWallTimeMs: Number(((captureCompleteProfile && Number.isFinite(profileStopAcknowledgedAtNodeMs)
          ? profileStopAcknowledgedAtNodeMs
          : performance.now()) - profileStartedAt).toFixed(3)),
        profileWallTimeInterpretation: captureCompleteProfile
          ? "Node CDP start-to-stop control interval; V8 profile startTime/endTime are the browser profiler interval; neither is a pure render duration"
          : "Node time from Profiler start until broad diagnostic summary; includes helper and external validation time",
        profileControlNodeClock: {
          startRequestedAtPerformanceNowMs: profileStartRequestedAtNodeMs,
          startAcknowledgedAtPerformanceNowMs: profileStartAcknowledgedAtNodeMs,
          stopRequestedAtPerformanceNowMs: profileStopRequestedAtNodeMs,
          stopAcknowledgedAtPerformanceNowMs: profileStopAcknowledgedAtNodeMs,
          clockDomain: "Node process performance.now; not directly comparable with browser page timestamps",
        },
      }, { start: profileStartClock, end: profileEndClock }, bursts.flatMap((burst) => burst.longTasks ?? []), approvedScriptBaseUrl);
      if (captureCompleteProfile) {
        rawCpuProfileArtifact.timestamps.pageClockAlignment = cpuProfile.clockAlignment;
        rawCpuProfileArtifact.timestamps.profileWindowBoundaryValidation = validateProfileWindowBoundaries({
          browserBurstEvents: rawCpuProfileArtifact.timestamps.browserBurstEvents,
          profileWindowPageTimeMs: cpuProfile.clockAlignment.profileWindowPageTimeMs,
          clockAlignmentStatus: cpuProfile.clockAlignment.status,
        });
        delete rawCpuProfileArtifact.serializedUtf8Bytes;
        const serializedBytes = Buffer.byteLength(JSON.stringify(rawCpuProfileArtifact));
        assert.ok(serializedBytes <= 64 * 1024 * 1024, "complete sanitized V8 profile exceeds the 64 MiB diagnostic artifact limit");
        rawCpuProfileArtifact.serializedUtf8Bytes = serializedBytes;
      }
    } catch (error) {
      cpuProfileError = String(error.message || error).slice(0, 300);
    }
  }
  if (cpuProfileError) state.activeStreamEvidence = { ...state.activeStreamEvidence, cpuProfileError };
  if (activeStreamError) {
    if (rawCpuProfileArtifact) activeStreamError.rawCpuProfileArtifact = rawCpuProfileArtifact;
    throw activeStreamError;
  }
  return { observations, cpuProfile, rawCpuProfileArtifact, evidence: state.activeStreamEvidence };
}

async function dispatchActiveFrame(page, state, frame, options = {}) {
  const result = await page.evaluate((payload) => window.__phoneRenderDispatchFrameInTask(payload), {
    frame,
    server: serverId,
    channel: "runtime",
    workspace: state.workspacePath,
    threadId,
    threadReadId: state.activeThreadReadRequestId,
    ...options,
  });
  return result;
}

async function dispatchActiveStreamFrames(page, state, frames, finalMarker) {
  return page.evaluate((payload) => window.__phoneRenderDispatchActiveStreamInTasks(payload), {
    frames,
    finalMarker,
    server: serverId,
    channel: "runtime",
    workspace: state.workspacePath,
    threadId,
    threadReadId: state.activeThreadReadRequestId,
  });
}

function makeLongMarkdownDelta(marker, index) {
  const paragraph = "The active transcript streams deterministic Markdown text while the Mobile UI parses and lays out a changing assistant message. ".repeat(4);
  const code = Array.from({ length: 12 }, (_, line) => `export const stream_${index}_${line} = (value: number) => value + ${line};`).join("\n");
  return [
    `\n\n### Live Markdown chunk ${index + 1}\n`,
    paragraph,
    `\n\n| chunk | state | notes |\n| --- | --- | --- |\n| ${index + 1} | streaming | ${marker} |\n`,
    "\n```typescript\n",
    code,
    "\n```\n\n",
    `${marker}\n`,
  ].join("");
}

async function measureSnapshotUpdates(page, state, source, count, panelState, samples, context) {
  const output = [];
  let currentSample = null;
  let currentMarker = null;
  let currentExpectedTailMarker = null;
  let currentViewportBeforeUpdate = null;
  try {
    for (let index = 0; index < samples; index += 1) {
      currentSample = index + 1;
      currentMarker = null;
      currentExpectedTailMarker = null;
      currentViewportBeforeUpdate = null;
      const variant = panelState === "mounted-hidden" ? "mounted" : "unmounted";
      const expectedTailMarker = index === 0
        ? `seed-${source}-${count}-${panelState}`
        : `UX-${source}-${count}-${variant}-${index - 1}`;
      currentExpectedTailMarker = expectedTailMarker;
      currentViewportBeforeUpdate = await scrollTranscriptToLatest(page, expectedTailMarker);
      const transcriptViewportBeforeUpdate = currentViewportBeforeUpdate;
      const marker = `UX-${source}-${count}-${variant}-${index}`;
      currentMarker = marker;
      const id = `changes-${source}-${count}-${variant}-${index}`;
      const mutationObserverArmed = await page.evaluate(({ value, markerValue }) => window.__phoneRenderArmMutation(value, markerValue), { value: id, markerValue: marker });
      assert.equal(mutationObserverArmed.observedRoot, true, `${panelState} Agent content revision observer must be attached`);
      assert.equal(mutationObserverArmed.primaryBoundary, "changed assistant-row text under Mobile message-list followed by two requestAnimationFrame callbacks");
      const startedAt = performance.now();
      let error = null;
      let delivery = null;
      try {
        assert.ok(state.activeSocketRoute, "isolated Mobile runtime route must have completed the fixture thread/read before snapshot injection");
        delivery = await emitSyntheticTaskSnapshot(page, state, marker, {
          artifactId: id,
          workspacePath: state.workspacePath,
          fileCount: 16,
          additions: 160 + index,
          deletions: 24 + index,
          files: [`${state.workspacePath}/src/${marker}-fixture.ts`, ...Array.from({ length: 15 }, (_, fileIndex) => `${state.workspacePath}/src/fixture-${index}-${fileIndex}.ts`)],
          status: "active",
          revertible: true,
        });
        await page.waitForFunction((value) => Boolean(window.__phoneRenderMutationResult(value)), id, { timeout: 5_000 });
      } catch (caught) { error = caught; }
      const result = await page.evaluate((value) => window.__phoneRenderMutationResult(value), id).catch(() => null);
      const longTasks = result ? await collectLongTasks(page, result) : [];
      output.push({
        source,
        requestedMessages: count,
        scenario: `hidden-changes-update-${panelState}`,
        panelState,
        sample: index + 1,
        marker,
        transcriptViewportBeforeUpdate,
        durationMs: result?.durationMs ?? null,
        fixtureHarnessElapsedToAgentRevisionMs: result ? Number((performance.now() - startedAt).toFixed(3)) : null,
        armToNotificationDispatchMs: result?.armToNotificationDispatchMs ?? null,
        notificationDispatchToAgentRevisionMs: result?.notificationDispatchToAgentRevisionMs ?? null,
        notificationDispatchToTwoFrameOpportunityMs: result?.notificationDispatchToTwoFrameOpportunityMs ?? null,
        agentRevision: result?.agentRevision ?? null,
        changesFilenameMarkerObserved: result?.changesFilenameMarkerObserved ?? false,
        changesFilenameMarkerAt: result?.changesFilenameMarkerAt ?? null,
        mutationObserverCallbackMs: result?.mutationObserverCallbackMs ?? null,
        synchronousEventTaskMs: result?.synchronousEventTaskMs ?? null,
        websocketDispatchMethods: delivery?.dispatchMethods ?? [],
        websocketDispatchHandlerSyncMs: delivery?.dispatchTaskDurationsMs ?? [],
        websocketDispatchHandlerSyncMaxMs: delivery?.maximumDispatchTaskMs ?? null,
        syntheticNotificationFramesDispatchedToAppMock: delivery?.delivered ?? 0,
        longTasks,
        ok: Boolean(result) && !error,
        timingSource: "test-side synthetic Mobile runtime WebSocket notifications through changed Agent assistant-row content to two requestAnimationFrame presentation opportunities; the mounted-hidden Changes filename is a supplemental observation only; excludes Gateway network transport",
        ...(error ? { error: String(error.message || error).slice(0, 400) } : {}),
      });
      currentSample = null;
      currentMarker = null;
      currentExpectedTailMarker = null;
      currentViewportBeforeUpdate = null;
    }
  } catch (error) {
    await context.writeArtifactJson(`phone-render-profile-failure-${source}-${count}-${panelState}.json`, {
      schemaVersion: 1,
      failureStage: "hidden-update-loop",
      source,
      requestedMessages: count,
      panelState,
      expectedUpdateCount: samples,
      completedUpdateResultCount: output.length,
      currentSample,
      currentMarker,
      currentExpectedTailMarker,
      currentViewportBeforeUpdate,
      helperViewport: error?.transcriptViewport ?? error?.cause?.transcriptViewport ?? null,
      hiddenUpdateResults: output,
      error: {
        name: error?.name ?? "Error",
        message: String(error?.message || error).slice(0, 2000),
        stack: typeof error?.stack === "string" ? error.stack.slice(0, 8000) : null,
      },
    });
    throw error;
  }
  return output;
}

async function captureCdpClockAnchor(session, page) {
  const pageBeforeMs = await page.evaluate(() => performance.now());
  const metrics = await session.send("Performance.getMetrics");
  const pageAfterMs = await page.evaluate(() => performance.now());
  const timestampSeconds = metrics.metrics?.find((metric) => metric.name === "Timestamp")?.value;
  const pageMidpointMs = (pageBeforeMs + pageAfterMs) / 2;
  const cdpTimestampMs = Number.isFinite(timestampSeconds) ? timestampSeconds * 1000 : null;
  return {
    pageBeforeMs: Number(pageBeforeMs.toFixed(3)),
    pageAfterMs: Number(pageAfterMs.toFixed(3)),
    pageMidpointMs: Number(pageMidpointMs.toFixed(3)),
    bracketWidthMs: Number((pageAfterMs - pageBeforeMs).toFixed(3)),
    cdpTimestampMs: Number.isFinite(cdpTimestampMs) ? Number(cdpTimestampMs.toFixed(3)) : null,
    cdpMinusPageMidpointMs: Number.isFinite(cdpTimestampMs) ? Number((cdpTimestampMs - pageMidpointMs).toFixed(3)) : null,
  };
}

function summarizeCpuProfile(profile, metadata, clockAnchors, longTasks, approvedScriptBaseUrl = null) {
  const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node]));
  const parentById = new Map();
  for (const node of nodes.values()) {
    for (const childId of node.children ?? []) {
      if (!parentById.has(childId)) parentById.set(childId, node.id);
    }
  }
  const durations = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let sampledMicros = 0;
  const sampleRecords = [];
  const stackFor = (nodeId) => {
    const stack = [];
    const seen = new Set();
    let currentId = nodeId;
    while (currentId !== undefined && !seen.has(currentId) && stack.length < 24) {
      seen.add(currentId);
      const node = nodes.get(currentId);
      if (!node) break;
      const frame = node.callFrame ?? {};
      const scriptUrlIdentity = recordScriptUrlIdentity(frame.url, approvedScriptBaseUrl);
      stack.push({
        functionName: frame.functionName || "(anonymous)",
        scriptPath: safePath(frame.url),
        scriptUrlIdentity,
        lineNumber: frame.lineNumber ?? null,
        columnNumber: frame.columnNumber ?? null,
      });
      currentId = parentById.get(currentId);
    }
    return stack;
  };
  let elapsedMicros = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const micros = Number(deltas[index] ?? 0);
    sampledMicros += micros;
    elapsedMicros += micros;
    const node = nodes.get(samples[index]);
    if (!node) continue;
    const frame = node.callFrame ?? {};
    const scriptUrlIdentity = recordScriptUrlIdentity(frame.url, approvedScriptBaseUrl);
    const key = `${frame.functionName || "(anonymous)"}|${JSON.stringify(scriptUrlIdentity)}|${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0}`;
    const current = durations.get(key) ?? {
      functionName: frame.functionName || "(anonymous)",
      scriptPath: safePath(frame.url),
      scriptUrlIdentity,
      lineNumber: frame.lineNumber ?? null,
      columnNumber: frame.columnNumber ?? null,
      selfSampledMs: 0,
      samples: 0,
    };
    current.selfSampledMs += micros / 1000;
    current.samples += 1;
    durations.set(key, current);
    sampleRecords.push({
      profileTimeUs: profile.startTime + elapsedMicros,
      pageTimeMs: null,
      sampleWeightMs: micros / 1000,
      stack: stackFor(samples[index]),
    });
  }
  const startAnchor = clockAnchors?.start;
  const endAnchor = clockAnchors?.end;
  const offsetMs = Number.isFinite(startAnchor?.cdpMinusPageMidpointMs) && Number.isFinite(endAnchor?.cdpMinusPageMidpointMs)
    ? (startAnchor.cdpMinusPageMidpointMs + endAnchor.cdpMinusPageMidpointMs) / 2
    : null;
  const clockDriftMs = Number.isFinite(offsetMs)
    ? Number((endAnchor.cdpMinusPageMidpointMs - startAnchor.cdpMinusPageMidpointMs).toFixed(3))
    : null;
  const clockAlignmentValid = Number.isFinite(offsetMs)
    && Number.isFinite(clockDriftMs)
    && Math.abs(clockDriftMs) <= 10
    && (startAnchor.bracketWidthMs ?? Infinity) <= 10
    && (endAnchor.bracketWidthMs ?? Infinity) <= 10;
  // The CDP Profile uses monotonic microseconds; page long-task timestamps use
  // performance.now(). Only correlate them when the bracketing clock checks agree.
  if (clockAlignmentValid) {
    for (const sample of sampleRecords) sample.pageTimeMs = Number((sample.profileTimeUs / 1000 - offsetMs).toFixed(3));
  }
  const longTaskStackAttribution = (longTasks ?? []).map((task) => {
    if (!clockAlignmentValid) return { longTask: task, status: "UNVERIFIED_CLOCK_ALIGNMENT", sampleCount: 0, sampledMs: 0, topStacks: [] };
    const taskEndMs = task.startTimeMs + task.durationMs;
    const taskSamples = sampleRecords.filter((sample) => sample.pageTimeMs >= task.startTimeMs && sample.pageTimeMs <= taskEndMs);
    const stacks = new Map();
    for (const sample of taskSamples) {
      const key = JSON.stringify(sample.stack);
      const current = stacks.get(key) ?? { stack: sample.stack, sampleCount: 0, sampledMs: 0 };
      current.sampleCount += 1;
      current.sampledMs += sample.sampleWeightMs;
      stacks.set(key, current);
    }
    return {
      longTask: task,
      status: taskSamples.length > 0 ? "PROFILE_SAMPLES_OVERLAP" : "NO_PROFILE_SAMPLES_IN_INTERVAL",
      sampleCount: taskSamples.length,
      sampledMs: Number(taskSamples.reduce((sum, sample) => sum + sample.sampleWeightMs, 0).toFixed(3)),
      topStacks: [...stacks.values()].map((item) => ({ ...item, sampledMs: Number(item.sampledMs.toFixed(3)) })).sort((left, right) => right.sampledMs - left.sampledMs).slice(0, 12),
    };
  });
  return {
    ...metadata,
    profilerSamplingIntervalUs: 500,
    sampleCount: samples.length,
    totalSampledMs: Number((sampledMicros / 1000).toFixed(3)),
    topFunctions: [...durations.values()].map((item) => ({ ...item, selfSampledMs: Number(item.selfSampledMs.toFixed(3)) })).sort((left, right) => right.selfSampledMs - left.selfSampledMs).slice(0, 40),
    profileWindow: { startTimeUs: profile.startTime, endTimeUs: profile.endTime },
    clockAlignment: {
      method: "CDP Performance.getMetrics Timestamp bracketing page performance.now, compared at profile start and stop",
      timeOffsetMs: Number.isFinite(offsetMs) ? Number(offsetMs.toFixed(3)) : null,
      driftMs: clockDriftMs,
      startAnchor,
      endAnchor,
      status: clockAlignmentValid ? "ALIGNED_WITHIN_10MS" : "UNVERIFIED",
      profileWindowPageTimeMs: clockAlignmentValid ? {
        start: Number((profile.startTime / 1000 - offsetMs).toFixed(3)),
        end: Number((profile.endTime / 1000 - offsetMs).toFixed(3)),
      } : null,
    },
    longTaskStackAttribution,
  };
}

async function mapCpuProfileWithSourceMaps(profile, bundleRoot, sourceMapEvidence, expectedBundleSha256, sourceSpec, trustedMountPath) {
  assert.ok(sourceMapEvidence?.enabled === true, "core attribution requires enabled source-map evidence");
  assert.equal(sourceMapEvidence.bundleSha256, expectedBundleSha256, "source maps must bind to the exact profile input bundle");
  assert.ok(trustedMountPath, "core attribution requires the exact trusted Mobile mount path");
  const mobileRequire = createRequire(resolve(repoRoot, "apps/kcoder-studio/mobile/package.json"));
  const traceMapping = mobileRequire("@jridgewell/trace-mapping");
  const traceMaps = new Map();
  const getMapForFrame = async (frame) => {
    const binding = resolveScriptMapBinding(frame?.scriptUrlIdentity, sourceMapEvidence.mapFiles.map((entry) => entry.path), { trustedMountPath });
    if (binding.status !== "EXACT_BUNDLE_PATH_MATCH") return { binding, selectedMap: null };
    const { mapPath, generatedPath } = binding;
    if (!traceMaps.has(mapPath)) {
      const mapEntry = sourceMapEvidence.mapFiles.find((entry) => entry.path === mapPath);
      const mapBytes = await readVerifiedMobileExportFile(bundleRoot, mapEntry, "core attribution source map");
      const mapJson = JSON.parse(mapBytes.toString("utf8"));
      assert.equal(mapJson.version, 3, `source map ${mapPath} must use version 3`);
      traceMaps.set(mapPath, {
        generatedPath,
        mapJson,
        traceMap: new traceMapping.TraceMap(mapJson, mapPath),
      });
    }
    return { binding, selectedMap: traceMaps.get(mapPath) };
  };
  const mapFrame = async (frame) => {
    const { binding, selectedMap } = await getMapForFrame(frame);
    const generatedPosition = {
      scriptPath: frame?.scriptPath ?? null,
      scriptUrlIdentity: frame?.scriptUrlIdentity ?? null,
      lineNumber: frame?.lineNumber ?? null,
      columnNumber: frame?.columnNumber ?? null,
    };
    if (!selectedMap) return { ...generatedPosition, sourceMapStatus: binding.status, originalPosition: null };
    return {
      ...generatedPosition,
      sourceMapPath: [...traceMaps.entries()].find(([, value]) => value === selectedMap)?.[0] ?? null,
      sourceMapStatus: binding.status,
      sourceMapMountNormalization: binding.mountNormalization ?? "EXACT_BUNDLE_PATH_MATCH",
      originalPosition: mapGeneratedProfilePosition(selectedMap.traceMap, frame, traceMapping, {
        sourceRoots: sourceSpec?.candidateSourceInventory?.sourceRoots,
        candidateSourceFiles: sourceSpec?.candidateSourceInventory?.files,
        sourceMapSources: selectedMap.mapJson.sources,
        sourcesContent: selectedMap.mapJson.sourcesContent,
      }),
    };
  };

  const mappedTopFunctions = [];
  for (const frame of profile.topFunctions ?? []) {
    mappedTopFunctions.push({ ...frame, originalPosition: await mapFrame(frame) });
  }
  const mappedLongTaskAttribution = [];
  for (const task of profile.longTaskStackAttribution ?? []) {
    const topStacks = [];
    for (const stack of task.topStacks ?? []) {
      const frames = [];
      for (const frame of stack.stack ?? []) frames.push({ ...frame, originalPosition: await mapFrame(frame) });
      topStacks.push({ ...stack, stack: frames });
    }
    mappedLongTaskAttribution.push({ ...task, topStacks });
  }
  const mappedFrameCount = mappedTopFunctions.reduce((count, frame) =>
    count + (frame.originalPosition.originalPosition?.status === "MAPPED" ? 1 : 0), 0)
    + mappedLongTaskAttribution.flatMap((task) => task.topStacks).flatMap((stack) => stack.stack)
      .filter((frame) => frame.originalPosition.originalPosition?.status === "MAPPED").length;
  const allMappedFrames = [
    ...mappedTopFunctions.map((frame) => frame.originalPosition),
    ...mappedLongTaskAttribution.flatMap((task) => task.topStacks).flatMap((stack) => stack.stack.map((frame) => frame.originalPosition)),
  ];
  const pinnedMobileFrameCount = allMappedFrames.filter((frame) => frame.originalPosition?.originalPosition?.sourcePathStatus === "PINNED_METRO_SOURCE"
    && frame.originalPosition?.originalPosition?.source?.startsWith("apps/kcoder-studio/mobile/")).length;
  const pinnedSharedFrameCount = allMappedFrames.filter((frame) => frame.originalPosition?.originalPosition?.sourcePathStatus === "PINNED_METRO_SOURCE"
    && frame.originalPosition?.originalPosition?.source?.startsWith("apps/kcoder-studio/shared/")).length;
  const dependencyFrameCount = allMappedFrames.filter((frame) => frame.originalPosition?.originalPosition?.sourcePathStatus === "RELATIVE_SOURCE"
    && /(^|\/)node_modules\//.test(frame.originalPosition?.originalPosition?.source ?? "")).length;
  const sourcePathStatusCounts = {};
  for (const frame of allMappedFrames) {
    const status = frame.originalPosition?.originalPosition?.sourcePathStatus ?? frame.originalPosition?.originalPosition?.status ?? "UNAVAILABLE";
    sourcePathStatusCounts[status] = (sourcePathStatusCounts[status] ?? 0) + 1;
  }
  return {
    bundleSha256: sourceMapEvidence.bundleSha256,
    sourceMapEvidenceDigest: sha256(Buffer.from(JSON.stringify(sourceMapEvidence))),
    mapFiles: sourceMapEvidence.mapFiles,
    mappedFrameCount,
    pinnedMobileFrameCount,
    pinnedSharedFrameCount,
    dependencyFrameCount,
    sourcePathStatusCounts,
    unmappedFrameCount: mappedTopFunctions.length
      + mappedLongTaskAttribution.flatMap((task) => task.topStacks).reduce((count, stack) => count + stack.stack.length, 0)
      - mappedFrameCount,
    mappedTopFunctions,
    mappedLongTaskAttribution,
  };
}

async function sendSyntheticSnapshot(page, state, marker, sequence, measure, options = {}) {
  const id = `seed-${marker}`;
  const runtimeProbe = runtimeConsumerDiagnostic && !measure
    ? { configuration: null, reads: [] }
    : null;
  if (measure) await page.evaluate(({ value, markerValue }) => window.__phoneRenderArmMutation(value, markerValue), { value: id, markerValue: marker });
  assert.ok(state.activeSocketRoute, "isolated Mobile runtime route must have completed the fixture thread/read before fixture seed");
  let traceActive = false;
  if (!measure && captureSeedUiDomTrace) {
    await page.evaluate(beginSeedUiTraceInPage, { marker });
    state.seedUiTraceActive = true;
    traceActive = true;
  }
  if (!measure) state.seedDispatchCaptureActive = true;
  let delivery = null;
  if (!measure) {
    let failurePhase = "seed-notification-dispatch";
    try {
      if (runtimeProbe) {
        runtimeProbe.configuration = await configureRuntimeConsumerProbe(page, marker);
      }
      delivery = await emitSyntheticTaskSnapshot(page, state, marker, { artifactId: id, workspacePath: state.workspacePath, fileCount: 16, additions: 160, deletions: 24, files: Array.from({ length: 16 }, (_, index) => `${state.workspacePath}/seed-${index}.ts`), status: "active", revertible: true });
      if (runtimeProbe) runtimeProbe.reads.push(await readRuntimeConsumerProbe(page, runtimeProbe, "after-four-frame-app-mock-dispatch"));
      const seedDispatch = state.lastSeedDispatchEvidence ?? summarizeSeedDispatchEvidence(state, marker, delivery);
      failurePhase = "seed-visible-tail-settlement";
      const transcriptViewport = options.deferTailGate === true
        ? null
        : await scrollTranscriptToLatest(page, marker, {
            requireMarkerVisible: true,
            captureVirtualizedGeometry: runtimeConsumerDiagnostic,
          });
      if (runtimeProbe) runtimeProbe.reads.push(await readRuntimeConsumerProbe(page, runtimeProbe, "after-existing-seed-marker-visibility-and-geometry-gate"));
      const seedUiTrace = traceActive ? await page.evaluate(endSeedUiTraceInPage) : null;
      state.seedUiTraceActive = false;
      traceActive = false;
      state.seedDispatchCaptureActive = false;
      return { ok: true, measured: false, transcriptViewport, seedDispatch, seedUiTrace, runtimeProbe };
    } catch (cause) {
      if (runtimeProbe?.configuration?.status === "CONFIGURED" && runtimeProbe.reads.length < 2) {
        runtimeProbe.reads.push(await readRuntimeConsumerProbe(page, runtimeProbe, "after-seed-gate-failure-without-extra-wait"));
      }
      const diagnosticDom = await captureSeedFailureDom(page, state, marker).catch((diagnosticError) => ({
        captureError: safeSeedErrorMessage(diagnosticError),
      }));
      const seedUiTrace = traceActive ? await page.evaluate(endSeedUiTraceInPage).catch((traceError) => ({
        captureError: safeSeedErrorMessage(traceError),
      })) : null;
      state.seedUiTraceActive = false;
      traceActive = false;
      state.seedDispatchCaptureActive = false;
      const error = new Error(`seed delivery or visible-tail gate failed for ${state.source}/${state.count}/${state.panelState}`);
      error.seedFailureEvidence = {
        failurePhase,
        seedDispatch: state.lastSeedDispatchEvidence ?? summarizeSeedDispatchEvidence(state, marker, delivery),
        transcriptViewport: summarizeSeedTranscriptViewport(cause?.transcriptViewport ?? null),
        diagnosticDom,
        seedUiTrace,
        runtimeProbe,
        error: {
          name: cause?.name ?? "Error",
          message: safeSeedErrorMessage(cause),
          stack: safeSeedErrorStack(cause),
        },
      };
      throw error;
    } finally {
      state.seedDispatchCaptureActive = false;
      if (traceActive) {
        await page.evaluate(endSeedUiTraceInPage).catch(() => null);
        state.seedUiTraceActive = false;
      }
    }
  }
  delivery = await emitSyntheticTaskSnapshot(page, state, marker, { artifactId: id, workspacePath: state.workspacePath, fileCount: 16, additions: 160, deletions: 24, files: Array.from({ length: 16 }, (_, index) => `${state.workspacePath}/seed-${index}.ts`), status: "active", revertible: true });
  await page.waitForFunction((value) => Boolean(window.__phoneRenderMutationResult(value)), id, { timeout: 5_000 });
  return { ok: true, measured: true, delivery };
}

async function readRuntimeConsumerProbe(page, runtimeProbe, stage) {
  if (runtimeProbe?.configuration?.status !== "CONFIGURED") {
    return {
      stage: String(stage).slice(0, 64),
      status: "NOT_RUN_CONFIGURATION_UNAVAILABLE",
      configurationStatus: String(runtimeProbe?.configuration?.status ?? "PROBE_NOT_CONFIGURED").slice(0, 48),
      records: [],
    };
  }
  return drainRuntimeConsumerProbe(page, stage);
}

async function drainRuntimeConsumerProbe(page, stage) {
  try {
    return await page.evaluate((stageName) => {
    const probe = window.__phoneRuntimeProbe;
    if (!probe || typeof probe.drain !== "function") {
      return { stage: stageName, status: "PROBE_GLOBAL_UNAVAILABLE", records: [] };
    }
    let value;
    try { value = probe.drain(); }
    catch { return { stage: stageName, status: "PROBE_DRAIN_FAILED", records: [] }; }
    const asInt = (input) => Number.isSafeInteger(input) && input >= 0 ? input : null;
    const asText = (input, max = 48) => typeof input === "string" ? input.slice(0, max) : null;
    const asBoolean = (input) => typeof input === "boolean" ? input : null;
    const normalizeProjection = (input) => {
      if (!input || typeof input !== "object") return null;
      return {
        messageCount: asInt(input.messageCount),
        assistantMatchCount: asInt(input.assistantMatchCount),
        lastAssistantMessageIdFingerprint: asText(input.lastAssistantMessageIdFingerprint, 16),
        lastAssistantAttemptFingerprint: asText(input.lastAssistantAttemptFingerprint, 16),
        lastAssistantStatus: asText(input.lastAssistantStatus, 32),
        contentMarkerPresent: asBoolean(input.contentMarkerPresent),
        orderedTextMarkerPresent: asBoolean(input.orderedTextMarkerPresent),
        renderedTextMarkerPresent: asBoolean(input.renderedTextMarkerPresent),
        orderedTextBlockCount: asInt(input.orderedTextBlockCount),
        contentLength: asInt(input.contentLength),
        orderedTextLength: asInt(input.orderedTextLength),
        running: asBoolean(input.running),
        connected: asBoolean(input.connected),
        disposed: asBoolean(input.disposed),
      };
    };
    const normalizeLegacySnapshot = (input) => {
      if (!input || typeof input !== "object") return null;
      return {
        messageCount: asInt(input.messageCount),
        assistantMatchCount: asInt(input.assistantMatchCount),
        contentLength: asInt(input.contentLength),
        markerPresent: asBoolean(input.markerPresent),
        status: asText(input.status, 32),
        running: asBoolean(input.running),
        connected: asBoolean(input.connected),
        disposed: asBoolean(input.disposed),
      };
    };
    const sourceRecords = Array.isArray(value?.records) ? value.records : [];
    const records = sourceRecords.slice(0, 64).map((row) => {
      const legacySnapshot = normalizeLegacySnapshot(row?.snapshot);
      return {
        ordinal: asInt(row?.ordinal),
        kind: asText(row?.kind, 32),
        runtimeInstanceOrdinal: asInt(row?.runtimeInstanceOrdinal),
        threadFingerprint: asText(row?.threadFingerprint, 16),
        turnFingerprint: asText(row?.turnFingerprint, 16),
        itemFingerprint: asText(row?.itemFingerprint, 16),
        rpcMethod: asText(row?.rpcMethod, 40),
        arrivalOrdinal: asInt(row?.arrivalOrdinal),
        projection: normalizeProjection(row?.projection),
        runtimeProjectionAtEffect: normalizeProjection(row?.runtimeProjectionAtEffect),
        panelSnapshotSameAsRuntimeAtEffect: asBoolean(row?.panelSnapshotSameAsRuntimeAtEffect),
        legacySnapshot,
        snapshot: legacySnapshot,
      };
    });
    return {
      stage: stageName,
      status: value?.schemaVersion === 1 && value?.limit === 64 && Array.isArray(value?.records) ? "CAPTURED" : "INVALID_PROBE_ENVELOPE",
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      schemaVersion: value?.schemaVersion === 1 ? 1 : null,
      limit: value?.limit === 64 ? 64 : null,
      dropped: asInt(value?.dropped),
      sourceRecordCount: sourceRecords.length,
      harnessTruncated: sourceRecords.length > 64,
      records,
    };
    }, String(stage).slice(0, 64));
  } catch (error) {
    return {
      stage: String(stage).slice(0, 64),
      status: "PROBE_PAGE_READ_FAILED",
      sampledAtPageTimeMs: null,
      schemaVersion: null,
      limit: null,
      dropped: null,
      sourceRecordCount: null,
      harnessTruncated: false,
      records: [],
      readError: safeSeedErrorMessage(error),
    };
  }
}

function buildRuntimeConsumerSeedDiagnostic(source, state, seed, mobileWeb) {
  const probe = seed.runtimeProbe ?? { configuration: null, reads: [] };
  const reads = Array.isArray(probe.reads) ? probe.reads.slice(0, 2) : [];
  const records = reads.flatMap((read) => Array.isArray(read.records) ? read.records : []).slice(0, 128);
  const identity = probe.configuration?.identity ?? {};
  const fingerprint = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  const legacyRpcEnterMethods = records.filter((record) => record.kind === "rpc-enter").map((record) => record.rpcMethod);
  const legacyAcceptedMethods = records.filter((record) => record.kind === "protocol-accepted").map((record) => record.rpcMethod);
  const legacyRpcReturnMethods = records.filter((record) => record.kind === "rpc-return").map((record) => record.rpcMethod);
  const legacySnapshots = records.filter((record) => record.kind === "snapshot" && record.legacySnapshot);
  const runtimeSnapshots = records.filter((record) => record.kind === "runtime-snapshot");
  const runtimeRegistrations = records.filter((record) => record.kind === "runtime-registered");
  const panelCommits = records.filter((record) => record.kind === "panel-projection-commit");
  const projectionRecords = [...runtimeSnapshots, ...runtimeRegistrations, ...panelCommits];
  const markerValue = (projection, fields) => {
    const values = fields.map((field) => projection?.[field]).filter((value) => typeof value === "boolean");
    if (values.some((value) => value === true)) return true;
    if (values.length === fields.length) return false;
    return null;
  };
  const combineBoolean = (values) => {
    const known = values.filter((value) => typeof value === "boolean");
    if (known.some((value) => value === true)) return true;
    if (known.length === values.length && known.length > 0) return false;
    return null;
  };
  const completedValue = (projection) => typeof projection?.lastAssistantStatus === "string"
    ? projection.lastAssistantStatus === "completed"
    : null;
  const aggregateProjection = (entries, projectionFor) => {
    const projections = entries.map(projectionFor).filter((projection) => projection && typeof projection === "object");
    const latest = projections.at(-1) ?? null;
    const fields = ["contentMarkerPresent", "orderedTextMarkerPresent", "renderedTextMarkerPresent"];
    return {
      recordCount: entries.length,
      projectionCount: projections.length,
      runtimeInstanceOrdinals: [...new Set(entries.map((entry) => entry.runtimeInstanceOrdinal).filter(Number.isSafeInteger))],
      messageCount: latest?.messageCount ?? null,
      assistantMatchCount: latest?.assistantMatchCount ?? null,
      orderedTextBlockCount: latest?.orderedTextBlockCount ?? null,
      contentLength: latest?.contentLength ?? null,
      orderedTextLength: latest?.orderedTextLength ?? null,
      lastAssistantStatus: latest?.lastAssistantStatus ?? null,
      contentMarkerPresent: combineBoolean(projections.map((projection) => projection.contentMarkerPresent)),
      orderedTextMarkerPresent: combineBoolean(projections.map((projection) => projection.orderedTextMarkerPresent)),
      renderedTextMarkerPresent: combineBoolean(projections.map((projection) => projection.renderedTextMarkerPresent)),
      markerPresent: combineBoolean(projections.map((projection) => markerValue(projection, fields))),
      completedStatusObserved: combineBoolean(projections.map(completedValue)),
      fieldsCaptured: projections.length > 0 && projections.every((projection) => fields.every((field) => typeof projection[field] === "boolean")),
      projections,
    };
  };
  const probeConfigured = probe.configuration?.status === "CONFIGURED";
  const fingerprintRecords = records.filter((record) => record.threadFingerprint !== null || record.turnFingerprint !== null || record.itemFingerprint !== null);
  const completeFingerprints = fingerprintRecords.every((record) => record.threadFingerprint !== null && record.turnFingerprint !== null && record.itemFingerprint !== null);
  const identityFingerprintsMatch = !probeConfigured || fingerprintRecords.length === 0 || !completeFingerprints
    ? null
    : fingerprintRecords.every((record) => record.threadFingerprint === fingerprint(threadId)
      && record.turnFingerprint === fingerprint(identity.turnId ?? "")
      && record.itemFingerprint === fingerprint(identity.itemId ?? ""));
  const readFailureStatuses = reads
    .filter((read) => ["PROBE_DRAIN_FAILED", "PROBE_PAGE_READ_FAILED", "INVALID_PROBE_ENVELOPE"].includes(read.status))
    .map((read) => read.status);
  const runtimeProjection = aggregateProjection([...runtimeRegistrations, ...runtimeSnapshots], (record) => record.projection);
  const runtimeInstanceRecords = [...runtimeRegistrations, ...runtimeSnapshots];
  const panelProjection = aggregateProjection(panelCommits, (record) => record.projection);
  const panelRuntimeAtEffect = aggregateProjection(panelCommits, (record) => record.runtimeProjectionAtEffect);
  const panelIdentity = panelCommits.at(-1) ?? null;
  const panelAndRuntimeInstanceOrdinalMatch = panelIdentity?.runtimeInstanceOrdinal != null
    && runtimeInstanceRecords.some((record) => record.runtimeInstanceOrdinal === panelIdentity.runtimeInstanceOrdinal)
    ? true
    : panelIdentity?.runtimeInstanceOrdinal != null && runtimeInstanceRecords.some((record) => Number.isSafeInteger(record.runtimeInstanceOrdinal))
      ? false
      : null;
  const panelSnapshotSameAsRuntimeAtEffect = combineBoolean(panelCommits.map((record) => record.panelSnapshotSameAsRuntimeAtEffect));
  const legacyMarker = combineBoolean(legacySnapshots.map((record) => record.legacySnapshot.markerPresent));
  const legacyCompleted = combineBoolean(legacySnapshots.map((record) => typeof record.legacySnapshot.status === "string"
    ? record.legacySnapshot.status === "completed"
    : null));
  let projectionStatus = "NO_RUNTIME_PROJECTION_RECORDS";
  if (!probeConfigured) projectionStatus = "NOT_RUN";
  else if (readFailureStatuses.length > 0) projectionStatus = "OBSERVATION_READ_FAILED";
  else if (projectionRecords.length > 0 && projectionRecords.every((record) => !record.projection && !record.runtimeProjectionAtEffect)) projectionStatus = "CAPTURED_PROJECTION_FIELDS_MISSING";
  else if (runtimeProjection.projectionCount === 0 && panelProjection.projectionCount === 0 && legacySnapshots.length > 0) {
    projectionStatus = legacyMarker === true && legacyCompleted === true
      ? "LEGACY_RUNTIME_MARKER_TERMINAL_SNAPSHOT_OBSERVED"
      : legacySnapshots.some((record) => record.legacySnapshot.markerPresent === null || record.legacySnapshot.status === null)
        ? "LEGACY_SNAPSHOT_FIELDS_MISSING"
        : "LEGACY_RUNTIME_SNAPSHOT_WITHOUT_MARKER_TERMINAL";
  } else if (runtimeProjection.projectionCount === 0 && panelProjection.projectionCount === 0 && records.length > 0) {
    projectionStatus = "RUNTIME_REGISTERED_WITHOUT_PROJECTION";
  } else if (runtimeProjection.markerPresent === true && runtimeProjection.completedStatusObserved === true
    && panelProjection.markerPresent === true && panelProjection.completedStatusObserved === true
    && panelSnapshotSameAsRuntimeAtEffect === true && panelAndRuntimeInstanceOrdinalMatch === true) {
    projectionStatus = "RUNTIME_AND_PANEL_MARKER_TERMINAL_PROJECTED";
  } else if (runtimeProjection.markerPresent === true && runtimeProjection.completedStatusObserved === true) {
    projectionStatus = "RUNTIME_MARKER_TERMINAL_PANEL_PROJECTION_INCOMPLETE";
  } else if (runtimeProjection.markerPresent === null && panelProjection.markerPresent === null && records.length > 0) {
    projectionStatus = "CAPTURED_PROJECTION_FIELDS_MISSING";
  } else if (runtimeProjection.markerPresent === true || panelProjection.markerPresent === true) {
    projectionStatus = "MARKER_PROJECTED_WITHOUT_COMPLETED_RUNTIME_AND_PANEL_MATCH";
  } else {
    projectionStatus = "RUNTIME_PROJECTION_OBSERVED_WITHOUT_MARKER";
  }
  const legacyEveryMethodEntered = expectedMethods.every((method) => legacyRpcEnterMethods.includes(method));
  const legacyEveryMethodAccepted = expectedMethods.every((method) => legacyAcceptedMethods.includes(method));
  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    performanceSample: false,
    evidenceClass: "isolated Mobile Web app-facing Playwright WebSocketMock dispatch plus private passive TaskRuntime projection; KCODER_STUDIO_MOCK Gateway, no Provider, no real app-server turn",
    source: {
      name: source.name,
      sourceTreeSha256: source.sourceTreeSha256,
      sourceFreezeEvidenceDigest: source.sourceFreezeEvidenceDigest,
      exportManifestSha256: source.exportManifestSha256,
      bundleSha256: mobileWeb.bundleSha256,
    },
    fixture: {
      requestedMessages: state.count,
      historyRowsDelivered: state.historyRowsDelivered,
      totalLoadedMessagesAfterSeed: state.historyRowsDelivered + 1,
      panelState: state.panelState,
      marker: identity.marker ?? null,
      turnId: identity.turnId ?? null,
      itemId: identity.itemId ?? null,
      threadId: threadId,
      activeRouteOrdinal: state.activeSocketRoute?.routeOrdinal ?? null,
      activeThreadReadRequestId: state.activeThreadReadRequestId,
    },
    mockDispatch: seed.seedDispatch ?? null,
    consumerProjection: {
      status: projectionStatus,
      configurationStatus: probe.configuration?.status ?? "PROBE_NOT_CONFIGURED",
      observationReadFailureCount: readFailureStatuses.length,
      observationReadFailureStatuses: readFailureStatuses,
      configure: probe.configuration,
      ringCapacityPerRead: 64,
      maximumStoredRecords: 128,
      readouts: reads,
      recordCount: records.length,
      runtimeRegistered: records.some((record) => record.kind === "runtime-registered" || record.kind === "registered"),
      runtimeInstanceOrdinals: [...new Set(records.map((record) => record.runtimeInstanceOrdinal).filter(Number.isSafeInteger))],
      runtimeProjection,
      panelProjection,
      panelRuntimeAtEffect,
      panelSnapshotSameAsRuntimeAtEffect,
      panelAndRuntimeInstanceOrdinalMatch,
      configuredIdentityFingerprintsMatch: identityFingerprintsMatch,
      identityFingerprintStatus: identityFingerprintsMatch === true ? "MATCH"
        : identityFingerprintsMatch === false ? "MISMATCH"
          : probeConfigured && fingerprintRecords.length === 0 ? "NOT_CAPTURED" : "INCOMPLETE",
      markerPresentInRuntimeSnapshot: runtimeProjection.markerPresent,
      completedStatusObservedInRuntimeSnapshot: runtimeProjection.completedStatusObserved,
      markerPresentInPanelProjection: panelProjection.markerPresent,
      completedStatusObservedInPanelProjection: panelProjection.completedStatusObserved,
      legacySnapshotRecordCount: legacySnapshots.length,
      legacySnapshotMarkerPresent: legacyMarker,
      legacySnapshotCompletedStatusObserved: legacyCompleted,
      legacyIngressEvidence: {
        evidenceClass: "legacy diagnostic record kinds only; current projection records do not establish RPC ingress or protocol acceptance",
        rpcEnterMethods: legacyRpcEnterMethods,
        protocolAcceptedMethods: legacyAcceptedMethods,
        rpcReturnMethods: legacyRpcReturnMethods,
        handlerThrowCount: records.filter((record) => record.kind === "rpc-threw").length,
        allFourMethodsEntered: legacyRpcEnterMethods.length > 0 ? legacyEveryMethodEntered : null,
        allFourMethodsProtocolAccepted: legacyAcceptedMethods.length > 0 ? legacyEveryMethodAccepted : null,
      },
    },
    domBoundary: {
      passedSeedVisibleTailGate: seed.ok === true,
      transcriptViewport: seed.transcriptViewport ?? null,
      changesPanelMounted: state.changesPanelMounted === true,
      changesPanelVisibilityEvidence: state.hiddenPanelEvidence ?? null,
      note: "Seed settlement requires the exact marker last-character Range to intersect the message-list viewport, stable tail geometry, and two animation-frame opportunities; probe reads do not alter or extend that gate.",
    },
    restrictions: {
      runtimeHandlerCalledDirectly: false,
      notificationFramesSentThrough: "the same identified app-facing Playwright 1.62 WebSocketMock selected by the existing active thread/read route guard",
      projectionReads: "one immediate drain after the four Mock frames and one drain after the existing DOM visibility/geometry gate; each drain is capped at 64 records",
      nativeStatus: "UNVERIFIED: Mobile Web Chromium only",
    },
  };
}

function summarizeRuntimeConsumerSeedFailure(source, state, error, mobileWeb) {
  const evidence = error?.seedFailureEvidence ?? {};
  const summary = buildRuntimeConsumerSeedDiagnostic(source, state, {
    ok: false,
    seedDispatch: evidence.seedDispatch ?? null,
    transcriptViewport: evidence.transcriptViewport ?? null,
    runtimeProbe: evidence.runtimeProbe ?? null,
  }, mobileWeb);
  return {
    ...summary,
    seedFailure: {
      failurePhase: evidence.failurePhase ?? null,
      diagnosticDom: evidence.diagnosticDom ?? null,
      error: evidence.error ?? null,
    },
  };
}

function summarizeSeedTranscriptViewport(viewport) {
  if (!viewport) return null;
  const compactSample = (sample) => sample ? ({
    observationSource: sample.observationSource ?? null,
    poll: sample.poll ?? null,
    sampledAtPageTimeMs: sample.sampledAtPageTimeMs ?? null,
    scrollTop: sample.scrollTop ?? null,
    scrollHeight: sample.scrollHeight ?? null,
    clientHeight: sample.clientHeight ?? null,
    bottomGapPx: sample.bottomGapPx ?? null,
    renderedMessageRowCount: sample.renderedMessageRowCount ?? null,
    targetRowFound: sample.targetRowFound ?? false,
    targetVisibleWithinMessageList: sample.targetVisibleWithinMessageList ?? false,
    targetRowRect: sample.targetRowRect ?? null,
    targetMarkerGeometryIncluded: sample.targetMarkerGeometryIncluded ?? false,
    targetMarkerOccurrenceCount: sample.targetMarkerOccurrenceCount ?? null,
    targetMarkerSelectedOccurrenceIndex: sample.targetMarkerSelectedOccurrenceIndex ?? null,
    targetMarkerLastCharacterRect: sample.targetMarkerLastCharacterRect ?? null,
    targetMarkerVisibleWithinMessageList: sample.targetMarkerVisibleWithinMessageList ?? null,
    jumpToLatestVisible: sample.jumpToLatestVisible ?? false,
    virtualizedGeometry: sample.virtualizedGeometry ?? null,
  }) : null;
  const samples = Array.isArray(viewport.pollSamples)
    ? viewport.pollSamples.slice(0, transcriptVirtualizationTraceLimits.maxViewportSamples)
    : [];
  return {
    expectedTailMarker: viewport.expectedTailMarker ?? null,
    before: compactSample(viewport.before),
    last: compactSample(viewport.last),
    afterTwoFrames: compactSample(viewport.afterTwoFrames),
    actions: (viewport.actions ?? []).map((action) => ({
      action: action.action,
      attemptNumber: action.attemptNumber ?? null,
      atPoll: action.atPoll ?? null,
      startedAtPageTimeMs: action.startedAtPageTimeMs ?? null,
      completedAtPageTimeMs: action.completedAtPageTimeMs ?? null,
      timeoutMs: action.timeoutMs ?? null,
      outcome: action.outcome ?? null,
      errorKind: action.errorKind ?? null,
      viewport: compactSample(action.viewport),
      recheck: action.recheck ? {
        locatorVisible: action.recheck.locatorVisible,
        buttonGone: action.recheck.buttonGone,
        viewport: compactSample(action.recheck.viewport),
      } : null,
    })),
    pollSamples: samples.map(compactSample),
    stableSamples: viewport.stableSamples ?? 0,
    pollCount: viewport.pollCount ?? samples.length,
    geometryStableAfterTwoFrames: viewport.geometryStableAfterTwoFrames ?? null,
    virtualizedGeometryTrace: viewport.virtualizedGeometryTrace ?? null,
  };
}

return { measureInputFeedback, measureScrollFeedback, summarizeScrollCausalityViewport, summarizeScrollCausalityTailGate, summarizeScrollCausalityWheel, summarizeScrollCausalityTouchTrace, evaluateScrollCausalityTouchEvidence, measureActiveMarkdownDelta, dispatchActiveFrame, dispatchActiveStreamFrames, makeLongMarkdownDelta, measureSnapshotUpdates, captureCdpClockAnchor, summarizeCpuProfile, mapCpuProfileWithSourceMaps, sendSyntheticSnapshot, readRuntimeConsumerProbe, drainRuntimeConsumerProbe, buildRuntimeConsumerSeedDiagnostic, summarizeRuntimeConsumerSeedFailure, summarizeSeedTranscriptViewport };
}
