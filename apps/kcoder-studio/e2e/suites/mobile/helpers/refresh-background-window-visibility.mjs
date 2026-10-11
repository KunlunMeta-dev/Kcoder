/**
 * Test-only derivation of the pinned R7 real-window visibility helper.
 * Base helper SHA-256: 5244e5cdccd5fd26429ebf99bfb3ec2331e95afc72e0c7644748a6f5c64e746e.
 * The sole behavioral addition is the awaited beforeMinimize hook after the
 * main page is brought forward and verified visible, before the minimize boundary.
 */
import { randomUUID } from "node:crypto";

export async function drainAndArmBackgroundHttpResponseHold({ waitForQuiescence, sampleControl, apiPath, delayMs }) {
  if (typeof waitForQuiescence !== "function") throw new TypeError("waitForQuiescence must be a function");
  if (!sampleControl || typeof sampleControl !== "object" || Array.isArray(sampleControl)) throw new TypeError("sampleControl must be an object");
  if (typeof apiPath !== "string" || !/^\/api\/(?:servers|servers\/status)$/.test(apiPath)) throw new TypeError("apiPath must be one of the measured server refresh endpoints");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) throw new RangeError("delayMs must be an integer from 0 through 10000");

  const quiescence = await waitForQuiescence();
  if (quiescence?.status !== "DRAINED") return { status: "NOT_ARMED", quiescence };
  sampleControl.httpPathDelayMs ??= {};
  if (!sampleControl.httpPathDelayMs || typeof sampleControl.httpPathDelayMs !== "object" || Array.isArray(sampleControl.httpPathDelayMs)) {
    throw new TypeError("sampleControl.httpPathDelayMs must be an object");
  }
  sampleControl.httpPathDelayMs[apiPath] = delayMs;
  return { status: "ARMED", quiescence, apiPath, delayMs };
}

const VISIBILITY_TRACE_KEY = "__phoneUxRealVisibilityTraceV1";

export async function captureWindowMinimizeVisibilityCycle(page, {
  timeoutMs = 2_000,
  pollIntervalMs = 20,
  prepareCompanionPage,
  beforeMinimize,
} = {}) {
  if (!page || page.isClosed()) {
    return { status: "NOT_RUN", reason: "page-unavailable", events: [] };
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new RangeError("timeoutMs must be an integer from 1 through 10000");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 250) {
    throw new RangeError("pollIntervalMs must be an integer from 1 through 250");
  }

  const outcome = {
    status: "NOT_RUN",
    reason: "window-minimize-visibility-transition-not-observed",
    driver: "Browser.getWindowForTarget plus Browser.setWindowBounds minimized, then restore normal state and saved geometry in separate calls",
    syntheticVisibilityEventDispatched: false,
    initialState: null,
    hiddenState: null,
    activeState: null,
    hiddenEvent: null,
    activeEvent: null,
    events: [],
    targetOwnership: null,
    initialWindow: null,
    minimizedWindow: null,
    restoredWindow: null,
    traceDetached: false,
    companionClosed: false,
    beforeMinimizeHookStatus: beforeMinimize === undefined ? "NOT_REQUESTED" : "NOT_REACHED",
    completedStages: [],
    cleanupStages: [],
  };

  let cdpSession;
  let companionPage;
  let companionPreparationCleanup;
  let mainTarget;
  let mainWindow;
  let minimizeMayHaveApplied = false;
  let traceArmed = false;
  let restoreBounds;
  let minimizeBoundaryEpochMs;
  let restoreBoundaryEpochMs;
  let activeStage = "check-browser-connection";
  const completeStage = () => outcome.completedStages.push(activeStage);
  const describeError = error => ({
    name: String(error?.name ?? "Error").slice(0, 128),
    message: String(error?.message ?? error).slice(0, 2_048),
    stack: String(error?.stack ?? "").slice(0, 4_096),
  });
  try {
    const browser = page.context().browser();
    completeStage();
    if (!browser || !browser.isConnected()) {
      outcome.reason = "browser-level-cdp-unavailable";
    } else {
      activeStage = "create-browser-cdp-session";
      cdpSession = await browser.newBrowserCDPSession();
      completeStage();
      activeStage = "arm-visibility-trace";
      const initial = await page.evaluate(key => {
        globalThis[key]?.cleanup?.();
        const events = [];
        const listener = event => {
          events.push({
            state: document.visibilityState,
            isTrusted: event.isTrusted === true,
            atEpochMs: Number((performance.timeOrigin + event.timeStamp).toFixed(3)),
            atPagePerformanceMs: Number(performance.now().toFixed(3)),
          });
          if (events.length > 8) events.splice(0, events.length - 8);
        };
        document.addEventListener("visibilitychange", listener, true);
        globalThis[key] = {
          initialState: document.visibilityState,
          events,
          cleanup() { document.removeEventListener("visibilitychange", listener, true); },
        };
        return {
          state: document.visibilityState,
          armedAtEpochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)),
        };
      }, VISIBILITY_TRACE_KEY);
      completeStage();
      traceArmed = true;
      outcome.initialState = initial.state;

      if (initial.state !== "visible") {
        outcome.reason = "page-was-not-visible-before-transition";
      } else {
        const mainTitle = "phone-ux-main-" + randomUUID();
        activeStage = "set-main-target-title";
        await page.evaluate(title => { document.title = title; }, mainTitle);
        completeStage();
        activeStage = "find-main-target";
        mainTarget = await waitForPageTargetByTitle(cdpSession, mainTitle, timeoutMs, pollIntervalMs);
        completeStage();
        if (!mainTarget) {
          outcome.reason = "main-page-cdp-target-not-found";
        } else {
          activeStage = "create-companion-page";
          companionPage = await page.context().newPage();
          completeStage();
          activeStage = "load-companion-page";
          await companionPage.goto("about:blank", { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
          completeStage();
          activeStage = "set-companion-viewport-document";
          await companionPage.setContent(
            '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
            { waitUntil: "domcontentloaded", timeout: timeoutMs },
          );
          completeStage();
          if (prepareCompanionPage !== undefined) {
            if (typeof prepareCompanionPage !== "function") {
              throw new TypeError("prepareCompanionPage must be a function when provided");
            }
            activeStage = "prepare-companion-page";
            companionPreparationCleanup = await prepareCompanionPage(companionPage);
            if (companionPreparationCleanup !== undefined && typeof companionPreparationCleanup !== "function") {
              throw new TypeError("prepareCompanionPage must return a cleanup function or undefined");
            }
            completeStage();
          }
          const companionTitle = "phone-ux-companion-" + randomUUID();
          activeStage = "set-companion-target-title";
          await companionPage.evaluate(title => { document.title = title; }, companionTitle);
          completeStage();
          activeStage = "find-companion-target";
          const companionTarget = await waitForPageTargetByTitle(cdpSession, companionTitle, timeoutMs, pollIntervalMs);
          completeStage();
          outcome.targetOwnership = {
            mainTargetId: mainTarget.targetId,
            mainBrowserContextId: mainTarget.browserContextId ?? null,
            companionTargetId: companionTarget?.targetId ?? null,
            companionBrowserContextId: companionTarget?.browserContextId ?? null,
            sameBrowserContext: Boolean(companionTarget && mainTarget.browserContextId && companionTarget.browserContextId === mainTarget.browserContextId),
          };

          if (!companionTarget || !outcome.targetOwnership.sameBrowserContext) {
            outcome.reason = "page-target-ownership-not-confirmed";
          } else {
            activeStage = "bring-main-page-to-front";
            await page.bringToFront();
            completeStage();
            activeStage = "check-main-page-visible";
            const beforeMinimizeState = await readVisibilityState(page);
            completeStage();
            outcome.preMinimizeState = beforeMinimizeState;
            if (beforeMinimizeState !== "visible") {
              outcome.reason = "main-page-not-visible-after-companion-bring-to-front";
            } else {
              if (beforeMinimize !== undefined) {
                if (typeof beforeMinimize !== "function") {
                  throw new TypeError("beforeMinimize must be a function when provided");
                }
                activeStage = "before-minimize-hook";
                outcome.beforeMinimizeHookStatus = "RUNNING";
                await beforeMinimize({ state: beforeMinimizeState });
                outcome.beforeMinimizeHookStatus = "COMPLETED";
                completeStage();
              }
              activeStage = "read-browser-window-bounds";
              mainWindow = await cdpSession.send("Browser.getWindowForTarget", { targetId: mainTarget.targetId });
              const companionWindow = await cdpSession.send("Browser.getWindowForTarget", { targetId: companionTarget.targetId });
              completeStage();
              outcome.initialWindow = mainWindow;
              outcome.targetOwnership.mainWindowId = mainWindow.windowId;
              outcome.targetOwnership.companionWindowId = companionWindow.windowId;
              outcome.targetOwnership.sameBrowserWindow = mainWindow.windowId === companionWindow.windowId;

              if (mainWindow.bounds.windowState !== "normal") {
                outcome.reason = "main-browser-window-was-not-normal-before-minimize";
              } else {
                restoreBounds = { windowState: "normal" };
              for (const key of ["left", "top", "width", "height"]) {
                if (Number.isFinite(mainWindow.bounds[key])) restoreBounds[key] = mainWindow.bounds[key];
              }
              activeStage = "capture-minimize-boundary";
              const minimizeBoundary = await page.evaluate(() => ({
                state: document.visibilityState,
                atEpochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)),
              }));
              completeStage();
              outcome.minimizeBoundaryState = minimizeBoundary.state;
              if (minimizeBoundary.state !== "visible") {
                outcome.reason = "main-page-not-visible-at-minimize-boundary";
              } else {
                minimizeBoundaryEpochMs = minimizeBoundary.atEpochMs;
                outcome.minimizeBoundaryEpochMs = minimizeBoundaryEpochMs;
                minimizeMayHaveApplied = true;
                activeStage = "send-minimize-command";
                await cdpSession.send("Browser.setWindowBounds", {
                  windowId: mainWindow.windowId,
                  bounds: { windowState: "minimized" },
                });
                completeStage();
                activeStage = "wait-for-minimized-window-state";
                const minimized = await waitForPageWindowState(cdpSession, mainTarget.targetId, "minimized", timeoutMs, pollIntervalMs);
                completeStage();
                outcome.minimizedWindow = minimized;
                if (!minimized) {
                  outcome.reason = "browser-window-did-not-enter-minimized-state";
                } else {
                  activeStage = "wait-for-trusted-hidden-event";
                  outcome.hiddenEvent = await waitForTrustedStateEvent(page, "hidden", minimizeBoundaryEpochMs, timeoutMs, pollIntervalMs);
                  completeStage();
                  activeStage = "read-hidden-document-state";
                  outcome.hiddenState = await readVisibilityState(page);
                  completeStage();
                  activeStage = "capture-restore-boundary";
                  restoreBoundaryEpochMs = await page.evaluate(() => Number((performance.timeOrigin + performance.now()).toFixed(3)));
                  completeStage();
                  outcome.restoreBoundaryEpochMs = restoreBoundaryEpochMs;
                  activeStage = "restore-browser-window";
                  await restoreBrowserWindowBounds(cdpSession, mainWindow.windowId, restoreBounds);
                  completeStage();
                  activeStage = "wait-for-normal-window-state";
                  outcome.restoredWindow = await waitForPageWindowState(cdpSession, mainTarget.targetId, "normal", timeoutMs, pollIntervalMs);
                  completeStage();
                  minimizeMayHaveApplied = !outcome.restoredWindow;
                  if (outcome.hiddenEvent && outcome.hiddenState === "hidden" && outcome.restoredWindow) {
                    activeStage = "wait-for-trusted-visible-event";
                    outcome.activeEvent = await waitForTrustedStateEvent(page, "visible", restoreBoundaryEpochMs, timeoutMs, pollIntervalMs);
                    completeStage();
                    activeStage = "read-restored-document-state";
                    outcome.activeState = await readVisibilityState(page);
                    completeStage();
                  }
                  if (!outcome.hiddenEvent || outcome.hiddenState !== "hidden") {
                    outcome.reason = "browser-window-minimized-without-trusted-hidden-transition";
                  } else if (!outcome.restoredWindow) {
                    outcome.reason = "browser-window-did-not-return-to-normal-state";
                  } else if (!outcome.activeEvent || outcome.activeState !== "visible") {
                    outcome.reason = "browser-window-restored-without-trusted-visible-transition";
                  } else {
                    outcome.status = "PASS";
                    outcome.reason = null;
                  }
                }
              }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    outcome.reason = "window-minimize-driver-unavailable";
    outcome.driverErrorStage = activeStage;
    outcome.driverError = describeError(error);
    if (activeStage === "before-minimize-hook") outcome.beforeMinimizeHookStatus = "FAILED";
  } finally {
    if (minimizeMayHaveApplied && cdpSession && mainWindow && restoreBounds) {
      try {
        activeStage = "finally-restore-browser-window";
        await restoreBrowserWindowBounds(cdpSession, mainWindow.windowId, restoreBounds);
        outcome.cleanupStages.push(activeStage);
        outcome.restoreAttemptedInFinally = true;
        if (mainTarget) {
          activeStage = "finally-wait-for-normal-window-state";
          outcome.restoredWindow ??= await waitForPageWindowState(cdpSession, mainTarget.targetId, "normal", timeoutMs, pollIntervalMs);
          outcome.cleanupStages.push(activeStage);
        }
      } catch (error) {
        outcome.restoreErrorStage = activeStage;
        outcome.restoreError = describeError(error);
      }
    }
    if (companionPreparationCleanup) {
      try {
        activeStage = "finally-cleanup-companion-page-preparation";
        await companionPreparationCleanup();
        outcome.cleanupStages.push(activeStage);
      } catch (error) {
        outcome.companionPreparationCleanupErrorStage = activeStage;
        outcome.companionPreparationCleanupError = describeError(error);
      }
    }
    if (companionPage && !companionPage.isClosed()) {
      try {
        activeStage = "finally-close-companion-page";
        await companionPage.close();
        outcome.cleanupStages.push(activeStage);
        outcome.companionClosed = companionPage.isClosed();
      } catch (error) {
        outcome.cleanupErrorStage = activeStage;
        outcome.cleanupError = describeError(error);
      }
    }
    if (traceArmed && !page.isClosed()) {
      try {
        activeStage = "finally-capture-and-detach-trace";
        const trace = await page.evaluate(key => {
          const current = globalThis[key];
          if (!current) return { status: "missing", initialState: null, events: [] };
          current.cleanup?.();
          const value = { status: "captured", initialState: current.initialState, events: current.events.slice() };
          delete globalThis[key];
          return value;
        }, VISIBILITY_TRACE_KEY);
        outcome.traceStatus = trace.status;
        outcome.traceDetached = trace.status === "captured";
        outcome.events = trace.events;
        outcome.hiddenEvent = outcome.events.find(event => event.state === "hidden" && event.isTrusted && event.atEpochMs > (minimizeBoundaryEpochMs ?? Infinity)) ?? outcome.hiddenEvent;
        outcome.activeEvent = outcome.events.find(event => event.state === "visible" && event.isTrusted && event.atEpochMs > (restoreBoundaryEpochMs ?? Infinity)) ?? outcome.activeEvent;
        outcome.cleanupStages.push(activeStage);
      } catch (error) {
        outcome.traceStatus = "capture-failed";
        outcome.traceErrorStage = activeStage;
        outcome.traceError = describeError(error);
      }
    }
    if (cdpSession) {
      try {
        activeStage = "finally-detach-browser-cdp-session";
        await cdpSession.detach();
        outcome.cleanupStages.push(activeStage);
      } catch (error) {
        outcome.cdpDetachErrorStage = activeStage;
        outcome.cdpDetachError = describeError(error);
      }
    }
    outcome.finalStage = activeStage;
  }
  return outcome;
}

async function waitForPageTargetByTitle(cdpSession, title, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const { targetInfos } = await cdpSession.send("Target.getTargets");
    const matches = targetInfos.filter(target => target.type === "page" && target.title === title);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error("multiple page targets matched a unique title marker");
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

async function waitForPageWindowState(cdpSession, targetId, expectedState, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const windowInfo = await cdpSession.send("Browser.getWindowForTarget", { targetId });
    if (windowInfo.bounds.windowState === expectedState) return windowInfo;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

async function restoreBrowserWindowBounds(cdpSession, windowId, restoreBounds) {
  await cdpSession.send("Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "normal" },
  });
  const geometry = Object.create(null);
  for (const key of ["left", "top", "width", "height"]) {
    if (Number.isFinite(restoreBounds?.[key])) geometry[key] = restoreBounds[key];
  }
  if (Object.keys(geometry).length > 0) {
    await cdpSession.send("Browser.setWindowBounds", { windowId, bounds: geometry });
  }
}

async function readVisibilityState(page) {
  if (page.isClosed()) return null;
  return page.evaluate(() => document.visibilityState).catch(() => null);
}

async function waitForTrustedStateEvent(page, expectedState, afterEpochMs, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline && !page.isClosed()) {
    const event = await page.evaluate(({ key, state, after }) => {
      const current = globalThis[key];
      return current?.events.find(row => row.state === state && row.isTrusted && row.atEpochMs > after) ?? null;
    }, { key: VISIBILITY_TRACE_KEY, state: expectedState, after: afterEpochMs }).catch(() => null);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}
