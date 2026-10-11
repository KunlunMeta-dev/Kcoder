import assert from "node:assert/strict";
import test from "node:test";
import { captureWindowMinimizeVisibilityCycle, drainAndArmBackgroundHttpResponseHold } from "./refresh-background-window-visibility.mjs";

test("arms the selected HTTP hold only after a drained Gateway sample, including zero delay", async () => {
  for (const delayMs of [0, 300, 600, 1000]) {
    const sampleControl = { httpPathDelayMs: {} };
    let quiescenceCalled = false;
    const result = await drainAndArmBackgroundHttpResponseHold({
      waitForQuiescence: async () => {
        quiescenceCalled = true;
        assert.deepEqual(sampleControl.httpPathDelayMs, {}, "hold must not be visible while the quiescence gate is running");
        return { status: "DRAINED", pendingHttp: 0, pendingRpc: 0 };
      },
      sampleControl,
      apiPath: "/api/servers/status",
      delayMs,
    });
    assert.equal(quiescenceCalled, true);
    assert.equal(result.status, "ARMED");
    assert.equal(sampleControl.httpPathDelayMs["/api/servers/status"], delayMs);
  }
});

test("does not arm an HTTP hold when foreground preparation is not quiescent", async () => {
  const sampleControl = { httpPathDelayMs: {} };
  const result = await drainAndArmBackgroundHttpResponseHold({
    waitForQuiescence: async () => ({ status: "NOT_DRAINED", pendingHttp: 1, pendingRpc: 0 }),
    sampleControl,
    apiPath: "/api/servers",
    delayMs: 600,
  });
  assert.equal(result.status, "NOT_ARMED");
  assert.deepEqual(sampleControl.httpPathDelayMs, {});
});

function createOwnedBrowserFixture() {
  const timeline = [];
  const events = [];
  let state = "visible";
  let windowState = "normal";
  let epochMs = 100;
  let mainTitle = "";
  let companionTitle = "";
  let boundaryReached = false;
  let companionClosed = false;

  const pushEvent = nextState => {
    epochMs += 1;
    state = nextState;
    events.push({ state, isTrusted: true, atEpochMs: epochMs, atPagePerformanceMs: epochMs - 100 });
  };

  const context = {
    browser: () => browser,
    newPage: async () => ({
      isClosed: () => companionClosed,
      context: () => context,
      goto: async () => ({ status: () => 200 }),
      setContent: async () => {},
      evaluate: async (fn, arg) => {
        if (String(fn).includes("document.title = title")) companionTitle = arg;
      },
      close: async () => { companionClosed = true; },
    }),
  };

  const cdpSession = {
    send: async (method, params = {}) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [
          { targetId: "main-target", type: "page", title: mainTitle, browserContextId: "owned-context" },
          { targetId: "companion-target", type: "page", title: companionTitle, browserContextId: "owned-context" },
        ] };
      }
      if (method === "Browser.getWindowForTarget") {
        return {
          windowId: 7,
          bounds: { left: 10, top: 20, width: 390, height: 844, windowState },
        };
      }
      if (method === "Browser.setWindowBounds") {
        const next = params.bounds?.windowState;
        if (next && next !== windowState) {
          windowState = next;
          pushEvent(next === "minimized" ? "hidden" : "visible");
          timeline.push(next === "minimized" ? "minimize" : "restore");
        }
        return {};
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
    detach: async () => {},
  };
  const browser = {
    isConnected: () => true,
    newBrowserCDPSession: async () => cdpSession,
  };
  const page = {
    isClosed: () => false,
    context: () => context,
    bringToFront: async () => { pushEvent("visible"); timeline.push("bring-main-front"); },
    evaluate: async (fn, arg) => {
      const source = String(fn);
      if (source.includes('addEventListener("visibilitychange"')) {
        return { state, armedAtEpochMs: epochMs };
      }
      if (source.includes("document.title = title")) {
        mainTitle = arg;
        return undefined;
      }
      if (arg && typeof arg === "object" && typeof arg.state === "string" && Number.isFinite(arg.after)) {
        return events.find(event => event.state === arg.state && event.isTrusted && event.atEpochMs > arg.after) ?? null;
      }
      if (source.includes("current.cleanup?.()")) {
        return { status: "captured", initialState: "visible", events: events.slice() };
      }
      if (source.includes("atEpochMs: Number((performance.timeOrigin + performance.now()).toFixed(3))")) {
        boundaryReached = true;
        epochMs += 1;
        return { state, atEpochMs: epochMs };
      }
      if (source.includes("Number((performance.timeOrigin + performance.now()).toFixed(3))")) {
        epochMs += 1;
        return epochMs;
      }
      if (source.trim() === "() => document.visibilityState") return state;
      throw new Error("unexpected page.evaluate operation");
    },
  };

  return {
    page,
    timeline,
    get boundaryReached() { return boundaryReached; },
    get companionClosed() { return companionClosed; },
  };
}

test("awaits the before-minimize drain hook after foreground check and before the minimize boundary", async () => {
  const fixture = createOwnedBrowserFixture();
  let releaseHook;
  let signalHookStarted;
  const hookStarted = new Promise(resolve => { signalHookStarted = resolve; });
  const hookRelease = new Promise(resolve => { releaseHook = resolve; });

  const run = captureWindowMinimizeVisibilityCycle(fixture.page, {
    timeoutMs: 500,
    pollIntervalMs: 1,
    beforeMinimize: async ({ state }) => {
      assert.equal(state, "visible");
      fixture.timeline.push("before-minimize-hook-enter");
      signalHookStarted();
      await hookRelease;
      fixture.timeline.push("before-minimize-hook-complete");
    },
  });

  let hookTimeout;
  try {
    await Promise.race([
      hookStarted,
      new Promise((_, reject) => { hookTimeout = setTimeout(() => reject(new Error("before-minimize hook was not reached")), 1_000); }),
    ]);
  } finally {
    clearTimeout(hookTimeout);
  }
  assert.equal(fixture.boundaryReached, false, "the minimize boundary must not be captured while the hook is pending");
  assert.deepEqual(fixture.timeline, ["bring-main-front", "before-minimize-hook-enter"]);
  releaseHook();

  const outcome = await run;
  assert.equal(outcome.status, "PASS");
  assert.equal(outcome.beforeMinimizeHookStatus, "COMPLETED");
  assert.equal(outcome.companionClosed, true);
  assert.ok(outcome.completedStages.indexOf("check-main-page-visible") < outcome.completedStages.indexOf("before-minimize-hook"));
  assert.ok(outcome.completedStages.indexOf("before-minimize-hook") < outcome.completedStages.indexOf("capture-minimize-boundary"));
  assert.ok(fixture.timeline.indexOf("before-minimize-hook-complete") < fixture.timeline.indexOf("minimize"));
  assert.equal(fixture.boundaryReached, true);
});
