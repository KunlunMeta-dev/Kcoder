const VISIBILITY_TRACE_KEY = "__phoneUxRealVisibilityTraceV1";
const OWNED_MOBILE_PAGES = new WeakMap();

/**
 * Attach the diagnostics normally installed by startChromium.newPage() to a
 * page created from an explicitly owned BrowserContext. The page-local list is
 * persisted once when its owner closes, so it remains compatible with
 * RunContext's exclusive artifact creation semantics.
 */
export function observeOwnedMobilePage(page, {
  runContext,
  pageId,
  onPageError,
  onRequestFailed,
} = {}) {
  if (!page || !runContext || !Number.isInteger(pageId) || pageId < 1) {
    throw new TypeError("observeOwnedMobilePage requires a page, RunContext, and positive pageId");
  }

  const diagnostics = [];
  const record = (kind, message) => {
    if (diagnostics.length >= 32) return;
    diagnostics.push({ kind, message: runContext.redactText(String(message)).slice(0, 2_000) });
  };
  page.on("pageerror", error => {
    onPageError?.(error);
    record("pageerror", error);
  });
  page.on("crash", () => record("crash", "renderer process crashed"));
  page.on("console", message => {
    if (message.type() === "error") record("console", message.text());
  });
  page.on("requestfailed", request => {
    onRequestFailed?.(request);
    let pathname = "unparseable-url";
    try { pathname = new URL(request.url()).pathname; } catch {}
    record("requestfailed", `${pathname}: ${request.failure()?.errorText ?? "unknown failure"}`);
  });
  OWNED_MOBILE_PAGES.set(page, {
    browserContext: page.context(),
    diagnostics,
    pageId,
    runContext,
  });
}

/** Flush page diagnostics and close its complete owned BrowserContext. */
export async function closeOwnedMobilePage(page, { closeContext = true } = {}) {
  if (!page) return;
  const owned = OWNED_MOBILE_PAGES.get(page);
  if (!owned) {
    if (!page.isClosed()) await page.close();
    return;
  }

  OWNED_MOBILE_PAGES.delete(page);
  let failure = null;
  try {
    if (owned.diagnostics.length > 0) {
      await owned.runContext.writeArtifactJson(
        `phone-ux-mobile-page-errors-${String(owned.pageId).padStart(4, "0")}.json`,
        { schemaVersion: 1, pageId: owned.pageId, diagnostics: owned.diagnostics },
      );
    }
  } catch (error) {
    failure = error;
  }
  try {
    if (closeContext) await owned.browserContext.close();
    else if (!page.isClosed()) await page.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

/** Create monotonically named progress artifacts without rewriting RunContext paths. */
export function createRefreshProgressWriter(writeArtifactJson) {
  if (typeof writeArtifactJson !== "function") {
    throw new TypeError("createRefreshProgressWriter requires a writeArtifactJson function");
  }
  let sequence = 0;
  return {
    get sequence() { return sequence; },
    async write(value) {
      const progressSequence = ++sequence;
      const name = `phone-ux-refresh-send-progress-${String(progressSequence).padStart(4, "0")}.json`;
      await writeArtifactJson(name, {
        ...value,
        artifactType: "progress-entry",
        progressSequence,
      });
      return progressSequence;
    },
  };
}

/**
 * Capture a browser-driven page background/foreground cycle.
 *
 * A fresh companion page is opened in the same Playwright BrowserContext and
 * receives focus. This helper never changes document.visibilityState and never
 * dispatches visibilitychange. PASS requires trusted events and actual states
 * in visible -> hidden -> visible order. The caller must correlate activeEvent
 * with the exact refresh route request before counting a sample.
 */
export async function captureRealPageVisibilityCycle(page, {
  timeoutMs = 2_000,
  pollIntervalMs = 20,
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

  let companionPage;
  const outcome = {
    status: "NOT_RUN",
    reason: "visibility-transition-not-observed",
    driver: "same-BrowserContext companion page plus Playwright bringToFront",
    syntheticVisibilityEventDispatched: false,
    initialState: null,
    hiddenState: null,
    activeState: null,
    hiddenEvent: null,
    activeEvent: null,
    events: [],
    companionClosed: false,
    traceDetached: false,
  };

  try {
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
    outcome.initialState = initial.state;
    if (initial.state !== "visible") {
      outcome.reason = "page-was-not-visible-before-transition";
    } else {
      companionPage = await page.context().newPage();
      await companionPage.goto("about:blank", { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
      await companionPage.bringToFront();

      outcome.hiddenEvent = await waitForTrustedStateEvent(page, "hidden", initial.armedAtEpochMs, timeoutMs, pollIntervalMs);
      outcome.hiddenState = await readVisibilityState(page);
      if (!outcome.hiddenEvent || outcome.hiddenState !== "hidden") {
        outcome.reason = "browser-did-not-produce-trusted-hidden-transition";
      } else {
        await page.bringToFront();
        outcome.activeEvent = await waitForTrustedStateEvent(page, "visible", outcome.hiddenEvent.atEpochMs, timeoutMs, pollIntervalMs);
        outcome.activeState = await readVisibilityState(page);
        if (outcome.activeEvent && outcome.activeState === "visible") {
          outcome.status = "PASS";
          outcome.reason = null;
        } else {
          outcome.reason = "browser-did-not-produce-trusted-visible-transition";
        }
      }
    }
  } catch (error) {
    outcome.reason = "visibility-driver-unavailable";
    outcome.driverError = String(error?.message ?? error).slice(0, 160);
  } finally {
    if (companionPage && !companionPage.isClosed()) {
      try {
        await companionPage.close();
        outcome.companionClosed = companionPage.isClosed();
      } catch (error) {
        outcome.cleanupError = String(error?.message ?? error).slice(0, 160);
      }
    }
    if (!page.isClosed()) {
      try {
        const trace = await page.evaluate(key => {
          const current = globalThis[key];
          if (!current) return { status: "missing", initialState: null, events: [] };
          current.cleanup?.();
          const value = { status: "captured", initialState: current.initialState, events: current.events.slice() };
          delete globalThis[key];
          return value;
        }, VISIBILITY_TRACE_KEY);
        outcome.traceStatus = trace.status;
        outcome.traceInitialState = trace.initialState;
        outcome.events = trace.events;
        outcome.traceDetached = trace.status === "captured";
        outcome.hiddenEvent = outcome.events.find(event => event.state === "hidden" && event.isTrusted) ?? null;
        outcome.activeEvent = outcome.events.find(event => event.state === "visible" && event.isTrusted && event.atEpochMs > (outcome.hiddenEvent?.atEpochMs ?? Infinity)) ?? null;
        if (outcome.status === "PASS" && (!outcome.hiddenEvent || !outcome.activeEvent)) {
          outcome.status = "NOT_RUN";
          outcome.reason = "trusted-transition-events-not-paired-in-order";
        }
      } catch (error) {
        outcome.traceStatus = "capture-failed";
        outcome.traceError = String(error?.message ?? error).slice(0, 160);
      }
    }
  }

  return outcome;
}

/** Create an isolated WSS-fixture error correlated to an actual turn/start id. */
export function createTurnStartErrorFixtureFrame(requestFrame, {
  code = -32091,
  message = "Isolated Mobile E2E rejected this turn/start",
} = {}) {
  if (!requestFrame || requestFrame.method !== "turn/start" || requestFrame.id === undefined || requestFrame.id === null) {
    throw new TypeError("requestFrame must be an identified turn/start JSON-RPC request");
  }
  if (!requestFrame.params || typeof requestFrame.params.threadId !== "string" || !requestFrame.params.threadId.trim()) {
    throw new TypeError("turn/start request must include a non-empty threadId");
  }
  if (typeof requestFrame.params.clientMessageId !== "string" || !requestFrame.params.clientMessageId.trim()) {
    throw new TypeError("turn/start request must include a non-empty clientMessageId");
  }
  if (!Number.isInteger(code) || typeof message !== "string" || !message.trim()) {
    throw new TypeError("fixture error code and message are invalid");
  }
  return {
    jsonrpc: requestFrame.jsonrpc === "2.0" ? requestFrame.jsonrpc : "2.0",
    id: requestFrame.id,
    error: { code, message },
  };
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
      return current?.events.find(row => row.state === state && row.isTrusted && row.atEpochMs >= after) ?? null;
    }, { key: VISIBILITY_TRACE_KEY, state: expectedState, after: afterEpochMs }).catch(() => null);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}
