import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createHomeServersRevisionDiagnosticControl } from "./home-servers-revision-diagnostic.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const round = value => Number(value.toFixed(3));
let clock;

function createControl() {
  clock = 1_000;
  return createHomeServersRevisionDiagnosticControl({
    stage: "sample-stage",
    actionId: "home:sample-01",
    epochNow: () => clock,
    round,
    sha256: hash,
    existingThreadId: "existing-thread",
    diagnosticThreadId: "diagnostic-thread",
    diagnosticTitle: "diagnostic row",
  });
}

function mockResponse(body) {
  return { body: async () => Buffer.from(JSON.stringify(body)) };
}

function threadListResponse({ request, routeInfo, routeSocketId, pageId, ledger, sentAtEpochMs, rpcOverrides = {} }) {
  const rpcRequest = {
    method: "thread/list",
    rpcIdFingerprint: `rpc-${sentAtEpochMs}`,
    stage: "sample-stage",
    actionId: "home:sample-01",
    sentAtEpochMs,
    threadListArchived: false,
    threadListCursorPresent: false,
    ...rpcOverrides,
  };
  const frame = { id: sentAtEpochMs, result: { threads: [{ id: "existing-thread", cwd: "/owned/workspace", title: "existing" }] } };
  const transformed = request.observeRpcResponse({
    frame,
    request: rpcRequest,
    routeInfo,
    routeSocketId,
    pageId,
    receivedAtEpochMs: sentAtEpochMs + 2,
    ledger,
  });
  return { transformed, rpcRequest };
}

test("Home revision control holds only the armed status response and releases once", async () => {
  const control = createControl();
  const heldRequest = { apiPath: "/api/servers/status", stage: "sample-stage" };
  assert.equal(control.statusHold.release("too-early"), true);
  assert.equal(control.statusHold.state, "RELEASED");
  assert.equal(control.statusHold.release("duplicate"), false);

  const armed = createControl();
  armed.statusHold.arm(900);
  const held = armed.statusHold.hold(heldRequest);
  await Promise.resolve();
  assert.equal(armed.statusHold.state, "PENDING");
  assert.equal(armed.statusHold.request, heldRequest);
  assert.equal(armed.statusHold.release("assertions-complete"), true);
  assert.equal(await held, true);
  assert.equal(armed.statusHold.state, "RELEASED");
  assert.equal(armed.statusHold.releaseReason, "assertions-complete");
});

test("synthetic Home row is added once only after unchanged inventory forwarding in the exact target scope", async () => {
  const control = createControl();
  control.pageId = 7;
  const routeInfo = { serverFingerprint: "server-a", channelFingerprint: "channel-a", workspaceFingerprint: "workspace-a" };
  const ledger = { httpResponsePathDelays: [] };
  const initial = threadListResponse({ request: control, routeInfo, routeSocketId: 4, pageId: 7, ledger, sentAtEpochMs: 800 });
  assert.equal(initial.transformed.result.threads.length, 1);
  assert.equal(control.targetScope.rawWorkspaceFingerprint, hash("/owned/workspace").slice(0, 16));

  control.statusHold.arm(900);
  const holdPromise = control.statusHold.hold({ apiPath: "/api/servers/status" });
  await Promise.resolve();
  const inventoryRequest = {
    routeRequestOrdinal: 12,
    apiPath: "/api/servers",
    startedAtEpochMs: 950,
    owner: null,
  };
  await control.observeHttpResponse({
    apiPath: "/api/servers",
    request: { headers: () => ({ authorization: "Bearer fixture-token", cookie: "" }) },
    routeRequest: inventoryRequest,
    response: mockResponse({ servers: [{ id: "server-a" }] }),
  });
  assert.equal(control.serverRefreshResponse, inventoryRequest);
  assert.equal(inventoryRequest.owner.bearerPresent, true);
  assert.equal(inventoryRequest.owner.cookiePresent, false);
  assert.equal(JSON.stringify(inventoryRequest).includes("fixture-token"), false);
  ledger.httpResponsePathDelays.push({ routeRequestOrdinal: 12, forwardedAtEpochMs: 1_000 });
  clock = 1_010;

  const active = threadListResponse({ request: control, routeInfo, routeSocketId: 4, pageId: 7, ledger, sentAtEpochMs: 1_001 });
  assert.equal(active.transformed.result.threads.length, 2);
  assert.equal(active.transformed.result.threads[1].id, "diagnostic-thread");
  assert.equal(active.rpcRequest.homeRevisionThreadListResponse.fixtureInjected, true);
  assert.equal(control.fixtureInjection.onlyThisTargetScopeResponse, true);
  assert.equal(control.fixtureInjection.serversResponseForwardedAtEpochMs, 1_000);

  const later = threadListResponse({ request: control, routeInfo, routeSocketId: 4, pageId: 7, ledger, sentAtEpochMs: 1_020 });
  assert.equal(later.transformed.result.threads.length, 1);
  assert.equal(later.rpcRequest.homeRevisionThreadListResponse.fixtureInjected, false);
  control.statusHold.release("test-finished");
  await holdPromise;
});

test("a different route scope or an archived/cursor list cannot receive the diagnostic row", async () => {
  const control = createControl();
  control.pageId = 7;
  const routeInfo = { serverFingerprint: "server-a", channelFingerprint: "channel-a", workspaceFingerprint: "workspace-a" };
  const ledger = { httpResponsePathDelays: [] };
  threadListResponse({ request: control, routeInfo, routeSocketId: 4, pageId: 7, ledger, sentAtEpochMs: 800 });
  control.statusHold.arm(900);
  const holdPromise = control.statusHold.hold({ apiPath: "/api/servers/status" });
  await Promise.resolve();
  const inventoryRequest = { routeRequestOrdinal: 12, startedAtEpochMs: 950 };
  await control.observeHttpResponse({
    apiPath: "/api/servers",
    request: { headers: () => ({ authorization: "Bearer fixture-token", cookie: "" }) },
    routeRequest: inventoryRequest,
    response: mockResponse({ servers: [{ id: "server-a" }] }),
  });
  ledger.httpResponsePathDelays.push({ routeRequestOrdinal: 12, forwardedAtEpochMs: 1_000 });

  for (const override of [
    { routeInfo: { ...routeInfo, workspaceFingerprint: "other-workspace" } },
    { rpcOverrides: { threadListArchived: true } },
    { rpcOverrides: { threadListCursorPresent: true } },
    { pageId: 8 },
  ]) {
    const inputs = {
      request: control,
      routeInfo,
      routeSocketId: 4,
      pageId: 7,
      ledger,
      sentAtEpochMs: 1_001,
      ...override,
    };
    const result = threadListResponse(inputs);
    assert.equal(result.transformed.result.threads.length, 1);
  }
  control.statusHold.release("test-finished");
  await holdPromise;
});
