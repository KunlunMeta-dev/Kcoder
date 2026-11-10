import assert from "node:assert/strict";
import test from "node:test";
import {
  captureMobileRouteFailure,
  isExpectedMobileReloadSocketClose,
  observeMobileRuntimeInitialize,
} from "./mobile-runtime-initialize.mjs";

const gatewayBaseUrl = "http://127.0.0.1:4173";
const workspacePath = "/private/run/workspace";
const warning = {
  kind: "warning",
  phase: "page-reload-restore",
  message: "WebSocket connection to 'ws://127.0.0.1:4173/rpc?token=%5BREDACTED%5D&server=local&channel=runtime&workspace=%2Fprivate%2Frun%2Fworkspace' failed: WebSocket is closed before the connection is established.",
};

test("reload socket warning classifier requires exact phase, origin, route and message", () => {
  const options = { gatewayBaseUrl, workspacePath };
  assert.equal(isExpectedMobileReloadSocketClose(warning, options), true);
  assert.equal(isExpectedMobileReloadSocketClose({ ...warning, phase: "idle" }, options), false);
  assert.equal(isExpectedMobileReloadSocketClose({ ...warning, message: warning.message.replace("channel=runtime", "channel=browser") }, options), false);
  assert.equal(isExpectedMobileReloadSocketClose({ ...warning, message: warning.message.replace("server=local", "server=remote") }, options), false);
  assert.equal(isExpectedMobileReloadSocketClose({ ...warning, message: warning.message.replace("127.0.0.1:4173", "127.0.0.1:4174") }, options), false);
  assert.equal(isExpectedMobileReloadSocketClose({ ...warning, message: warning.message.replace("closed before the connection is established", "failed") }, options), false);
});

test("runtime observer waits for a matching successful initialize response", async () => {
  let websocketListener;
  const page = { on: (event, listener) => { if (event === "websocket") websocketListener = listener; } };
  let phase = "page-reload-restore";
  const observer = observeMobileRuntimeInitialize(page, {
    gatewayBaseUrl,
    workspacePath,
    getPhase: () => phase,
    redactText: observerRedact,
  });
  const handlers = new Map();
  websocketListener({
    url: () => `ws://127.0.0.1:4173/rpc?token=private&server=local&channel=runtime&workspace=${encodeURIComponent(workspacePath)}`,
    on: (event, listener) => handlers.set(event, listener),
  });
  handlers.get("framesent")({ payload: JSON.stringify({ id: 7, method: "initialize" }) });
  phase = "post-reload-actions";
  handlers.get("framereceived")({ payload: JSON.stringify({ id: 7, result: { protocolVersion: "2026-07-27" } }) });

  const initialized = await observer.waitForSuccessfulInitializeAfter(0, 100);

  assert.deepEqual(initialized, {
    testPhase: "post-reload-actions",
    requestTestPhase: "page-reload-restore",
    success: true,
    protocolVersion: "2026-07-27",
    socketIndex: 0,
    testPhaseAtSocket: "page-reload-restore",
  });
  assert.equal(JSON.stringify(observer.sockets).includes("private"), false, "the observer must not retain the socket credential");
});

test("runtime observer records close/error stages without retaining the socket URL", () => {
  let websocketListener;
  const page = { on: (event, listener) => { if (event === "websocket") websocketListener = listener; } };
  let phase = "page-reload-restore";
  const observer = observeMobileRuntimeInitialize(page, {
    gatewayBaseUrl,
    workspacePath,
    getPhase: () => phase,
    redactText: observerRedact,
  });
  const handlers = new Map();
  websocketListener({
    url: () => `ws://127.0.0.1:4173/rpc?token=secret&server=local&channel=runtime&workspace=${encodeURIComponent(workspacePath)}`,
    on: (event, listener) => handlers.set(event, listener),
  });

  handlers.get("socketerror")(`WebSocket handshake failed at ws://127.0.0.1:4173/rpc?token=secret&workspace=${encodeURIComponent(workspacePath)}`);
  phase = "post-reload-actions";
  handlers.get("close")();

  assert.deepEqual(observer.sockets[0].lifecycle, [
    { event: "websocket-created", testPhase: "page-reload-restore" },
    { event: "socketerror", testPhase: "page-reload-restore", message: "WebSocket handshake failed at [REDACTED_URL]" },
    { event: "close", testPhase: "post-reload-actions" },
  ]);
  const evidence = JSON.stringify(observer.sockets);
  assert.equal(evidence.includes("secret"), false);
  assert.equal(evidence.includes(workspacePath), false);
  assert.equal(evidence.includes("ws://"), false);
});

test("route failure evidence keeps only pathname, bounded controls and redacted diagnostics", async () => {
  const artifacts = new Map();
  const screenshotPaths = [];
  const context = {
    redactText(value) { return String(value).replaceAll("private-secret", "[REDACTED]"); },
    pathInArtifacts(name) { return `/run/artifacts/${name}`; },
    async writeArtifactJson(name, value) { artifacts.set(name, value); },
  };
  const page = {
    url: () => "http://127.0.0.1:4173/mobile/new?token=private-secret&draft=private-secret",
    getByTestId: testId => ({
      count: async () => testId === "new-task-draft" ? 0 : 1,
      evaluateAll: async () => testId === "new-task-draft" ? 0 : 1,
    }),
    locator: () => ({ evaluateAll: async () => ["New task", "Alert private-secret"] }),
    screenshot: async options => { screenshotPaths.push(options.path); },
  };
  const evidence = await captureMobileRouteFailure(page, {
    context,
    artifactName: "route-failure.json",
    screenshotName: "route-failure.png",
    testPhase: "create-task-after-home-new",
    testIds: ["new-task-draft", "workspace-path"],
    diagnosticEvents: [{
      phase: "idle",
      type: "warning",
      message: "WebSocket failed at ws://127.0.0.1:4173/rpc?token=private-secret&workspace=%2Fprivate",
      location: { url: "http://127.0.0.1:4173/mobile/_expo/entry.js?token=private-secret" },
    }],
    runtimeSocketObservations: [{ routeMatches: true, lifecycle: [{ event: "close" }] }],
    error: new Error("wait failed at https://gateway.invalid/rpc?token=private-secret"),
  });

  assert.equal(evidence.pathname, "/mobile/new");
  assert.deepEqual(evidence.controls, [
    { testId: "new-task-draft", count: 0, visibleCount: 0 },
    { testId: "workspace-path", count: 1, visibleCount: 1 },
  ]);
  assert.deepEqual(evidence.headingsAndAlerts, ["New task", "Alert [REDACTED]"]);
  assert.deepEqual(evidence.consolePageErrors, [{
    testPhase: "idle",
    type: "warning",
    message: "WebSocket failed at /rpc",
    locationPathname: "/mobile/_expo/entry.js",
  }]);
  assert.deepEqual(screenshotPaths, ["/run/artifacts/route-failure.png"]);
  assert.equal(artifacts.get("route-failure.json"), evidence);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("private-secret"), false);
  assert.equal(serialized.includes("token="), false);
  assert.equal(serialized.includes("?draft="), false);
});

function observerRedact(value) { return String(value); }
