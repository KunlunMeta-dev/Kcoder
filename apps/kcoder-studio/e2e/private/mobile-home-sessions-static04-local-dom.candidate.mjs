// Private, model-independent Browser candidate for the 2026-10-09 Home/Sessions
// incremental route changes. It reuses the existing local two-Gateway profile
// flow and retained-export copier. It starts no Rust app-server, Provider,
// Relay, SSH, or public service, and it never starts a turn.
//
// Exact manual command (integration checkout cwd):
// KCODER_E2E_CHROMIUM_NO_SANDBOX=1 KCODER_E2E_PRIVATE_HOME_SESSIONS_STATIC04=1 \
//   /home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node \
//   apps/kcoder-studio/e2e/private/mobile-home-sessions-static04-local-dom.candidate.mjs
//
// This file is a private review candidate, not a registered run-all suite.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { reuseMobileWebExport } from "../harness/mobile-web-export-reuse.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { parseObservedJsonRpcFrame } from "./mobile-public-new-catalog-dom-probe.candidate.mjs";

const PRIVATE_RUN_FLAG = "KCODER_E2E_PRIVATE_HOME_SESSIONS_STATIC04";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const SOURCE_TREE_SHA256 = "139184a0fa957d2c024340993f22036a46ddcb8a0907debf3d38355538843714";
const EXPORT_MANIFEST_SHA256 = "83275d4db706ac733dccd5f07eb642ddc53d9f15d5e32bec253653856eb9ff30";
const BUNDLE_SHA256 = "073fb5bdf2d8d8bdf6d0684afd1b56c3ba181985c2c5448fafee3bba9c8ad14a";
const BUNDLE_FILE_COUNT = 37;
const EXPORT_RELATIVE_ROOT = "target/private-phone-ux-implementation/mobile-web-export-incremental-home-sessions-20261009-054052";
const EXPORT_RELATIVE_MANIFEST = `${EXPORT_RELATIVE_ROOT}-manifest.json`;
const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const MAX_RPC_EVENTS = 512;
const WORKSPACES = Object.freeze({
  "A/fast-A": "/fixture/A-fast",
  "A/slow-A": "/fixture/A-slow",
  "B/fast-B": "/fixture/B-fast",
});
const SERVER_ALIASES = Object.freeze({
  "fast-A": "A-fast",
  "slow-A": "A-slow",
  "fast-B": "B-fast",
});
const MUTATING_METHODS = new Set([
  "thread/start", "thread/fork", "thread/delete", "thread/metadata/update",
  "thread/compact", "thread/rollback", "turn/start", "turn/interrupt",
  "runtime.worktrees.create", "runtime.worktrees.archive", "runtime.worktrees.restore",
]);

const SOURCE_PINS = Object.freeze({
  "apps/kcoder-studio/mobile/src/app/h/[profileId]/index.tsx": "e3b9e868e30bc9e375f517656a7f3e7a1efdcc7bbf9dc488170e5016a824d1b2",
  "apps/kcoder-studio/mobile/src/app/sessions.tsx": "9272f68b37799afce439cc5a88918bf0ed96f178b95887f31e2d9647fecb2c53",
  "apps/kcoder-studio/mobile/src/app/new.tsx": "c0d91a4b99aa462006c75146666afce21a663b646c0f9b3b59df7409cfe908ba",
  "apps/kcoder-studio/mobile/src/app/open-project.tsx": "c68bdf7d8adeda9b5e3fd3de2f6ae44bd2f007c0d4570e5fbe7de0e5c41af4fd",
  "apps/kcoder-studio/mobile/src/app/__tests__/thread-list-incremental-routes.review.test.tsx": "e1cb28b8b346ef298c9323c499b3f0ac5eb03c64b21889bccd39f42f158877ad",
  "apps/kcoder-studio/mobile/src/app/__tests__/new-catalog-read-publication.review.test.tsx": "d27ffd65ba74a8a39e842cac03ce9529a0480242ef8b9660c3c16e9c6b6b60c9",
  "apps/kcoder-studio/mobile/src/app/__tests__/new-workspace-handoff-discovery.review.test.tsx": "60390feeb2e95704628b42f6f3edda33a81cc4e29c03c3c3a9dfa0541604e947",
  "apps/kcoder-studio/dev-server.mjs": "de640946af19537953327d17f10411de0d84e32b29f77f72408bebbb4e48c832",
  "apps/kcoder-studio/src/mock-thread-store.js": "5ef2726f8565f8c0152dd4f95b15b32116adcd18941c7e3fca2a2bc6adf44941",
  "apps/kcoder-studio/e2e/harness/gateway.mjs": "7cef55697a767cb78c88dd9c4c72203e9db129e16d8502341e5496d3a325a2c9",
  "apps/kcoder-studio/e2e/harness/chromium.mjs": "6da43f71496317e00098780ab7e8c3bf0874e4b925c6add4e4c0e87bdf7b504c",
  "apps/kcoder-studio/e2e/harness/mobile-web-export-reuse.mjs": "d3e84b074e485dd2bf171d690d18e130920689b67711ad3f56a3bd791eb363f3",
  "apps/kcoder-studio/e2e/harness/run-context.mjs": "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11",
  "apps/kcoder-studio/e2e/private/mobile-public-new-catalog-dom-probe.candidate.mjs": "481152c8a343649231d396d343a151b54c471d6a94cde20d68ad3fe1958c3e9f",
  "apps/kcoder-studio/e2e/suites/mobile/mobile-qa-profile-background-reauth-isolation.e2e.mjs": "8f4676d5c7b6e90b061a4a4b4979c90a4fac77a578ecd8dabdc696efc1cea53f",
});

if (process.env[PRIVATE_RUN_FLAG] !== "1")
  throw new Error(`${PRIVATE_RUN_FLAG}=1 is required for this private candidate`);
if (process.execPath !== EXPECTED_NODE || process.version !== "v22.17.0")
  throw new Error("This candidate requires the pinned Node 22.17.0 executable");
if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1")
  throw new Error("This isolated VM requires explicit KCODER_E2E_CHROMIUM_NO_SANDBOX=1");

await runE2E(import.meta.url, {
  testId: "mobile-home-sessions-static04-local-mock-dom",
  tier: "manual-live",
  modelPolicy: "model-independent local Mobile Web DOM, route, mock-Gateway and profile-owner isolation; KCODER_STUDIO_MOCK=1; no Rust app-server, Provider, or turn",
  retainSuccessLogs: true,
}, async context => {
  const sourcePins = await verifySourcePins();
  const exportRoot = resolve(repoRoot, EXPORT_RELATIVE_ROOT);
  const exportManifest = resolve(repoRoot, EXPORT_RELATIVE_MANIFEST);
  assert.ok(isAbsolute(exportRoot) && isAbsolute(exportManifest));
  const mobileWeb = await reuseMobileWebExport(context, {
    bundleRoot: exportRoot,
    manifestPath: exportManifest,
    expectedSourceTreeSha256: SOURCE_TREE_SHA256,
    expectedManifestSha256: EXPORT_MANIFEST_SHA256,
    expectedBundleSha256: BUNDLE_SHA256,
    expectedBundleFileCount: BUNDLE_FILE_COUNT,
    label: "home-sessions-static04-local",
    outputName: "home-sessions-static04-web",
  });
  assert.equal(mobileWeb.sourceTreeSha256, SOURCE_TREE_SHA256);
  assert.equal(mobileWeb.sourceManifestSha256, EXPORT_MANIFEST_SHA256);
  assert.equal(mobileWeb.bundleSha256, BUNDLE_SHA256);
  assert.equal(mobileWeb.bundleFileCount, BUNDLE_FILE_COUNT);

  await context.writeArtifactJson("execution-plan.json", {
    schemaVersion: 1,
    scope: "local-mock-browser-only",
    modelPolicy: "no Rust app-server, Provider, turn/start, or thread/start",
    node: { executable: process.execPath, version: process.version },
    sandbox: { KCODER_E2E_CHROMIUM_NO_SANDBOX: true },
    export: {
      sourceEntryCount: 335,
      sourceTreeSha256: SOURCE_TREE_SHA256,
      bundleRootRelativePath: EXPORT_RELATIVE_ROOT,
      bundleManifestSha256: EXPORT_MANIFEST_SHA256,
      bundleSha256: BUNDLE_SHA256,
      bundleFileCount: BUNDLE_FILE_COUNT,
      exportPerformedByThisCandidate: false,
    },
    sourcePins,
    gateways: [
      { alias: "A", mock: true, targets: ["A-fast", "A-slow"], servesPinnedStaticBundle: true },
      { alias: "B", mock: true, targets: ["B-fast"], mobileWebOriginAllowlistAlias: "A" },
    ],
    expectedReads: ["initialize", "runtime.workspaces.list", "runtime.worktrees.list", "thread/list", "thread/read", "thread/resume"],
    allowedPairingCleanup: ["POST /api/mobile/session", "DELETE /api/mobile/session"],
    forbiddenRpcMethods: [...MUTATING_METHODS].sort(),
  });

  const workspaceAfast = context.pathInState("workspace-a-fast");
  const workspaceAslow = context.pathInState("workspace-a-slow");
  const workspaceBfast = context.pathInState("workspace-b-fast");
  await Promise.all([
    mkdir(workspaceAfast, { recursive: true, mode: 0o700 }),
    mkdir(workspaceAslow, { recursive: true, mode: 0o700 }),
    mkdir(workspaceBfast, { recursive: true, mode: 0o700 }),
  ]);
  const serversAPath = await context.writeStateJson("servers-a.json", [
    mockServer("fast-A", "Fast A", workspaceAfast),
    mockServer("slow-A", "Slow A", workspaceAslow),
  ]);
  const serversBPath = await context.writeStateJson("servers-b.json", [
    mockServer("fast-B", "Fast B", workspaceBfast),
  ]);
  const gatewayA = await startGateway(context, {
    label: "home-sessions-gateway-a",
    auth: true,
    workspace: workspaceAfast,
    serversFile: serversAPath,
    env: { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_WEB_ROOT: mobileWeb.path },
  });
  const gatewayB = await startGateway(context, {
    label: "home-sessions-gateway-b",
    auth: true,
    workspace: workspaceBfast,
    serversFile: serversBPath,
    env: {
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl,
    },
  });
  assert.notEqual(gatewayA.port, gatewayB.port, "A and B must be separate owned Gateways");

  const phases = {
    current: "home-a-fast-first-peer-and-cursor-held",
    homeSlowDiscovery: deferredGate("home-slow-discovery"),
    homeFastCursor: deferredGate("home-fast-cursor"),
    sessionsSlowCursor: deferredGate("sessions-slow-cursor"),
    profileBFirstPage: deferredGate("profile-b-first-page"),
  };
  const ledger = {
    events: [],
    droppedEvents: 0,
    malformedFrameCount: 0,
    unknownRpcResponseCount: 0,
    mutatingRequestCount: 0,
    http: [],
    held: { homeSlowDiscovery: false, homeFastCursor: false, sessionsSlowCursor: false, profileBFirstPage: false },
    historyReadThreadIds: [],
  };
  const record = event => {
    if (ledger.events.length >= MAX_RPC_EVENTS) { ledger.droppedEvents += 1; return; }
    ledger.events.push({ atNodeMs: performance.now(), phase: phases.current, ...event });
  };
  const roleForOrigin = value => {
    let origin;
    try { origin = httpOrigin(value); } catch { return null; }
    if (origin === gatewayA.baseUrl) return "A";
    if (origin === gatewayB.baseUrl) return "B";
    return null;
  };

  const chromium = await startChromium(context, { label: "home-sessions-static04-chromium", noSandbox: true });
  const browserContext = chromium.browser.contexts()[0];
  assert.ok(browserContext, "the owned Chromium default context must exist");
  const page = await browserContext.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  context.addCleanup("close home-sessions static04 page", async () => {
    if (!page.isClosed()) await page.close();
  });

  page.on("response", response => {
    try {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/")) return;
      ledger.http.push({
        role: roleForOrigin(url.origin) ?? "foreign",
        method: response.request().method(),
        path: safeApiPath(url.pathname),
        status: response.status(),
      });
    } catch { ledger.droppedEvents += 1; }
  });
  let pageErrorCount = 0;
  let consoleErrorCount = 0;
  page.on("pageerror", () => { pageErrorCount += 1; });
  page.on("console", message => { if (message.type() === "error") consoleErrorCount += 1; });

  await installRpcFixture(page, context, {
    gatewayA,
    gatewayB,
    roleForOrigin,
    phases,
    ledger,
    workspaceByTarget: WORKSPACES,
    record,
  });
  try {
    await connectProfileFromLogin(page, gatewayA);
    const profileA = await readProfileIdentity(page, gatewayA.baseUrl);
    await waitFor(() => phases.homeSlowDiscovery.held && phases.homeFastCursor.held,
      30_000, "A fast first page plus the independent slow discovery and fast cursor holds", 50, context.abortSignal);
    await visible(page, "thread-A_HOME_FIRST").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await visible(page, "thread-A_HOME_FIRST").isEnabled(), true,
      "the fast Home first-page row must be actionable while peer discovery and its cursor are held");

    phases.homeSlowDiscovery.release("reject");
    await page.getByText("A_SLOW_DISCOVERY_ERROR", { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "thread-A_HOME_FIRST").click();
    await waitForTaskRoute(page, profileA.id, "fast-A", "A_HOME_FIRST", workspaceAfast, "A Home first");
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("HISTORY_A_HOME_FIRST", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    phases.homeFastCursor.release("complete");
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await visible(page, "thread-A_HOME_FIRST").waitFor({ state: "visible", timeout: 30_000 });

    phases.current = "sessions-a-first-pages-and-held-peer-cursor";
    await visible(page, "sessions").click();
    const sessionsList = visible(page, "sessions-list");
    await sessionsList.waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "session-A_SESSIONS_FAST_0").waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "session-A_SESSIONS_SLOW_0").waitFor({ state: "visible", timeout: 30_000 });
    await scrollListWithBrowserInput(page, sessionsList);
    await waitFor(() => phases.sessionsSlowCursor.held,
      30_000, "slow Sessions cursor request held after an actual list scroll", 50, context.abortSignal);
    await visible(page, "session-A_SESSIONS_FAST_MORE").waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "sessions-page-loading").waitFor({ state: "visible", timeout: 30_000 });
    phases.sessionsSlowCursor.release("complete");
    await visible(page, "session-A_SESSIONS_SLOW_MORE").waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "sessions-page-loading").waitFor({ state: "hidden", timeout: 30_000 });

    await visible(page, "session-A_SESSIONS_FAST_0").click();
    await waitForTaskRoute(page, profileA.id, "fast-A", "A_SESSIONS_FAST_0", workspaceAfast, "A Sessions first");
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("HISTORY_A_SESSIONS_FAST_0", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await visible(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });

    phases.current = "pair-b-actual-settings-profile";
    await openDrawerSettings(page);
    await clickAddGateway(page);
    await visible(page, "welcome-direct-connection").click();
    await visible(page, "gateway-endpoint").fill(gatewayB.baseUrl);
    await visible(page, "gateway-token").fill(gatewayB.authToken);
    phases.current = "profile-b-bootstrap";
    await visible(page, "gateway-connect").click();
    await visible(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    const profileB = await readProfileIdentity(page, gatewayB.baseUrl);
    assert.notEqual(profileA.id, profileB.id, "two owned Gateway profiles must have distinct IDs");
    await waitForStoredActiveProfile(page, profileB.id);
    await visible(page, "thread-B_BOOTSTRAP_FIRST").waitFor({ state: "visible", timeout: 30_000 });

    phases.current = "profile-a-after-b-bootstrap";
    await openDrawerSettings(page);
    await switchToProfile(page, profileA);
    await visible(page, "thread-A_HOME_FIRST").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByText("A_SLOW_DISCOVERY_ERROR", { exact: false }).count() > 0, true,
      "A's owned discovery error must exist before the A-to-B isolation check");

    phases.current = "settings-a-to-b-owner-switch-with-b-first-page-held";
    await openDrawerSettings(page);
    await switchToProfile(page, profileB);
    await waitFor(() => phases.profileBFirstPage.held,
      30_000, "B's first thread/list response held after the actual Settings A-to-B switch", 50, context.abortSignal);
    await waitForStoredActiveProfile(page, profileB.id);
    assert.equal(await visible(page, "thread-A_HOME_FIRST").count(), 0,
      "A's Home row must be absent before B's held first page is released");
    assert.equal(await page.getByText("A_SLOW_DISCOVERY_ERROR", { exact: false }).count(), 0,
      "A's workspace discovery error must be absent before B's held first page is released");
    phases.profileBFirstPage.release("complete");
    await visible(page, "thread-B_AFTER_SWITCH_FIRST").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await visible(page, "thread-A_HOME_FIRST").count(), 0);
    await visible(page, "thread-B_AFTER_SWITCH_FIRST").click();
    await waitForTaskRoute(page, profileB.id, "fast-B", "B_AFTER_SWITCH_FIRST", workspaceBfast, "B after switch");
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("HISTORY_B_AFTER_SWITCH_FIRST", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    assert.equal(ledger.mutatingRequestCount, 0, "the browser must not issue thread/turn or other mutation RPCs");
    assert.equal(ledger.droppedEvents, 0, "RPC evidence must remain within the bounded collector");
    assert.equal(ledger.malformedFrameCount, 0, "all observed RPC frames must parse");
    assert.equal(ledger.unknownRpcResponseCount, 0, "all observed RPC responses must correlate to one request");
    assert.equal(pageErrorCount, 0, "the page must have no uncaught JavaScript errors");
    assert.equal(consoleErrorCount, 0, "the page must have no console errors");
    const historyAliasesRead = [...new Set(ledger.historyReadThreadIds.map(historyAlias))].sort();
    for (const expectedAlias of ["A_HOME_FIRST", "A_SESSIONS_FAST_0", "B_AFTER_SWITCH_FIRST"])
      assert.ok(historyAliasesRead.includes(expectedAlias), `actual thread/read response for ${expectedAlias} must be observed`);
    const heldBPage = ledger.events.find(event => event.phase === "settings-a-to-b-owner-switch-with-b-first-page-held" && event.role === "B" && event.method === "thread/list" && event.kind === "held-response");
    assert.ok(heldBPage, "the owner-switch check must be backed by B's actual held RPC response");
    assert.ok(ledger.events.some(event => event.phase === heldBPage.phase && event.role === "B" && event.method === "thread/list" && event.kind === "rpc-request" && event.requestIdFingerprint === heldBPage.requestIdFingerprint),
      "the held B response must correlate to its observed list request");

    await context.writeArtifactJson("mobile-home-sessions-static04-local-dom-result.json", {
      schemaVersion: 1,
      status: "passed",
      claimScope: "local two-Gateway Mobile Web mock DOM/profile route only; not Rust, public Relay, real-phone, Provider, or model evidence",
      export: { sourceTreeSha256: SOURCE_TREE_SHA256, manifestSha256: EXPORT_MANIFEST_SHA256, bundleSha256: BUNDLE_SHA256, bundleFileCount: BUNDLE_FILE_COUNT },
      profileAliases: { A: shortHash(profileA.id), B: shortHash(profileB.id), distinct: profileA.id !== profileB.id },
      gatewayAliases: { A: gatewayA.port, B: gatewayB.port, distinct: gatewayA.port !== gatewayB.port },
      home: { firstRowVisibleWhilePeerAndCursorHeld: true, firstRowClickedWhilePeerErrorAndCursorHeld: true, routeAndHistoryVerified: true },
      sessions: { firstRowsVisible: true, fastLoadMoreVisibleWhileSlowCursorHeld: true, slowCursorReleasedAndVisible: true, routeAndHistoryVerified: true },
      profileSwitch: { actualSettingsSwitch: true, oldARowAbsentBeforeBFirstPageRelease: true, oldAErrorAbsentBeforeBFirstPageRelease: true, BRouteAndHistoryVerified: true },
      calls: { mutationRpcCount: ledger.mutatingRequestCount, historyAliasesRead, pageErrorCount, consoleErrorCount },
      http: ledger.http,
      rpcEvents: ledger.events,
      droppedEvents: ledger.droppedEvents,
      sourcePins,
    });
  } catch (error) {
    await context.writeArtifactJson("mobile-home-sessions-static04-local-dom-failure.json", {
      schemaVersion: 1,
      status: "failed",
      phase: phases.current,
      errorName: safeErrorName(error),
      rpcEvents: ledger.events,
      http: ledger.http,
      droppedEvents: ledger.droppedEvents,
      malformedFrameCount: ledger.malformedFrameCount,
      unknownRpcResponseCount: ledger.unknownRpcResponseCount,
      mutatingRequestCount: ledger.mutatingRequestCount,
      historyAliasesRead: [...new Set(ledger.historyReadThreadIds.map(historyAlias))].sort(),
      pageErrorCount,
      consoleErrorCount,
      sourcePins,
    });
    throw error;
  } finally {
    phases.homeSlowDiscovery.release("cleanup");
    phases.homeFastCursor.release("cleanup");
    phases.sessionsSlowCursor.release("cleanup");
    phases.profileBFirstPage.release("cleanup");
  }
});

async function installRpcFixture(page, context, { gatewayA, gatewayB, roleForOrigin, phases, ledger, workspaceByTarget, record }) {
  await page.routeWebSocket("**/rpc*", routed => {
    let role = null;
    let serverId = "unknown";
    let workspaceAlias = "default";
    try {
      const url = new URL(typeof routed.url === "function" ? routed.url() : routed.url);
      role = roleForOrigin(url.origin);
      serverId = url.searchParams.get("server") ?? "unknown";
      const workspace = url.searchParams.get("workspace");
      if (workspace) workspaceAlias = Object.keys(workspaceByTarget).find(key => workspaceByTarget[key] === workspace) ?? "other";
    } catch { ledger.malformedFrameCount += 1; }
    const upstream = routed.connectToServer();
    const outstanding = new Map();
    let closed = false;
    routed.onClose(() => { closed = true; });
    routed.onMessage(raw => {
      const parsed = parseObservedJsonRpcFrame("client-to-server", raw);
      if (!parsed.ok) {
        ledger.malformedFrameCount += 1;
        upstream.send(raw);
        return;
      }
      if (parsed.envelopeKind === "request") {
        const frame = parsed.frame;
        const key = rpcKey(frame.id);
        const method = frame.method;
        outstanding.set(key, { id: frame.id, method, params: isRecord(frame.params) ? frame.params : {}, role, serverId, workspaceAlias });
        if (MUTATING_METHODS.has(method)) ledger.mutatingRequestCount += 1;
        record({ kind: "rpc-request", direction: "client-to-server", role: role ?? "foreign", server: SERVER_ALIASES[serverId] ?? "unknown", workspace: workspaceAlias, method: safeMethod(method), requestIdFingerprint: shortHash(key), hasCursor: Boolean(frame.params?.cursor) });
      }
      upstream.send(raw);
    });
    upstream.onMessage(async raw => {
      const parsed = parseObservedJsonRpcFrame("server-to-client", raw);
      if (!parsed.ok) {
        ledger.malformedFrameCount += 1;
        routed.send(raw);
        return;
      }
      if (parsed.envelopeKind !== "response") {
        routed.send(raw);
        return;
      }
      const response = structuredClone(parsed.frame);
      const request = outstanding.get(rpcKey(response.id));
      if (!request) {
        ledger.unknownRpcResponseCount += 1;
        routed.send(raw);
        return;
      }
      outstanding.delete(rpcKey(response.id));
      const action = await shapeOrHoldResponse(response, request, phases, workspaceByTarget, ledger, closed);
      if (closed) return;
      record({ kind: action.held ? "held-response-released" : "rpc-response", direction: "server-to-client", role: request.role ?? "foreign", server: SERVER_ALIASES[request.serverId] ?? "unknown", workspace: request.workspaceAlias, method: safeMethod(request.method), requestIdFingerprint: shortHash(rpcKey(request.id)), responseShape: Object.hasOwn(action.frame, "error") ? "error" : "result", held: action.held });
      routed.send(JSON.stringify(action.frame));
    });
  });
}

async function shapeOrHoldResponse(response, request, phases, workspaceByTarget, ledger, closed) {
  const { role, serverId, method, params } = request;
  let held = false;
  if (method === "runtime.workspaces.list" && role === "A" && serverId === "slow-A" && phases.current === "home-a-fast-first-peer-and-cursor-held" && !phases.homeSlowDiscovery.released) {
    phases.homeSlowDiscovery.held = true;
    ledger.held.homeSlowDiscovery = true;
    recordForGate(ledger, phases, "held-response", role, serverId, method, response.id);
    const releaseKind = await phases.homeSlowDiscovery.promise;
    held = true;
    if (closed) return { frame: response, held };
    if (releaseKind === "reject")
      return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32110, message: "A_SLOW_DISCOVERY_ERROR" } }, held };
  }
  if (method === "runtime.workspaces.list" && role === "A" && serverId === "slow-A" && phases.current === "profile-a-after-b-bootstrap")
    return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32110, message: "A_SLOW_DISCOVERY_ERROR" } }, held };
  if (method === "runtime.workspaces.list") {
    const workspace = workspaceByTarget[`${role}/${serverId}`];
    if (workspace) response.result = { ...(isRecord(response.result) ? response.result : {}), success: true, items: [{ workspacePath: workspace, label: SERVER_ALIASES[serverId] ?? serverId }], pinnedTaskIds: [], taskOrders: {} };
  } else if (method === "runtime.worktrees.list") {
    response.result = { ...(isRecord(response.result) ? response.result : {}), success: true, items: [] };
  } else if (method === "thread/list") {
    const page = fixturePage(phases.current, role, serverId, params);
    if (page) {
      if (page.gate) {
        const gate = phases[page.gate];
        gate.held = true;
        if (page.gate === "homeFastCursor") ledger.held.homeFastCursor = true;
        if (page.gate === "sessionsSlowCursor") ledger.held.sessionsSlowCursor = true;
        if (page.gate === "profileBFirstPage") ledger.held.profileBFirstPage = true;
        recordForGate(ledger, phases, "held-response", role, serverId, method, response.id);
        await gate.promise;
        held = true;
        if (closed) return { frame: response, held };
      }
      response.result = { ...(isRecord(response.result) ? response.result : {}), threads: page.threads, nextCursor: page.nextCursor ?? null, completeness: "complete", issueCount: 0 };
    }
  } else if (method === "thread/read") {
    const threadId = typeof params.threadId === "string" ? params.threadId : "unknown-thread";
    ledger.historyReadThreadIds.push(threadId);
    const alias = historyAlias(threadId);
    response.result = {
      ...(isRecord(response.result) ? response.result : {}),
      thread: { id: threadId, title: threadId, cwd: workspaceByTarget[`${role}/${serverId}`] ?? "/", status: "idle", model: "mock-local", createdAt: 1, updatedAt: 2 },
      messages: [{ id: `history-${alias}`, role: "user", content: `HISTORY_${alias}`, timestampMs: 2, blocks: [] }],
    };
  }
  return { frame: response, held };
}

function fixturePage(phase, role, serverId, params) {
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  if (phase === "home-a-fast-first-peer-and-cursor-held" && role === "A" && serverId === "fast-A") {
    if (!cursor) return { threads: [threadSummary("A_HOME_FIRST", "A fast first", WORKSPACES["A/fast-A"])], nextCursor: "home-fast-cursor" };
    if (cursor === "home-fast-cursor") return { threads: [threadSummary("A_HOME_MORE", "A fast later", WORKSPACES["A/fast-A"])], nextCursor: null, gate: "homeFastCursor" };
  }
  if (phase === "sessions-a-first-pages-and-held-peer-cursor" && role === "A" && (serverId === "fast-A" || serverId === "slow-A")) {
    const prefix = serverId === "fast-A" ? "A_SESSIONS_FAST" : "A_SESSIONS_SLOW";
    if (!cursor) {
      const workspace = WORKSPACES[`A/${serverId}`];
      return { threads: Array.from({ length: 8 }, (_value, index) => threadSummary(`${prefix}_${index}`, `${prefix} ${index}`, workspace)), nextCursor: `${prefix}_CURSOR` };
    }
    if (cursor === "A_SESSIONS_FAST_CURSOR" && serverId === "fast-A")
      return { threads: [threadSummary("A_SESSIONS_FAST_MORE", "A fast more", WORKSPACES["A/fast-A"])], nextCursor: null };
    if (cursor === "A_SESSIONS_SLOW_CURSOR" && serverId === "slow-A")
      return { threads: [threadSummary("A_SESSIONS_SLOW_MORE", "A slow more", WORKSPACES["A/slow-A"])], nextCursor: null, gate: "sessionsSlowCursor" };
  }
  if ((phase === "profile-b-bootstrap" || phase === "settings-a-to-b-owner-switch-with-b-first-page-held") && role === "B" && serverId === "fast-B" && !cursor) {
    if (phase === "settings-a-to-b-owner-switch-with-b-first-page-held")
      return { threads: [threadSummary("B_AFTER_SWITCH_FIRST", "B after switch", WORKSPACES["B/fast-B"])], nextCursor: null, gate: "profileBFirstPage" };
    return { threads: [threadSummary("B_BOOTSTRAP_FIRST", "B bootstrap", WORKSPACES["B/fast-B"])], nextCursor: null };
  }
  if (phase === "profile-a-after-b-bootstrap" && role === "A" && serverId === "fast-A" && !cursor)
    return { threads: [threadSummary("A_HOME_FIRST", "A fast first", WORKSPACES["A/fast-A"])], nextCursor: null };
  return null;
}

async function verifySourcePins() {
  const observed = {};
  for (const [relativePath, expected] of Object.entries(SOURCE_PINS)) {
    const file = resolve(repoRoot, relativePath);
    assert.equal(await realpath(file), file, `source pin must be canonical: ${relativePath}`);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `source pin must be a regular file: ${relativePath}`);
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    assert.equal(digest, expected, `source pin changed: ${relativePath}`);
    observed[relativePath] = digest;
  }
  return observed;
}

async function connectProfileFromLogin(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await visible(page, "welcome-direct-connection").click();
  await visible(page, "gateway-endpoint").fill(gateway.baseUrl);
  await visible(page, "gateway-token").fill(gateway.authToken);
  await visible(page, "gateway-connect").click();
  await visible(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function openDrawerSettings(page) {
  const menu = page.locator('[aria-label="打开任务列表"]:visible, [aria-label="打开导航"]:visible');
  await menu.first().click();
  const drawer = visible(page, "mobile-drawer");
  await drawer.waitFor({ state: "visible", timeout: 10_000 });
  await drawer.getByLabel("设置", { exact: true }).click();
}

async function clickAddGateway(page) {
  const label = (await page.locator("html").getAttribute("lang")) === "en" ? "Add Gateway" : "添加 Gateway";
  await page.getByText(label, { exact: true }).and(page.locator(":visible")).click();
}

async function switchToProfile(page, profile) {
  const prefix = (await page.locator("html").getAttribute("lang")) === "en" ? "Switch to" : "切换到";
  await page.getByLabel(`${prefix} ${profile.label}`, { exact: true }).and(page.locator(":visible")).click();
  await waitForStoredActiveProfile(page, profile.id);
}

async function readProfileIdentity(page, baseUrl) {
  const profile = await page.evaluate(({ key, expectedBaseUrl }) => {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    const profiles = Array.isArray(raw) ? raw : raw?.profiles;
    if (!Array.isArray(profiles)) return null;
    const value = profiles.find(item => item?.baseUrl === expectedBaseUrl);
    return typeof value?.id === "string" && typeof value?.label === "string" ? { id: value.id, label: value.label } : null;
  }, { key: PROFILE_INDEX_KEY, expectedBaseUrl: baseUrl });
  assert.ok(profile, "the actual UI pairing must persist an owned profile identity");
  return profile;
}

async function waitForStoredActiveProfile(page, profileId) {
  await page.waitForFunction(({ key, expected }) => {
    try { return JSON.parse(localStorage.getItem(key) ?? "null")?.activeId === expected; }
    catch { return false; }
  }, { key: PROFILE_INDEX_KEY, expected: profileId }, { timeout: 15_000 });
}

async function waitForTaskRoute(page, profileId, serverId, threadId, cwd, title) {
  await waitFor(() => {
    try {
      const url = new URL(page.url());
      return url.pathname === `/h/${encodeURIComponent(profileId)}/task/${encodeURIComponent(serverId)}/${encodeURIComponent(threadId)}` &&
        url.searchParams.get("cwd") === cwd && url.searchParams.get("title") === title;
    } catch { return false; }
  }, 15_000, "exact Mobile task route profile/server/thread/cwd/title", 50);
}

async function scrollListWithBrowserInput(page, list) {
  await list.scrollIntoViewIfNeeded();
  const box = await list.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "Sessions list must have a visible scroll box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, Math.max(1200, box.height * 3));
}

function mockServer(id, label, workspace) {
  return { id, label, runtime: "kcoder", transport: "local", command: process.execPath, workspace };
}

function threadSummary(id, title, cwd) {
  return { id, title, cwd, status: "idle", model: "mock-local", createdAt: 1, updatedAt: 2 };
}

function deferredGate(name) {
  let resolve;
  let released = false;
  const promise = new Promise(done => { resolve = done; });
  return {
    name,
    held: false,
    get released() { return released; },
    promise,
    release(value) { if (released) return; released = true; resolve(value); },
  };
}

function recordForGate(ledger, phases, kind, role, serverId, method, id) {
  if (ledger.events.length >= MAX_RPC_EVENTS) { ledger.droppedEvents += 1; return; }
  ledger.events.push({ atNodeMs: performance.now(), phase: phases.current, kind, role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method), requestIdFingerprint: shortHash(rpcKey(id)) });
}

function historyAlias(id) {
  if (id === "A_HOME_FIRST") return "A_HOME_FIRST";
  if (id === "A_SESSIONS_FAST_0") return "A_SESSIONS_FAST_0";
  if (id === "B_AFTER_SWITCH_FIRST") return "B_AFTER_SWITCH_FIRST";
  return "OTHER";
}

function safeApiPath(pathname) {
  if (pathname === "/api/servers" || pathname === "/api/servers/status" || pathname === "/api/mobile/session") return pathname;
  return "/api/<other>";
}

function safeMethod(value) {
  return typeof value === "string" && /^[a-z][a-zA-Z0-9./_-]{0,63}$/.test(value) ? value : "other";
}

function rpcKey(value) { return `${typeof value}:${String(value)}`; }

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function httpOrigin(value) {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin;
}

function visible(page, testId) { return page.locator(`[data-testid="${testId}"]:visible`); }

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function safeErrorName(error) {
  const allowed = new Set(["Error", "TypeError", "RangeError", "AssertionError", "TimeoutError", "AbortError", "AggregateError"]);
  return allowed.has(error?.name) ? error.name : "OtherError";
}
