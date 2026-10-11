// Private, model-independent Browser candidate for the 2026-10-09 Sessions
// default-discovery lease revision. It reuses the existing local two-Gateway profile
// flow and retained-export copier. It starts no Rust app-server, Provider,
// Relay, SSH, or public service, and it never starts a turn.
//
// Exact manual command (integration checkout cwd):
// KCODER_E2E_CHROMIUM_NO_SANDBOX=1 KCODER_E2E_PRIVATE_HOME_SESSIONS_LEASE3=1 \
//   /home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node \
//   apps/kcoder-studio/e2e/private/mobile-home-sessions-lease3-local-dom.candidate.mjs
//
// This file is a private review candidate, not a registered run-all suite.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, lstat, realpath, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { parseObservedJsonRpcFrame } from "../mobile-public-new-catalog-dom-probe.candidate.mjs";

const PRIVATE_RUN_FLAG = "KCODER_E2E_PRIVATE_HOME_SESSIONS_LEASE3";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const SOURCE_TREE_SHA256 = "effa93130e74c958a4fd6639e79efab1d1a8bc78bcd18648aa9f70fe26f2b233";
const SOURCE_FILE_COUNT = 336;
const SOURCE_FREEZE_RELATIVE_ROOT = "target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104";
const SOURCE_METADATA_SHA256 = "9735c1cf961031e235a2811a6f173794b1946d4f4d9282d50566a686c0fb9d3f";
const SOURCE_MAP_SHA256 = "d78b6de305d13b7a9ce24798dc8cbd5a9c8afdeae7cc133111634259d97fb916";
const SOURCE_MANIFEST_SHA256 = "604d8915c48d56ac58404990183072b73db0c63abd68821a974b311b2f4924a5";
const EXPORT_MANIFEST_SHA256 = "873acb13320c76f9f770418b909a1acc34aa069e4699a567bc2385756835d7d0";
const EXPORT_PROVENANCE_SHA256 = "aaccffadf796366601b1e169c53b43332748325c7f441869564f1b68b71cf7cd";
const BUNDLE_SHA256 = "73f068775c6d8a24f4051a1caeb05b4275f47af2cb35390704fb28aa58816689";
const BUNDLE_FILE_COUNT = 37;
const EXPORT_RELATIVE_ROOT = "target/private-phone-ux-implementation/mobile-web-export-sessions-default-lease-20261009-062104";
const EXPORT_RELATIVE_MANIFEST = `${EXPORT_RELATIVE_ROOT}-manifest.json`;
const EXPORT_RELATIVE_PROVENANCE = `${EXPORT_RELATIVE_ROOT}-provenance.json`;
const SOURCE_RELATIVE_MAP = `${SOURCE_FREEZE_RELATIVE_ROOT}/sha256.json`;
const SOURCE_RELATIVE_MANIFEST = `${SOURCE_FREEZE_RELATIVE_ROOT}/source-manifest.json`;
const SOURCE_RELATIVE_METADATA = `${SOURCE_FREEZE_RELATIVE_ROOT}/metadata.json`;
const SOURCE_RELATIVE_CONTENT_ROOT = `${SOURCE_FREEZE_RELATIVE_ROOT}/source`;
const GATEWAY_SOURCE_FILE_COUNT = 67;
const GATEWAY_SOURCE_TREE_SHA256 = "843e34d9aa55c123a40cdd002015ad89e13b78df7a378f34bb6b01b70b1457b2";
const MAX_GATEWAY_SOURCE_FILES = 512;
const MAX_GATEWAY_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_GATEWAY_SOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const MAX_RPC_EVENTS = 512;
const MAX_PENDING_RPCS = 128;
const MAX_TOTAL_PENDING_RPCS = 256;
const MAX_WEBSOCKET_ROUTES = 32;
const MAX_HTTP_EVENTS = 128;
const MAX_HISTORY_READS = 64;
const SERVER_ALIASES = Object.freeze({
  "fast-A": "A-fast",
  "slow-A": "A-slow",
  "fast-B": "B-fast",
});
const THREAD_FIXTURES = Object.freeze({
  homeFirst: Object.freeze({ id: "A_HOME_FIRST", title: "A Home first" }),
  homeMore: Object.freeze({ id: "A_HOME_MORE", title: "A Home later" }),
  sessionsFastFirst: Object.freeze({ id: "A_SESSIONS_FAST_0", title: "A Sessions first" }),
  sessionsSlowFirst: Object.freeze({ id: "A_SESSIONS_SLOW_0", title: "A Sessions slow first" }),
  sessionsFastMore: Object.freeze({ id: "A_SESSIONS_FAST_MORE", title: "A Sessions fast more" }),
  sessionsSlowMore: Object.freeze({ id: "A_SESSIONS_SLOW_MORE", title: "A Sessions slow more" }),
  profileBBootstrap: Object.freeze({ id: "B_BOOTSTRAP_FIRST", title: "B bootstrap" }),
  profileBAfterSwitch: Object.freeze({ id: "B_AFTER_SWITCH_FIRST", title: "B after switch" }),
});
const THREAD_FIXTURE_ROUTES = new Map([
  [THREAD_FIXTURES.homeFirst.id, "A/fast-A"],
  [THREAD_FIXTURES.homeMore.id, "A/fast-A"],
  [THREAD_FIXTURES.sessionsFastFirst.id, "A/fast-A"],
  [THREAD_FIXTURES.sessionsFastMore.id, "A/fast-A"],
  [THREAD_FIXTURES.sessionsSlowFirst.id, "A/slow-A"],
  [THREAD_FIXTURES.sessionsSlowMore.id, "A/slow-A"],
  [THREAD_FIXTURES.profileBBootstrap.id, "B/fast-B"],
  [THREAD_FIXTURES.profileBAfterSwitch.id, "B/fast-B"],
]);
for (let index = 1; index < 8; index += 1) {
  THREAD_FIXTURE_ROUTES.set(`A_SESSIONS_FAST_${index}`, "A/fast-A");
  THREAD_FIXTURE_ROUTES.set(`A_SESSIONS_SLOW_${index}`, "A/slow-A");
}
const FIXTURE_THREAD_IDS = new Set(THREAD_FIXTURE_ROUTES.keys());
const ALLOWED_CLIENT_RPC_METHODS = new Set([
  "initialize", "runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list",
  "thread/list", "thread/read", "thread/resume", "thread/goal/get",
]);
const ALLOWED_CLIENT_NOTIFICATIONS = new Set(["initialized"]);
const ALLOWED_SERVER_NOTIFICATIONS = new Set(["thread/goal/updated"]);

const SOURCE_PINS = Object.freeze({
  "apps/kcoder-studio/mobile/src/app/h/[profileId]/index.tsx": "e3b9e868e30bc9e375f517656a7f3e7a1efdcc7bbf9dc488170e5016a824d1b2",
  "apps/kcoder-studio/mobile/src/app/sessions.tsx": "ddc92d676975d52c93c682130bdcb6b3fb7ccc3c135f0f2de4e52752dbdfa159",
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
  testId: "mobile-home-sessions-lease3-local-mock-dom",
  tier: "manual-live",
  modelPolicy: "model-independent local Mobile Web DOM, route, mock-Gateway and profile-owner isolation; KCODER_STUDIO_MOCK=1; no Rust app-server, Provider, or turn",
  retainSuccessLogs: true,
}, async context => {
  const sourceFreeze = await verifyFrozenSourceInputs();
  const sourcePins = await verifySourcePins(sourceFreeze.sourceMap);
  const gatewaySourceBefore = await hashGatewaySourceTree();
  assert.equal(gatewaySourceBefore.fileCount, GATEWAY_SOURCE_FILE_COUNT, "complete Gateway source closure file count changed");
  assert.equal(gatewaySourceBefore.sourceTreeSha256, GATEWAY_SOURCE_TREE_SHA256, "complete Gateway source closure changed");
  const exportRoot = resolve(repoRoot, EXPORT_RELATIVE_ROOT);
  const exportManifest = resolve(repoRoot, EXPORT_RELATIVE_MANIFEST);
  const exportProvenance = resolve(repoRoot, EXPORT_RELATIVE_PROVENANCE);
  assert.ok(isAbsolute(exportRoot) && isAbsolute(exportManifest) && isAbsolute(exportProvenance));
  const exportProvenanceSha256 = await verifyPinnedRegularFile(exportProvenance, EXPORT_PROVENANCE_SHA256);
  const derivedExport = await deriveSchema1ReuseInput(context, exportRoot, exportManifest, exportProvenance);
  const mobileWeb = await reuseMobileWebExport(context, {
    bundleRoot: derivedExport.bundleRoot,
    manifestPath: derivedExport.manifestPath,
    expectedSourceTreeSha256: SOURCE_TREE_SHA256,
    expectedManifestSha256: derivedExport.manifestSha256,
    expectedBundleSha256: BUNDLE_SHA256,
    expectedBundleFileCount: BUNDLE_FILE_COUNT,
    label: "home-sessions-lease3-local",
    outputName: "home-sessions-lease3-web",
  });
  assert.equal(mobileWeb.sourceTreeSha256, SOURCE_TREE_SHA256);
  assert.equal(mobileWeb.sourceManifestSha256, derivedExport.manifestSha256);
  assert.equal(mobileWeb.bundleSha256, BUNDLE_SHA256);
  assert.equal(mobileWeb.bundleFileCount, BUNDLE_FILE_COUNT);

  await context.writeArtifactJson("execution-plan.json", {
    schemaVersion: 1,
    scope: "local-mock-browser-only",
    modelPolicy: "no Rust app-server, Provider, turn/start, or thread/start",
    node: { executable: process.execPath, version: process.version },
    sandbox: { KCODER_E2E_CHROMIUM_NO_SANDBOX: true },
    export: {
      sourceEntryCount: SOURCE_FILE_COUNT,
      sourceTreeSha256: SOURCE_TREE_SHA256,
      sourceFreezeManifestSha256: sourceFreeze.sourceManifestSha256,
      sourceFreezeMapSha256: sourceFreeze.sourceMapSha256,
      sourceFreezeMetadataSha256: sourceFreeze.sourceMetadataSha256,
      bundleRootRelativePath: EXPORT_RELATIVE_ROOT,
      bundleExportManifestSha256: EXPORT_MANIFEST_SHA256,
      derivedReuseManifestSha256: derivedExport.manifestSha256,
      exportProvenanceSha256,
      bundleSha256: BUNDLE_SHA256,
      bundleFileCount: BUNDLE_FILE_COUNT,
      exportPerformedByThisCandidate: false,
    },
    sourcePins,
    gatewaySource: {
      boundary: "dev-server.mjs, package.json, pnpm-lock.yaml, complete src/, complete shared/ source snapshot; excludes dependency files",
      fileCount: gatewaySourceBefore.fileCount,
      sourceTreeSha256: gatewaySourceBefore.sourceTreeSha256,
    },
    gateways: [
      { alias: "A", mock: true, targets: ["A-fast", "A-slow"], servesPinnedStaticBundle: true },
      { alias: "B", mock: true, targets: ["B-fast"], mobileWebOriginAllowlistAlias: "A" },
    ],
    allowedClientRpcMethods: [...ALLOWED_CLIENT_RPC_METHODS].sort(),
    allowedClientNotifications: [...ALLOWED_CLIENT_NOTIFICATIONS].sort(),
    unknownClientRpcPolicy: "record-and-reject; never forward outside the explicit read-only allowlist",
    foreignOriginPolicy: "all HTTP(S) requests outside the two owned Gateway origins, with non-owned Origin headers, or with URL credentials are aborted; all WebSockets outside exact owned /rpc+server+workspace routes are closed before upstream connect",
    observerBounds: { rpcEvents: MAX_RPC_EVENTS, httpApiResponses: MAX_HTTP_EVENTS, historyReads: MAX_HISTORY_READS, rejectedClientMethods: 32, sockets: MAX_WEBSOCKET_ROUTES, perSocketPendingRpc: MAX_PENDING_RPCS, totalPendingRpc: MAX_TOTAL_PENDING_RPCS, httpRequests: 512 },
    allowedPairingCleanup: ["POST /api/mobile/session", "DELETE /api/mobile/session"],
  });

  const workspaceAfast = context.pathInState("workspace-a-fast");
  const workspaceAslow = context.pathInState("workspace-a-slow");
  const workspaceBfast = context.pathInState("workspace-b-fast");
  const workspaceByTarget = Object.freeze({
    "A/fast-A": workspaceAfast,
    "A/slow-A": workspaceAslow,
    "B/fast-B": workspaceBfast,
  });
  await Promise.all([
    mkdir(workspaceAfast, { recursive: true, mode: 0o700 }),
    mkdir(workspaceAslow, { recursive: true, mode: 0o700 }),
    mkdir(workspaceBfast, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all(Object.values(workspaceByTarget).map(path => assertOwnedWorkspace(context, path)));
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
    gates: {
      homeSlowDiscovery: deferredGate("home-slow-discovery"),
      homeFastCursor: deferredGate("home-fast-cursor"),
      sessionsSlowCursor: deferredGate("sessions-slow-cursor"),
      profileBFirstPage: deferredGate("profile-b-first-page"),
    },
  };
  const ledger = {
    events: [],
    droppedEvents: 0,
    droppedHttpEvents: 0,
    droppedHistoryReadCount: 0,
    malformedFrameCount: 0,
    unknownRpcResponseCount: 0,
    rejectedClientRpcCount: 0,
    rejectedServerFrameCount: 0,
    rejectedWebSocketCount: 0,
    foreignWebSocketBlockedCount: 0,
    foreignHttpBlockedCount: 0,
    foreignHttpResponseCount: 0,
    httpRouteCount: 0,
    httpRouteOverflowCount: 0,
    webSocketRouteOverflowCount: 0,
    webSocketRouteCount: 0,
    pendingRpcCount: 0,
    fixtureErrorCount: 0,
    rejectedClientMethods: [],
    http: [],
    gates: phases.gates,
    held: { homeSlowDiscovery: false, homeFastCursor: false, sessionsSlowCursor: false, profileBFirstPage: false },
    historyReadThreadIds: [],
  };
  let homeClickHoldState = null;
  const record = event => {
    if (ledger.events.length >= MAX_RPC_EVENTS) { ledger.droppedEvents += 1; return; }
    const phase = typeof event.phase === "string" ? event.phase : phases.current;
    const { phase: _capturedPhase, ...fields } = event;
    ledger.events.push({ atNodeMs: performance.now(), phase, ...fields });
  };
  const roleForOrigin = value => {
    let origin;
    try { origin = httpOrigin(value); } catch { return null; }
    if (origin === gatewayA.baseUrl) return "A";
    if (origin === gatewayB.baseUrl) return "B";
    return null;
  };

  const chromium = await startChromium(context, { label: "home-sessions-lease3-chromium", noSandbox: true });
  const browserContext = chromium.browser.contexts()[0];
  assert.ok(browserContext, "the owned Chromium default context must exist");
  const page = await browserContext.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  context.addCleanup("close home-sessions lease3 page", async () => {
    if (!page.isClosed()) await page.close();
  });

  const httpRequestPhases = new WeakMap();
  await page.route("**/*", async route => {
    try {
      ledger.httpRouteCount += 1;
      if (ledger.httpRouteCount > 512) {
        ledger.httpRouteOverflowCount += 1;
        await route.abort("blockedbyclient");
        return;
      }
      const request = route.request();
      const url = new URL(request.url());
      const role = ["http:", "https:"].includes(url.protocol) ? roleForOrigin(url.origin) : null;
      const requestOrigin = request.headers().origin;
      const originHeaderOwned = !requestOrigin || roleForOrigin(requestOrigin) !== null;
      if (!role || url.username || url.password || !originHeaderOwned) {
        ledger.foreignHttpBlockedCount += 1;
        record({ phase: phases.current, kind: "foreign-http-blocked", direction: "page-to-gateway", role: "foreign", reason: !originHeaderOwned ? "origin-not-owned" : "url-origin-not-owned", method: safeMethod(request.method()), path: safeObservedRequestPath(url.pathname) });
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    } catch {
      ledger.fixtureErrorCount += 1;
      await route.abort("blockedbyclient").catch(() => {});
    }
  });
  page.on("request", request => { httpRequestPhases.set(request, phases.current); });
  page.on("response", response => {
    try {
      const url = new URL(response.url());
      const role = roleForOrigin(url.origin);
      if (!role) {
        ledger.foreignHttpResponseCount += 1;
        record({ phase: httpRequestPhases.get(response.request()) ?? "unknown", kind: "foreign-http-response-observed", direction: "gateway-to-page", role: "foreign", method: safeMethod(response.request().method()), path: safeObservedRequestPath(url.pathname), status: response.status() });
        return;
      }
      if (!url.pathname.startsWith("/api/")) return;
      if (ledger.http.length >= MAX_HTTP_EVENTS) { ledger.droppedHttpEvents += 1; return; }
      ledger.http.push({
        phase: httpRequestPhases.get(response.request()) ?? "unknown",
        role,
        method: safeMethod(response.request().method()),
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
    workspaceByTarget,
    record,
  });
  try {
    await connectProfileFromLogin(page, gatewayA);
    const profileA = await readProfileIdentity(page, gatewayA.baseUrl);
    await waitFor(() => phases.gates.homeSlowDiscovery.held && phases.gates.homeFastCursor.held,
      30_000, "A fast first page plus the independent slow discovery and fast cursor holds", 50, context.abortSignal);
    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `thread-${THREAD_FIXTURES.homeFirst.id}`, THREAD_FIXTURES.homeFirst.title);
    assert.equal(await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).isEnabled(), true,
      "the fast Home first-page row must be actionable while peer discovery and its cursor are held");
    homeClickHoldState = {
      slowPeerHeld: phases.gates.homeSlowDiscovery.held,
      slowPeerReleased: phases.gates.homeSlowDiscovery.released,
      fastCursorHeld: phases.gates.homeFastCursor.held,
      fastCursorReleased: phases.gates.homeFastCursor.released,
    };
    assert.deepEqual(homeClickHoldState, {
      slowPeerHeld: true,
      slowPeerReleased: false,
      fastCursorHeld: true,
      fastCursorReleased: false,
    }, "the fast Home row click must happen before either peer or cursor is released");

    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).click();
    await waitForTaskRoute(page, profileA.id, "fast-A", THREAD_FIXTURES.homeFirst.id, workspaceAfast, THREAD_FIXTURES.homeFirst.title);
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(`HISTORY_${THREAD_FIXTURES.homeFirst.id}`, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    phases.gates.homeSlowDiscovery.release("reject");
    phases.gates.homeFastCursor.release("complete");
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("A_SLOW_DISCOVERY_ERROR", { exact: false }).waitFor({ state: "visible", timeout: 30_000 });

    phases.current = "sessions-a-first-pages-and-held-peer-cursor";
    await visible(page, "sessions").click();
    const sessionsList = visible(page, "sessions-list");
    await sessionsList.waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`, THREAD_FIXTURES.sessionsFastFirst.title);
    await visible(page, `session-${THREAD_FIXTURES.sessionsSlowFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `session-${THREAD_FIXTURES.sessionsSlowFirst.id}`, THREAD_FIXTURES.sessionsSlowFirst.title);
    await scrollListWithBrowserInput(page, sessionsList);
    await waitFor(() => phases.gates.sessionsSlowCursor.held,
      30_000, "slow Sessions cursor request held after an actual list scroll", 50, context.abortSignal);
    await visible(page, `session-${THREAD_FIXTURES.sessionsFastMore.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "sessions-page-loading").waitFor({ state: "visible", timeout: 30_000 });
    phases.gates.sessionsSlowCursor.release("complete");
    await visible(page, `session-${THREAD_FIXTURES.sessionsSlowMore.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "sessions-page-loading").waitFor({ state: "hidden", timeout: 30_000 });

    await assertRowAdvertisesTitle(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`, THREAD_FIXTURES.sessionsFastFirst.title);
    await visible(page, `session-${THREAD_FIXTURES.sessionsFastFirst.id}`).click();
    await waitForTaskRoute(page, profileA.id, "fast-A", THREAD_FIXTURES.sessionsFastFirst.id, workspaceAfast, THREAD_FIXTURES.sessionsFastFirst.title);
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(`HISTORY_${THREAD_FIXTURES.sessionsFastFirst.id}`, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
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
    await visible(page, `thread-${THREAD_FIXTURES.profileBBootstrap.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `thread-${THREAD_FIXTURES.profileBBootstrap.id}`, THREAD_FIXTURES.profileBBootstrap.title);

    await openDrawerSettings(page);
    phases.current = "profile-a-after-b-bootstrap";
    await switchToProfile(page, profileA);
    await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByText("A_SLOW_DISCOVERY_ERROR", { exact: false }).count() > 0, true,
      "A's owned discovery error must exist before the A-to-B isolation check");

    await openDrawerSettings(page);
    phases.current = "settings-a-to-b-owner-switch-with-b-first-page-held";
    await switchToProfile(page, profileB);
    await waitFor(() => phases.gates.profileBFirstPage.held,
      30_000, "B's first thread/list response held after the actual Settings A-to-B switch", 50, context.abortSignal);
    await waitForStoredActiveProfile(page, profileB.id);
    assert.equal(await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).count(), 0,
      "A's Home row must be absent before B's held first page is released");
    assert.equal(await page.getByText("A_SLOW_DISCOVERY_ERROR", { exact: false }).count(), 0,
      "A's workspace discovery error must be absent before B's held first page is released");
    phases.gates.profileBFirstPage.release("complete");
    await visible(page, `thread-${THREAD_FIXTURES.profileBAfterSwitch.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await assertRowAdvertisesTitle(page, `thread-${THREAD_FIXTURES.profileBAfterSwitch.id}`, THREAD_FIXTURES.profileBAfterSwitch.title);
    assert.equal(await visible(page, `thread-${THREAD_FIXTURES.homeFirst.id}`).count(), 0);
    await visible(page, `thread-${THREAD_FIXTURES.profileBAfterSwitch.id}`).click();
    await waitForTaskRoute(page, profileB.id, "fast-B", THREAD_FIXTURES.profileBAfterSwitch.id, workspaceBfast, THREAD_FIXTURES.profileBAfterSwitch.title);
    await visible(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(`HISTORY_${THREAD_FIXTURES.profileBAfterSwitch.id}`, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    assert.equal(ledger.rejectedClientRpcCount, 0, "the explicit read-only Mobile RPC allowlist must cover all client operations");
    assert.equal(ledger.droppedEvents, 0, "RPC evidence must remain within the bounded collector");
    assert.equal(ledger.droppedHttpEvents, 0, "HTTP evidence must remain within the bounded collector");
    assert.equal(ledger.droppedHistoryReadCount, 0, "history evidence must remain within the bounded collector");
    assert.equal(ledger.malformedFrameCount, 0, "all observed RPC frames must parse");
    assert.equal(ledger.unknownRpcResponseCount, 0, "all observed RPC responses must correlate to one request");
    assert.equal(ledger.rejectedServerFrameCount, 0, "the mock Gateway must not send unallowlisted server frames");
    assert.equal(ledger.rejectedWebSocketCount, 0, "all page WebSockets must use an exact owned Gateway route");
    assert.equal(ledger.foreignWebSocketBlockedCount, 0, "the page must not attempt foreign-origin WebSockets");
    assert.equal(ledger.foreignHttpBlockedCount, 0, "the page must not attempt foreign-origin HTTP requests");
    assert.equal(ledger.foreignHttpResponseCount, 0, "no foreign-origin HTTP response may reach the page");
    assert.equal(ledger.httpRouteOverflowCount, 0, "all page HTTP requests must stay within the explicit interception bound");
    assert.equal(ledger.webSocketRouteOverflowCount, 0, "WebSocket route count must stay within its explicit bound");
    assert.equal(ledger.pendingRpcCount, 0, "all allowed RPC requests must be correlated before evidence is finalized");
    assert.equal(ledger.fixtureErrorCount, 0, "all fixture response handling must complete");
    assert.equal(pageErrorCount, 0, "the page must have no uncaught JavaScript errors");
    assert.equal(consoleErrorCount, 0, "the page must have no console errors");
    const historyAliasesRead = [...new Set(ledger.historyReadThreadIds.map(historyAlias))].sort();
    for (const expectedAlias of [THREAD_FIXTURES.homeFirst.id, THREAD_FIXTURES.sessionsFastFirst.id, THREAD_FIXTURES.profileBAfterSwitch.id])
      assert.ok(historyAliasesRead.includes(expectedAlias), `actual thread/read response for ${expectedAlias} must be observed`);
    const heldBPage = ledger.events.find(event => event.phase === "settings-a-to-b-owner-switch-with-b-first-page-held" && event.role === "B" && event.method === "thread/list" && event.kind === "held-response");
    assert.ok(heldBPage, "the owner-switch check must be backed by B's actual held RPC response");
    assert.ok(ledger.events.some(event => event.phase === heldBPage.phase && event.role === "B" && event.method === "thread/list" && event.kind === "rpc-request" && event.requestIdFingerprint === heldBPage.requestIdFingerprint),
      "the held B response must correlate to its observed list request");
    const sessionsSocketOrdinals = assertSessionsSocketOrdinals(ledger.events);
    const gatewaySourceAfter = await hashGatewaySourceTree();
    assert.equal(gatewaySourceAfter.fileCount, gatewaySourceBefore.fileCount, "complete Gateway source closure file count changed during the run");
    assert.equal(gatewaySourceAfter.sourceTreeSha256, gatewaySourceBefore.sourceTreeSha256, "complete Gateway source closure changed during the run");

    await context.writeArtifactJson("mobile-home-sessions-lease3-local-dom-observation.json", {
      schemaVersion: 1,
      status: "functional-checks-satisfied-awaiting-runcontext-cleanup",
      terminalStatus: "not-yet-observed",
      claimScope: "local two-Gateway Mobile Web mock DOM/profile route only; not Rust, public Relay, real-phone, Provider, or model evidence",
      export: { sourceTreeSha256: SOURCE_TREE_SHA256, exporterManifestSha256: EXPORT_MANIFEST_SHA256, derivedReuseManifestSha256: derivedExport.manifestSha256, bundleSha256: BUNDLE_SHA256, bundleFileCount: BUNDLE_FILE_COUNT },
      gatewaySource: { fileCount: gatewaySourceBefore.fileCount, sourceTreeSha256: gatewaySourceBefore.sourceTreeSha256, unchanged: gatewaySourceAfter.sourceTreeSha256 === gatewaySourceBefore.sourceTreeSha256 },
      profileAliases: { A: shortHash(profileA.id), B: shortHash(profileB.id), distinct: profileA.id !== profileB.id },
      gatewayAliases: { A: gatewayA.port, B: gatewayB.port, distinct: gatewayA.port !== gatewayB.port },
      home: { firstRowVisibleWhilePeerAndCursorHeld: true, firstRowClickedWhilePeerAndCursorHeld: true, holdStateAtClick: homeClickHoldState, slowPeerReleasedAfterRouteAndHistoryVerified: true, routeAndHistoryVerified: true },
      sessions: { firstRowsVisible: true, fastLoadMoreVisibleWhileSlowCursorHeld: true, slowCursorReleasedAndVisible: true, routeAndHistoryVerified: true, socketOrdinals: sessionsSocketOrdinals },
      profileSwitch: { actualSettingsSwitch: true, oldARowAbsentBeforeBFirstPageRelease: true, oldAErrorAbsentBeforeBFirstPageRelease: true, BRouteAndHistoryVerified: true },
      calls: {
        rejectedClientRpcCount: ledger.rejectedClientRpcCount,
        rejectedServerFrameCount: ledger.rejectedServerFrameCount,
        rejectedWebSocketCount: ledger.rejectedWebSocketCount,
        foreignWebSocketBlockedCount: ledger.foreignWebSocketBlockedCount,
        foreignHttpBlockedCount: ledger.foreignHttpBlockedCount,
        foreignHttpResponseCount: ledger.foreignHttpResponseCount,
        httpRouteCount: ledger.httpRouteCount,
        httpRouteOverflowCount: ledger.httpRouteOverflowCount,
        webSocketRouteCount: ledger.webSocketRouteCount,
        pendingRpcCount: ledger.pendingRpcCount,
        historyAliasesRead,
        pageErrorCount,
        consoleErrorCount,
      },
      http: ledger.http,
      rpcEvents: ledger.events,
      droppedEvents: ledger.droppedEvents,
      droppedHttpEvents: ledger.droppedHttpEvents,
      droppedHistoryReadCount: ledger.droppedHistoryReadCount,
      homeClickHoldState,
      gatewaySourceBefore: { fileCount: gatewaySourceBefore.fileCount, sourceTreeSha256: gatewaySourceBefore.sourceTreeSha256 },
      rejectedClientMethods: ledger.rejectedClientMethods,
      malformedFrameCount: ledger.malformedFrameCount,
      unknownRpcResponseCount: ledger.unknownRpcResponseCount,
      fixtureErrorCount: ledger.fixtureErrorCount,
      held: ledger.held,
      gates: summarizeGates(phases.gates),
      sourcePins,
    });
  } catch (error) {
    await context.writeArtifactJson("mobile-home-sessions-lease3-local-dom-failure.json", {
      schemaVersion: 1,
      status: "failed",
      phase: phases.current,
      errorName: safeErrorName(error),
      rpcEvents: ledger.events,
      http: ledger.http,
      droppedEvents: ledger.droppedEvents,
      malformedFrameCount: ledger.malformedFrameCount,
      unknownRpcResponseCount: ledger.unknownRpcResponseCount,
      rejectedClientRpcCount: ledger.rejectedClientRpcCount,
      rejectedServerFrameCount: ledger.rejectedServerFrameCount,
      rejectedWebSocketCount: ledger.rejectedWebSocketCount,
      foreignWebSocketBlockedCount: ledger.foreignWebSocketBlockedCount,
      foreignHttpBlockedCount: ledger.foreignHttpBlockedCount,
      foreignHttpResponseCount: ledger.foreignHttpResponseCount,
      httpRouteCount: ledger.httpRouteCount,
      httpRouteOverflowCount: ledger.httpRouteOverflowCount,
      webSocketRouteOverflowCount: ledger.webSocketRouteOverflowCount,
      webSocketRouteCount: ledger.webSocketRouteCount,
      pendingRpcCount: ledger.pendingRpcCount,
      fixtureErrorCount: ledger.fixtureErrorCount,
      droppedHttpEvents: ledger.droppedHttpEvents,
      droppedHistoryReadCount: ledger.droppedHistoryReadCount,
      rejectedClientMethods: ledger.rejectedClientMethods,
      historyAliasesRead: [...new Set(ledger.historyReadThreadIds.map(historyAlias))].sort(),
      held: ledger.held,
      gates: summarizeGates(phases.gates),
      pageErrorCount,
      consoleErrorCount,
      gatewaySourceBefore: { fileCount: gatewaySourceBefore.fileCount, sourceTreeSha256: gatewaySourceBefore.sourceTreeSha256 },
      sourcePins,
    });
    throw error;
  } finally {
    phases.gates.homeSlowDiscovery.release("cleanup");
    phases.gates.homeFastCursor.release("cleanup");
    phases.gates.sessionsSlowCursor.release("cleanup");
    phases.gates.profileBFirstPage.release("cleanup");
  }
});

async function installRpcFixture(page, context, { gatewayA, gatewayB, roleForOrigin, phases, ledger, workspaceByTarget, record }) {
  await page.routeWebSocket("**/*", async routed => {
    ledger.webSocketRouteCount += 1;
    const socketOrdinal = ledger.webSocketRouteCount;
    if (socketOrdinal > MAX_WEBSOCKET_ROUTES) {
      ledger.webSocketRouteOverflowCount += 1;
      await routed.close({ code: 1008, reason: "local fixture route limit" });
      return;
    }
    let role = null;
    let serverId = "unknown";
    let workspaceAlias = "default";
    let rpcPathOwned = false;
    let websocketUrl = null;
    try {
      websocketUrl = new URL(typeof routed.url === "function" ? routed.url() : routed.url);
      role = roleForOrigin(websocketUrl.origin);
      rpcPathOwned = websocketUrl.pathname === "/rpc" && ["ws:", "wss:"].includes(websocketUrl.protocol);
      serverId = websocketUrl.searchParams.get("server") ?? "unknown";
      const workspace = websocketUrl.searchParams.get("workspace");
      if (workspace) workspaceAlias = Object.keys(workspaceByTarget).find(key => workspaceByTarget[key] === workspace) ?? "other";
    } catch { ledger.malformedFrameCount += 1; }
    const routeOwned = websocketUrl && !websocketUrl.username && !websocketUrl.password && rpcPathOwned && workspaceAlias === `${role}/${serverId}` &&
      ((role === "A" && (serverId === "fast-A" || serverId === "slow-A")) || (role === "B" && serverId === "fast-B"));
    if (!role) {
      ledger.foreignWebSocketBlockedCount += 1;
      record({ phase: phases.current, kind: "foreign-websocket-blocked", direction: "page-to-gateway", role: "foreign", socketOrdinal });
      await routed.close({ code: 1008, reason: "local fixture rejected foreign WebSocket" });
      return;
    }
    if (!routeOwned) {
      ledger.rejectedWebSocketCount += 1;
      record({ phase: phases.current, kind: "unowned-websocket-rejected", direction: "page-to-gateway", role, server: SERVER_ALIASES[serverId] ?? "unknown", socketOrdinal });
      await routed.close({ code: 1008, reason: "local fixture rejected unowned WebSocket" });
      return;
    }
    const recordSocket = event => record({ ...event, socketOrdinal });
    recordSocket({ phase: phases.current, kind: "owned-websocket-connected", direction: "page-to-gateway", role, server: SERVER_ALIASES[serverId] ?? "unknown", workspace: workspaceAlias });
    const upstream = routed.connectToServer();
    const outstanding = new Map();
    let closed = false;
    const releaseOutstanding = () => {
      ledger.pendingRpcCount -= outstanding.size;
      outstanding.clear();
    };
    routed.onClose((code) => {
      closed = true;
      releaseOutstanding();
      recordSocket({ phase: phases.current, kind: "owned-websocket-closed", direction: "page-to-gateway", role, server: SERVER_ALIASES[serverId] ?? "unknown", closeCode: Number.isSafeInteger(code) ? code : null });
      const closeOptions = Number.isSafeInteger(code) && code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code)
        ? { code }
        : {};
      void upstream.close(closeOptions).catch(() => {});
    });
    routed.onMessage(raw => {
      const parsed = parseObservedJsonRpcFrame("client-to-server", raw);
      if (!parsed.ok) {
        ledger.malformedFrameCount += 1;
        recordSocket({ phase: phases.current, kind: "rejected-client-frame", direction: "client-to-server", reason: parsed.reason });
        return;
      }
      const frame = parsed.frame;
      const phase = phases.current;
      const routeOwned = rpcPathOwned && workspaceAlias === `${role}/${serverId}` &&
        ((role === "A" && (serverId === "fast-A" || serverId === "slow-A")) ||
        (role === "B" && serverId === "fast-B"));
      if (Object.hasOwn(frame, "params") && !isRecord(frame.params)) {
        ledger.malformedFrameCount += 1;
        recordSocket({ phase, kind: "rejected-client-frame", direction: "client-to-server", reason: "params-not-object" });
        if (parsed.envelopeKind === "request")
          routed.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32600, message: "fixture requires object params" } }));
        return;
      }
      if (parsed.envelopeKind === "notification") {
        if (!routeOwned || !ALLOWED_CLIENT_NOTIFICATIONS.has(frame.method)) {
          ledger.rejectedClientRpcCount += 1;
          recordSocket({ phase, kind: "rejected-client-notification", direction: "client-to-server", method: safeMethod(frame.method), reason: "notification-not-allowlisted" });
          return;
        }
        recordSocket({ phase, kind: "rpc-notification", direction: "client-to-server", role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(frame.method) });
        upstream.send(raw);
        return;
      }

      const key = rpcKey(frame.id);
      const method = frame.method;
      const params = isRecord(frame.params) ? frame.params : {};
      const readTargetsKnown = !["thread/read", "thread/resume", "thread/goal/get"].includes(method) ||
        (typeof params.threadId === "string" && THREAD_FIXTURE_ROUTES.get(params.threadId) === `${role}/${serverId}`);
      if (!ALLOWED_CLIENT_RPC_METHODS.has(method) || !readTargetsKnown || outstanding.size >= MAX_PENDING_RPCS || ledger.pendingRpcCount >= MAX_TOTAL_PENDING_RPCS || outstanding.has(key)) {
        ledger.rejectedClientRpcCount += 1;
        if (ledger.rejectedClientMethods.length < 32) ledger.rejectedClientMethods.push(safeMethod(method));
        const reason = !ALLOWED_CLIENT_RPC_METHODS.has(method) ? "method-not-allowlisted" : !readTargetsKnown ? "thread-id-not-in-fixture" : "pending-limit-or-duplicate-id";
        recordSocket({ phase, kind: "rejected-client-rpc", direction: "client-to-server", role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method), requestIdFingerprint: shortHash(key), reason });
        routed.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "fixture blocked non-allowlisted request" } }));
        return;
      }
      const request = {
        id: frame.id,
        method,
        params: isRecord(frame.params) ? frame.params : {},
        role,
        serverId,
        workspaceAlias,
        socketOrdinal,
        phase,
        sentAtNodeMs: performance.now(),
      };
      outstanding.set(key, request);
      ledger.pendingRpcCount += 1;
      recordSocket({ phase, kind: "rpc-request", direction: "client-to-server", role, server: SERVER_ALIASES[serverId] ?? "unknown", workspace: workspaceAlias, method: safeMethod(method), requestIdFingerprint: shortHash(key), hasCursor: Boolean(request.params.cursor) });
      upstream.send(raw);
    });
    upstream.onMessage(async raw => {
      const parsed = parseObservedJsonRpcFrame("server-to-client", raw);
      if (!parsed.ok) {
        ledger.malformedFrameCount += 1;
        recordSocket({ phase: phases.current, kind: "rejected-server-frame", direction: "server-to-client", reason: parsed.reason });
        return;
      }
      if (parsed.envelopeKind === "notification") {
        const method = parsed.frame.method;
        if (!ALLOWED_SERVER_NOTIFICATIONS.has(method)) {
          ledger.rejectedServerFrameCount += 1;
          recordSocket({ phase: phases.current, kind: "rejected-server-notification", direction: "server-to-client", method: safeMethod(method) });
          return;
        }
        recordSocket({ phase: phases.current, kind: "rpc-notification", direction: "server-to-client", role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method) });
        routed.send(raw);
        return;
      }
      if (parsed.envelopeKind !== "response") {
        ledger.rejectedServerFrameCount += 1;
        recordSocket({ phase: phases.current, kind: "rejected-server-request", direction: "server-to-client", method: safeMethod(parsed.frame.method) });
        upstream.send(JSON.stringify({ jsonrpc: "2.0", id: parsed.frame.id, error: { code: -32601, message: "local fixture does not accept server requests" } }));
        return;
      }
      const response = structuredClone(parsed.frame);
      const request = outstanding.get(rpcKey(response.id));
      if (!request) {
        ledger.unknownRpcResponseCount += 1;
        recordSocket({ phase: phases.current, kind: "uncorrelated-server-response", direction: "server-to-client", requestIdFingerprint: shortHash(rpcKey(response.id)) });
        routed.send(raw);
        return;
      }
      outstanding.delete(rpcKey(response.id));
      ledger.pendingRpcCount -= 1;
      try {
        const action = await shapeOrHoldResponse(response, request, workspaceByTarget, ledger, closed, recordSocket);
        if (closed) return;
        recordSocket({ phase: request.phase, kind: action.held ? "held-response-released" : "rpc-response", direction: "server-to-client", role: request.role, server: SERVER_ALIASES[request.serverId] ?? "unknown", workspace: request.workspaceAlias, method: safeMethod(request.method), requestIdFingerprint: shortHash(rpcKey(request.id)), responseShape: Object.hasOwn(action.frame, "error") ? "error" : "result", held: action.held, elapsedNodeMs: Math.max(0, performance.now() - request.sentAtNodeMs) });
        routed.send(JSON.stringify(action.frame));
      } catch {
        ledger.fixtureErrorCount += 1;
        recordSocket({ phase: request.phase, kind: "fixture-response-error", direction: "server-to-client", role: request.role, server: SERVER_ALIASES[request.serverId] ?? "unknown", method: safeMethod(request.method), requestIdFingerprint: shortHash(rpcKey(request.id)) });
        if (!closed) routed.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "local fixture failed" } }));
      }
    });
  });
}

async function shapeOrHoldResponse(response, request, workspaceByTarget, ledger, closed, record) {
  const { role, serverId, method, params, phase } = request;
  let held = false;
  if (method === "runtime.workspaces.list" && role === "A" && serverId === "slow-A" && phase === "home-a-fast-first-peer-and-cursor-held" && !ledger.gates.homeSlowDiscovery.released) {
    ledger.gates.homeSlowDiscovery.held = true;
    ledger.held.homeSlowDiscovery = true;
    recordForGate(record, phase, "held-response", role, serverId, method, response.id);
    const releaseKind = await ledger.gates.homeSlowDiscovery.promise;
    held = true;
    if (closed) return { frame: response, held };
    if (releaseKind === "reject")
      return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32110, message: "A_SLOW_DISCOVERY_ERROR" } }, held };
  }
  if (method === "runtime.workspaces.list" && role === "A" && serverId === "slow-A" && phase === "profile-a-after-b-bootstrap")
    return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32110, message: "A_SLOW_DISCOVERY_ERROR" } }, held };
  if (method === "runtime.workspaces.list") {
    const workspace = workspaceByTarget[`${role}/${serverId}`];
    if (workspace) response.result = { ...(isRecord(response.result) ? response.result : {}), success: true, items: [{ workspacePath: workspace, label: SERVER_ALIASES[serverId] ?? serverId }], pinnedTaskIds: [], taskOrders: {} };
  } else if (method === "runtime.worktrees.list") {
    response.result = { ...(isRecord(response.result) ? response.result : {}), success: true, items: [] };
  } else if (method === "thread/list") {
    const page = fixturePage(phase, role, serverId, params, workspaceByTarget);
    if (page) {
      if (page.gate) {
        const gate = ledger.gates[page.gate];
        gate.held = true;
        if (page.gate === "homeFastCursor") ledger.held.homeFastCursor = true;
        if (page.gate === "sessionsSlowCursor") ledger.held.sessionsSlowCursor = true;
        if (page.gate === "profileBFirstPage") ledger.held.profileBFirstPage = true;
        recordForGate(record, phase, "held-response", role, serverId, method, response.id);
        await gate.promise;
        held = true;
        if (closed) return { frame: response, held };
      }
      response.result = { ...(isRecord(response.result) ? response.result : {}), threads: page.threads, nextCursor: page.nextCursor ?? null, completeness: "complete", issueCount: 0 };
    } else {
      ledger.fixtureErrorCount += 1;
      record({ phase, kind: "unmapped-fixture-rpc", role: role ?? "foreign", server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method) });
      return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32602, message: "fixture has no response for this list phase" } }, held };
    }
  } else if (method === "thread/read") {
    const threadId = typeof params.threadId === "string" ? params.threadId : "unknown-thread";
    if (!FIXTURE_THREAD_IDS.has(threadId) || THREAD_FIXTURE_ROUTES.get(threadId) !== `${role}/${serverId}`) {
      ledger.fixtureErrorCount += 1;
      record({ phase, kind: "unmapped-fixture-rpc", role: role ?? "foreign", server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method), reason: "thread-id-not-owned-by-route" });
      return { frame: { jsonrpc: "2.0", id: response.id, error: { code: -32602, message: "fixture has no response for this thread" } }, held };
    }
    if (ledger.historyReadThreadIds.length < MAX_HISTORY_READS) ledger.historyReadThreadIds.push(threadId);
    else ledger.droppedHistoryReadCount += 1;
    const alias = historyAlias(threadId);
    response.result = {
      ...(isRecord(response.result) ? response.result : {}),
      thread: { id: threadId, title: threadId, cwd: workspaceByTarget[`${role}/${serverId}`] ?? "/", status: "idle", model: "mock-local", createdAt: 1, updatedAt: 2 },
      messages: [{ id: `history-${alias}`, role: "user", content: `HISTORY_${alias}`, timestampMs: 2, blocks: [] }],
    };
  }
  return { frame: response, held };
}

function fixturePage(phase, role, serverId, params, workspaceByTarget) {
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  if (phase === "home-a-fast-first-peer-and-cursor-held" && role === "A" && serverId === "fast-A") {
    if (!cursor) return { threads: [threadSummary(THREAD_FIXTURES.homeFirst.id, THREAD_FIXTURES.homeFirst.title, workspaceByTarget["A/fast-A"])], nextCursor: "home-fast-cursor" };
    if (cursor === "home-fast-cursor") return { threads: [threadSummary(THREAD_FIXTURES.homeMore.id, THREAD_FIXTURES.homeMore.title, workspaceByTarget["A/fast-A"])], nextCursor: null, gate: "homeFastCursor" };
  }
  if (phase === "sessions-a-first-pages-and-held-peer-cursor" && role === "A" && (serverId === "fast-A" || serverId === "slow-A")) {
    const fast = serverId === "fast-A";
    const prefix = fast ? "A_SESSIONS_FAST" : "A_SESSIONS_SLOW";
    const first = fast ? THREAD_FIXTURES.sessionsFastFirst : THREAD_FIXTURES.sessionsSlowFirst;
    if (!cursor) {
      const workspace = workspaceByTarget[`A/${serverId}`];
      return { threads: Array.from({ length: 8 }, (_value, index) => index === 0
        ? threadSummary(first.id, first.title, workspace)
        : threadSummary(`${prefix}_${index}`, `A Sessions ${fast ? "fast" : "slow"} ${index}`, workspace)), nextCursor: `${prefix}_CURSOR` };
    }
    if (cursor === "A_SESSIONS_FAST_CURSOR" && serverId === "fast-A")
      return { threads: [threadSummary(THREAD_FIXTURES.sessionsFastMore.id, THREAD_FIXTURES.sessionsFastMore.title, workspaceByTarget["A/fast-A"])], nextCursor: null };
    if (cursor === "A_SESSIONS_SLOW_CURSOR" && serverId === "slow-A")
      return { threads: [threadSummary(THREAD_FIXTURES.sessionsSlowMore.id, THREAD_FIXTURES.sessionsSlowMore.title, workspaceByTarget["A/slow-A"])], nextCursor: null, gate: "sessionsSlowCursor" };
  }
  if ((phase === "profile-b-bootstrap" || phase === "settings-a-to-b-owner-switch-with-b-first-page-held") && role === "B" && serverId === "fast-B" && !cursor) {
    if (phase === "settings-a-to-b-owner-switch-with-b-first-page-held")
      return { threads: [threadSummary(THREAD_FIXTURES.profileBAfterSwitch.id, THREAD_FIXTURES.profileBAfterSwitch.title, workspaceByTarget["B/fast-B"])], nextCursor: null, gate: "profileBFirstPage" };
    return { threads: [threadSummary(THREAD_FIXTURES.profileBBootstrap.id, THREAD_FIXTURES.profileBBootstrap.title, workspaceByTarget["B/fast-B"])], nextCursor: null };
  }
  if (phase === "profile-a-after-b-bootstrap" && role === "A" && serverId === "fast-A" && !cursor)
    return { threads: [threadSummary(THREAD_FIXTURES.homeFirst.id, THREAD_FIXTURES.homeFirst.title, workspaceByTarget["A/fast-A"])], nextCursor: null };
  return null;
}

async function verifySourcePins(frozenSourceMap) {
  const observed = {};
  for (const [relativePath, expected] of Object.entries(SOURCE_PINS)) {
    const file = resolve(repoRoot, relativePath);
    assert.equal(await realpath(file), file, `source pin must be canonical: ${relativePath}`);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `source pin must be a regular file: ${relativePath}`);
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    assert.equal(digest, expected, `source pin changed: ${relativePath}`);
    if (Object.hasOwn(frozenSourceMap, relativePath))
      assert.equal(frozenSourceMap[relativePath], expected, `live pin differs from the source freeze: ${relativePath}`);
    observed[relativePath] = digest;
  }
  return observed;
}

async function verifyPinnedRegularFile(file, expectedSha256) {
  assert.equal(await realpath(file), file, `pinned input must be canonical: ${file}`);
  const stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `pinned input must be a regular file: ${file}`);
  const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
  assert.equal(sha256, expectedSha256, `pinned input digest changed: ${file}`);
  return sha256;
}

async function deriveSchema1ReuseInput(context, sourceBundleRoot, exportManifestPath, exportProvenancePath) {
  const exportManifestSha256 = await verifyPinnedRegularFile(exportManifestPath, EXPORT_MANIFEST_SHA256);
  const exportProvenanceSha256 = await verifyPinnedRegularFile(exportProvenancePath, EXPORT_PROVENANCE_SHA256);
  const sourceRoot = resolve(sourceBundleRoot);
  assert.equal(sourceRoot, sourceBundleRoot, "schema-2 bundle root must be normalized");
  assert.equal(await realpath(sourceRoot), sourceRoot, "schema-2 bundle root must be canonical");
  const exportManifest = await readJson(exportManifestPath);
  assert.equal(exportManifest.schemaVersion, 2, "pinned Mobile Web exporter manifest must use schema 2");
  assert.equal(exportManifest.status, "complete");
  assert.equal(exportManifest.failurePhase, null);
  assert.equal(exportManifest.error, null);
  assert.equal(exportManifest.sourceTreeSha256, SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceHashBefore, SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceHashAfter, SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceUnchanged, true);
  assert.equal(exportManifest.snapshotCopyMatchesSource, true);
  assert.equal(exportManifest.snapshotUnchangedDuringExport, true);
  assert.equal(exportManifest.bundleSha256, BUNDLE_SHA256);
  assert.equal(exportManifest.bundleFileCount, BUNDLE_FILE_COUNT);
  assert.ok(Array.isArray(exportManifest.bundleFiles) && exportManifest.bundleFiles.length === BUNDLE_FILE_COUNT,
    "schema-2 manifest must contain the exact 37-file bundle table");
  const files = exportManifest.bundleFiles;
  assert.equal(hashJson(files), BUNDLE_SHA256, "schema-2 ordered bundle table must match its fixed aggregate SHA-256");
  const indexFiles = files.filter(file => file?.path === "index.html");
  assert.equal(indexFiles.length, 1, "schema-2 table must contain exactly one root index.html");
  assert.equal(indexFiles[0].sha256, exportManifest.indexHtmlSha256);

  const ownedBundleRoot = context.pathInArtifacts("home-sessions-lease3-schema2-bundle");
  assert.equal(resolve(ownedBundleRoot), ownedBundleRoot, "derived public bundle path must be normalized");
  const relativeBundleRoot = relative(context.runRoot, ownedBundleRoot);
  assert.ok(relativeBundleRoot.startsWith(`artifacts${sep}`) && !relativeBundleRoot.startsWith(`..${sep}`),
    "derived bundle must remain inside this RunContext artifacts");
  await mkdir(ownedBundleRoot, { recursive: false, mode: 0o700 });

  let totalBytes = 0;
  const derivedFiles = [];
  for (const entry of files) {
    assert.ok(entry && Object.keys(entry).join(",") === "path,size,sha256",
      "schema-2 bundle entry must contain only path, size, and SHA-256 in fixed order");
    const bundlePath = assertSafeMobileBundlePath(entry.path);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0, "schema-2 bundle entry size is invalid");
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, "schema-2 bundle entry SHA-256 is invalid");
    totalBytes += entry.size;
    assert.ok(totalBytes <= 64 * 1024 * 1024, "pinned Mobile Web bundle exceeds the public-copy bound");

    const sourceFile = resolve(sourceRoot, ...bundlePath.split("/"));
    assertContainedPath(sourceRoot, sourceFile, "schema-2 bundle entry escaped the pinned bundle root");
    assert.equal(await realpath(sourceFile), sourceFile, `schema-2 bundle file must be canonical: ${bundlePath}`);
    const sourceInfo = await lstat(sourceFile);
    assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), `schema-2 bundle entry must be a regular file: ${bundlePath}`);
    const bytes = await readFile(sourceFile);
    assert.equal(bytes.length, entry.size, `schema-2 bundle size changed: ${bundlePath}`);
    assert.equal(hashBytes(bytes), entry.sha256, `schema-2 bundle SHA-256 changed: ${bundlePath}`);

    const destination = resolve(ownedBundleRoot, ...bundlePath.split("/"));
    assertContainedPath(ownedBundleRoot, destination, "derived bundle destination escaped its owned root");
    const destinationDirectory = dirname(destination);
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    assert.equal(await realpath(destinationDirectory), destinationDirectory, "derived bundle directory must be canonical");
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    const destinationInfo = await lstat(destination);
    assert.ok(destinationInfo.isFile() && !destinationInfo.isSymbolicLink(), `derived bundle copy must be a regular file: ${bundlePath}`);
    assert.equal(destinationInfo.uid, process.getuid(), "derived bundle copy owner must match this process");
    assert.equal(destinationInfo.mode & 0o777, 0o600, "derived public bundle files must be private mode 0600");
    const copiedBytes = await readFile(destination);
    assert.equal(copiedBytes.length, entry.size);
    assert.equal(hashBytes(copiedBytes), entry.sha256, `derived bundle copy SHA-256 mismatch: ${bundlePath}`);
    derivedFiles.push({ path: bundlePath, size: entry.size, sha256: entry.sha256 });
  }
  assert.equal(derivedFiles.length, BUNDLE_FILE_COUNT);
  assert.equal(hashJson(derivedFiles), BUNDLE_SHA256, "derived bundle file table changed its exporter aggregate");
  assert.equal(await verifyPinnedRegularFile(exportManifestPath, EXPORT_MANIFEST_SHA256), exportManifestSha256,
    "schema-2 export manifest changed while deriving the local reuse view");
  assert.equal(await verifyPinnedRegularFile(exportProvenancePath, EXPORT_PROVENANCE_SHA256), exportProvenanceSha256,
    "exporter provenance changed while deriving the local reuse view");

  const manifestPath = context.pathInArtifacts("home-sessions-lease3-derived-reuse-manifest.json");
  const reuseManifest = {
    schemaVersion: 1,
    purpose: "derived local schema-1 view from the immutable schema-2 export bundle; original exporter manifest and bundle remain unchanged",
    sourceCommit: null,
    sourceTreeSha256: SOURCE_TREE_SHA256,
    bundleSha256: BUNDLE_SHA256,
    bundleFileCount: BUNDLE_FILE_COUNT,
    indexHtmlSha256: exportManifest.indexHtmlSha256,
    directory: relative(context.runRoot, ownedBundleRoot).split(sep).join("/"),
    files: derivedFiles,
  };
  const writtenManifestPath = await context.writeArtifactJson("home-sessions-lease3-derived-reuse-manifest.json", reuseManifest);
  assert.equal(writtenManifestPath, manifestPath, "RunContext wrote the derived adapter at an unexpected path");
  const manifestBytes = await readFile(manifestPath);
  const parsedManifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.deepEqual(Object.keys(parsedManifest), [
    "schemaVersion", "purpose", "sourceCommit", "sourceTreeSha256", "bundleSha256", "bundleFileCount", "indexHtmlSha256", "directory", "files",
  ], "derived schema-1 manifest must exactly match the strict public reuse-helper input contract");
  assert.equal(hashJson(parsedManifest.files), BUNDLE_SHA256);
  return {
    bundleRoot: ownedBundleRoot,
    manifestPath,
    manifestSha256: hashBytes(manifestBytes),
    sourceExportManifestSha256: exportManifestSha256,
    sourceExportProvenanceSha256: exportProvenanceSha256,
    copiedFileCount: derivedFiles.length,
  };
}

async function hashGatewaySourceTree() {
  const root = resolve(repoRoot, "apps/kcoder-studio");
  assert.equal(await realpath(root), root, "Gateway source root must be canonical");
  const files = [];
  const budget = { totalBytes: 0 };
  for (const relativePath of ["dev-server.mjs", "package.json", "pnpm-lock.yaml"]) {
    const file = resolve(root, relativePath);
    assert.equal(await realpath(file), file, `Gateway runtime source must be canonical: ${relativePath}`);
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `Gateway runtime source must be a regular file: ${relativePath}`);
    await appendGatewaySourceFile(file, relativePath, info, files, budget);
  }
  for (const relativeRoot of ["src", "shared"]) {
    const directory = resolve(root, relativeRoot);
    assert.equal(await realpath(directory), directory, `Gateway source directory must be canonical: ${relativeRoot}`);
    await appendGatewaySourceFiles(directory, relativeRoot, files, budget);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { fileCount: files.length, sourceTreeSha256: hashJson(files) };
}

async function appendGatewaySourceFiles(directory, relativeDirectory, output, budget, depth = 0) {
  assert.ok(depth <= 32, "Gateway source closure directory depth exceeded its fixed bound");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (isGatewaySourceExcluded(entry.name, entry.isDirectory())) continue;
    const file = resolve(directory, entry.name);
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const info = await lstat(file);
    assert.ok(!info.isSymbolicLink(), `Gateway source closure cannot contain symlinks: ${relativePath}`);
    if (info.isDirectory()) {
      await appendGatewaySourceFiles(file, relativePath, output, budget, depth + 1);
    } else if (info.isFile()) {
      assert.equal(await realpath(file), file, `Gateway source file must be canonical: ${relativePath}`);
      await appendGatewaySourceFile(file, relativePath, info, output, budget);
    } else {
      assert.fail(`Gateway source closure cannot contain special files: ${relativePath}`);
    }
  }
}

async function appendGatewaySourceFile(file, relativePath, info, output, budget) {
  assert.ok(output.length < MAX_GATEWAY_SOURCE_FILES, "Gateway source closure exceeded its fixed file-count bound");
  assert.ok(info.size <= MAX_GATEWAY_SOURCE_FILE_BYTES, `Gateway source file exceeds its fixed size bound: ${relativePath}`);
  budget.totalBytes += info.size;
  assert.ok(budget.totalBytes <= MAX_GATEWAY_SOURCE_TOTAL_BYTES, "Gateway source closure exceeded its fixed total-size bound");
  const bytes = await readFile(file);
  assert.equal(bytes.length, info.size, `Gateway source file changed while hashing: ${relativePath}`);
  output.push({ path: relativePath, size: bytes.length, sha256: hashBytes(bytes) });
}

function isGatewaySourceExcluded(name, isDirectory) {
  if (name === "gateway-runtime-freeze.json" || name === "node_modules") return true;
  if (isDirectory && [".git", ".expo", "dist", "target"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

function assertSafeMobileBundlePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024, "bundle path is invalid");
  assert.ok(!value.startsWith("/") && !value.includes("\\") && !value.includes("\0"), "bundle path must be relative and platform-neutral");
  const parts = value.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f]/.test(part)), "bundle path contains an unsafe segment");
  assert.ok(parts.every(part => !part.includes(":")), "bundle path contains a platform-specific separator");
  const lowerParts = parts.map(part => part.toLowerCase());
  assert.ok(!lowerParts.some(part => /^\.env(?:$|[._-])/.test(part)), "public bundle cannot contain environment files");
  assert.ok(!lowerParts.some(part => [".npmrc", ".netrc"].includes(part)), "public bundle cannot contain network credential files");
  assert.ok(!lowerParts.some(part => /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|privatekey|private-key|api[-_.]?key|keys?)(?:[._-]|$)/.test(part)), "public bundle cannot contain secrets or keys");
  assert.ok(!lowerParts.some(part => /\.(?:pem|key|p12|pfx|keystore|jks)$/.test(part)), "public bundle cannot contain key material");
  const nodeModulesIndexes = lowerParts.flatMap((part, index) => part === "node_modules" ? [index] : []);
  if (nodeModulesIndexes.length) {
    const imageAsset = /\.(?:png|svg|webp|jpe?g|gif)$/i.test(value);
    assert.ok(parts[0] === "assets" && nodeModulesIndexes.length === 1 && nodeModulesIndexes[0] === 1 && imageAsset,
      "public bundle cannot contain node_modules except manifest-listed images");
  }
  return value;
}

function assertContainedPath(root, candidate, message) {
  const child = relative(resolve(root), resolve(candidate));
  assert.ok(child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child), message);
}

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function hashJson(value) { return hashBytes(Buffer.from(JSON.stringify(value))); }

async function assertOwnedWorkspace(context, path) {
  const stateRoot = resolve(context.stateDir);
  const workspace = resolve(path);
  const relativePath = relative(stateRoot, workspace);
  assert.ok(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
    "fixture workspace must remain inside this RunContext state");
  assert.equal(await realpath(workspace), workspace, "fixture workspace path must be canonical");
  const stat = await lstat(workspace);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "fixture workspace must be an owned directory");
  assert.equal(stat.uid, process.getuid(), "fixture workspace owner must match this test process");
  assert.equal(stat.mode & 0o077, 0, "fixture workspace must be private to its owner");
}

async function verifyFrozenSourceInputs() {
  const frozenRoot = resolve(repoRoot, SOURCE_FREEZE_RELATIVE_ROOT);
  const contentRoot = resolve(repoRoot, SOURCE_RELATIVE_CONTENT_ROOT);
  assert.equal(await realpath(frozenRoot), frozenRoot, "source freeze root must be canonical");
  assert.equal(await realpath(contentRoot), contentRoot, "source content root must be canonical");
  const metadataPath = resolve(repoRoot, SOURCE_RELATIVE_METADATA);
  const sourceMapPath = resolve(repoRoot, SOURCE_RELATIVE_MAP);
  const sourceManifestPath = resolve(repoRoot, SOURCE_RELATIVE_MANIFEST);
  const sourceMetadataSha256 = await verifyPinnedRegularFile(metadataPath, SOURCE_METADATA_SHA256);
  const sourceMapSha256 = await verifyPinnedRegularFile(sourceMapPath, SOURCE_MAP_SHA256);
  const sourceManifestSha256 = await verifyPinnedRegularFile(sourceManifestPath, SOURCE_MANIFEST_SHA256);
  const [metadata, sourceMap, sourceManifest] = await Promise.all([
    readJson(metadataPath), readJson(sourceMapPath), readJson(sourceManifestPath),
  ]);
  assert.equal(metadata.status, "CURRENT_SOURCE_FROZEN_FOR_STATIC_EXPORT");
  assert.equal(metadata.sourceDigest, SOURCE_TREE_SHA256);
  assert.equal(metadata.sourceFiles, SOURCE_FILE_COUNT);
  assert.equal(metadata.sha256MapSha256, SOURCE_MAP_SHA256);
  assert.equal(metadata.sourceManifestSha256, SOURCE_MANIFEST_SHA256);
  assert.equal(sourceManifest.status, "FROZEN_CURRENT_SOURCE_FOR_STATIC_WEB_EXPORT");
  assert.equal(sourceManifest.sourceDigest, SOURCE_TREE_SHA256);
  assert.equal(sourceManifest.fileCount, SOURCE_FILE_COUNT);
  assert.equal(sourceManifest.files.length, SOURCE_FILE_COUNT);
  assert.equal(Object.keys(sourceMap).length, SOURCE_FILE_COUNT);

  const manifestEntries = new Map(sourceManifest.files.map(entry => [entry.path, entry]));
  assert.equal(manifestEntries.size, SOURCE_FILE_COUNT, "source manifest paths must be unique");
  for (const [relativePath, expectedSha256] of Object.entries(sourceMap)) {
    const entry = manifestEntries.get(relativePath);
    assert.ok(entry, `source manifest is missing ${relativePath}`);
    assert.equal(entry.sha256, expectedSha256, `source map/manifest mismatch for ${relativePath}`);
    const file = resolve(contentRoot, relativePath);
    const withinRoot = relative(contentRoot, file);
    assert.ok(withinRoot && withinRoot !== ".." && !withinRoot.startsWith(`..${sep}`) && !isAbsolute(withinRoot),
      `frozen source path escaped its root: ${relativePath}`);
    assert.equal(await realpath(file), file, `frozen source path must be canonical: ${relativePath}`);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `frozen source must be a regular file: ${relativePath}`);
    assert.equal(stat.size, entry.size, `frozen source size changed: ${relativePath}`);
    const observedSha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    assert.equal(observedSha256, expectedSha256, `frozen source bytes changed: ${relativePath}`);
  }
  return { sourceMetadataSha256, sourceMapSha256, sourceManifestSha256, sourceMap };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function summarizeGates(gates) {
  return Object.fromEntries(Object.entries(gates).map(([name, gate]) => [name, { held: gate.held, released: gate.released }]));
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

function recordForGate(record, phase, kind, role, serverId, method, id) {
  record({ phase, kind, role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method), requestIdFingerprint: shortHash(rpcKey(id)) });
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

function safeObservedRequestPath(pathname) {
  return pathname.startsWith("/api/") ? safeApiPath(pathname) : "non-api";
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

async function assertRowAdvertisesTitle(page, testId, expectedTitle) {
  const text = await visible(page, testId).innerText();
  assert.ok(text.includes(expectedTitle), `${testId} must visibly advertise its fixture title`);
}

function assertSessionsSocketOrdinals(events) {
  const phase = "sessions-a-first-pages-and-held-peer-cursor";
  const result = {};
  for (const server of ["A-fast", "A-slow"]) {
    const base = event => event.kind === "rpc-request" && event.role === "A" && event.server === server;
    const firstPage = events.find(event => base(event) && event.phase === phase && event.method === "thread/list" && event.hasCursor === false);
    const cursorPage = events.find(event => base(event) && event.phase === phase && event.method === "thread/list" && event.hasCursor === true);
    assert.ok(firstPage, `${server} Sessions default-page request must be observed`);
    assert.ok(cursorPage, `${server} Sessions cursor request must be observed`);
    assert.ok(Number.isSafeInteger(firstPage.socketOrdinal) && firstPage.socketOrdinal > 0,
      `${server} Sessions default page must have an owned socket ordinal`);
    assert.equal(cursorPage.socketOrdinal, firstPage.socketOrdinal,
      `${server} Sessions default and cursor pages must use the same WebSocket`);
    const initialize = events.find(event => base(event) && event.method === "initialize" && event.socketOrdinal === firstPage.socketOrdinal);
    assert.ok(initialize, `${server} Sessions pages must use the WebSocket that performed initialize`);
    assert.ok(initialize.atNodeMs <= firstPage.atNodeMs && firstPage.atNodeMs <= cursorPage.atNodeMs,
      `${server} initialize/default-page/cursor sequence must preserve request order`);
    result[server] = {
      socketOrdinal: firstPage.socketOrdinal,
      initializePhase: initialize.phase,
      initializeRequestIdFingerprint: initialize.requestIdFingerprint,
      defaultPageRequestIdFingerprint: firstPage.requestIdFingerprint,
      cursorRequestIdFingerprint: cursorPage.requestIdFingerprint,
    };
  }
  return result;
}

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function safeErrorName(error) {
  const allowed = new Set(["Error", "TypeError", "RangeError", "AssertionError", "TimeoutError", "AbortError", "AggregateError"]);
  return allowed.has(error?.name) ? error.name : "OtherError";
}
