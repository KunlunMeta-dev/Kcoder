// One-shot P1-C history-first diagnostic for auxiliary RPC failures.
// This mounts the matched Git 992 Mobile Web bundle on the frozen mock Gateway;
// it is not an official Expo receipt, Rust pagination, Provider, Relay, or device claim.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { materializeMatchedMobileStaticDist } from "../harness/matched-mobile-static-dist.mjs";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { makeHistoryPage } from "./p1c-render-history.fixture.mjs";

const RUN_FLAG = "KCODER_E2E_PRIVATE_HISTORY_AUX_RPC_FAILURE";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const SOURCE_COMMIT = "9925461ca047031f3f7f37d1f039d986c305fec3";
const THREAD = "mock-active-session";
const SERVER = "local";
const DRAFT = "P1C_AUX_RPC_DRAFT";
const PREFIX = "kcoder-studio:mobile-workspace-state:v3";
const MODEL = "mock-mobile";
const EFFORT = "high";
const CONTROLLED_ERROR = Object.freeze({ code: -32601, message: "P1C controlled auxiliary read failure" });
const MATCHED_EXPORT_MANIFEST_RELATIVE_PATH = "target/private-phone-ux-validation/new-common-dependencies-before10feb-after992-20261009/run-d065c8c452c648f7/comparison-9925461c/export-manifest.json";
const MATCHED_EXPORT_MANIFEST_SHA256 = "f2f262624d4a2286ef31e250fb1752e02ab9a41232196b5591dafc5d8369d14d";
const MATCHED_BUNDLE_SHA256 = "e4a7277de6ecb2afb8f68dee52dfdf3b5a270c0e0c2e7f46cbdba02e83e140ab";
const MATCHED_SOURCE_TREE_SHA256 = "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020";
const MATCHED_DEPENDENCY_SOURCE_TREE_SHA256 = "46b02fc5ac823118f6eb2c034ea3f1d9cbbf79b71041fc2fa848f79a9abca1c6";
const MATCHED_DEPENDENCY_OWNED_TREE_SHA256 = "51b0c6987324fa5b6dbc17d8ea34ff83dd832deaa06c9c1193f84465a89001e4";
const MATCHED_DEPENDENCY_FILE_COUNT = 52524;
const MATCHED_INPUT_ROOTS = Object.freeze([
  Object.freeze({ name: "mobile", destination: "apps/kcoder-studio/mobile", sha256: "8a0963fb62846395dcdf1162470452d20fff84eed51adb44311fb75c5d327455", fileCount: 350 }),
  Object.freeze({ name: "studio-shared", destination: "apps/kcoder-studio/shared", sha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88", fileCount: 19 }),
]);
const GATEWAY_SNAPSHOT_RELATIVE_PATH = "target/private-phone-ux-implementation/shared-gateway-current-20261009/snapshot-20261009-223221.326Z";
const GATEWAY_MANIFEST_SHA256 = "0219dce48d65e6413ce60d0aadfe1fe8047426c6570689ecaf77d757f256cda5";
const GATEWAY_SOURCE_TREE_SHA256 = "6a8255fa538d6f2534d1784a088de9757283e8935e69a0d78a95358bb49ae197";
const GATEWAY_DEPENDENCY_TREE_SHA256 = "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954";
const GATEWAY_DEV_SERVER_SHA256 = "0b70b5262eba51c5018750411116b416d92355506637553e48f6e1b29fb4b161";
const GATEWAY_BINARY_RELATIVE_PATH = "target/private-b6-device-revoke-20261009/build-03/owned-kcoder-copy";
const GATEWAY_BINARY_SHA256 = "bc985854134edffc02415a5d9e72f8905fdc23e7e2263e84f9554e53619dec29";
const GATEWAY_NODE_VERSION = "v22.17.0";
const ALLOWED_RPC_REQUEST_METHODS = new Set([
  "initialize", "thread/list", "thread/resume", "thread/read", "agent/list",
  "runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list",
]);
const ALLOWED_RPC_NOTIFICATION_METHODS = new Set(["initialized"]);
const KNOWN_MUTATING_RPC_METHODS = new Set([
  "thread/start", "thread/fork", "thread/compact", "thread/rollback", "thread/delete", "thread/dispose",
  "thread/metadata/update", "thread/sessionMode/set", "thread/goal/set", "thread/goal/clear",
  "turn/start", "turn/interrupt", "turn/shorten_wait",
  "runtime.providers.upsert", "runtime.providers.delete", "runtime.providers.clearUserOverride",
  "runtime.worktrees.create", "runtime.worktrees.archive", "runtime.worktrees.restore",
  "workspace/file/importAttachment", "attachment/save", "attachment/delete", "device/execute",
  "terminal/start", "terminal/write", "terminal/close", "browser/action", "browser/close",
]);
const sha256 = value => createHash("sha256").update(value).digest("hex");

function distanceToFullyVisibleOlderControlPx(control) {
  if (!control.rect || !control.viewportClipRect) return null;
  return Math.max(
    0,
    control.viewportClipRect.top - control.rect.top,
    control.rect.bottom - control.viewportClipRect.bottom,
  );
}

const olderControlDistanceCases = Object.freeze([
  Object.freeze({
    name: "observed-control-above-viewport",
    control: Object.freeze({
      rect: Object.freeze({ top: -12787, bottom: -12743 }),
      viewportClipRect: Object.freeze({ top: 60, bottom: 711 }),
    }),
    expectedPx: 12847,
  }),
  Object.freeze({
    name: "control-already-visible",
    control: Object.freeze({
      rect: Object.freeze({ top: 100, bottom: 144 }),
      viewportClipRect: Object.freeze({ top: 60, bottom: 711 }),
    }),
    expectedPx: 0,
  }),
  Object.freeze({
    name: "control-below-viewport",
    control: Object.freeze({
      rect: Object.freeze({ top: 740, bottom: 784 }),
      viewportClipRect: Object.freeze({ top: 60, bottom: 711 }),
    }),
    expectedPx: 73,
  }),
]);

if (process.argv[2] === "--self-check-older-control-distance") {
  const results = olderControlDistanceCases.map(testCase => {
    const actualPx = distanceToFullyVisibleOlderControlPx(testCase.control);
    assert.equal(actualPx, testCase.expectedPx, `${testCase.name} distance calculation`);
    return { name: testCase.name, expectedPx: testCase.expectedPx, actualPx };
  });
  console.log(JSON.stringify({ check: "older-control-distance", status: "passed", results }));
  process.exit(0);
}

if (process.env[RUN_FLAG] !== "1") throw new Error(`${RUN_FLAG}=1 is required for this private one-shot diagnostic`);
if (process.execPath !== EXPECTED_NODE || process.version !== GATEWAY_NODE_VERSION) throw new Error("pinned Node 22.17.0 is required");
if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1") throw new Error("KCODER_E2E_CHROMIUM_NO_SANDBOX=1 is required");

await runE2E(import.meta.url, {
  testId: "mobile-p1c-history-first-aux-rpc-failure",
  tier: "manual-live",
  modelPolicy: "matched Git 992 Mobile Web export adapted to the frozen current Gateway static mount; compact plain-text 50-row history fixture for functional history-first and auxiliary-error recovery coverage; long-Markdown/tool/file-card render stress remains in the separate CPU profile; client-facing controlled JSON-RPC rejects for scoped agent/list and thread-bound runtime.models.list; no original Expo receipt, Rust pagination, Provider, public Gateway, Relay, or native-device claim",
  retainSuccessLogs: true,
}, async context => {
  const exportManifestPath = resolve(repoRoot, MATCHED_EXPORT_MANIFEST_RELATIVE_PATH);
  const mobile = await materializeMatchedMobileStaticDist(context, {
    bundleRoot: resolve(dirname(exportManifestPath), "bundle"),
    exportManifestPath,
    expectedExportManifestSha256: MATCHED_EXPORT_MANIFEST_SHA256,
    expectedBundleSha256: MATCHED_BUNDLE_SHA256,
    expectedSourceTreeSha256: MATCHED_SOURCE_TREE_SHA256,
    expectedDependencySourceTreeSha256: MATCHED_DEPENDENCY_SOURCE_TREE_SHA256,
    expectedDependencyOwnedTreeSha256: MATCHED_DEPENDENCY_OWNED_TREE_SHA256,
    expectedDependencyFileCount: MATCHED_DEPENDENCY_FILE_COUNT,
    expectedInputRoots: MATCHED_INPUT_ROOTS,
    outputName: "p1c-history-aux-mobile-dist",
    stagingName: "p1c-history-aux-mobile-dist-staging",
    artifactName: "matched-mobile-static-dist.json",
    comparisonId: "git-992-history-aux-rpc-failure",
  });

  const latencyHelpers = createMobileLatencyHelpers({ sha256 });
  const gatewayRuntime = await latencyHelpers.prepareGatewayRuntimeSnapshot(
    context,
    GATEWAY_SNAPSHOT_RELATIVE_PATH,
    resolve(repoRoot, GATEWAY_BINARY_RELATIVE_PATH),
    GATEWAY_BINARY_SHA256,
  );
  assert.equal(gatewayRuntime.manifestSha256, GATEWAY_MANIFEST_SHA256);
  assert.equal(gatewayRuntime.manifest.sourceTreeSha256, GATEWAY_SOURCE_TREE_SHA256);
  assert.equal(gatewayRuntime.manifest.dependencyTreeSha256, GATEWAY_DEPENDENCY_TREE_SHA256);
  assert.ok(gatewayRuntime.manifest.sourceFiles.some(file => file.path === "src/mobile-web-static.js"), "frozen Gateway must contain its Mobile static mount");
  assert.equal(gatewayRuntime.manifest.sourceFiles.find(file => file.path === "dev-server.mjs")?.sha256, GATEWAY_DEV_SERVER_SHA256);
  assert.equal(gatewayRuntime.binaryPath, resolve(repoRoot, GATEWAY_BINARY_RELATIVE_PATH));
  assert.equal(gatewayRuntime.manifest.runtimeInputs.kcoderBinarySha256, GATEWAY_BINARY_SHA256);

  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: SERVER,
    label: "P1-C auxiliary RPC fixture",
    runtime: "kcoder",
    transport: "local",
    workspacePath: workspace,
    command: process.execPath,
  }]);
  const gateway = await startGateway(context, {
    label: "p1c-history-aux-mock-gateway",
    workspace,
    serversFile,
    gatewayRoot: gatewayRuntime.root,
    cwd: gatewayRuntime.root,
    kcoderBin: resolve(repoRoot, GATEWAY_BINARY_RELATIVE_PATH),
    auth: true,
    env: {
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobile.ownedRoot,
    },
  });
  const chromium = await startChromium(context, { label: "p1c-history-aux-chromium" });
  const browserContext = await chromium.browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
  });
  context.addCleanup("close P1-C history auxiliary Browser context", () => browserContext.close());
  const page = await browserContext.newPage();
  const browserErrors = [];
  const unhandledRejections = [];
  page.on("pageerror", error => browserErrors.push(context.redactText(error.message).slice(0, 400)));
  const rpc = await installRpcFixture(page, workspace);
  page.on("websocket", websocket => {
    const route = routeFromUrl(websocket.url());
    websocket.on("framereceived", frame => rpc.recordPlaywrightFrame(route, frame.payload));
  });
  await page.exposeFunction("__p1cAuxRecordUnhandled", message => unhandledRejections.push(String(message).slice(0, 400)));
  await page.exposeFunction("__p1cAuxRecordBrowserError", observation => rpc.recordBrowserReceived(observation));
  await page.addInitScript(() => {
    globalThis.__p1cAuxUnhandled = [];
    addEventListener("unhandledrejection", event => {
      const reason = event.reason;
      const message = String(reason?.message ?? reason).slice(0, 400);
      globalThis.__p1cAuxUnhandled.push(message);
      void globalThis.__p1cAuxRecordUnhandled(message).catch(() => {});
    });
    globalThis.__p1cAuxExpectedError = null;
    const webSocketRoute = value => {
      try {
        const url = new URL(String(value));
        return {
          server: url.searchParams.get("server"),
          workspace: url.searchParams.get("workspace"),
          channel: url.searchParams.get("channel"),
        };
      } catch { return null; }
    };
    const instrument = Constructor => new Proxy(Constructor, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        const route = webSocketRoute(args[0]);
        if (route && typeof socket.addEventListener === "function") {
          socket.addEventListener("message", event => {
            let frame;
            try { frame = JSON.parse(String(event.data)); } catch { return; }
            const expected = globalThis.__p1cAuxExpectedError;
            if (!expected || route.server !== expected.route.server || route.workspace !== expected.route.workspace ||
                route.channel !== expected.route.channel || frame?.jsonrpc !== "2.0" || frame.id !== expected.id ||
                frame.error?.code !== expected.code) return;
            const observation = {
              source: "browser-websocket-message-event",
              scenarioId: expected.scenarioId,
              method: expected.method,
              id: frame.id,
              code: frame.error.code,
              message: frame.error.message,
              jsonrpc: frame.jsonrpc,
              route,
            };
            globalThis.__p1cAuxBrowserReceived ??= [];
            globalThis.__p1cAuxBrowserReceived.push(observation);
            void globalThis.__p1cAuxRecordBrowserError(observation).catch(() => {});
          });
        }
        return socket;
      },
    });
    window.WebSocket = instrument(window.WebSocket);
  });

  const cases = [];
  try {
    await pairThroughUi(page, gateway);

    const agentCase = rpc.arm("agent-list", "agent/list");
    await page.getByTestId(`thread-${THREAD}`).click();
    await rpc.waitUntilHeld(agentCase, context);
    await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("message-input").fill(DRAFT);
    const scopeKey = await waitFor(() => findExactStoredScope(page), 10_000, "exact task scope key after draft persistence", 25, context.abortSignal);
    assert.ok(scopeKey, "the current local task scope must be observed before seeding effort preferences");
    const taskUrl = page.url();
    await assertHistoryVisible(page);
    markPhase(agentCase, "history-visible-before-error");
    const agentOlderPage = await loadOlderPage(page, rpc, context, agentCase);
    assert.equal(agentCase.initializeCapabilityAdvertised, true, "the scoped initialize response must advertise agentSteering");
    assert.equal(agentCase.targetRequests.length, 1, "exactly one scoped agent/list request must be observed and held");
    await rpc.armBrowserError(page, agentCase);
    const agentResult = await rpc.rejectHeld(agentCase);
    await rpc.waitForBrowserReceived(agentCase, context);
    await assertHistoryVisible(page);
    assert.equal(await page.getByTestId("message-input").inputValue(), DRAFT);
    const agentAfterErrorPage = await loadOlderPage(page, rpc, context, agentCase, "post-error-older-page-request-observed-and-history-visible");
    await verifyPostErrorDraft(page, scopeKey, agentCase, context);
    cases.push({ ...summarizeCase(agentCase, agentOlderPage, agentResult), capabilityActivated: "agentSteering", postErrorOlderPage: agentAfterErrorPage });

    await backToHome(page);
    const seeded = await seedModelEffort(page, scopeKey);
    assert.deepEqual(seeded, { model: MODEL, reasoningEffort: EFFORT, draftPresent: true }, "thread-bound model restoration must be armed by real scoped preferences");
    const modelCase = rpc.arm("thread-model-effort", "runtime.models.list");
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await rpc.waitUntilHeld(modelCase, context);
    await assertHistoryVisible(page);
    await assertConfigurationHeldUi(page);
    markPhase(modelCase, "history-visible-and-configuration-gated-before-error");
    const modelOlderPage = await loadOlderPage(page, rpc, context, modelCase);
    await assertConfigurationHeldUi(page);
    assert.equal(modelCase.targetRequests.length, 1, "exactly one scoped thread-bound runtime.models.list request must be observed and held");
    await rpc.armBrowserError(page, modelCase);
    const modelResult = await rpc.rejectHeld(modelCase);
    await rpc.waitForBrowserReceived(modelCase, context);
    await assertHistoryVisible(page);
    await waitFor(async () => !(await page.getByTestId("task-header-status").innerText()).includes("正在校验任务配置"),
      10_000, "configuration readiness after the scoped model read fallback", 25, context.abortSignal);
    assert.equal(await page.getByTestId("message-input").inputValue(), DRAFT);
    assert.equal(await page.getByTestId("send-message").isEnabled(), true, "local fallback restores the existing send-ready gate; no message is submitted");
    const modelAfterErrorPage = await loadOlderPage(page, rpc, context, modelCase, "post-error-older-page-request-observed-and-history-visible");
    await verifyPostErrorDraft(page, scopeKey, modelCase, context);
    assert.equal(await page.getByTestId("send-message").isEnabled(), true, "send gate remains open after post-error history and draft reads; no send is clicked");
    cases.push({ ...summarizeCase(modelCase, modelOlderPage, modelResult), localPreferenceSeed: seeded, sendEnabledAfterFallback: true, postErrorOlderPage: modelAfterErrorPage });

    assert.equal(rpc.mutations.length, 0, "no method in the explicitly enumerated known-mutation set may be dispatched");
    assert.equal(rpc.unknownRpcRequests.length, 0, "only the explicit startup/read RPC and initialized-notification allowlist may be forwarded");
    assert.deepEqual(browserErrors, [], "no uncaught Browser page errors");
    assert.deepEqual(unhandledRejections, [], "no unhandled promise rejections across either full-page scenario");
    assert.equal(cases.length, 2);
    const result = {
      schemaVersion: 1,
      status: "PASS",
      sourceCommit: SOURCE_COMMIT,
      evidenceKind: "MATCHED_MOBILE_WEB_CONTROLLED_CLIENT_FACING_JSONRPC_FAILURE_HISTORY_FIRST",
      claimBoundary: "matched Git 992 bundle mounted by the pinned shared Gateway snapshot; client-facing RPC faults and controlled history fixture; no official Expo receipt, Rust pagination, public route, Provider, Relay, or device claim",
      mobileBundleSha256: mobile.bundleSha256,
      mobileSourceTreeSha256: mobile.sourceTreeSha256,
      mobileBundleFileCount: mobile.bundleFileCount,
      derivedGatewayManifestSha256: mobile.manifestSha256,
      gatewayManifestSha256: gatewayRuntime.manifestSha256,
      gatewaySourceTreeSha256: gatewayRuntime.manifest.sourceTreeSha256,
      gatewayDependencyTreeSha256: gatewayRuntime.manifest.dependencyTreeSha256,
      cases,
      historyPages: rpc.historyPages,
      historyPageInteractions: rpc.historyPageInteractions,
      observedRequests: rpc.requests,
      mutationCount: rpc.mutations.length,
      mutationCountScope: "only methods enumerated in KNOWN_MUTATING_RPC_METHODS; forwarding is independently restricted to the explicit startup/read RPC and initialized-notification allowlist, with unknown requests blocked",
      rpcAllowlistBoundary: {
        purpose: "allow only the thread setup/resume, history, workspace/catalog, capability, and initialization RPCs needed by this diagnostic; malformed or unlisted requests are recorded and blocked",
        requestMethods: [...ALLOWED_RPC_REQUEST_METHODS].sort(),
        notificationMethods: [...ALLOWED_RPC_NOTIFICATION_METHODS].sort(),
        unknownRequests: rpc.unknownRpcRequests,
      },
      browserErrors,
      unhandledRejections,
    };
    await context.writeArtifactJson("mobile-history-aux-rpc-failure-result.json", result);
    return result;
  } catch (error) {
    const uiDiagnostics = await captureFailureUiDiagnostics(page, context, latencyHelpers).catch(captureError => ({
      captureError: context.redactText(captureError instanceof Error ? captureError.message : String(captureError)).slice(0, 400),
    }));
    await context.writeArtifactJson("mobile-history-aux-rpc-failure-failure.json", {
      cases: cases.map(row => ({ name: row.name, targetMethod: row.targetMethod })),
      activeScenario: rpc.activeScenario ? summarizeCase(rpc.activeScenario, null, null) : null,
      observedRequests: rpc.requests,
      historyPages: rpc.historyPages,
      historyPageInteractions: rpc.historyPageInteractions,
      mutationMethods: rpc.mutations.map(row => row.method),
      unknownRpcRequests: rpc.unknownRpcRequests,
      browserErrors,
      unhandledRejections,
      uiDiagnostics,
      interactionDiagnostics: error?.historyPaginationDiagnostics ?? null,
      failure: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 800),
    });
    throw error;
  } finally {
    rpc.releaseAll();
  }
});

async function installRpcFixture(page, workspace) {
  const state = {
    activeScenario: null,
    scenarios: [],
    requests: [],
    historyPages: [],
    historyPageInteractions: [],
    mutations: [],
    unknownRpcRequests: [],
    initializeCapabilityEvents: [],
    nextSocketId: 1,
    arm(name, targetMethod) {
      const scenario = {
        id: `${name}-${Date.now()}-${state.nextSocketId}`,
        name,
        targetMethod,
        phase: "armed-before-task-route",
        targetRequests: [],
        browserReceived: [],
        phases: [{ phase: "armed-before-task-route", at: Date.now() }],
        initializeCapabilityAdvertised: false,
        expectedError: null,
        errorFrameSent: null,
      };
      state.activeScenario = scenario;
      state.scenarios.push(scenario);
      return scenario;
    },
    async waitUntilHeld(scenario, context) {
      await waitFor(() => scenario.targetRequests.length > 0, 20_000,
        `observed actual ${scenario.targetMethod} request on the armed task WebSocket`, 25, context.abortSignal);
      assert.equal(scenario.targetRequests.length, 1, `${scenario.targetMethod} must be observed exactly once before release`);
      scenario.phase = "target-request-held-before-history-assertion";
      scenario.phases.push({ phase: scenario.phase, at: Date.now() });
    },
    async armBrowserError(page, scenario) {
      const held = scenario.targetRequests[0];
      assert.ok(held, "cannot arm Browser observation before the exact RPC request is held");
      scenario.expectedError = {
        scenarioId: scenario.id,
        method: held.method,
        id: held.id,
        code: CONTROLLED_ERROR.code,
        message: CONTROLLED_ERROR.message,
        route: held.route,
      };
      await page.evaluate(expected => {
        globalThis.__p1cAuxExpectedError = expected;
        globalThis.__p1cAuxBrowserReceived = [];
      }, scenario.expectedError);
    },
    rejectHeld(scenario) {
      assert.equal(scenario.targetRequests.length, 1, "a real target request must be held before a controlled error is sent");
      assert.ok(scenario.phases.some(row => row.phase === "history-visible-and-older-page-loaded-before-error"),
        "the controlled JSON-RPC reject must follow visible history and a completed older-page load");
      const held = scenario.targetRequests[0];
      assert.equal(typeof held.sendError, "function", "held request must own a live client-facing WebSocket response path");
      const sentAt = Date.now();
      const errorFrame = { jsonrpc: "2.0", id: held.id, error: { ...CONTROLLED_ERROR } };
      markPhase(scenario, "fixture-sent-jsonrpc-error-frame");
      held.sendError(errorFrame);
      scenario.errorFrameSent = {
        jsonrpc: errorFrame.jsonrpc,
        id: errorFrame.id,
        code: errorFrame.error.code,
        message: errorFrame.error.message,
        phase: scenario.phase,
        heldMs: sentAt - held.observedAt,
      };
      return { ...scenario.errorFrameSent };
    },
    async waitForBrowserReceived(scenario, context) {
      await waitFor(() => scenario.browserReceived.length > 0, 10_000,
        `Browser received the exact ${scenario.targetMethod} JSON-RPC error frame`, 25, context.abortSignal);
      assert.ok(scenario.browserReceived.some(row => row.jsonrpc === "2.0" && row.method === scenario.targetMethod &&
        row.id === scenario.expectedError.id && row.code === CONTROLLED_ERROR.code && row.message === CONTROLLED_ERROR.message &&
        sameRoute(row.route, scenario.expectedError.route)),
      "Browser-side evidence must match the held method, request ID, error code/message, and exact route");
      return scenario.browserReceived[0];
    },
    recordBrowserReceived(observation) {
      const scenario = state.scenarios.find(item => item.id === observation?.scenarioId);
      if (!scenario?.expectedError || observation.jsonrpc !== "2.0" || observation.method !== scenario.expectedError.method ||
          observation.id !== scenario.expectedError.id ||
          observation.code !== scenario.expectedError.code || observation.message !== scenario.expectedError.message ||
          !sameRoute(observation.route, scenario.expectedError.route)) return false;
      scenario.browserReceived.push({ ...observation, receivedAt: Date.now() });
      if (scenario.browserReceived.length === 1) markPhase(scenario, "browser-websocket-error-message-received");
      return true;
    },
    recordPlaywrightFrame(route, payload) {
      let frame;
      try { frame = JSON.parse(String(payload)); } catch { return false; }
      const scenario = state.scenarios.find(item => item.expectedError && item.expectedError.id === frame?.id &&
        item.expectedError.code === frame?.error?.code && sameRoute(route, item.expectedError.route));
      if (!scenario) return false;
      return state.recordBrowserReceived({
        source: "playwright-websocket-framereceived",
        scenarioId: scenario.id,
        method: scenario.expectedError.method,
        id: frame.id,
        code: frame.error.code,
        message: frame.error.message,
        jsonrpc: frame.jsonrpc,
        route,
      });
    },
    releaseAll() {
      for (const scenario of state.scenarios) {
        for (const held of scenario.targetRequests) {
          if (held.replied) continue;
          try { held.sendError({ jsonrpc: "2.0", id: held.id, error: { ...CONTROLLED_ERROR } }); } catch { /* owned Browser cleanup closes the remaining route */ }
        }
      }
    },
  };

  await page.routeWebSocket("**/rpc*", routed => {
    const url = new URL(routed.url());
    const route = {
      server: url.searchParams.get("server"),
      workspace: url.searchParams.get("workspace"),
      channel: url.searchParams.get("channel"),
    };
    const scoped = route.server === SERVER && route.workspace === workspace && route.channel === "runtime";
    const socketId = state.nextSocketId++;
    const upstream = routed.connectToServer();
    const pending = new Map();

    routed.onMessage(raw => {
      let request;
      try { request = JSON.parse(String(raw)); } catch {
        state.unknownRpcRequests.push({ socketId, route, kind: "malformed-json-frame", forwardDecision: "blocked" });
        return;
      }
      if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
        state.unknownRpcRequests.push({ socketId, route, kind: "invalid-jsonrpc-request", forwardDecision: "blocked" });
        return;
      }
      const hasId = Object.hasOwn(request, "id") && request.id !== undefined;
      const keys = request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? Object.keys(request.params).sort() : [];
      const row = {
        socketId,
        scenarioId: scoped ? state.activeScenario?.id ?? null : null,
        phase: scoped ? state.activeScenario?.phase ?? "unarmed" : "nonscoped",
        route,
        method: request.method,
        id: hasId ? request.id : null,
        paramsKeys: keys,
        threadId: typeof request.params?.threadId === "string" ? request.params.threadId : null,
      };
      state.requests.push(row);
      if (KNOWN_MUTATING_RPC_METHODS.has(request.method)) state.mutations.push({ method: request.method, route, socketId });
      const allowed = !hasId
        ? ALLOWED_RPC_NOTIFICATION_METHODS.has(request.method)
        : ALLOWED_RPC_REQUEST_METHODS.has(request.method);
      if (!allowed) {
        const unknown = { socketId, route, kind: "method-outside-allowlist", method: request.method, id: hasId ? request.id : null, paramsKeys: keys, threadId: row.threadId, forwardDecision: "blocked" };
        state.unknownRpcRequests.push(unknown);
        row.forwardDecision = "blocked-unknown-or-out-of-allowlist";
        if (hasId) routed.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "RPC outside this diagnostic request allowlist" } }));
        return;
      }
      if (hasId) pending.set(String(request.id), request);

      const scenario = scoped ? state.activeScenario : null;
      const isExactTarget = scenario && request.method === scenario.targetMethod && request.params?.threadId === THREAD &&
        keys.length === 1 && keys[0] === "threadId";
      if (isExactTarget) {
        assert.notEqual(request.id, undefined, "auxiliary RPC under test must be a request with a JSON-RPC id");
        if (scenario.name === "agent-list") {
          scenario.initializeCapabilityAdvertised = state.initializeCapabilityEvents.some(event =>
            event.socketId === socketId && event.route.server === SERVER && event.route.workspace === workspace &&
            event.route.channel === "runtime" && event.agentSteering === true);
        }
        let target;
        target = {
          socketId,
          route,
          method: request.method,
          id: request.id,
          paramsKeys: keys,
          threadId: request.params.threadId,
          phaseAtRequest: scenario.phase,
          observedAt: Date.now(),
          sendError: frame => {
            pending.delete(String(request.id));
            routed.send(JSON.stringify(frame));
            target.replied = true;
          },
        };
        scenario.targetRequests.push(target);
        row.held = true;
        row.forwardDecision = "held-by-fixture-for-exact-scenario-request";
        row.phase = scenario.phase;
        return;
      }
      if (scenario && request.method === scenario.targetMethod) {
        scenario.forwardedSameMethodRequests ??= [];
        scenario.forwardedSameMethodRequests.push({
          ...row,
          kind: request.method === "runtime.models.list" && keys.length === 0
            ? "page-catalog-read-without-threadId-forwarded"
            : "same-method-outside-exact-threadId-scope-forwarded",
        });
      }
      row.forwardDecision = "forwarded-upstream-from-explicit-allowlist";
      upstream.send(raw);
    });

    upstream.onMessage(raw => {
      let response;
      try { response = JSON.parse(String(raw)); } catch { routed.send(raw); return; }
      const request = response?.id === undefined ? null : pending.get(String(response.id));
      if (scoped && request?.method === "initialize" && response.result && !response.error) {
        const capabilities = response.result.capabilities ?? {};
        const experimental = capabilities.experimental ?? {};
        response.result = { ...response.result, capabilities: { ...capabilities, experimental: { ...experimental, agentSteering: true } } };
        const event = { socketId, route, agentSteering: response.result.capabilities.experimental.agentSteering === true };
        state.initializeCapabilityEvents.push(event);
        if (state.activeScenario?.name === "agent-list") state.activeScenario.initializeCapabilityAdvertised = event.agentSteering;
      }
      if (scoped && request?.method === "thread/read" && request.params?.threadId === THREAD && request.params?.limit !== 1 && !response.error) {
        const data = makeCompactHistoryPage(120, request.params.beforeCursor, request.params.limit, workspace);
        response.result = {
          thread: { id: THREAD, title: "P1-C auxiliary failure history", status: "idle", cwd: workspace, model: MODEL },
          ...data,
        };
        state.historyPages.push({
          socketId,
          scenarioId: scoped ? state.activeScenario?.id ?? null : null,
          phase: scoped ? state.activeScenario?.phase ?? "unarmed" : "nonscoped",
          beforeCursor: request.params.beforeCursor ?? null,
          requestedLimit: request.params.limit ?? null,
          rangeStart: data.rangeStart,
          rangeEnd: data.rangeEnd,
          hasMoreBefore: data.hasMoreBefore,
        });
      }
      if (response?.id !== undefined) pending.delete(String(response.id));
      routed.send(JSON.stringify(response));
    });
  });
  return state;
}

function makeCompactHistoryPage(total, beforeCursor, requestedLimit, fixtureWorkspace) {
  const page = makeHistoryPage(total, beforeCursor, requestedLimit, fixtureWorkspace);
  return {
    ...page,
    messages: page.messages.map(message => {
      const match = /^history-(\d+)$/.exec(message.id);
      assert.ok(match, "compact functional history rows must preserve their exact source message id");
      const marker = `HISTORY-${String(Number(match[1])).padStart(4, "0")}`;
      return { ...message, content: `${marker} compact functional history fixture`, blocks: [] };
    }),
  };
}

async function pairThroughUi(page, gateway) {
  const entry = await fetch(`${gateway.baseUrl}/mobile-entry`).then(response => response.json());
  assert.equal(entry.available, true);
  assert.equal(entry.gatewayUrl, gateway.baseUrl);
  const response = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId(`thread-${THREAD}`).waitFor({ state: "visible", timeout: 30_000 });
}

async function backToHome(page) {
  await page.getByTestId("task-header").getByRole("button", { name: "返回", exact: true }).click();
  await page.getByTestId(`thread-${THREAD}`).waitFor({ state: "visible", timeout: 15_000 });
}

async function assertHistoryVisible(page, expectedMarker = null) {
  await page.getByTestId("message-list").waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(async () => await visibleHistoryMarker(page, expectedMarker), 10_000,
    expectedMarker ? `visible newly loaded history marker ${expectedMarker}` : "visible controlled history marker before/after auxiliary RPC failure", 25);
}

async function visibleHistoryMarker(page, expectedMarker = null) {
  const markers = page.getByText(expectedMarker ? new RegExp(expectedMarker) : /HISTORY-\d{4}/);
  const count = await markers.count();
  for (let index = 0; index < Math.min(count, 120); index += 1) {
    const marker = markers.nth(index);
    if (await marker.isVisible().catch(() => false)) return (await marker.innerText().catch(() => "")).match(/HISTORY-\d{4}/)?.[0] ?? "visible-history";
  }
  return null;
}

async function loadOlderPage(page, rpc, context, scenario, observedPhase = "history-visible-and-older-page-loaded-before-error") {
  const button = page.getByTestId("load-older-messages");
  await button.waitFor({ state: "visible", timeout: 15_000 });
  const previous = rpc.historyPages.length;
  const priorPageRecord = rpc.historyPages.at(-1);
  const priorStart = priorPageRecord?.rangeStart;
  assert.ok(Number.isSafeInteger(priorStart) && Number.isSafeInteger(priorPageRecord?.rangeEnd),
    "the preceding history page must establish an exact older cursor boundary before navigating to its control");
  const olderControlNavigation = await scrollToOlderControl(page, context, priorPageRecord);
  const anchorBefore = await waitForStableVisibleHistoryAnchor(
    page,
    context,
    "readable prior-page history anchor before older-page prepend",
    null,
    { rangeStart: priorStart, rangeEnd: priorPageRecord.rangeEnd },
  );
  const beforeClickGeometry = await readHistoryUiGeometry(page);
  const beforeClickControl = summarizeOlderControlVisibility(beforeClickGeometry);
  assert.equal(beforeClickControl.fullyVisibleWithinMessageList, true,
    "the older-page button must be fully in the real message-list viewport before clicking");
  const beforeClickHitTest = await hitTestOlderControl(page, beforeClickControl.rect);
  assert.equal(beforeClickHitTest.targetIsOlderControl, true,
    "the visible older-page button center must hit the actual button before clicking");
  const beforeClickAnchor = beforeClickGeometry.visibleRows.find(row =>
    row.marker === anchorBefore.marker && row.markerTextVisible);
  assert.ok(beforeClickAnchor, "the selected history marker must remain readable immediately before clicking");
  let afterClickGeometry;
  let afterClickControl;
  let afterClickAnchor;
  let clickScrollDeltaPx;
  let clickAnchorDisplacementPx;
  try {
    await button.click();
    afterClickGeometry = await readHistoryUiGeometry(page);
    afterClickControl = summarizeOlderControlVisibility(afterClickGeometry);
    afterClickAnchor = afterClickGeometry.visibleRows.find(row =>
      row.marker === anchorBefore.marker && row.markerTextVisible);
    clickScrollDeltaPx = Math.abs(afterClickGeometry.scrollHost.scrollTop - beforeClickGeometry.scrollHost.scrollTop);
    clickAnchorDisplacementPx = afterClickAnchor
      ? Math.abs(afterClickAnchor.viewportOffsetPx - beforeClickAnchor.viewportOffsetPx)
      : null;
    assert.ok(clickScrollDeltaPx <= 0.5,
      `clicking the already-visible older-page button must not perform an extra scroll; actual=${clickScrollDeltaPx.toFixed(3)}px`);
    assert.ok(afterClickAnchor && clickAnchorDisplacementPx <= 0.5,
      `the same readable history anchor must stay in place through the button click; actual=${clickAnchorDisplacementPx?.toFixed(3) ?? "missing"}px`);
  } catch (error) {
    error.historyPaginationDiagnostics = {
      label: "click older-page control without implicit scroll",
      olderControlNavigation,
      beforeClick: {
        control: beforeClickControl,
        anchor: { marker: beforeClickAnchor.marker, rect: beforeClickAnchor.rect,
          viewportOffsetPx: beforeClickAnchor.viewportOffsetPx },
        scrollTop: beforeClickGeometry.scrollHost.scrollTop,
      },
      afterClick: afterClickGeometry ? {
        control: afterClickControl,
        anchor: afterClickAnchor ? { marker: afterClickAnchor.marker, rect: afterClickAnchor.rect,
          viewportOffsetPx: afterClickAnchor.viewportOffsetPx } : null,
        scrollTop: afterClickGeometry.scrollHost.scrollTop,
        clickScrollDeltaPx,
        clickAnchorDisplacementPx,
      } : null,
      failure: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
  await waitFor(() => rpc.historyPages.length === previous + 1, 10_000, "actual older-page RPC response while auxiliary read is held", 25, context.abortSignal);
  const pageRecord = rpc.historyPages.at(-1);
  const interaction = {
    phase: observedPhase,
    priorRangeStart: priorStart,
    priorPageRange: priorPageRecord ? { rangeStart: priorPageRecord.rangeStart, rangeEnd: priorPageRecord.rangeEnd } : null,
    response: { ...pageRecord },
    olderControlNavigation,
    anchorBefore,
    clickViewport: {
      controlBeforeClick: beforeClickControl,
      controlAfterClick: afterClickControl,
      hitTest: beforeClickHitTest,
      scrollTopBefore: beforeClickGeometry.scrollHost.scrollTop,
      scrollTopAfter: afterClickGeometry.scrollHost.scrollTop,
      clickScrollDeltaPx,
      anchorMarker: anchorBefore.marker,
      anchorOffsetBefore: beforeClickAnchor.viewportOffsetPx,
      anchorOffsetAfter: afterClickAnchor.viewportOffsetPx,
      clickAnchorDisplacementPx,
    },
    status: "response-observed",
  };
  rpc.historyPageInteractions.push(interaction);
  try {
    assert.ok(Number.isSafeInteger(priorStart), "the preceding history page must establish an exact older cursor boundary");
    assert.equal(pageRecord.beforeCursor, `ux:${priorStart}`, "older-page request must use the exact cursor for the preceding range start");
    assert.equal(pageRecord.requestedLimit, 50, "older-page request must preserve the bounded 50-message page size");
    assert.equal(pageRecord.rangeEnd, priorStart, "older page must end exactly at the preceding page boundary");
    assert.equal(pageRecord.rangeStart, Math.max(0, priorStart - 50), "older page must return the exact bounded 50-message range");
    assert.equal(pageRecord.hasMoreBefore, pageRecord.rangeStart > 0, "older-page availability must match the returned range start");
    const anchorAfter = await waitForStableVisibleHistoryAnchor(page, context, "same visible history anchor after older-page prepend", anchorBefore.marker);
    interaction.anchorAfter = anchorAfter;
    interaction.anchor = assertHistoryAnchorPreserved(anchorBefore, anchorAfter);

    const targetIndex = pageRecord.rangeStart + Math.floor((pageRecord.rangeEnd - pageRecord.rangeStart) / 2);
    assert.ok(targetIndex >= pageRecord.rangeStart && targetIndex < pageRecord.rangeEnd, "new-range target must belong to the returned page");
    assert.ok(targetIndex < priorPageRecord.rangeStart, "new-range target must be older than every message in the preceding page range");
    interaction.newRangeTarget = { marker: `HISTORY-${String(targetIndex).padStart(4, "0")}`, historyIndex: targetIndex };
    interaction.status = "range-and-anchor-verified";
    interaction.trustedWheel = await scrollToNewHistoryRange(page, context, interaction.newRangeTarget.marker);
    interaction.status = "new-range-visible-after-trusted-wheel";
  } catch (error) {
    interaction.status = "failed";
    interaction.failure = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 400);
    interaction.failureViewport = await readHistoryUiGeometry(page, interaction.newRangeTarget?.marker ?? null).catch(() => null);
    error.historyPaginationDiagnostics = interaction;
    throw error;
  }
  markPhase(scenario, observedPhase);
  return {
    beforeCursor: pageRecord.beforeCursor,
    rangeStart: pageRecord.rangeStart,
    rangeEnd: pageRecord.rangeEnd,
    hasMoreBefore: pageRecord.hasMoreBefore,
    anchor: interaction.anchor,
    newRangeTarget: interaction.newRangeTarget,
    trustedWheel: interaction.trustedWheel,
  };
}

function summarizeOlderControlVisibility(geometry) {
  const rect = geometry.olderControl?.rect ?? null;
  const list = geometry.listRect;
  const viewport = geometry.viewportRect;
  const clip = list && viewport ? {
    top: Math.max(list.top, viewport.top),
    bottom: Math.min(list.bottom, viewport.bottom),
    left: Math.max(list.left, viewport.left),
    right: Math.min(list.right, viewport.right),
  } : null;
  const present = geometry.olderControl?.present === true && rect !== null;
  const fullyVisibleWithinMessageList = Boolean(present && clip && rect.top >= clip.top &&
    rect.bottom <= clip.bottom && rect.left >= clip.left && rect.right <= clip.right);
  return {
    present,
    disabled: geometry.olderControl?.disabled ?? null,
    rect,
    listRect: list ?? null,
    viewportClipRect: clip,
    fullyVisibleWithinMessageList,
  };
}

async function hitTestOlderControl(page, rect) {
  assert.ok(rect, "older-page control hit-test requires its measured viewport rectangle");
  const x = Math.round((rect.left + rect.right) / 2);
  const y = Math.round((rect.top + rect.bottom) / 2);
  return page.evaluate(({ pointX, pointY }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    const button = document.querySelector('[data-testid="load-older-messages"]');
    const target = document.elementFromPoint(pointX, pointY);
    return {
      point: { x: pointX, y: pointY },
      insideMessageList: Boolean(list && target && list.contains(target)),
      targetIsOlderControl: Boolean(button && target && (button === target || button.contains(target))),
      targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
    };
  }, { pointX: x, pointY: y });
}

async function scrollToOlderControl(page, context, priorPageRecord) {
  const button = page.getByTestId("load-older-messages");
  await button.waitFor({ state: "visible", timeout: 15_000 });
  const list = page.getByTestId("message-list");
  const bounds = await list.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0,
    "trusted older-control navigation requires the actual visible message-list hitbox");
  const x = Math.round(bounds.x + 2);
  const y = Math.round(bounds.y + bounds.height / 2);
  const wheelHitTest = await page.evaluate(({ pointX, pointY }) => {
    const root = document.querySelector('[data-testid="message-list"]');
    const target = document.elementFromPoint(pointX, pointY);
    return {
      insideMessageList: Boolean(root && target && root.contains(target)),
      targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
    };
  }, { pointX: x, pointY: y });
  assert.equal(wheelHitTest.insideMessageList, true,
    "trusted older-control navigation wheel must hit the actual message-list subtree");

  const initial = await readHistoryUiGeometry(page);
  assert.equal(initial.listFound, true, "the actual message-list must be present before older-control navigation");
  const initialControl = summarizeOlderControlVisibility(initial);
  const initialPriorRangeMarkerIsReadable = initial.visibleRows.some(row =>
    row.markerTextVisible && row.historyIndex >= priorPageRecord.rangeStart &&
    row.historyIndex < priorPageRecord.rangeEnd);
  const navigationRequired = !(initialControl.fullyVisibleWithinMessageList && initialPriorRangeMarkerIsReadable);
  const traceInstall = await installHistoryWheelTrace(page);
  const startedAt = performance.now();
  const maximumWheelEventsUpperBound = 120;
  const wheelDeltaY = -480;
  const requestedDeltaYs = [];
  const convergenceSamples = [];
  let current = initial;
  let estimatedWheelEvents = 0;
  let hostDirectionCorrect = true;
  let hostProgressEvents = 0;
  let consecutiveStalledWheelEvents = 0;
  const maximumConsecutiveStalledWheelEvents = 3;
  const recordHostScrollProgress = stepPx => {
    if (stepPx > 0.5) {
      hostProgressEvents += 1;
      consecutiveStalledWheelEvents = 0;
    } else if (stepPx < -0.5) {
      hostDirectionCorrect = false;
      consecutiveStalledWheelEvents = 0;
    } else {
      consecutiveStalledWheelEvents += 1;
    }
  };
  const priorRangeMarkerIsReadable = geometry => geometry.visibleRows.some(row =>
    row.markerTextVisible && row.historyIndex >= priorPageRecord.rangeStart &&
    row.historyIndex < priorPageRecord.rangeEnd);
  await page.mouse.move(x, y);
  let budgetEstimate = {
    initialDistanceToVisibleControlPx: distanceToFullyVisibleOlderControlPx(initialControl),
    probeDeltaY: null,
    measuredControlStepPx: null,
    measuredScrollHostStepPx: null,
    expectedStepsAfterProbe: null,
    safetyMarginSteps: null,
    estimatedWheelEvents: 0,
    maximumWheelEventsUpperBound,
    traceEventCapacity: 256,
  };
  if (navigationRequired) {
    const beforeProbe = current;
    requestedDeltaYs.push(wheelDeltaY);
    await page.mouse.wheel(0, wheelDeltaY);
    await waitForAnimationFrames(page, 2);
    current = await readHistoryUiGeometry(page);
    const afterProbeControl = summarizeOlderControlVisibility(current);
    const measuredControlStepPx = afterProbeControl.rect.top - initialControl.rect.top;
    const measuredScrollHostStepPx = current.scrollHost.scrollTop - initial.scrollHost.scrollTop;
    const probeMovesHostTowardOlder = measuredScrollHostStepPx > 0.5;
    recordHostScrollProgress(measuredScrollHostStepPx);
    const remainingControlDistancePx = distanceToFullyVisibleOlderControlPx(afterProbeControl);
    const expectedControlSteps = probeMovesHostTowardOlder
      ? Math.ceil(remainingControlDistancePx / measuredScrollHostStepPx)
      : maximumWheelEventsUpperBound;
    const minimumMarkerSteps = priorRangeMarkerIsReadable(current) ? 0 : 8;
    const expectedStepsAfterProbe = Math.max(expectedControlSteps, minimumMarkerSteps);
    const safetyMarginSteps = Math.max(2, Math.ceil(expectedStepsAfterProbe * 0.25));
    estimatedWheelEvents = Math.min(maximumWheelEventsUpperBound,
      1 + expectedStepsAfterProbe + safetyMarginSteps);
    budgetEstimate = {
      ...budgetEstimate,
      probeDeltaY: wheelDeltaY,
      measuredControlStepPx,
      measuredScrollHostStepPx,
      remainingControlDistanceAfterProbePx: remainingControlDistancePx,
      expectedControlSteps,
      minimumMarkerSteps,
      expectedStepsAfterProbe,
      safetyMarginSteps,
      estimatedWheelEvents,
    };
    convergenceSamples.push({
      wheelIndex: 1,
      controlTopBefore: initialControl.rect.top,
      controlTopAfter: afterProbeControl.rect.top,
      controlStepPx: measuredControlStepPx,
      controlLayoutShiftPx: measuredScrollHostStepPx - measuredControlStepPx,
      scrollTopBefore: initial.scrollHost.scrollTop,
      scrollTopAfter: current.scrollHost.scrollTop,
      scrollHostStepPx: measuredScrollHostStepPx,
      controlDistanceAfterPx: remainingControlDistancePx,
      hostMovedTowardOlder: probeMovesHostTowardOlder,
    });
  }
  for (let index = requestedDeltaYs.length; index < maximumWheelEventsUpperBound &&
      performance.now() - startedAt <= 12_000; index += 1) {
    const control = summarizeOlderControlVisibility(current);
    if (control.fullyVisibleWithinMessageList && priorRangeMarkerIsReadable(current)) break;
    const beforeStep = current;
    requestedDeltaYs.push(wheelDeltaY);
    await page.mouse.wheel(0, wheelDeltaY);
    await waitForAnimationFrames(page, 2);
    current = await readHistoryUiGeometry(page);
    const nextControl = summarizeOlderControlVisibility(current);
    const controlStepPx = nextControl.rect.top - control.rect.top;
    const scrollHostStepPx = current.scrollHost.scrollTop - beforeStep.scrollHost.scrollTop;
    const hostMovedTowardOlder = scrollHostStepPx > 0.5;
    recordHostScrollProgress(scrollHostStepPx);
    convergenceSamples.push({
      wheelIndex: requestedDeltaYs.length,
      controlTopBefore: control.rect.top,
      controlTopAfter: nextControl.rect.top,
      controlStepPx,
      controlLayoutShiftPx: scrollHostStepPx - controlStepPx,
      scrollTopBefore: beforeStep.scrollHost.scrollTop,
      scrollTopAfter: current.scrollHost.scrollTop,
      scrollHostStepPx,
      controlDistanceAfterPx: distanceToFullyVisibleOlderControlPx(nextControl),
      hostMovedTowardOlder,
      consecutiveStalledWheelEvents,
    });
    if (scrollHostStepPx < -0.5 ||
        consecutiveStalledWheelEvents >= maximumConsecutiveStalledWheelEvents) break;
  }

  const trace = await readHistoryWheelTrace(page);
  const trustedOlderWheels = trace?.events.filter(event => event.type === "wheel" &&
    event.isTrusted && event.insideMessageList && event.deltaY < 0) ?? [];
  const trustedScrolls = trace?.events.filter(event => event.type === "scroll" &&
    event.isTrusted && event.insideMessageList) ?? [];
  const finalControl = summarizeOlderControlVisibility(current);
  const readablePriorRangeRows = current.visibleRows.filter(row => row.markerTextVisible &&
    row.historyIndex >= priorPageRecord.rangeStart && row.historyIndex < priorPageRecord.rangeEnd);
  const movedScrollEvent = trustedScrolls.find(event =>
    Math.abs(event.scrollHostTop - initial.scrollHost.scrollTop) > 0.5) ?? null;
  const trustedWheelPrecededMovedScroll = Boolean(movedScrollEvent && trustedOlderWheels.some(event =>
    event.ordinal < movedScrollEvent.ordinal));
  const buttonHitTest = finalControl.fullyVisibleWithinMessageList
    ? await hitTestOlderControl(page, finalControl.rect)
    : null;
  const evidence = {
    direction: "toward-older; bounded trusted negative-delta wheel",
    navigationRequired,
    wheelHitTest,
    traceInstall,
    priorRange: { rangeStart: priorPageRecord.rangeStart, rangeEnd: priorPageRecord.rangeEnd },
    initialControl,
    finalControl,
    estimatedWheelEvents,
    maximumWheelEventsUpperBound,
    requestedWheelEvents: requestedDeltaYs.length,
    wheelDeltaY,
    budgetEstimate,
    hostDirectionCorrect,
    hostProgressEvents,
    consecutiveStalledWheelEvents,
    maximumConsecutiveStalledWheelEvents,
    convergenceSamples,
    requestedDeltaYs,
    trustedWheelEvents: trustedOlderWheels,
    trustedScrollEvents: trustedScrolls,
    traceDropped: trace?.dropped ?? null,
    scrollTopBefore: initial.scrollHost.scrollTop,
    scrollTopAfter: current.scrollHost.scrollTop,
    scrollMoved: Math.abs(current.scrollHost.scrollTop - initial.scrollHost.scrollTop) > 0.5,
    movedScrollEvent,
    trustedWheelPrecededMovedScroll,
    readablePriorRangeMarkers: readablePriorRangeRows.map(row => ({
      marker: row.marker,
      historyIndex: row.historyIndex,
      rect: row.rect,
      viewportOffsetPx: row.viewportOffsetPx,
    })),
    buttonHitTest,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
    finalGeometry: current,
  };
  try {
    if (navigationRequired) {
      assert.ok(trustedOlderWheels.length > 0,
        "the offscreen older-page button must be reached through an actual trusted negative-delta wheel");
      assert.ok(trustedScrolls.length > 0 && movedScrollEvent && trustedWheelPrecededMovedScroll && evidence.scrollMoved,
        "a trusted older-direction wheel must precede observed message-list scroll movement");
      assert.equal(hostDirectionCorrect, true,
        "trusted older-direction wheel navigation must not move the message-list away from older history");
      assert.ok(hostProgressEvents > 0,
        "trusted older-direction wheel navigation must produce observed message-list progress");
      assert.ok(estimatedWheelEvents <= maximumWheelEventsUpperBound &&
        estimatedWheelEvents > budgetEstimate.expectedControlSteps,
      "the measured-distance estimate must remain diagnostic and within the fixed hard upper bound");
      assert.ok(requestedDeltaYs.length <= maximumWheelEventsUpperBound,
        "trusted wheel navigation must stay within the fixed hard event bound");
    }
    assert.equal(trace?.dropped, 0, "older-control navigation evidence must stay inside its bounded event trace");
    assert.equal(finalControl.present, true, "the actual older-page button must remain mounted");
    assert.equal(finalControl.disabled, false, "the actual older-page button must be enabled before its click");
    assert.equal(finalControl.fullyVisibleWithinMessageList, true,
      "the actual older-page button must be fully inside the real message-list viewport before clicking");
    assert.ok(readablePriorRangeRows.length > 0,
      "at least one marker from the already-loaded history range must be readable before loading older history");
    assert.equal(buttonHitTest?.insideMessageList, true,
      "the older-page button center must hit within the actual message-list");
    assert.equal(buttonHitTest?.targetIsOlderControl, true,
      "the older-page button center must hit the actual control, not rely on locator auto-scroll");
  } catch (error) {
    error.historyPaginationDiagnostics = {
      label: "trusted wheel to fully visible older-page control",
      evidence,
    };
    throw error;
  }
  return evidence;
}

async function readHistoryUiGeometry(page, targetMarker = null) {
  return page.evaluate(expectedMarker => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { listFound: false, targetMarker: expectedMarker, mountedRows: [], visibleRows: [] };
    const listRect = list.getBoundingClientRect();
    const hostCandidate = list.querySelector("[data-phone-ux-scroll-host]");
    const candidates = [list, ...list.querySelectorAll("*")].filter(element =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    ).sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight),
    );
    const host = hostCandidate instanceof HTMLElement ? hostCandidate : candidates[0] ?? list;
    const rectSummary = rect => ({
      top: Number(rect.top.toFixed(2)), bottom: Number(rect.bottom.toFixed(2)),
      left: Number(rect.left.toFixed(2)), right: Number(rect.right.toFixed(2)),
      width: Number(rect.width.toFixed(2)), height: Number(rect.height.toFixed(2)),
    });
    const intersect = (left, right) => ({
      left: Math.max(left.left, right.left),
      top: Math.max(left.top, right.top),
      right: Math.min(left.right, right.right),
      bottom: Math.min(left.bottom, right.bottom),
    });
    const intersects = (rect, clip) => rect.width > 0 && rect.height > 0
      && clip.right > clip.left && clip.bottom > clip.top
      && rect.right > clip.left && rect.left < clip.right
      && rect.bottom > clip.top && rect.top < clip.bottom;
    const viewportRect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const listClipRect = intersect(viewportRect, listRect);
    const effectiveClipFor = row => {
      let clip = { ...listClipRect };
      const clippingAncestors = [];
      let ancestor = row.parentElement;
      while (ancestor instanceof HTMLElement) {
        const style = getComputedStyle(ancestor);
        const clipsX = style.overflowX !== "visible";
        const clipsY = style.overflowY !== "visible";
        if (clipsX || clipsY) {
          const rect = ancestor.getBoundingClientRect();
          const contentBox = {
            left: rect.left + ancestor.clientLeft,
            top: rect.top + ancestor.clientTop,
            right: rect.left + ancestor.clientLeft + ancestor.clientWidth,
            bottom: rect.top + ancestor.clientTop + ancestor.clientHeight,
          };
          const next = { ...clip };
          if (clipsX) {
            next.left = Math.max(next.left, contentBox.left);
            next.right = Math.min(next.right, contentBox.right);
          }
          if (clipsY) {
            next.top = Math.max(next.top, contentBox.top);
            next.bottom = Math.min(next.bottom, contentBox.bottom);
          }
          clip = next;
          clippingAncestors.push({
            tag: ancestor.tagName.toLowerCase(),
            testId: ancestor.getAttribute("data-testid"),
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            rect: rectSummary(rect),
            contentBox: rectSummary({
              ...contentBox,
              width: contentBox.right - contentBox.left,
              height: contentBox.bottom - contentBox.top,
            }),
          });
        }
        ancestor = ancestor.parentElement;
      }
      return { rect: clip, clippingAncestors };
    };
    const markerRangeRect = (row, marker) => {
      if (!marker) return null;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue ?? "";
        const offset = value.indexOf(marker);
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + marker.length);
        const rect = range.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      }
      return null;
    };
    const mountedRows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')]
      .map(row => {
        const text = row.textContent ?? "";
        const marker = /HISTORY-(\d{4})/.exec(text)?.[0] ?? null;
        if (!marker) return null;
        const historyIndex = Number(marker.slice("HISTORY-".length));
        const rect = row.getBoundingClientRect();
        const clipping = effectiveClipFor(row);
        const markerRect = markerRangeRect(row, marker);
        let presentationVisible = true;
        for (let ancestor = row; ancestor instanceof HTMLElement; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            presentationVisible = false;
            break;
          }
        }
        const intersectsList = presentationVisible && intersects(rect, clipping.rect);
        const markerTextVisible = presentationVisible && markerRect !== null && intersects(markerRect, clipping.rect);
        return {
          marker,
          historyIndex,
          messageId: `history-${historyIndex}`,
          role: row.getAttribute("data-testid") === "message-assistant" ? "assistant" : "user",
          rect: rectSummary(rect),
          clipRect: rectSummary({
            ...clipping.rect,
            width: Math.max(0, clipping.rect.right - clipping.rect.left),
            height: Math.max(0, clipping.rect.bottom - clipping.rect.top),
          }),
          clippingAncestors: clipping.clippingAncestors,
          markerRect: markerRect ? rectSummary(markerRect) : null,
          markerTextVisible,
          presentationVisible,
          viewportOffsetPx: Number((rect.top - listRect.top).toFixed(2)),
          visibleWithinMessageList: intersectsList,
        };
      })
      .filter(Boolean)
      .slice(0, 160);
    const visibleRows = mountedRows.filter(row => row.visibleWithinMessageList).sort((left, right) => left.rect.top - right.rect.top);
    const targetRows = expectedMarker ? mountedRows.filter(row => row.marker === expectedMarker) : [];
    const button = document.querySelector('[data-testid="load-older-messages"]');
    const input = document.querySelector('[data-testid="message-input"]');
    const send = document.querySelector('[data-testid="send-message"]');
    const status = document.querySelector('[data-testid="task-header-status"]');
    return {
      sampledAtPageTimeMs: Number(performance.now().toFixed(2)),
      listFound: true,
      listRect: rectSummary(listRect),
      viewportRect: rectSummary({ ...viewportRect, width: viewportRect.right - viewportRect.left, height: viewportRect.bottom - viewportRect.top }),
      listClipRect: rectSummary({
        ...listClipRect,
        width: Math.max(0, listClipRect.right - listClipRect.left),
        height: Math.max(0, listClipRect.bottom - listClipRect.top),
      }),
      scrollHost: {
        testId: host.getAttribute("data-testid"),
        productScrollHost: host.hasAttribute("data-phone-ux-scroll-host"),
        rect: rectSummary(host.getBoundingClientRect()),
        scrollTop: Number(host.scrollTop.toFixed(2)),
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        maxScrollTop: Math.max(0, host.scrollHeight - host.clientHeight),
      },
      mountedRows,
      mountedHistoryIndexes: mountedRows.map(row => row.historyIndex),
      visibleRows,
      visibleHistoryIndexes: visibleRows.map(row => row.historyIndex),
      targetMarker: expectedMarker,
      target: {
        mounted: targetRows.length > 0,
        visibleWithinMessageList: targetRows.some(row => row.visibleWithinMessageList),
        markerTextVisible: targetRows.some(row => row.markerTextVisible),
        rows: targetRows,
      },
      olderControl: button instanceof HTMLElement ? {
        present: true,
        disabled: button instanceof HTMLButtonElement ? button.disabled : button.getAttribute("aria-disabled") === "true",
        rect: rectSummary(button.getBoundingClientRect()),
      } : { present: false },
      input: input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? {
        present: true,
        editable: !input.disabled && !input.readOnly,
        valueLength: input.value.length,
      } : { present: Boolean(input) },
      sendEnabled: send instanceof HTMLButtonElement ? !send.disabled : null,
      configurationStatus: status?.textContent?.trim().slice(0, 120) ?? null,
    };
  }, targetMarker);
}

async function waitForStableVisibleHistoryAnchor(page, context, label, requiredMarker = null, requiredRange = null) {
  const startedAt = performance.now();
  const observations = [];
  let previous = null;
  while (performance.now() - startedAt <= 5_000) {
    await waitForAnimationFrames(page, 2);
    const geometry = await readHistoryUiGeometry(page);
    const inRequiredRange = row => !requiredRange ||
      (row.historyIndex >= requiredRange.rangeStart && row.historyIndex < requiredRange.rangeEnd);
    const anchor = requiredMarker
      ? geometry.visibleRows.find(row => row.marker === requiredMarker && row.markerTextVisible) ?? null
      : geometry.visibleRows.find(row => row.markerTextVisible && inRequiredRange(row)) ?? null;
    observations.push({ geometry, anchor });
    assert.equal(geometry.listFound, true, `${label}: actual message-list must remain mounted`);
    if (anchor && previous?.anchor?.messageId === anchor.messageId
        && Math.abs(previous.anchor.viewportOffsetPx - anchor.viewportOffsetPx) <= 0.5
        && Math.abs(previous.geometry.scrollHost.scrollTop - geometry.scrollHost.scrollTop) <= 0.5
        && previous.geometry.scrollHost.scrollHeight === geometry.scrollHost.scrollHeight
        && previous.geometry.scrollHost.clientHeight === geometry.scrollHost.clientHeight) {
      return {
        marker: anchor.marker,
        messageId: anchor.messageId,
        historyIndex: anchor.historyIndex,
        viewportOffsetPx: anchor.viewportOffsetPx,
        rect: anchor.rect,
        listRect: geometry.listRect,
        scrollHost: geometry.scrollHost,
        stableAfterTwoFrames: true,
        stabilityPair: [previous, observations.at(-1)],
      };
    }
    previous = observations.at(-1);
    await page.waitForTimeout(25);
  }
  const error = new Error(`${label}: a stable visible history anchor did not settle within 5000ms`);
  error.historyPaginationDiagnostics = { label, requiredMarker, requiredRange, observations: observations.slice(-12) };
  throw error;
}

function assertHistoryAnchorPreserved(before, after) {
  assert.ok(before?.messageId && after?.messageId, "before/after anchor observations must identify mounted history rows");
  assert.equal(after.messageId, before.messageId, "history prepend must preserve the exact previously visible history message");
  assert.equal(after.marker, before.marker, "history prepend must preserve the prior visible row marker");
  const displacementPx = Math.abs(after.viewportOffsetPx - before.viewportOffsetPx);
  assert.ok(displacementPx <= 2, `history prepend must preserve the same visible row top within 2 CSS px; actual=${displacementPx.toFixed(3)}px`);
  return {
    messageId: before.messageId,
    marker: before.marker,
    historyIndex: before.historyIndex,
    beforeOffsetPx: before.viewportOffsetPx,
    afterOffsetPx: after.viewportOffsetPx,
    displacementPx,
    beforeScrollTop: before.scrollHost.scrollTop,
    afterScrollTop: after.scrollHost.scrollTop,
    beforeScrollHeight: before.scrollHost.scrollHeight,
    afterScrollHeight: after.scrollHost.scrollHeight,
  };
}

async function installHistoryWheelTrace(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) throw new Error("trusted history wheel requires the actual message-list");
    const hostCandidate = list.querySelector("[data-phone-ux-scroll-host]");
    const candidates = [list, ...list.querySelectorAll("*")].filter(element =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    ).sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight),
    );
    const host = hostCandidate instanceof HTMLElement ? hostCandidate : candidates[0] ?? list;
    const existing = window.__p1cHistoryWheelTrace;
    if (existing?.list === list && existing?.host === host) {
      existing.events.length = 0;
      existing.dropped = 0;
      existing.nextOrdinal = 1;
      const rect = list.getBoundingClientRect();
      return {
        installed: true,
        reused: true,
        hostTestId: host.getAttribute("data-testid"),
        hostScrollTop: Number(host.scrollTop.toFixed(2)),
        listSize: { width: rect.width, height: rect.height },
      };
    }
    existing?.removeListeners?.();
    const state = { list, host, events: [], dropped: 0, maximumEvents: 256, nextOrdinal: 1 };
    const record = event => {
      const targetNode = event.target instanceof Node ? event.target : null;
      if (!targetNode || (targetNode !== list && !list.contains(targetNode))) return;
      if (state.events.length >= state.maximumEvents) { state.dropped += 1; return; }
      const target = targetNode instanceof HTMLElement ? targetNode : targetNode.parentElement ?? list;
      state.events.push({
        ordinal: state.nextOrdinal++,
        type: event.type,
        isTrusted: Boolean(event.isTrusted),
        insideMessageList: true,
        targetTestId: target.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        scrollHostTestId: host.getAttribute("data-testid"),
        scrollHostIsEventTarget: targetNode === host,
        scrollHostTop: Number(host.scrollTop.toFixed(2)),
        deltaY: event.type === "wheel" ? Number(event.deltaY.toFixed(2)) : null,
        targetScrollTop: Number(target.scrollTop.toFixed(2)),
        targetScrollHeight: target.scrollHeight,
        targetClientHeight: target.clientHeight,
        pageTimeMs: Number(performance.now().toFixed(2)),
      });
    };
    document.addEventListener("wheel", record, { capture: true, passive: true });
    document.addEventListener("scroll", record, true);
    state.removeListeners = () => {
      document.removeEventListener("wheel", record, true);
      document.removeEventListener("scroll", record, true);
    };
    window.__p1cHistoryWheelTrace = state;
    const rect = list.getBoundingClientRect();
    return {
      installed: true,
      reused: false,
      hostTestId: host.getAttribute("data-testid"),
      hostScrollTop: Number(host.scrollTop.toFixed(2)),
      listSize: { width: rect.width, height: rect.height },
    };
  });
}

async function readHistoryWheelTrace(page) {
  return page.evaluate(() => {
    const state = window.__p1cHistoryWheelTrace;
    return state ? { events: state.events, dropped: state.dropped } : null;
  });
}

async function scrollToNewHistoryRange(page, context, targetMarker) {
  const list = page.getByTestId("message-list");
  const bounds = await list.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, "trusted older-history wheel needs the visible message-list hitbox");
  const x = Math.round(bounds.x + Math.min(28, bounds.width / 4));
  const y = Math.round(bounds.y + bounds.height / 2);
  const hitTest = await page.evaluate(({ pointX, pointY }) => {
    const root = document.querySelector('[data-testid="message-list"]');
    const target = document.elementFromPoint(pointX, pointY);
    return { insideMessageList: Boolean(root && target && root.contains(target)), targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null };
  }, { pointX: x, pointY: y });
  assert.equal(hitTest.insideMessageList, true, "trusted older-history wheel must hit the actual message-list subtree");
  const initial = await readHistoryUiGeometry(page, targetMarker);
  assert.equal(initial.listFound, true, "the actual message-list must be present before scrolling to older history");
  assert.equal(initial.target.markerTextVisible, false,
    `${targetMarker} marker text must not already be readable before the trusted scroll proves access to the newly loaded range`);
  const traceInstall = await installHistoryWheelTrace(page);
  await page.mouse.move(x, y);
  const startedAt = performance.now();
  const maximumWheelEvents = 120;
  const maximumDurationMs = 12_000;
  let current = initial;
  const requestedDeltaYs = [];
  for (let index = 0; index < maximumWheelEvents
      && (index === 0 || !current.target?.markerTextVisible)
      && performance.now() - startedAt <= maximumDurationMs; index += 1) {
    requestedDeltaYs.push(-160);
    await page.mouse.wheel(0, -160);
    await waitForAnimationFrames(page, 2);
    current = await readHistoryUiGeometry(page, targetMarker);
  }
  const trace = await readHistoryWheelTrace(page);
  const trustedOlderWheels = trace?.events.filter(event => event.type === "wheel"
    && event.isTrusted && event.insideMessageList && event.deltaY < 0) ?? [];
  const trustedScrolls = trace?.events.filter(event => event.type === "scroll"
    && event.isTrusted && event.insideMessageList) ?? [];
  const scrollMoved = Math.abs(current.scrollHost.scrollTop - initial.scrollHost.scrollTop) > 0.5;
  const movedScrollEvent = trustedScrolls.find(event => Math.abs(event.scrollHostTop - initial.scrollHost.scrollTop) > 0.5) ?? null;
  const trustedWheelPrecededMovedScroll = Boolean(movedScrollEvent && trustedOlderWheels.some(event => event.ordinal < movedScrollEvent.ordinal));
  const targetRow = page.locator('[data-testid="message-user"], [data-testid="message-assistant"]').filter({ hasText: targetMarker });
  const targetRowCount = await targetRow.count();
  const targetRowVisible = targetRowCount === 1 && await targetRow.isVisible();
  const evidence = {
    targetMarker,
    targetHistoryIndex: Number(targetMarker.slice("HISTORY-".length)),
    direction: "toward-older; bounded trusted negative-delta wheel",
    hitTest,
    traceInstall,
    maximumWheelEvents,
    requestedDeltaYs,
    trustedWheelEvents: trustedOlderWheels,
    trustedScrollEvents: trustedScrolls,
    traceDropped: trace?.dropped ?? null,
    scrollTopBefore: initial.scrollHost.scrollTop,
    scrollTopAfter: current.scrollHost.scrollTop,
    scrollMoved,
    movedScrollEvent,
    trustedWheelPrecededMovedScroll,
    targetMountedBefore: initial.target.mounted,
    targetVisibleBefore: initial.target.visibleWithinMessageList,
    targetMarkerTextVisibleBefore: initial.target.markerTextVisible,
    targetMountedAfter: current.target.mounted,
    targetVisibleAfter: current.target.visibleWithinMessageList,
    targetMarkerTextVisibleAfter: current.target.markerTextVisible,
    targetRowCount,
    targetRowVisible,
    initialGeometry: initial,
    finalGeometry: current,
    inputDurationMs: Number((performance.now() - startedAt).toFixed(2)),
  };
  try {
    assert.ok(trustedOlderWheels.length > 0, "new history must be reached using a real trusted negative-delta wheel event");
    assert.ok(trustedScrolls.length > 0 && movedScrollEvent && trustedWheelPrecededMovedScroll && scrollMoved,
      "a trusted negative-delta wheel must precede a trusted scroll event that records actual scroll-host movement");
    assert.equal(trace?.dropped, 0, "history wheel evidence must stay inside the bounded event trace");
    assert.ok(current.target.mounted, `${targetMarker} from the exact newly loaded range must be mounted after trusted scrolling`);
    assert.ok(current.target.visibleWithinMessageList && current.target.markerTextVisible,
      `${targetMarker} from the exact newly loaded range must be visibly rendered inside the message-list after trusted scrolling`);
    assert.equal(targetRowCount, 1, `${targetMarker} must resolve to one actual rendered transcript row`);
    assert.equal(targetRowVisible, true, `${targetMarker} transcript row must remain visible to the Browser after trusted scrolling`);
  } catch (error) {
    error.historyPaginationDiagnostics = { targetMarker, wheelEvidence: evidence };
    throw error;
  }
  return evidence;
}

async function waitForAnimationFrames(page, count) {
  await page.evaluate(frameCount => new Promise(resolve => {
    const next = remaining => remaining <= 0 ? resolve() : requestAnimationFrame(() => next(remaining - 1));
    next(frameCount);
  }), count);
}

async function captureFailureUiDiagnostics(page, context, latencyHelpers) {
  let geometry = null;
  let geometryError = null;
  try { geometry = await readHistoryUiGeometry(page); }
  catch (error) { geometryError = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 400); }
  const screenshot = await latencyHelpers.capturePrivateFailureScreenshot(
    context,
    page,
    "mobile-history-aux-rpc-failure-failure.png",
  );
  return { geometry, geometryError, screenshot };
}

async function assertConfigurationHeldUi(page) {
  await page.getByTestId("task-header-status").waitFor({ state: "visible" });
  await waitFor(async () => (await page.getByTestId("task-header-status").innerText()).includes("正在校验任务配置"),
    10_000, "source-rendered task configuration validation status while the exact thread model read is held", 25);
  assert.equal(await page.getByTestId("message-input").isEditable(), true, "the local draft remains editable while model restoration is held");
  assert.equal(await page.getByTestId("message-input").inputValue(), DRAFT);
  assert.equal(await page.getByTestId("send-message").isEnabled(), false, "existing configuration gate must disable send while the exact thread model read is held");
}

async function findExactStoredScope(page) {
  return page.evaluate(({ prefix, draft, thread, server }) => {
    const matches = Object.keys(localStorage).filter(key => {
      if (!key.startsWith(`${prefix}:`)) return false;
      const parts = key.slice(prefix.length + 1).split(":");
      if (parts.length !== 5 || parts[3] !== "scope" || decodeURIComponent(parts[1]) !== server || decodeURIComponent(parts[2]) !== thread) return false;
      try { return JSON.parse(localStorage.getItem(key))?.composerDraft === draft; } catch { return false; }
    });
    if (matches.length > 1) throw new Error("ambiguous task preference scope key");
    return matches[0] ?? null;
  }, { prefix: PREFIX, draft: DRAFT, thread: THREAD, server: SERVER });
}

async function seedModelEffort(page, key) {
  return page.evaluate(({ key, model, reasoningEffort }) => {
    const original = JSON.parse(localStorage.getItem(key));
    if (!original || original.composerDraft !== "P1C_AUX_RPC_DRAFT") throw new Error("exact task scope no longer contains the observed draft");
    localStorage.setItem(key, JSON.stringify({ ...original, activeTab: "agent", model, reasoningEffort }));
    const stored = JSON.parse(localStorage.getItem(key));
    return { model: stored.model, reasoningEffort: stored.reasoningEffort, draftPresent: stored.composerDraft === "P1C_AUX_RPC_DRAFT" };
  }, { key, model: MODEL, reasoningEffort: EFFORT });
}

async function verifyPostErrorDraft(page, scopeKey, scenario, context) {
  const input = page.getByTestId("message-input");
  const temporaryDraft = `${DRAFT} AFTER_ERROR`;
  const persistedDraftIs = expected => page.evaluate(({ key, value }) => {
    try { return JSON.parse(localStorage.getItem(key))?.composerDraft === value; } catch { return false; }
  }, { key: scopeKey, value: expected });

  assert.equal(await input.isEditable(), true, "the composer remains editable after the Browser received the auxiliary RPC error");
  await input.fill(temporaryDraft);
  assert.equal(await input.inputValue(), temporaryDraft, "the post-error draft edit must be visible in the composer");
  await waitFor(() => persistedDraftIs(temporaryDraft), 10_000, "temporary post-error draft persisted in the exact task scope", 25, context.abortSignal);
  markPhase(scenario, "post-error-draft-editable-and-persisted");

  await input.fill(DRAFT);
  assert.equal(await input.inputValue(), DRAFT, "the original draft is restored without sending a message");
  await waitFor(() => persistedDraftIs(DRAFT), 10_000, "original draft restored in the exact task scope", 25, context.abortSignal);
  markPhase(scenario, "original-draft-restored-and-persisted");
}

function summarizeCase(scenario, olderPage, errorFrameSent) {
  return {
    name: scenario.name,
    targetMethod: scenario.targetMethod,
    targetRequestCount: scenario.targetRequests.length,
    targetRequest: scenario.targetRequests.map(({ socketId, route, method, id, paramsKeys, threadId, phaseAtRequest }) =>
      ({ socketId, route, method, id, paramsKeys, threadId, phaseAtRequest })),
    forwardedSameMethodRequests: scenario.forwardedSameMethodRequests ?? [],
    initializeCapabilityAdvertised: scenario.initializeCapabilityAdvertised,
    historyVisibleBeforeError: scenario.phases.some(row => row.phase === "history-visible-before-error" || row.phase === "history-visible-and-configuration-gated-before-error" || row.phase === "history-visible-and-older-page-loaded-before-error"),
    olderPage,
    errorFrameSent,
    browserReceivedExactError: scenario.browserReceived.some(row => row.jsonrpc === "2.0" && row.id === scenario.expectedError?.id &&
      row.code === CONTROLLED_ERROR.code && row.message === CONTROLLED_ERROR.message),
    browserReceivedErrorFrames: scenario.browserReceived,
    phases: scenario.phases,
  };
}

function routeFromUrl(value) {
  try {
    const url = new URL(String(value));
    return {
      server: url.searchParams.get("server"),
      workspace: url.searchParams.get("workspace"),
      channel: url.searchParams.get("channel"),
    };
  } catch { return null; }
}

function sameRoute(left, right) {
  return Boolean(left && right && left.server === right.server && left.workspace === right.workspace && left.channel === right.channel);
}

function markPhase(scenario, phase) {
  scenario.phase = phase;
  scenario.phases.push({ phase, at: Date.now() });
}
