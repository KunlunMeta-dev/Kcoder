import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import * as timingPageOwnership from "./mobile-cache-timing-page-ownership.mjs";
import {
  closeMobileTimingTaskPage,
  observeMobilePageRpcSockets,
  openMobileTimingCacheObserverPage,
  projectRelayBootstrapFailureEvidence,
  releaseMobileTimingChromium,
} from "./mobile-cache-timing-page-ownership.mjs";
import { createDirectMobileTimingLaneDescriptor } from "./mobile-cache-timing-runner.mjs";

test("timing Page release proves its own route pair before graceful Chromium release and restart", async () => {
  const events = [];
  const peer = { socketOrdinal: 1, clientClosedAtMs: null, upstreamClosedAtMs: null };
  const owned = { socketOrdinal: 2, clientClosedAtMs: null, upstreamClosedAtMs: null };
  owned.closeForwarding = {
    requestCloseFromOwnerRelease() { events.push("route-close-request"); },
    closeRequestPendingCount: 0, closeRequestSettledCount: 0, closeForwardErrorCount: 0,
  };
  const result = await timingPageOwnership.releaseMobileTimingPageAndChromium({
    page: { async close() { events.push("task-page-close"); } },
    protocol: {
      nextSocketOrdinal: 2, nextPageRpcSocketOrdinal: 2,
      pageWebSockets: [{ path: "/rpc", rpcOrdinal: 1 }, { path: "/rpc", rpcOrdinal: 2 }],
      routeDiagnostics: [peer, owned],
    },
    firstRouteSocketOrdinal: 1, firstPageRpcOrdinal: 1, requiredSocketOrdinal: 2,
    observerPages: [{ async close() { events.push("entry-observer-close"); } }],
    waitFor: async probe => {
      assert.deepEqual(events, ["entry-observer-close", "route-close-request"]);
      assert.equal(probe(), null);
      owned.clientClosedAtMs = 3; owned.upstreamClosedAtMs = 4;
      assert.equal(probe(), true); events.push("actual-route-closes");
    },
    restart: true,
    releaseChromium: async restart => {
      assert.equal(restart, true); events.push("graceful-chromium-release-and-restart");
      return { chromium: { nextOwner: true }, evidence: { status: "PASS", restartRequested: true } };
    },
  });
  assert.deepEqual(events, ["entry-observer-close", "route-close-request", "actual-route-closes",
    "task-page-close", "graceful-chromium-release-and-restart"]);
  assert.equal(result.chromium.nextOwner, true);
  assert.equal(result.evidence.taskPageRelease.requiredRouteEndpointsClosed, true);
  assert.equal(result.evidence.observerPageCloseCount, 1);
  assert.equal(peer.clientClosedAtMs, null, "the earlier peer route must not be touched");
});

test("failed timing Page barrier preserves the primary failure and cleans Chromium without restarting", async t => {
  for (const cleanupFails of [false, true]) await t.test(`cleanup fails: ${cleanupFails}`, async () => {
    const primary = new Error("exact upstream close not observed");
    const cleanup = new Error("exact Chromium cleanup failed");
    const restarts = [];
    await assert.rejects(timingPageOwnership.releaseMobileTimingPageAndChromium({
      page: { async close() {} },
      protocol: {
        nextSocketOrdinal: 1, nextPageRpcSocketOrdinal: 1,
        pageWebSockets: [{ path: "/rpc", rpcOrdinal: 1 }],
        routeDiagnostics: [{ socketOrdinal: 1, clientClosedAtMs: null, upstreamClosedAtMs: null,
          closeForwarding: { requestCloseFromOwnerRelease() {} } }],
      },
      waitFor: async () => { throw primary; },
      restart: true,
      releaseChromium: async restart => {
        restarts.push(restart); if (cleanupFails) throw cleanup;
        return { chromium: null, evidence: { status: "PASS" } };
      },
    }), error => cleanupFails ? error instanceof AggregateError && error.errors[0] === primary &&
      error.errors[1] === cleanup : error === primary);
    assert.deepEqual(restarts, [false], "a failed bridge barrier must never reopen the profile");
  });
});

test("pre-page observer close failure cleans the exact Browser without touching old task routes", async () => {
  const primary = new Error("owned entry observer close failed");
  const restarts = [];
  await assert.rejects(timingPageOwnership.releaseMobileTimingPageAndChromium({
    page: null,
    protocol: new Proxy({}, { get() { throw new Error("old task protocol must not be read before sample Page creation"); } }),
    observerPages: [{ async close() { throw primary; } }],
    restart: true,
    releaseChromium: async restart => { restarts.push(restart); return { evidence: { status: "PASS" } }; },
  }), error => error === primary);
  assert.deepEqual(restarts, [false]);
});

test("task-page release closes only its own post-baseline RPC route pair", async () => {
  const oldRoute = { socketOrdinal: 1, clientClosedAtMs: 2, upstreamClosedAtMs: 3 };
  const ownedRoute = { socketOrdinal: 2, clientClosedAtMs: null, upstreamClosedAtMs: null };
  const protocol = {
    nextSocketOrdinal: 2,
    nextPageRpcSocketOrdinal: 2,
    pageWebSockets: [
      { path: "/rpc", rpcOrdinal: 1, closedAtMs: 3 },
      { path: "/rpc", rpcOrdinal: 2, closedAtMs: null },
    ],
    routeDiagnostics: [oldRoute, ownedRoute],
  };
  let pageClosed = false;
  let ownerCloseRequested = false;
  ownedRoute.closeForwarding = {
    clientCloseRequestCount: 0,
    upstreamCloseRequestCount: 0,
    closeRequestPendingCount: 0,
    closeRequestSettledCount: 0,
    closeForwardErrorCount: 0,
    requestCloseFromOwnerRelease() {
      assert.equal(pageClosed, false, "paired route close requests must precede owned Page disposal");
      ownerCloseRequested = true;
    },
  };
  const release = await closeMobileTimingTaskPage({
    page: { async close() { pageClosed = true; } },
    protocol,
    firstRouteSocketOrdinal: 1,
    firstPageRpcOrdinal: 1,
    requiredSocketOrdinal: 2,
    waitFor: async probe => {
      assert.equal(pageClosed, false);
      assert.equal(ownerCloseRequested, true);
      ownedRoute.clientClosedAtMs = 4;
      ownedRoute.upstreamClosedAtMs = 5;
      assert.equal(probe(), true);
    },
  });
  assert.equal(pageClosed, true, "owner Page closes after actual endpoint close evidence");
  assert.deepEqual(release, {
    pageClosed: true,
    rpcSocketCount: 1,
    allRouteEndpointsClosed: true,
    requiredSocketOrdinal: 2,
    requiredRouteEndpointsClosed: true,
  });
  assert.deepEqual(oldRoute, { socketOrdinal: 1, clientClosedAtMs: 2, upstreamClosedAtMs: 3 });
});

test("route diagnostic ring truncation must fail the exact owner-release barrier", async () => {
  const protocol = {
    nextSocketOrdinal: 3,
    nextPageRpcSocketOrdinal: 2,
    pageWebSockets: [
      { path: "/rpc", rpcOrdinal: 1, closedAtMs: 3 },
      { path: "/rpc", rpcOrdinal: 2, closedAtMs: 5 },
    ],
    routeDiagnostics: [
      { socketOrdinal: 2, clientClosedAtMs: 4, upstreamClosedAtMs: 4 },
      { socketOrdinal: 3, clientClosedAtMs: 5, upstreamClosedAtMs: 5 },
    ],
  };
  let pageClosed = false;

  await assert.rejects(closeMobileTimingTaskPage({
    page: { async close() { pageClosed = true; } },
    protocol,
    requiredSocketOrdinal: 3,
    waitFor: async probe => { assert.equal(probe(), true); },
  }), /route.*history.*truncated/i);
  assert.equal(pageClosed, true, "truncation must still close the exact owned page before failing");
});

test("page RPC observer maps only the exact lane endpoint and keeps credentials out of records", () => {
  const pageListeners = new Map();
  const protocol = { nextPageWebSocketOrdinal: 0, nextPageRpcSocketOrdinal: 0, pageWebSockets: [] };
  const registeredSecrets = [];
  const credentialsByRecord = new WeakMap();
  const socketListeners = new Map();
  const socket = {
    url: () => "ws://127.0.0.1:43001/g/gw-secret/rpc?server=server-secret&workspace=%2Fprivate%2Fworkspace&token=rpc-secret-token",
    on(event, callback) {
      const list = socketListeners.get(event) ?? [];
      list.push(callback);
      socketListeners.set(event, list);
    },
  };
  observeMobilePageRpcSockets({
    on(event, callback) { pageListeners.set(event, callback); },
  }, protocol, { registerSecret: value => registeredSecrets.push(value) },
  "http://127.0.0.1:43001/", "/g/gw-secret/rpc", credentialsByRecord);

  pageListeners.get("websocket")(socket);
  const [record] = protocol.pageWebSockets;
  assert.deepEqual({ path: record.path, ordinal: record.ordinal, rpcOrdinal: record.rpcOrdinal },
    { path: "/rpc", ordinal: 1, rpcOrdinal: 1 });
  assert.equal(JSON.stringify(record).includes("gw-secret"), false);
  assert.equal(JSON.stringify(record).includes("rpc-secret-token"), false);
  assert.deepEqual(credentialsByRecord.get(record), {
    host: "127.0.0.1:43001",
    path: "/g/gw-secret/rpc",
    serverId: "server-secret",
    workspace: "/private/workspace",
    rpcToken: "rpc-secret-token",
  });
  assert.deepEqual(registeredSecrets, ["rpc-secret-token"]);
  socketListeners.get("close")[0]();
  assert.equal(Number.isFinite(record.closedAtMs), true);

  const unrelated = {
    url: () => "ws://127.0.0.1:43002/g/gw-secret/rpc?token=foreign-secret-token",
    on() {},
  };
  pageListeners.get("websocket")(unrelated);
  assert.deepEqual(protocol.pageWebSockets.map(item => [item.path, item.rpcOrdinal]), [
    ["/rpc", 1], ["[non-rpc]", null],
  ]);
  assert.equal(registeredSecrets.includes("foreign-secret-token"), false);
});

test("Relay failure projection retains route and RPC outcomes but excludes private identifiers and credentials", () => {
  const projected = projectRelayBootstrapFailureEvidence({
    protocol: {
      requests: [{ method: "thread/resume", socketOrdinal: 4, threadId: "private-thread-id" }],
      rpcResponses: [{ method: "thread/resume", socketOrdinal: 4, success: false, threadId: "private-thread-id" }],
      routeDiagnostics: [{
        socketOrdinal: 4,
        clientClosedAtMs: null,
        upstreamClosedAtMs: null,
        clientToServerForwardCount: 1,
        serverToClientForwardCount: 0,
      }],
      pageWebSockets: [{ path: "/rpc", rpcOrdinal: 4, closedAtMs: null,
        sentFrameCount: 1, receivedFrameCount: 0 }],
    },
    routeAudit: {
      requestCount: 3,
      requestCountsByKind: { entry: 1, api: 1, rpc: 1 },
      websocketObservationCount: 1,
      violations: [],
      overflowed: false,
    },
    serverInventoryResponses: [{
      source: "Relay GET /api/servers",
      responseStatus: 200,
      bodyReadComplete: true,
      descriptors: [{ id: "private-gateway-id", runtime: "kcoder" }],
    }],
    browserErrorCount: 1,
    seedThreadId: "private-thread-id",
  });
  assert.equal(projected.rpcRequests[0].matchesSeedThread, true);
  assert.equal(projected.rpcResponses[0].success, false);
  assert.equal(projected.routeAudit.requestCountsByKind.rpc, 1);
  const serialized = JSON.stringify(projected);
  for (const secret of ["private-thread-id", "private-gateway-id", "token", "/private"]) {
    assert.equal(serialized.includes(secret), false, `failure projection must omit ${secret}`);
  }
});

test("cache observer uses the RunContext persistent-page factory and exact lane entry", async () => {
  const lane = createDirectMobileTimingLaneDescriptor({
    gatewayUrl: "http://127.0.0.1:43001/",
    mobileUrl: "http://127.0.0.1:43001/mobile/",
  });
  let closeCount = 0;
  let routeHandler = null;
  let currentUrl = "about:blank";
  const page = {
    on() {},
    async route(_pattern, callback) { routeHandler = callback; },
    async goto(url) {
      currentUrl = url;
      let continued = false;
      await routeHandler({
        request: () => ({ url: () => url, resourceType: () => "document" }),
        async continue() { continued = true; },
        async abort() {},
      });
      assert.equal(continued, true, "the exact Mobile entry document must pass through the lane guard");
      return { status: () => 200 };
    },
    url() { return currentUrl; },
    async close() { closeCount += 1; },
  };
  let persistentPageCalls = 0;
  const opened = await openMobileTimingCacheObserverPage({
    chromium: { async newPersistentPage() { persistentPageCalls += 1; return page; } },
    lane,
  });
  assert.equal(opened, page);
  assert.equal(persistentPageCalls, 1);
  assert.equal(currentUrl, lane.mobileEntryUrl);
  assert.equal(closeCount, 0);
});

test("cache observer closes its owned page when the entry escapes the lane contract", async () => {
  const lane = createDirectMobileTimingLaneDescriptor({
    gatewayUrl: "http://127.0.0.1:43001/",
    mobileUrl: "http://127.0.0.1:43001/mobile/",
  });
  let closeCount = 0;
  const page = {
    on() {},
    async route(_pattern, callback) {
      this.handler = callback;
    },
    async goto(url) {
      await this.handler({
        request: () => ({ url: () => url.replace("43001", "43002"), resourceType: () => "document" }),
        async continue() {},
        async abort() {},
      });
      return { status: () => 200 };
    },
    url() { return lane.mobileEntryUrl; },
    async close() { closeCount += 1; },
  };
  await assert.rejects(openMobileTimingCacheObserverPage({
    chromium: { async newPersistentPage() { return page; } }, lane,
  }), /HTTP 200|entry document|route|other lane resources/);
  assert.equal(closeCount, 1);
});

function timingChromiumHarness({ closeOwner = true, nextProfileDir = null,
  createError = null, sendError = null, browserExit = true } = {}) {
  const stateDir = "/run/mobile-cache-test/state";
  const profileName = "timing-profile";
  const profileDir = resolve(stateDir, "chromium", `${profileName}-profile`);
  const processes = new Map();
  const events = [];
  const context = {
    stateDir,
    processes,
    pathInState: (...parts) => resolve(stateDir, ...parts),
  };
  const makeOwner = (label, pid, pgid, ownerProfileDir = profileDir) => {
    const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null });
    const record = { label, child, pid, pgid, identity: { pid, pgid }, stopped: false, stopPromise: null, spawnError: null };
    processes.set(label, record);
    const browser = Object.assign(new EventEmitter(), {
      connected: true,
      isConnected() { return this.connected; },
      newBrowserCDPSession() {
        events.push("cdp-session");
        if (createError) throw createError;
        const session = Object.assign(new EventEmitter(), {
          send(method) {
            assert.equal(method, "Browser.close");
            events.push("cdp-close");
            if (browserExit) queueMicrotask(() => {
              events.push("natural-exit");
              child.exitCode = 0;
              browser.connected = false;
              browser.emit("disconnected");
              session.emit("close");
              child.emit("exit", 0, null);
            });
            return sendError ? Promise.reject(sendError) : Promise.resolve({});
          },
          async detach() {},
        });
        return session;
      },
    });
    return {
      profileDir: ownerProfileDir,
      child,
      browser,
      async close() {
        events.push("owner-cleanup");
        if (closeOwner) {
          record.stopped = true;
          record.stopPromise = Promise.resolve();
          if (child.exitCode === null && child.signalCode === null) {
            child.signalCode = "SIGTERM";
            child.emit("exit", null, "SIGTERM");
          }
        }
      },
    };
  };
  const current = makeOwner("timing-before", 1_500_000_000, 1_500_000_000);
  let starts = 0;
  return {
    context,
    current,
    profileName,
    profileDir,
    events,
    makeOwner,
    startChromium: async (_context, options) => {
      starts += 1;
      events.push("restart");
      assert.equal(processes.get("timing-before").stopped, true,
        "the old exact process tree must exit before the next profile owner starts");
      assert.equal(options.profileName, profileName);
      assert.equal(options.portLabel, `${options.label}-cdp`);
      return makeOwner(options.label, 1_500_000_001, 1_500_000_001, nextProfileDir ?? profileDir);
    },
    starts: () => starts,
  };
}

test("process-cold timing accepts TargetClosed only after natural owner exit, cleanup, and exact profile reuse", async () => {
  const harness = timingChromiumHarness({
    sendError: new Error("cdpSession.send: Target page, context or browser has been closed"),
  });
  const result = await releaseMobileTimingChromium({
    ...harness,
    chromium: harness.current,
    currentLabel: "timing-before",
    nextLabel: "timing-after",
    restart: true,
    reason: "sample-boundary",
  });
  assert.equal(harness.starts(), 1);
  assert.deepEqual(harness.events, ["cdp-session", "cdp-close", "natural-exit", "owner-cleanup", "restart"],
    "actual browser shutdown and natural child exit must precede process cleanup and profile reuse");
  assert.equal(result.chromium.profileDir, harness.profileDir);
  assert.deepEqual(result.evidence, {
    status: "PASS",
    reason: "sample-boundary",
    browserOwnerReleased: true,
    gracefulExitObserved: true,
    profileExit: result.evidence.profileExit,
    processGroupGone: true,
    sameProfileDir: true,
    restartRequested: true,
    oldPid: 1_500_000_000,
    oldPgid: 1_500_000_000,
    newPid: 1_500_000_001,
    newPgid: 1_500_000_001,
    profileDir: "chromium/timing-profile-profile",
    closeMs: result.evidence.closeMs,
    startupMs: result.evidence.startupMs,
    restartMs: result.evidence.restartMs,
  });
  assert.ok([result.evidence.closeMs, result.evidence.startupMs, result.evidence.restartMs]
    .every(value => Number.isFinite(value) && value >= 0));
  assert.equal(result.evidence.profileExit.outcome, "graceful-exit-observed");
  assert.equal(result.evidence.profileExit.fallbackUsed, false);
  assert.equal(result.evidence.profileExit.childExitCode, 0);
  assert.equal(result.evidence.profileExit.childSignalCode, null);
  assert.equal(result.evidence.profileExit.processTreeClearBeforeRelease, true);
});

for (const failure of ["cdp-create", "cdp-send", "child-exit-timeout"]) {
  test(`process-cold timing ${failure} fails the sample, cleans its exact owner, and never restarts`, async () => {
    const primary = new Error(`injected ${failure}`);
    const harness = timingChromiumHarness({
      createError: failure === "cdp-create" ? primary : null,
      sendError: failure === "cdp-send" ? primary : null,
      browserExit: failure !== "child-exit-timeout",
    });
    await assert.rejects(releaseMobileTimingChromium({
      ...harness,
      chromium: harness.current,
      currentLabel: "timing-before",
      nextLabel: "timing-after",
      restart: true,
      reason: "sample-boundary",
      closeTimeoutMs: 25,
    }), error => failure === "child-exit-timeout" ? /child-exit-timeout/.test(error.message) : error === primary);
    assert.equal(harness.starts(), 0, "failed shutdown cannot authorize another owner on this profile");
    assert.equal(harness.context.processes.get("timing-before").stopped, true);
    assert.ok(harness.events.includes("owner-cleanup"), "even a shutdown failure must clean its exact owner");
  });
}

test("process-cold timing release fails closed when Browser.close does not prove exact PGID exit", async () => {
  const harness = timingChromiumHarness({ closeOwner: false });
  await assert.rejects(releaseMobileTimingChromium({
    ...harness,
    chromium: harness.current,
    currentLabel: "timing-before",
    nextLabel: "timing-after",
    restart: true,
    reason: "sample-boundary",
  }), /process-tree|stopped|exited/i);
  assert.equal(harness.starts(), 0, "a second profile owner must not start before the old owner is gone");
});

test("process-cold timing release waits for the exact RunContext stop promise before relaunch", async () => {
  const harness = timingChromiumHarness();
  const record = harness.context.processes.get("timing-before");
  let settleStop;
  harness.current.close = async () => {
    record.stopped = true;
    record.child.exitCode = 0;
    record.stopPromise = new Promise(resolveStop => { settleStop = resolveStop; });
  };
  const pending = releaseMobileTimingChromium({
    ...harness,
    chromium: harness.current,
    currentLabel: "timing-before",
    nextLabel: "timing-after",
    restart: true,
    reason: "sample-boundary",
  });
  await new Promise(resolveTurn => setImmediate(resolveTurn));
  assert.equal(harness.starts(), 0, "relaunch must wait for the exact owned process-tree stop operation");
  settleStop();
  const result = await pending;
  assert.equal(harness.starts(), 1);
  assert.equal(result.evidence.processGroupGone, true);
});

test("process-cold timing release closes a replacement owner when profile reuse is not exact", async () => {
  const harness = timingChromiumHarness({ nextProfileDir: "/run/mobile-cache-test/state/chromium/other-profile" });
  await assert.rejects(releaseMobileTimingChromium({
    ...harness,
    chromium: harness.current,
    currentLabel: "timing-before",
    nextLabel: "timing-after",
    restart: true,
    reason: "sample-boundary",
  }), /same RunContext-owned profile/);
  assert.equal(harness.context.processes.get("timing-after").stopped, true,
    "an incorrectly profiled replacement must be closed before reporting failure");
});

test("the final process-cold timing sample closes its exact owner without an unused relaunch", async () => {
  const harness = timingChromiumHarness();
  const result = await releaseMobileTimingChromium({
    ...harness,
    chromium: harness.current,
    currentLabel: "timing-before",
    profileName: harness.profileName,
    restart: false,
    reason: "final-sample",
  });
  assert.equal(harness.starts(), 0);
  assert.equal(result.chromium, null);
  assert.equal(harness.context.processes.get("timing-before").stopped, true);
  assert.equal(result.evidence.newPid, null);
  assert.equal(result.evidence.newPgid, null);
  assert.equal(result.evidence.startupMs, null);
  assert.equal(result.evidence.processGroupGone, true);
});
