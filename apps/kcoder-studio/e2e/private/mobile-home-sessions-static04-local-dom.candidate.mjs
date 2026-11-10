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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../harness/chromium.mjs";
import { dispatchTrustedTouchDrag } from "../harness/browser-touch-input.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { reuseMobileWebExport } from "../harness/mobile-web-export-reuse.mjs";
import { copyOfficialMobileStaticDist, inspectOfficialMobileStaticDist } from "../harness/mobile-static-dist-input.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { parseObservedJsonRpcFrame } from "./mobile-public-new-catalog-dom-probe.candidate.mjs";

const PRIVATE_RUN_FLAG = "KCODER_E2E_PRIVATE_HOME_SESSIONS_STATIC04";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const CLI_FLAGS = new Set(["--current-official-dist", "--preview-sessions", "--central-row-text-target-diagnostic"]);
const CLI_VALUE_OPTIONS = new Set([
  "--official-dist-root",
  "--official-dist-manifest-sha256",
  "--home-view-all-test-id",
  "--preview-source-root",
  "--preview-source-commit",
  "--home-source-sha256",
  "--sessions-source-sha256",
]);
const cliOptions = parseCliOptions(process.argv.slice(2), CLI_FLAGS, CLI_VALUE_OPTIONS);
const CURRENT_OFFICIAL_DIST_MODE = cliOptions.flags.has("--current-official-dist");
const PREVIEW_SESSIONS_MODE = cliOptions.flags.has("--preview-sessions");
const CENTRAL_ROW_TEXT_TARGET_DIAGNOSTIC = cliOptions.flags.has("--central-row-text-target-diagnostic");
assert.ok(!CENTRAL_ROW_TEXT_TARGET_DIAGNOSTIC || (CURRENT_OFFICIAL_DIST_MODE && PREVIEW_SESSIONS_MODE), "central-row text-target diagnostic requires --current-official-dist and --preview-sessions");
const EXPLICIT_OFFICIAL_DIST_ROOT = cliOptions.values.get("--official-dist-root") ?? null;
const EXPLICIT_OFFICIAL_DIST_MANIFEST_SHA256 = cliOptions.values.get("--official-dist-manifest-sha256") ?? null;
const HOME_VIEW_ALL_TEST_ID = cliOptions.values.get("--home-view-all-test-id") ?? null;
const EXPLICIT_PREVIEW_SOURCE_ROOT = cliOptions.values.get("--preview-source-root") ?? null;
const PREVIEW_SOURCE_COMMIT = cliOptions.values.get("--preview-source-commit") ?? null;
const PREVIEW_HOME_SOURCE_SHA256 = cliOptions.values.get("--home-source-sha256") ?? null;
const PREVIEW_SESSIONS_SOURCE_SHA256 = cliOptions.values.get("--sessions-source-sha256") ?? null;
assert.equal(Boolean(EXPLICIT_OFFICIAL_DIST_ROOT), Boolean(EXPLICIT_OFFICIAL_DIST_MANIFEST_SHA256),
  "--official-dist-root and --official-dist-manifest-sha256 must be supplied together");
assert.ok(!EXPLICIT_OFFICIAL_DIST_ROOT || CURRENT_OFFICIAL_DIST_MODE,
  "explicit official dist input requires --current-official-dist");
assert.ok(!PREVIEW_SESSIONS_MODE || CURRENT_OFFICIAL_DIST_MODE,
  "--preview-sessions requires --current-official-dist");
assert.ok(!PREVIEW_SESSIONS_MODE || (EXPLICIT_OFFICIAL_DIST_ROOT && HOME_VIEW_ALL_TEST_ID && EXPLICIT_PREVIEW_SOURCE_ROOT && PREVIEW_SOURCE_COMMIT && PREVIEW_HOME_SOURCE_SHA256 && PREVIEW_SESSIONS_SOURCE_SHA256),
  "--preview-sessions requires explicit dist, CTA testID, source root/commit, and Home/Sessions source SHA-256 pins");
assert.ok(PREVIEW_SESSIONS_MODE || (!HOME_VIEW_ALL_TEST_ID && !EXPLICIT_PREVIEW_SOURCE_ROOT && !PREVIEW_SOURCE_COMMIT && !PREVIEW_HOME_SOURCE_SHA256 && !PREVIEW_SESSIONS_SOURCE_SHA256),
  "preview-only Home/Sessions pins require --preview-sessions");
if (EXPLICIT_OFFICIAL_DIST_ROOT) assert.ok(isAbsolute(EXPLICIT_OFFICIAL_DIST_ROOT), "--official-dist-root must be absolute");
if (EXPLICIT_PREVIEW_SOURCE_ROOT) assert.ok(isAbsolute(EXPLICIT_PREVIEW_SOURCE_ROOT), "--preview-source-root must be absolute");
if (PREVIEW_SOURCE_COMMIT)
  assert.match(PREVIEW_SOURCE_COMMIT, /^[a-f0-9]{40}$/, "--preview-source-commit must be a full lowercase Git commit SHA");
if (EXPLICIT_OFFICIAL_DIST_MANIFEST_SHA256)
  assert.match(EXPLICIT_OFFICIAL_DIST_MANIFEST_SHA256, /^[a-f0-9]{64}$/, "--official-dist-manifest-sha256 must be lowercase SHA-256");
if (HOME_VIEW_ALL_TEST_ID)
  assert.match(HOME_VIEW_ALL_TEST_ID, /^[A-Za-z0-9_-]{1,96}$/, "--home-view-all-test-id must be a stable testID");
for (const [option, digest] of [["--home-source-sha256", PREVIEW_HOME_SOURCE_SHA256], ["--sessions-source-sha256", PREVIEW_SESSIONS_SOURCE_SHA256]]) {
  if (digest) assert.match(digest, /^[a-f0-9]{64}$/, `${option} must be lowercase SHA-256`);
}
const TOUCH_SCROLL_CAUSALITY_DIAGNOSTIC = process.env.KCODER_E2E_PRIVATE_HOME_SESSIONS_TOUCH_SCROLL_CAUSALITY === "1";
assert.ok(!TOUCH_SCROLL_CAUSALITY_DIAGNOSTIC || CURRENT_OFFICIAL_DIST_MODE, "touch-scroll causality diagnostic requires the current official static dist mode");
const SOURCE_TREE_SHA256 = "139184a0fa957d2c024340993f22036a46ddcb8a0907debf3d38355538843714";
const EXPORT_MANIFEST_SHA256 = "83275d4db706ac733dccd5f07eb642ddc53d9f15d5e32bec253653856eb9ff30";
const BUNDLE_SHA256 = "073fb5bdf2d8d8bdf6d0684afd1b56c3ba181985c2c5448fafee3bba9c8ad14a";
const BUNDLE_FILE_COUNT = 37;
const EXPORT_RELATIVE_ROOT = "target/private-phone-ux-implementation/mobile-web-export-incremental-home-sessions-20261009-054052";
const EXPORT_RELATIVE_MANIFEST = `${EXPORT_RELATIVE_ROOT}-manifest.json`;
const CURRENT_OFFICIAL_DIST_ROOT = resolve(repoRoot, "target/worktree/2026/10/09/mobile-ux-all-changes-20261009/apps/kcoder-studio/mobile/dist");
const CURRENT_OFFICIAL_DIST_MANIFEST_SHA256 = "5053ac22d3476f7f17513a3c76a71b8993f3752e47bd060b8bead5c07c830752";
const OFFICIAL_DIST_ROOT = EXPLICIT_OFFICIAL_DIST_ROOT ? resolve(EXPLICIT_OFFICIAL_DIST_ROOT) : CURRENT_OFFICIAL_DIST_ROOT;
const OFFICIAL_DIST_MANIFEST_SHA256 = EXPLICIT_OFFICIAL_DIST_MANIFEST_SHA256 ?? CURRENT_OFFICIAL_DIST_MANIFEST_SHA256;
const CURRENT_OFFICIAL_DIST_RESOURCE_TABLE_SHA256 = "5c476e1a11242c37365d16fb1552edf77b956113b643b502cb74857b36e65186";
const CURRENT_GATEWAY_RUNTIME_RELATIVE_ROOT = "target/private-phone-ux-implementation/shared-gateway-current-20261009/snapshot-20261009-223221.326Z";
const CURRENT_GATEWAY_RUNTIME_MANIFEST_SHA256 = "0219dce48d65e6413ce60d0aadfe1fe8047426c6570689ecaf77d757f256cda5";
const CURRENT_GATEWAY_SOURCE_TREE_SHA256 = "6a8255fa538d6f2534d1784a088de9757283e8935e69a0d78a95358bb49ae197";
const CURRENT_GATEWAY_DEPENDENCY_TREE_SHA256 = "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954";
const CURRENT_GATEWAY_KCODER_BINARY = resolve(repoRoot, "target/private-b6-device-revoke-20261009/build-03/owned-kcoder-copy");
const CURRENT_GATEWAY_KCODER_BINARY_SHA256 = "bc985854134edffc02415a5d9e72f8905fdc23e7e2263e84f9554e53619dec29";
const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const PINNED_CFT_PATH = "/opt/cft/chrome-linux64/chrome";
const PINNED_CFT_VERSION = "151.0.7922.34";
const MAX_RPC_EVENTS = 512;
const CURRENT_MOBILE_PAGE_OPTIONS = Object.freeze({
  viewport: Object.freeze({ width: 390, height: 844 }),
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
});
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
  "apps/kcoder-studio/e2e/harness/browser-touch-input.mjs": "60e99fad3bd9d09aaac89cee8ff90cdc469edb5974c53183e08ae894a1706f65",
  "apps/kcoder-studio/e2e/harness/mobile-web-export-reuse.mjs": "d3e84b074e485dd2bf171d690d18e130920689b67711ad3f56a3bd791eb363f3",
  "apps/kcoder-studio/e2e/harness/run-context.mjs": "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11",
  "apps/kcoder-studio/e2e/private/mobile-public-new-catalog-dom-probe.candidate.mjs": "481152c8a343649231d396d343a151b54c471d6a94cde20d68ad3fe1958c3e9f",
  "apps/kcoder-studio/e2e/suites/mobile/mobile-qa-profile-background-reauth-isolation.e2e.mjs": "8f4676d5c7b6e90b061a4a4b4979c90a4fac77a578ecd8dabdc696efc1cea53f",
});

const CURRENT_MODE_SOURCE_PINS = Object.freeze({
  "apps/kcoder-studio/e2e/harness/chromium.mjs": "e33e4cfc9946eda7df914027a3d1fc94d17008dff2ae4f8c6c27d1ad2edffb88",
  "apps/kcoder-studio/e2e/harness/browser-touch-input.mjs": "60e99fad3bd9d09aaac89cee8ff90cdc469edb5974c53183e08ae894a1706f65",
  "apps/kcoder-studio/e2e/harness/gateway.mjs": "8a3fc744a90bfd9a6311145f60a25e7156d0672702bb7220b8e98368475ea573",
  "apps/kcoder-studio/e2e/harness/gateway-runtime-snapshot-guard.mjs": "a8a8b9883bb145a7807cf0c07ef463fc016f18b2d8182c7caab7bab9ce12ab39",
  "apps/kcoder-studio/e2e/harness/mobile-latency-helpers.mjs": "ab94fc2f8ec946033391f632375f6272fdfb47a865b40a22f018b1ef1e857e3a",
  "apps/kcoder-studio/e2e/harness/mobile-static-dist-input.mjs": "0457db8c0e1f4326aea5a5e8242e5f58d9f9ba0f8bf59e0d01cd5e2743378063",
  "apps/kcoder-studio/e2e/harness/run-context.mjs": "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11",
  "apps/kcoder-studio/e2e/private/mobile-public-new-catalog-dom-probe.candidate.mjs": "301658bf571cdd1b949ed30b8178d98e36c30299491ce8672eae563df456eed8",
});

if (process.env[PRIVATE_RUN_FLAG] !== "1")
  throw new Error(`${PRIVATE_RUN_FLAG}=1 is required for this private candidate`);
if (process.execPath !== EXPECTED_NODE || process.version !== "v22.17.0")
  throw new Error("This candidate requires the pinned Node 22.17.0 executable");
if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1")
  throw new Error("This isolated VM requires explicit KCODER_E2E_CHROMIUM_NO_SANDBOX=1");

await runE2E(import.meta.url, {
  testId: PREVIEW_SESSIONS_MODE ? "mobile-home-preview-sessions-pagination-local-mock-dom" : "mobile-home-sessions-static04-local-mock-dom",
  tier: "manual-live",
  modelPolicy: PREVIEW_SESSIONS_MODE
    ? "mounted Mobile Web Home preview-to-Sessions pagination through an owned KCODER_STUDIO_MOCK Gateway; JS fixture controls workspace/thread pages; no Rust/native/Provider/model claim"
    : "model-independent local Mobile Web DOM, route, mock-Gateway and profile-owner isolation; KCODER_STUDIO_MOCK=1; no Rust app-server, Provider, or turn",
  retainSuccessLogs: true,
}, async context => {
  const sourcePins = await verifySourcePins(CURRENT_OFFICIAL_DIST_MODE ? CURRENT_MODE_SOURCE_PINS : SOURCE_PINS);
  const previewProductSourcePinsBefore = PREVIEW_SESSIONS_MODE ? await verifyPreviewProductSourcePins() : null;
  let mobileWeb;
  let exportEvidence;
  let gatewayRuntime = null;
  if (CURRENT_OFFICIAL_DIST_MODE) {
    const officialDist = await inspectOfficialMobileStaticDist({
      distRoot: OFFICIAL_DIST_ROOT,
      expectedManifestSha256: OFFICIAL_DIST_MANIFEST_SHA256,
    });
    assert.equal(officialDist.resourceCount, BUNDLE_FILE_COUNT);
    if (!EXPLICIT_OFFICIAL_DIST_ROOT)
      assert.equal(officialDist.resourceTableSha256, CURRENT_OFFICIAL_DIST_RESOURCE_TABLE_SHA256);
    const ownedDist = await copyOfficialMobileStaticDist(context, {
      distRoot: OFFICIAL_DIST_ROOT,
      expectedManifestSha256: OFFICIAL_DIST_MANIFEST_SHA256,
      outputName: PREVIEW_SESSIONS_MODE ? "preview-sessions-official-mobile-static-dist" : "current-official-mobile-static-dist",
    });
    assert.equal(ownedDist.ownedCopyVerified, true);
    assert.equal(ownedDist.sourceStableDuringCopy, true);
    assert.equal(ownedDist.resourceTableSha256, officialDist.resourceTableSha256);
    if (!EXPLICIT_OFFICIAL_DIST_ROOT)
      assert.equal(ownedDist.resourceTableSha256, CURRENT_OFFICIAL_DIST_RESOURCE_TABLE_SHA256);
    mobileWeb = { path: ownedDist.ownedRoot };
    exportEvidence = {
      inputKind: "official-mobile-static-dist",
      manifestPath: officialDist.manifestPath,
      manifestSha256: officialDist.manifestSha256,
      resourceCount: officialDist.resourceCount,
      resourceTableSha256: officialDist.resourceTableSha256,
      ownedRoot: ownedDist.ownedRoot,
      ownedCopyVerified: ownedDist.ownedCopyVerified,
      sourceStableDuringCopy: ownedDist.sourceStableDuringCopy,
      exportPerformedByCandidate: false,
    };
    const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
    gatewayRuntime = await createMobileLatencyHelpers({ sha256: hashBytes })
      .prepareGatewayRuntimeSnapshot(
        context,
        CURRENT_GATEWAY_RUNTIME_RELATIVE_ROOT,
        CURRENT_GATEWAY_KCODER_BINARY,
        CURRENT_GATEWAY_KCODER_BINARY_SHA256,
      );
    assert.equal(gatewayRuntime.manifestSha256, CURRENT_GATEWAY_RUNTIME_MANIFEST_SHA256);
    assert.equal(gatewayRuntime.manifest.sourceTreeSha256, CURRENT_GATEWAY_SOURCE_TREE_SHA256);
    assert.equal(gatewayRuntime.manifest.dependencyTreeSha256, CURRENT_GATEWAY_DEPENDENCY_TREE_SHA256);
    assert.equal(gatewayRuntime.manifest.nodeVersion, "v22.17.0");
  } else {
    const exportRoot = resolve(repoRoot, EXPORT_RELATIVE_ROOT);
    const exportManifest = resolve(repoRoot, EXPORT_RELATIVE_MANIFEST);
    assert.ok(isAbsolute(exportRoot) && isAbsolute(exportManifest));
    mobileWeb = await reuseMobileWebExport(context, {
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
    exportEvidence = {
      inputKind: "pinned-expo-export",
      sourceTreeSha256: SOURCE_TREE_SHA256,
      bundleRootRelativePath: EXPORT_RELATIVE_ROOT,
      bundleManifestSha256: EXPORT_MANIFEST_SHA256,
      bundleSha256: BUNDLE_SHA256,
      bundleFileCount: BUNDLE_FILE_COUNT,
      exportPerformedByCandidate: false,
    };
  }

  await context.writeArtifactJson("execution-plan.json", {
    schemaVersion: 1,
    scope: PREVIEW_SESSIONS_MODE ? "current-official-mobile-dist-home-preview-to-sessions-pagination-browser-only" : CURRENT_OFFICIAL_DIST_MODE ? "current-official-mobile-dist-local-mock-browser-only" : "local-mock-browser-only",
    modelPolicy: "no Rust app-server, Provider, turn/start, or thread/start",
    node: { executable: process.execPath, version: process.version },
    sandbox: { KCODER_E2E_CHROMIUM_NO_SANDBOX: true },
    export: exportEvidence,
    gatewayRuntime: gatewayRuntime ? {
      root: gatewayRuntime.root,
      manifestSha256: gatewayRuntime.manifestSha256,
      sourceTreeSha256: gatewayRuntime.manifest.sourceTreeSha256,
      dependencyTreeSha256: gatewayRuntime.manifest.dependencyTreeSha256,
      nodeVersion: gatewayRuntime.manifest.nodeVersion,
      binaryPath: gatewayRuntime.binaryPath ?? null,
      classification: "reused frozen KCODER_STUDIO_MOCK gateway snapshot; no CLI binary or Rust engine evidence",
    } : null,
    sourcePins,
    homePreview: PREVIEW_SESSIONS_MODE ? {
      homeViewAllTestId: HOME_VIEW_ALL_TEST_ID,
      previewSourceRoot: resolve(EXPLICIT_PREVIEW_SOURCE_ROOT),
      previewSourceCommit: PREVIEW_SOURCE_COMMIT,
      productSourcePins: previewProductSourcePinsBefore,
      workspaceScopeDiagnostic: "requests grouped by observed server and workspace alias; raw request totals remain the acceptance gate",
      paginationBoundary: "Home reads only one first page per scope and closes those socket owners; View All routes to Sessions for the exact server; Sessions opens a fresh socket and only trusted touch requests the next page",
    } : null,
    officialDistInput: CURRENT_OFFICIAL_DIST_MODE ? {
      root: OFFICIAL_DIST_ROOT,
      manifestSha256: OFFICIAL_DIST_MANIFEST_SHA256,
      rootWasExplicit: Boolean(EXPLICIT_OFFICIAL_DIST_ROOT),
    } : null,
    gateways: PREVIEW_SESSIONS_MODE
      ? [{ alias: "A", mock: true, targets: ["A-fast", "A-slow"], servesPinnedStaticBundle: true }]
      : [
        { alias: "A", mock: true, targets: ["A-fast", "A-slow"], servesPinnedStaticBundle: true },
        { alias: "B", mock: true, targets: ["B-fast"], mobileWebOriginAllowlistAlias: "A" },
      ],
    expectedReads: ["initialize", "runtime.workspaces.list", "runtime.worktrees.list", "thread/list", "thread/read", "thread/resume"],
    fixtureBoundary: PREVIEW_SESSIONS_MODE
      ? "page.routeWebSocket forwards one owned Gateway response into the bridge, overlays synthetic workspace/worktree/thread page data, and sends one correlated response; each returned workspace path matches that server's run-owned default workspace, so the fixture does not manufacture a second scope; this does not prove Gateway or Rust directory results"
      : null,
    allowedPairingCleanup: ["POST /api/mobile/session", "DELETE /api/mobile/session"],
    forbiddenRpcMethods: [...MUTATING_METHODS].sort(),
  });

  const workspaceAfast = context.pathInState("workspace-a-fast");
  const workspaceAslow = context.pathInState("workspace-a-slow");
  const workspaceBfast = PREVIEW_SESSIONS_MODE ? null : context.pathInState("workspace-b-fast");
  const workspaceByTarget = PREVIEW_SESSIONS_MODE
    ? Object.freeze({ "A/fast-A": workspaceAfast, "A/slow-A": workspaceAslow })
    : WORKSPACES;
  await Promise.all([
    mkdir(workspaceAfast, { recursive: true, mode: 0o700 }),
    mkdir(workspaceAslow, { recursive: true, mode: 0o700 }),
    ...(workspaceBfast ? [mkdir(workspaceBfast, { recursive: true, mode: 0o700 })] : []),
  ]);
  const serversA = [
    mockServer("fast-A", "Fast A", workspaceAfast),
    mockServer("slow-A", "Slow A", workspaceAslow),
  ];
  const serversAPath = await context.writeStateJson("servers-a.json", serversA);
  const serversBPath = workspaceBfast ? await context.writeStateJson("servers-b.json", [
    mockServer("fast-B", "Fast B", workspaceBfast),
  ]) : null;
  const gatewayA = await startGateway(context, {
    label: "home-sessions-gateway-a",
    auth: true,
    workspace: workspaceAfast,
    serversFile: serversAPath,
    ...(gatewayRuntime ? { gatewayRoot: gatewayRuntime.root, cwd: gatewayRuntime.root } : {}),
    env: gatewayRuntime
      ? { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_WEB_ROOT: "", KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path }
      : { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_WEB_ROOT: mobileWeb.path },
  });
  const gatewayB = workspaceBfast ? await startGateway(context, {
    label: "home-sessions-gateway-b",
    auth: true,
    workspace: workspaceBfast,
    serversFile: serversBPath,
    ...(gatewayRuntime ? { gatewayRoot: gatewayRuntime.root, cwd: gatewayRuntime.root } : {}),
    env: {
      KCODER_STUDIO_MOCK: "1",
      ...(gatewayRuntime ? { KCODER_STUDIO_WEB_ROOT: "", KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path } : { KCODER_STUDIO_WEB_ROOT: mobileWeb.path }),
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl,
    },
  }) : null;
  if (gatewayB) assert.notEqual(gatewayA.port, gatewayB.port, "A and B must be separate owned Gateways");

  const phases = {
    current: PREVIEW_SESSIONS_MODE ? "preview-home-first-pages" : "home-a-fast-first-peer-and-cursor-held",
    homeSlowDiscovery: deferredGate("home-slow-discovery"),
    homeFastCursor: deferredGate("home-fast-cursor"),
    previewSessionsNextPage: deferredGate("preview-sessions-next-page"),
    sessionsSlowCursor: deferredGate("sessions-slow-cursor"),
    profileBFirstPage: deferredGate("profile-b-first-page"),
  };
  const ledger = {
    events: [],
    droppedEvents: 0,
    malformedFrameCount: 0,
    unknownRpcResponseCount: 0,
    mutatingRequestCount: 0,
    fixtureErrorCount: 0,
    gatewayForwardedResponseCount: 0,
    browserFixtureOverlayResponseCount: 0,
    nextSocketOrdinal: 0,
    sockets: [],
    http: [],
    held: { homeSlowDiscovery: false, homeFastCursor: false, sessionsSlowCursor: false, profileBFirstPage: false, previewSessionsNextPage: false },
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
    if (gatewayB && origin === gatewayB.baseUrl) return "B";
    return null;
  };

  const chromium = await startChromium(context, {
    label: PREVIEW_SESSIONS_MODE ? "home-preview-sessions-chromium" : "home-sessions-static04-chromium",
    noSandbox: true,
    startTimeoutMs: 60_000,
    ...(PREVIEW_SESSIONS_MODE ? { executablePath: PINNED_CFT_PATH } : {}),
  });
  if (PREVIEW_SESSIONS_MODE) {
    assert.equal(chromium.executablePath, PINNED_CFT_PATH);
    assert.equal(await chromium.browser.version(), PINNED_CFT_VERSION);
  }
  const browserContext = chromium.browser.contexts()[0];
  assert.ok(browserContext, "the owned Chromium default context must exist");
  const page = CURRENT_OFFICIAL_DIST_MODE
    ? await chromium.newPage(CURRENT_MOBILE_PAGE_OPTIONS)
    : await browserContext.newPage();
  if (!CURRENT_OFFICIAL_DIST_MODE) await page.setViewportSize({ width: 390, height: 844 });
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
  let sessionsScrollCapture = null;
  let sessionsScrollEvidence = null;
  let sessionsScrollInputEvidence = null;
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
    if (PREVIEW_SESSIONS_MODE) phases.current = "preview-home-first-pages";
    await connectProfileFromLogin(page, gatewayA);
    const profileA = await readProfileIdentity(page, gatewayA.baseUrl);
    if (PREVIEW_SESSIONS_MODE) {
      const previewResult = await runPreviewSessionsFlow(page, profileA, phases, ledger, {
        homeViewAllTestId: HOME_VIEW_ALL_TEST_ID,
        previewSourceRoot: resolve(EXPLICIT_PREVIEW_SOURCE_ROOT),
        serverDefinitions: serversA,
        workspaceByTarget,
        onScrollInput: value => { sessionsScrollInputEvidence = value; },
        onScrollCapture: value => { sessionsScrollCapture = value; },
        onScrollEvidence: value => {
          sessionsScrollEvidence = value;
          sessionsScrollEvidence.cursorLedger = sessionsCursorLedger(ledger, "preview-sessions-next-page");
        },
        abortSignal: context.abortSignal,
      });
      if (sessionsScrollEvidence)
        await context.writeArtifactJson("mobile-sessions-scroll-capture.json", sessionsScrollEvidence);
      assert.equal(ledger.mutatingRequestCount, 0, "preview-to-Sessions must issue no mutation RPCs");
      assert.equal(ledger.droppedEvents, 0, "preview RPC evidence must remain within the bounded collector");
      assert.equal(ledger.malformedFrameCount, 0, "all preview RPC frames must parse");
      assert.equal(ledger.unknownRpcResponseCount, 0, "all preview RPC responses must correlate to one request");
      assert.equal(ledger.fixtureErrorCount, 0, "every observed preview thread/list request must match the explicit fixture");
      assert.equal(pageErrorCount, 0, "the preview page must have no uncaught JavaScript errors");
      assert.equal(consoleErrorCount, 0, "the preview page must have no console errors");
      const previewProductSourcePinsAfter = await verifyPreviewProductSourcePins();
      assert.deepEqual(previewProductSourcePinsAfter, previewProductSourcePinsBefore,
        "frozen Home and Sessions sources must remain unchanged during the mounted Browser run");
      await context.writeArtifactJson("mobile-home-preview-sessions-result.json", {
        schemaVersion: 1,
        status: "passed",
        claimScope: "mounted Mobile Web Home preview-to-Sessions flow using an owned KCODER_STUDIO_MOCK Gateway; page.routeWebSocket overlays synthetic workspace/worktree/thread page data after one forwarded Gateway response and sends one correlated response; not Gateway/Rust directory, native, real-phone, Provider, public Relay, model, or performance evidence",
        export: exportEvidence,
        gatewayRuntime: gatewayRuntime ? {
          manifestSha256: gatewayRuntime.manifestSha256,
          sourceTreeSha256: gatewayRuntime.manifest.sourceTreeSha256,
          dependencyTreeSha256: gatewayRuntime.manifest.dependencyTreeSha256,
          nodeVersion: gatewayRuntime.manifest.nodeVersion,
          binaryPath: gatewayRuntime.binaryPath ?? null,
        } : null,
        profileAlias: shortHash(profileA.id),
        homeViewAllTestId: HOME_VIEW_ALL_TEST_ID,
        previewSourceRoot: resolve(EXPLICIT_PREVIEW_SOURCE_ROOT),
        previewSourceCommit: PREVIEW_SOURCE_COMMIT,
        home: previewResult.home,
        sessions: previewResult.sessions,
        sessionsScrollCapture: sessionsScrollEvidence ? "mobile-sessions-scroll-capture.json" : null,
        sessionsScrollInputEvidence,
        protocol: {
          mutationRpcCount: ledger.mutatingRequestCount,
          fixtureErrorCount: ledger.fixtureErrorCount,
          gatewayForwardedResponseCount: ledger.gatewayForwardedResponseCount,
          browserFixtureOverlayResponseCount: ledger.browserFixtureOverlayResponseCount,
          malformedFrameCount: ledger.malformedFrameCount,
          unknownRpcResponseCount: ledger.unknownRpcResponseCount,
          pageErrorCount,
          consoleErrorCount,
          http: ledger.http,
          rpcEvents: ledger.events,
          previewHomeWorkspaceScopes: summarizePreviewHomeWorkspaceScopes(ledger.events, ledger.sockets),
          sockets: ledger.sockets.map(safeSocketEvidence),
          droppedEvents: ledger.droppedEvents,
        },
        sourcePins,
        productSourcePins: { before: previewProductSourcePinsBefore, after: previewProductSourcePinsAfter },
      });
      return { classification: "MOBILE_WEB_MOCK_GATEWAY_BROWSER_ONLY", homePreview: true, sessionsCursorTouch: true };
    }
    await waitFor(() => phases.homeSlowDiscovery.held && phases.homeFastCursor.held,
      30_000, "A fast first page plus the independent slow discovery and fast cursor holds", 50, context.abortSignal);
    await visible(page, "thread-A_HOME_FIRST").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await visible(page, "thread-A_HOME_FIRST").isEnabled(), true,
      "the fast Home first-page row must be actionable while peer discovery and its cursor are held");

    phases.homeSlowDiscovery.release("reject");
    await page.getByText("A_SLOW_DISCOVERY_ERROR", { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "thread-A_HOME_FIRST").click();
    await waitForTaskRoute(context, page, profileA.id, "fast-A", "A_HOME_FIRST", WORKSPACES["A/fast-A"], "A fast first");
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
    if (CURRENT_OFFICIAL_DIST_MODE) {
      if (TOUCH_SCROLL_CAUSALITY_DIAGNOSTIC) {
        const touchScrollDiagnostic = await runTouchScrollCausalityDiagnostic(page, context);
        const observedPageUrl = new URL(page.url());
        await context.writeArtifactJson("mobile-sessions-touch-scroll-causality.json", {
          schemaVersion: 1,
          status: touchScrollDiagnostic.status,
          claimScope: touchScrollDiagnostic.claimScope,
          mode: "current official 37-resource Mobile dist over owned local KCODER_STUDIO_MOCK Gateways; no Rust app-server, Relay, Provider, public service, or model",
          page: { origin: observedPageUrl.origin, pathname: observedPageUrl.pathname },
          export: exportEvidence,
          gatewayRuntime: gatewayRuntime ? {
            manifestSha256: gatewayRuntime.manifestSha256,
            sourceTreeSha256: gatewayRuntime.manifest.sourceTreeSha256,
            dependencyTreeSha256: gatewayRuntime.manifest.dependencyTreeSha256,
            nodeVersion: gatewayRuntime.manifest.nodeVersion,
          } : null,
          protocolCounts: {
            rpcEvents: ledger.events.length,
            droppedEvents: ledger.droppedEvents,
            mutationRequests: ledger.mutatingRequestCount,
            historyReads: ledger.historyReadThreadIds.length,
          },
          diagnostic: touchScrollDiagnostic,
        });
        return { classification: "DIAGNOSTIC_ONLY", touchScrollDiagnostic: touchScrollDiagnostic.classification };
      }
      sessionsScrollInputEvidence = createSessionsTouchInputEvidence();
      sessionsScrollCapture = await scrollListWithTrustedTouch(
        page,
        sessionsList,
        sessionsScrollInputEvidence,
        capture => { sessionsScrollCapture = capture; },
        context.abortSignal,
      );
    } else {
      sessionsScrollCapture = await scrollListWithBrowserInput(page, sessionsList);
    }
    await waitFor(() => phases.sessionsSlowCursor.held,
      30_000, "slow Sessions cursor request held after an actual list scroll", 50, context.abortSignal);
    sessionsScrollEvidence = await finishSessionsScrollCapture(sessionsScrollCapture, "slow-cursor-held");
    sessionsScrollEvidence.cursorLedger = sessionsCursorLedger(ledger);
    sessionsScrollEvidence.inputEvidence = sessionsScrollInputEvidence;
    await context.writeArtifactJson("mobile-sessions-scroll-capture.json", sessionsScrollEvidence);
    await visible(page, "session-A_SESSIONS_FAST_MORE").waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "sessions-page-loading").waitFor({ state: "visible", timeout: 30_000 });
    phases.sessionsSlowCursor.release("complete");
    await visible(page, "session-A_SESSIONS_SLOW_MORE").waitFor({ state: "visible", timeout: 30_000 });
    await visible(page, "sessions-page-loading").waitFor({ state: "hidden", timeout: 30_000 });

    await visible(page, "session-A_SESSIONS_FAST_0").click();
    await waitForTaskRoute(context, page, profileA.id, "fast-A", "A_SESSIONS_FAST_0", WORKSPACES["A/fast-A"], "A_SESSIONS_FAST 0");
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
    await waitForTaskRoute(context, page, profileB.id, "fast-B", "B_AFTER_SWITCH_FIRST", WORKSPACES["B/fast-B"], "B after switch");
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
      export: exportEvidence,
      gatewayRuntime: gatewayRuntime ? {
        manifestSha256: gatewayRuntime.manifestSha256,
        sourceTreeSha256: gatewayRuntime.manifest.sourceTreeSha256,
        dependencyTreeSha256: gatewayRuntime.manifest.dependencyTreeSha256,
        nodeVersion: gatewayRuntime.manifest.nodeVersion,
        binaryPath: gatewayRuntime.binaryPath ?? null,
      } : null,
      profileAliases: { A: shortHash(profileA.id), B: shortHash(profileB.id), distinct: profileA.id !== profileB.id },
      gatewayAliases: { A: gatewayA.port, B: gatewayB.port, distinct: gatewayA.port !== gatewayB.port },
      home: { firstRowVisibleWhilePeerAndCursorHeld: true, firstRowClickedWhilePeerErrorAndCursorHeld: true, routeAndHistoryVerified: true },
      sessions: { firstRowsVisible: true, fastLoadMoreVisibleWhileSlowCursorHeld: true, slowCursorReleasedAndVisible: true, routeAndHistoryVerified: true },
      sessionsScrollCapture: "mobile-sessions-scroll-capture.json",
      sessionsScrollInputEvidence,
      profileSwitch: { actualSettingsSwitch: true, oldARowAbsentBeforeBFirstPageRelease: true, oldAErrorAbsentBeforeBFirstPageRelease: true, BRouteAndHistoryVerified: true },
      calls: { mutationRpcCount: ledger.mutatingRequestCount, historyAliasesRead, pageErrorCount, consoleErrorCount },
      http: ledger.http,
      rpcEvents: ledger.events,
      droppedEvents: ledger.droppedEvents,
      sourcePins,
    });
  } catch (error) {
    if (sessionsScrollCapture && !sessionsScrollEvidence) {
      try {
        sessionsScrollEvidence = await finishSessionsScrollCapture(sessionsScrollCapture, "failure");
        sessionsScrollEvidence.cursorLedger = sessionsCursorLedger(ledger,
          PREVIEW_SESSIONS_MODE ? "preview-sessions-next-page" : undefined);
        sessionsScrollEvidence.inputEvidence = sessionsScrollInputEvidence;
        await context.writeArtifactJson("mobile-sessions-scroll-capture.json", sessionsScrollEvidence);
      } catch (captureError) {
        sessionsScrollEvidence = { schemaVersion: 1, status: "capture-read-failed", errorName: safeErrorName(captureError) };
      }
    }
    await context.writeArtifactJson("mobile-home-sessions-static04-local-dom-failure.json", {
      schemaVersion: 1,
      status: "failed",
      phase: phases.current,
      errorName: safeErrorName(error),
      previewSourceRoot: PREVIEW_SESSIONS_MODE ? resolve(EXPLICIT_PREVIEW_SOURCE_ROOT) : null,
      previewSourceCommit: PREVIEW_SESSIONS_MODE ? PREVIEW_SOURCE_COMMIT : null,
      rpcEvents: ledger.events,
      previewHomeWorkspaceScopes: PREVIEW_SESSIONS_MODE ? summarizePreviewHomeWorkspaceScopes(ledger.events, ledger.sockets) : null,
      http: ledger.http,
      droppedEvents: ledger.droppedEvents,
      malformedFrameCount: ledger.malformedFrameCount,
      unknownRpcResponseCount: ledger.unknownRpcResponseCount,
      mutatingRequestCount: ledger.mutatingRequestCount,
      fixtureErrorCount: ledger.fixtureErrorCount,
      gatewayForwardedResponseCount: ledger.gatewayForwardedResponseCount,
      browserFixtureOverlayResponseCount: ledger.browserFixtureOverlayResponseCount,
      sockets: ledger.sockets.map(safeSocketEvidence),
      historyAliasesRead: [...new Set(ledger.historyReadThreadIds.map(historyAlias))].sort(),
      errorSummary: error?.message === "Timed out waiting for slow Sessions cursor request held after an actual list scroll"
        ? CURRENT_OFFICIAL_DIST_MODE
          ? "Timed out waiting for the Sessions slow-cursor hold after trusted touch input"
          : "Timed out waiting for the Sessions slow-cursor hold after browser wheel input"
        : safeErrorName(error),
      sessionsCursorLedger: ledger.events.filter(event =>
        event.phase === (PREVIEW_SESSIONS_MODE ? "preview-sessions-next-page" : "sessions-a-first-pages-and-held-peer-cursor") &&
        event.method === "thread/list"),
      sessionsScrollCapture: sessionsScrollEvidence ? "mobile-sessions-scroll-capture.json" : null,
      sessionsScrollCaptureErrorName: sessionsScrollEvidence?.status === "capture-read-failed" ? sessionsScrollEvidence.errorName : null,
      sessionsScrollInputEvidence,
      pageErrorCount,
      consoleErrorCount,
      sourcePins,
      previewProductSourcePinsBefore,
    });
    throw error;
  } finally {
    phases.homeSlowDiscovery.release("cleanup");
    phases.homeFastCursor.release("cleanup");
    phases.sessionsSlowCursor.release("cleanup");
    phases.profileBFirstPage.release("cleanup");
    phases.previewSessionsNextPage.release("cleanup");
  }
});

async function installRpcFixture(page, context, { gatewayA, gatewayB, roleForOrigin, phases, ledger, workspaceByTarget, record }) {
  await page.routeWebSocket("**/rpc*", routed => {
    const socketOrdinal = ++ledger.nextSocketOrdinal;
    let role = null;
    let serverId = "unknown";
    let workspaceAlias = "default";
    try {
      const url = new URL(typeof routed.url === "function" ? routed.url() : routed.url);
      role = roleForOrigin(url.origin);
      serverId = url.searchParams.get("server") ?? "unknown";
      const workspace = url.searchParams.get("workspace");
      if (workspace) workspaceAlias = Object.keys(workspaceByTarget).find(key => workspaceByTarget[key] === workspace) ?? "other";
      else if (workspaceByTarget[`${role}/${serverId}`]) workspaceAlias = `${role}/${serverId}`;
    } catch { ledger.malformedFrameCount += 1; }
    const socketState = {
      socketOrdinal,
      role: role ?? "foreign",
      server: SERVER_ALIASES[serverId] ?? "unknown",
      browserClosed: false,
      gatewayClosed: false,
      closeForwardFailed: false,
    };
    ledger.sockets.push(socketState);
    record({ kind: "websocket-open", direction: "page-to-gateway", role: socketState.role, server: socketState.server, socketOrdinal });
    const upstream = routed.connectToServer();
    const outstanding = new Map();
    let closed = false;
    const closeForwardState = { started: false };
    routed.onClose((code, reason) => {
      closed = true;
      socketState.browserClosed = true;
      record({ kind: "websocket-close", direction: "page-to-gateway", side: "browser", role: socketState.role, server: socketState.server, socketOrdinal, closeCode: Number.isInteger(code) ? code : null, closeReasonByteLength: typeof reason === "string" ? Buffer.byteLength(reason, "utf8") : null });
      forwardCloseOnce(closeForwardState, upstream, "browser", "gateway", code, reason, event => record({ ...event, role: socketState.role, server: socketState.server, socketOrdinal }), socketState);
    });
    upstream.onClose((code, reason) => {
      closed = true;
      socketState.gatewayClosed = true;
      record({ kind: "websocket-close", direction: "gateway-to-page", side: "gateway", role: socketState.role, server: socketState.server, socketOrdinal, closeCode: Number.isInteger(code) ? code : null, closeReasonByteLength: typeof reason === "string" ? Buffer.byteLength(reason, "utf8") : null });
      forwardCloseOnce(closeForwardState, routed, "gateway", "browser", code, reason, event => record({ ...event, role: socketState.role, server: socketState.server, socketOrdinal }), socketState);
    });
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
        outstanding.set(key, { id: frame.id, method, params: isRecord(frame.params) ? frame.params : {}, role, serverId, workspaceAlias, socketOrdinal });
        if (MUTATING_METHODS.has(method)) ledger.mutatingRequestCount += 1;
        record({ kind: "rpc-request", direction: "client-to-server", role: role ?? "foreign", server: SERVER_ALIASES[serverId] ?? "unknown", workspace: workspaceAlias, method: safeMethod(method), requestIdFingerprint: shortHash(key), hasCursor: Boolean(frame.params?.cursor), socketOrdinal });
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
      const responseProvenance = PREVIEW_SESSIONS_MODE && ["runtime.workspaces.list", "runtime.worktrees.list", "thread/list", "thread/read"].includes(request.method)
        ? "browser-bridge-fixture-overlay-after-owned-gateway-response"
        : "owned-gateway-response-forwarded";
      if (responseProvenance === "browser-bridge-fixture-overlay-after-owned-gateway-response") ledger.browserFixtureOverlayResponseCount += 1;
      else ledger.gatewayForwardedResponseCount += 1;
      record({ kind: action.held ? "held-response-released" : "rpc-response", direction: "server-to-client", role: request.role ?? "foreign", server: SERVER_ALIASES[request.serverId] ?? "unknown", workspace: request.workspaceAlias, method: safeMethod(request.method), requestIdFingerprint: shortHash(rpcKey(request.id)), responseShape: Object.hasOwn(action.frame, "error") ? "error" : "result", responseProvenance, hasNextCursor: request.method === "thread/list" && isRecord(action.frame.result) && typeof action.frame.result.nextCursor === "string" && action.frame.result.nextCursor.length > 0, held: action.held, socketOrdinal: request.socketOrdinal });
      routed.send(JSON.stringify(action.frame));
    });
  });
}

async function shapeOrHoldResponse(response, request, phases, workspaceByTarget, ledger, closed) {
  const { role, serverId, method, params } = request;
  let held = false;
  if (PREVIEW_SESSIONS_MODE && method === "thread/list") {
    const page = fixturePage(phases.current, role, serverId, params, workspaceByTarget);
    if (!page) {
      ledger.fixtureErrorCount += 1;
      return {
        frame: { jsonrpc: "2.0", id: response.id, error: { code: -32190, message: "preview fixture rejected an unexpected thread/list request" } },
        held,
      };
    }
    if (page.gate) {
      const gate = phases[page.gate];
      assert.ok(gate, `preview fixture gate ${page.gate} must exist`);
      gate.held = true;
      if (page.gate === "previewSessionsNextPage") ledger.held.previewSessionsNextPage = true;
      recordForGate(ledger, phases, "held-response", role, serverId, method, response.id, request.socketOrdinal);
      await gate.promise;
      held = true;
      if (closed) return { frame: response, held };
    }
    response.result = {
      ...(isRecord(response.result) ? response.result : {}),
      threads: page.threads,
      nextCursor: page.nextCursor ?? null,
      completeness: "complete",
      issueCount: 0,
    };
    return { frame: response, held };
  }
  if (method === "runtime.workspaces.list" && role === "A" && serverId === "slow-A" && phases.current === "home-a-fast-first-peer-and-cursor-held" && !phases.homeSlowDiscovery.released) {
    phases.homeSlowDiscovery.held = true;
    ledger.held.homeSlowDiscovery = true;
    recordForGate(ledger, phases, "held-response", role, serverId, method, response.id, request.socketOrdinal);
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
    const page = fixturePage(phases.current, role, serverId, params, workspaceByTarget);
    if (page) {
      if (page.gate) {
        const gate = phases[page.gate];
        gate.held = true;
        if (page.gate === "homeFastCursor") ledger.held.homeFastCursor = true;
        if (page.gate === "sessionsSlowCursor") ledger.held.sessionsSlowCursor = true;
        if (page.gate === "profileBFirstPage") ledger.held.profileBFirstPage = true;
        recordForGate(ledger, phases, "held-response", role, serverId, method, response.id, request.socketOrdinal);
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

function fixturePage(phase, role, serverId, params, workspaceByTarget = WORKSPACES) {
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  if (phase === "preview-home-first-pages" && role === "A" && serverId === "fast-A" && !cursor)
    return { threads: [threadSummary("A_HOME_PREVIEW_FIRST", "A Home preview first", workspaceByTarget["A/fast-A"])], nextCursor: "preview-home-fast-next" };
  if (phase === "preview-home-first-pages" && role === "A" && serverId === "slow-A" && !cursor)
    return { threads: [threadSummary("A_HOME_PREVIEW_PEER", "A Home preview peer", workspaceByTarget["A/slow-A"])], nextCursor: null };
  if (phase === "preview-sessions-first-page" && role === "A" && serverId === "fast-A" && !cursor) {
    const threads = [threadSummary("A_SESSIONS_PREVIEW_FIRST", "A Sessions preview first", workspaceByTarget["A/fast-A"])];
    for (let index = 1; index < 12; index += 1)
      threads.push(threadSummary(`A_SESSIONS_PREVIEW_FILL_${String(index).padStart(2, "0")}`, `A Sessions preview row ${index}`, workspaceByTarget["A/fast-A"]));
    return { threads, nextCursor: "preview-sessions-fast-next" };
  }
  if (phase === "preview-sessions-next-page" && role === "A" && serverId === "fast-A" && cursor === "preview-sessions-fast-next")
    return { threads: [threadSummary("A_SESSIONS_PREVIEW_MORE", "A Sessions preview later", workspaceByTarget["A/fast-A"])], nextCursor: null, gate: "previewSessionsNextPage" };
  if (phase === "home-a-fast-first-peer-and-cursor-held" && role === "A" && serverId === "fast-A") {
    if (!cursor) return { threads: [threadSummary("A_HOME_FIRST", "A fast first", workspaceByTarget["A/fast-A"])], nextCursor: "home-fast-cursor" };
    if (cursor === "home-fast-cursor") return { threads: [threadSummary("A_HOME_MORE", "A fast later", workspaceByTarget["A/fast-A"])], nextCursor: null, gate: "homeFastCursor" };
  }
  if (phase === "sessions-a-first-pages-and-held-peer-cursor" && role === "A" && (serverId === "fast-A" || serverId === "slow-A")) {
    const prefix = serverId === "fast-A" ? "A_SESSIONS_FAST" : "A_SESSIONS_SLOW";
    if (!cursor) {
      const workspace = workspaceByTarget[`A/${serverId}`];
      return { threads: Array.from({ length: 8 }, (_value, index) => threadSummary(`${prefix}_${index}`, `${prefix} ${index}`, workspace)), nextCursor: `${prefix}_CURSOR` };
    }
    if (cursor === "A_SESSIONS_FAST_CURSOR" && serverId === "fast-A")
      return { threads: [threadSummary("A_SESSIONS_FAST_MORE", "A fast more", workspaceByTarget["A/fast-A"])], nextCursor: null };
    if (cursor === "A_SESSIONS_SLOW_CURSOR" && serverId === "slow-A")
      return { threads: [threadSummary("A_SESSIONS_SLOW_MORE", "A slow more", workspaceByTarget["A/slow-A"])], nextCursor: null, gate: "sessionsSlowCursor" };
  }
  if ((phase === "profile-b-bootstrap" || phase === "settings-a-to-b-owner-switch-with-b-first-page-held") && role === "B" && serverId === "fast-B" && !cursor) {
    if (phase === "settings-a-to-b-owner-switch-with-b-first-page-held")
      return { threads: [threadSummary("B_AFTER_SWITCH_FIRST", "B after switch", workspaceByTarget["B/fast-B"])], nextCursor: null, gate: "profileBFirstPage" };
    return { threads: [threadSummary("B_BOOTSTRAP_FIRST", "B bootstrap", workspaceByTarget["B/fast-B"])], nextCursor: null };
  }
  if (phase === "profile-a-after-b-bootstrap" && role === "A" && serverId === "fast-A" && !cursor)
    return { threads: [threadSummary("A_HOME_FIRST", "A fast first", workspaceByTarget["A/fast-A"])], nextCursor: null };
  return null;
}

async function verifySourcePins(pins = SOURCE_PINS) {
  const observed = {};
  for (const [relativePath, expected] of Object.entries(pins)) {
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

async function verifyPreviewProductSourcePins() {
  const sourceRoot = resolve(EXPLICIT_PREVIEW_SOURCE_ROOT);
  assert.equal(await realpath(sourceRoot), sourceRoot, "preview source root must be canonical and existing");
  const relativeSourceRoot = relative(repoRoot, sourceRoot);
  assert.match(relativeSourceRoot, /^target[\\/]mobile-web-source-[a-f0-9]+$/, "preview source root must be an explicit detached source snapshot under target");
  const rootStat = await lstat(sourceRoot);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "preview source root must be a real directory");
  const observedCommit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(observedCommit, PREVIEW_SOURCE_COMMIT, "preview source root Git commit differs from the explicit bundle source pin");
  const expectedPins = {
    "apps/kcoder-studio/mobile/src/app/h/[profileId]/index.tsx": PREVIEW_HOME_SOURCE_SHA256,
    "apps/kcoder-studio/mobile/src/app/sessions.tsx": PREVIEW_SESSIONS_SOURCE_SHA256,
  };
  const observed = {};
  for (const [relativePath, expected] of Object.entries(expectedPins)) {
    const file = resolve(sourceRoot, relativePath);
    assert.equal(await realpath(file), file, `frozen preview source must be canonical: ${relativePath}`);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `frozen preview source must be a regular file: ${relativePath}`);
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    assert.equal(digest, expected, `frozen preview source changed: ${relativePath}`);
    observed[relativePath] = digest;
  }
  return { gitCommit: observedCommit, files: observed };
}

async function runPreviewSessionsFlow(page, profile, phases, ledger, {
  homeViewAllTestId,
  onScrollInput,
  onScrollCapture,
  onScrollEvidence,
  serverDefinitions,
  workspaceByTarget,
  abortSignal,
}) {
  const expectedHomeScopes = serverDefinitions.map(definition => {
    const workspaceMatches = Object.entries(workspaceByTarget).filter(([, workspacePath]) => workspacePath === definition.workspace);
    assert.equal(workspaceMatches.length, 1, `server ${definition.id} must map to exactly one workspaceByTarget entry`);
    return {
      role: "A",
      serverId: definition.id,
      serverLabel: definition.label,
      server: SERVER_ALIASES[definition.id],
      workspaceAlias: workspaceMatches[0][0],
    };
  });
  assert.deepEqual(expectedHomeScopes.map(({ serverId, serverLabel, server, workspaceAlias }) => ({ serverId, serverLabel, server, workspaceAlias })), [
    { serverId: "fast-A", serverLabel: "Fast A", server: "A-fast", workspaceAlias: "A/fast-A" },
    { serverId: "slow-A", serverLabel: "Slow A", server: "A-slow", workspaceAlias: "A/slow-A" },
  ], "Home mock server id/label, request alias, and workspaceByTarget key must stay aligned");
  const homeFastScope = expectedHomeScopes.find(scope => scope.serverId === "fast-A");
  const homeSlowScope = expectedHomeScopes.find(scope => scope.serverId === "slow-A");
  assert.ok(homeFastScope && homeSlowScope, "Home must define its fast and slow server IDs");
  assert.equal(homeViewAllTestId, `view-all-home-threads-${homeFastScope.serverId}`,
    "Home View All test ID must select the expected server ID, not its display alias");

  const homeRows = ["thread-A_HOME_PREVIEW_FIRST", "thread-A_HOME_PREVIEW_PEER"];
  for (const testId of homeRows) await visible(page, testId).waitFor({ state: "visible", timeout: 30_000 });
  await visible(page, homeViewAllTestId).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await visible(page, `view-all-home-threads-${homeSlowScope.serverId}`).count(), 0,
    "the no-cursor peer scope must not expose a View All CTA");

  const homeRequests = ledger.events.filter(event => event.phase === "preview-home-first-pages" && event.kind === "rpc-request" && event.method === "thread/list");
  assert.equal(homeRequests.length, 2, "Home must request exactly one first page for each of its two fixture scopes");
  for (const scope of expectedHomeScopes) {
    assert.equal(typeof scope.server, "string", `server ${scope.serverId} must have a ledger alias`);
    const requests = homeRequests.filter(event => event.role === scope.role && event.server === scope.server);
    assert.equal(requests.length, 1, `Home must request one first page for ${scope.serverLabel} (${scope.serverId})`);
    assert.equal(requests[0].hasCursor, false, `Home ${scope.serverLabel} request must start without a cursor`);
    assert.equal(requests[0].workspace, scope.workspaceAlias,
      `Home ${scope.serverLabel} request must use the workspaceByTarget key for ${scope.serverId}`);
  }
  const homeFastRequest = homeRequests.find(event => event.role === homeFastScope.role && event.server === homeFastScope.server);
  const homeSlowRequest = homeRequests.find(event => event.role === homeSlowScope.role && event.server === homeSlowScope.server);
  assert.ok(homeFastRequest?.socketOrdinal && homeSlowRequest?.socketOrdinal && homeFastRequest.socketOrdinal !== homeSlowRequest.socketOrdinal,
    "the two Home scopes must have separately attributable WebSocket owners");
  for (const request of homeRequests) {
    assert.ok(ledger.events.some(event => event.phase === "preview-home-first-pages" && event.kind === "rpc-request" &&
      event.method === "initialize" && event.socketOrdinal === request.socketOrdinal),
    `Home scope socket ${request.socketOrdinal} must initialize before its first page`);
    const response = ledger.events.filter(event => event.phase === "preview-home-first-pages" && event.kind === "rpc-response" &&
      event.method === "thread/list" && event.server === request.server && event.socketOrdinal === request.socketOrdinal);
    assert.equal(response.length, 1, `Home ${request.server} must receive exactly one fixture first-page response`);
    assert.equal(response[0].hasNextCursor, request.server === homeFastScope.server,
      `Home ${request.server} cursor preview must match its configured fixture page`);
  }
  assert.equal(homeRequests.some(event => event.hasCursor), false, "Home must not fetch a later page after previewing the cursor");
  await waitForOwnedSocketsClosed(ledger, [homeFastRequest.socketOrdinal, homeSlowRequest.socketOrdinal], abortSignal,
    "both Home first-page WebSocket owners to close before route navigation");
  const finalHomeRequests = ledger.events.filter(event => event.phase === "preview-home-first-pages" && event.kind === "rpc-request" && event.method === "thread/list");
  assert.equal(finalHomeRequests.length, 2, "Home must not retry or duplicate either scope while its preview sockets close");
  assert.ok(ledger.sockets.every(socket => socket.role === "A" && expectedHomeScopes.some(scope => scope.server === socket.server)),
    "the isolated preview fixture must observe only its two owned Gateway scopes");

  phases.current = "preview-sessions-first-page";
  await visible(page, homeViewAllTestId).click();
  await waitFor(() => {
    try {
      const url = new URL(page.url());
      return url.pathname.endsWith("/sessions") && url.searchParams.get("profileId") === profile.id && url.searchParams.get("serverId") === homeFastScope.serverId;
    } catch { return false; }
  }, 30_000, "Home View All to navigate to Sessions with the exact profile and server", 50, abortSignal);

  const sessionsList = visible(page, "sessions-list");
  await sessionsList.waitFor({ state: "visible", timeout: 30_000 });
  await visible(page, "session-A_SESSIONS_PREVIEW_FIRST").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(250);
  const sessionRequestsBeforeTouch = ledger.events.filter(event => event.phase === "preview-sessions-first-page" && event.kind === "rpc-request" && event.method === "thread/list");
  assert.equal(sessionRequestsBeforeTouch.length, 1, "Sessions must load exactly one first page before trusted touch");
  const sessionsFirstRequest = sessionRequestsBeforeTouch[0];
  assert.equal(sessionsFirstRequest.role, "A");
  assert.equal(sessionsFirstRequest.server, homeFastScope.server, "Sessions first page must stay scoped to the server selected by Home");
  assert.equal(sessionsFirstRequest.hasCursor, false, "a fresh Sessions owner must start at the first page, without Home's cursor");
  assert.ok(![homeFastRequest.socketOrdinal, homeSlowRequest.socketOrdinal].includes(sessionsFirstRequest.socketOrdinal),
    "Sessions must use a fresh WebSocket owner after the Home preview sockets close");
  assert.ok(ledger.events.some(event => event.phase === "preview-sessions-first-page" && event.kind === "rpc-request" &&
    event.method === "initialize" && event.socketOrdinal === sessionsFirstRequest.socketOrdinal),
  "fresh Sessions owner must initialize its new socket");
  const sessionsFirstResponses = ledger.events.filter(event => event.phase === "preview-sessions-first-page" && event.kind === "rpc-response" &&
    event.method === "thread/list" && event.socketOrdinal === sessionsFirstRequest.socketOrdinal);
  assert.equal(sessionsFirstResponses.length, 1, "fresh Sessions owner must receive one first-page response");
  assert.equal(sessionsFirstResponses[0].hasNextCursor, true, "the Sessions fixture first page must advertise a later page");
  assert.equal(await visible(page, "session-A_SESSIONS_PREVIEW_FILL_11").count(), 1,
    "the first Sessions page must include enough real rows to create a scrollable list");
  const beforeTouchMetrics = await sessionsList.evaluate(element => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert.ok(beforeTouchMetrics.scrollHeight > beforeTouchMetrics.clientHeight,
    "the rendered Sessions first page must have a real scroll range before touch input");
  assert.equal(beforeTouchMetrics.scrollTop, 0, "the fresh Sessions list must start at its top before touch input");
  assert.equal(sessionRequestsBeforeTouch.some(event => event.hasCursor), false,
    "no cursor page may be requested before the trusted touch phase");

  phases.current = "preview-sessions-next-page";
  const sessionsScrollInputEvidence = createSessionsTouchInputEvidence();
  onScrollInput(sessionsScrollInputEvidence);
  const capture = await scrollListWithTrustedTouch(page, sessionsList, sessionsScrollInputEvidence,
    value => onScrollCapture(value), abortSignal);
  await waitFor(() => phases.previewSessionsNextPage.held, 30_000,
    "trusted touch to request the fresh Sessions owner's next cursor page", 50, abortSignal);
  const nextPageRequest = ledger.events.find(event => event.phase === "preview-sessions-next-page" && event.kind === "rpc-request" &&
    event.method === "thread/list" && event.hasCursor);
  assert.ok(nextPageRequest, "trusted touch must issue a cursor-bearing Sessions page request");
  assert.equal(nextPageRequest.socketOrdinal, sessionsFirstRequest.socketOrdinal,
    "the next page must use the fresh Sessions owner that supplied its first page");
  const sessionPageRequests = ledger.events.filter(event => event.phase === "preview-sessions-next-page" && event.kind === "rpc-request" && event.method === "thread/list");
  assert.equal(sessionPageRequests.length, 1, "the touch phase must issue exactly one cursor-page request");
  assert.equal(await visible(page, "session-A_SESSIONS_PREVIEW_FIRST").count(), 1,
    "the original Sessions row must remain mounted while the next-page response is held");
  await visible(page, "sessions-page-loading").waitFor({ state: "visible", timeout: 10_000 });
  const heldNextPage = ledger.events.find(event => event.phase === "preview-sessions-next-page" && event.kind === "held-response" &&
    event.method === "thread/list" && event.socketOrdinal === sessionsFirstRequest.socketOrdinal);
  assert.ok(heldNextPage, "the fresh owner must hold the fixture cursor response while preserving existing rows");
  onScrollEvidence(await finishSessionsScrollCapture(capture, "preview-next-page-held"));
  phases.previewSessionsNextPage.release("complete");
  await visible(page, "session-A_SESSIONS_PREVIEW_MORE").waitFor({ state: "visible", timeout: 30_000 });
  await visible(page, "sessions-page-loading").waitFor({ state: "hidden", timeout: 30_000 });
  assert.equal(await visible(page, "session-A_SESSIONS_PREVIEW_FIRST").count(), 1,
    "the original Sessions row must remain mounted after the next page is appended");
  const afterTouchMetrics = await sessionsList.evaluate(element => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert.ok(afterTouchMetrics.scrollHeight >= beforeTouchMetrics.scrollHeight,
    "appending the next page must retain or increase rendered Sessions scroll content");
  const completedNextPage = ledger.events.find(event => event.phase === "preview-sessions-next-page" && event.kind === "held-response-released" &&
    event.method === "thread/list" && event.socketOrdinal === sessionsFirstRequest.socketOrdinal);
  assert.ok(completedNextPage, "the fixture must deliver the held next-page response on the live Sessions owner");
  phases.current = "preview-complete";

  return {
    home: {
      firstPageRowsVisible: true,
      firstPageScopes: expectedHomeScopes.map(scope => scope.server),
      exactlyOneFirstPagePerScope: true,
      noCursorPageRequested: true,
      fastPageHadCursorForViewAll: true,
      bothFirstPageOwnersClosedBeforeNavigation: true,
      socketOrdinals: { fast: homeFastRequest.socketOrdinal, slow: homeSlowRequest.socketOrdinal },
    },
    sessions: {
      urlProfileExact: true,
      urlServerExact: homeFastScope.serverId,
      freshOwnerSocketOrdinal: sessionsFirstRequest.socketOrdinal,
      freshOwnerFirstPageWithoutCursor: true,
      nextPageRequestedAfterTrustedTouch: true,
      originalRowsRetainedWhileHeldAndAfterAppend: true,
      appendedRowVisible: true,
      nextPageUsedSameSessionsOwner: true,
      beforeTouchMetrics,
      afterTouchMetrics,
      cursorRequestSocketOrdinal: nextPageRequest.socketOrdinal,
    },
  };
}

async function waitForOwnedSocketsClosed(ledger, ordinals, abortSignal, description) {
  await waitFor(() => ordinals.every(socketOrdinal => {
    const socket = ledger.sockets.find(item => item.socketOrdinal === socketOrdinal);
    return socket?.browserClosed === true && socket?.gatewayClosed === true;
  }), 15_000, description, 50, abortSignal);
  for (const socketOrdinal of ordinals) {
    const socket = ledger.sockets.find(item => item.socketOrdinal === socketOrdinal);
    assert.equal(socket.closeForwardFailed, false, `socket ${socketOrdinal} close must forward without fixture error`);
  }
}

function safeSocketEvidence(socket) {
  return {
    socketOrdinal: socket.socketOrdinal,
    role: socket.role,
    server: socket.server,
    browserClosed: socket.browserClosed,
    gatewayClosed: socket.gatewayClosed,
    closeForwardFailed: socket.closeForwardFailed,
  };
}

function summarizePreviewHomeWorkspaceScopes(events, sockets) {
  const homeEvents = events.filter(event => event.phase === "preview-home-first-pages");
  const requestEvents = homeEvents.filter(event => event.kind === "rpc-request");
  const requestsByScope = new Map();
  for (const event of requestEvents) {
    const workspaceAlias = event.workspace ?? "unknown";
    const key = JSON.stringify([event.server, workspaceAlias]);
    const scope = requestsByScope.get(key) ?? { server: event.server, workspaceAlias, requests: [] };
    scope.requests.push(event);
    requestsByScope.set(key, scope);
  }
  const socketByOrdinal = new Map(sockets.map(socket => [socket.socketOrdinal, safeSocketEvidence(socket)]));
  const scopes = [...requestsByScope.values()].sort((left, right) =>
    left.server.localeCompare(right.server) || left.workspaceAlias.localeCompare(right.workspaceAlias)).map(scope => {
    const socketOrdinals = [...new Set(scope.requests.map(event => event.socketOrdinal))].sort((left, right) => left - right);
    const responses = homeEvents.filter(event => event.kind === "rpc-response" && event.server === scope.server && event.workspace === scope.workspaceAlias);
    const countRequests = method => scope.requests.filter(event => event.method === method).length;
    return {
      server: scope.server,
      workspaceAlias: scope.workspaceAlias,
      socketOrdinals,
      sockets: socketOrdinals.map(socketOrdinal => socketByOrdinal.get(socketOrdinal) ?? null),
      initializeRequestCount: countRequests("initialize"),
      workspaceListRequestCount: countRequests("runtime.workspaces.list"),
      worktreeListRequestCount: countRequests("runtime.worktrees.list"),
      threadListFirstPageRequestCount: scope.requests.filter(event => event.method === "thread/list" && event.hasCursor !== true).length,
      threadListCursorRequestCount: scope.requests.filter(event => event.method === "thread/list" && event.hasCursor === true).length,
      threadListResponseCount: responses.filter(event => event.method === "thread/list").length,
    };
  });
  const threadListRequests = homeEvents.filter(event => event.kind === "rpc-request" && event.method === "thread/list");
  return {
    partition: "server + observed workspace alias mapped to the run-owned default workspace path; diagnostic only",
    totalThreadListRequestCount: threadListRequests.length,
    totalFirstPageThreadListRequestCount: threadListRequests.filter(event => event.hasCursor !== true).length,
    totalCursorThreadListRequestCount: threadListRequests.filter(event => event.hasCursor === true).length,
    scopes,
  };
}

function forwardCloseOnce(state, target, fromSide, toSide, code, reason, record, socketState) {
  if (state.started) return;
  state.started = true;
  const legalCode = Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999));
  const reasonBytes = typeof reason === "string" ? Buffer.byteLength(reason, "utf8") : null;
  const legalReason = legalCode && typeof reason === "string" && reasonBytes <= 123;
  record({ kind: "websocket-close-forward", fromSide, toSide, closeCode: Number.isInteger(code) ? code : null, closeCodeForwarded: legalCode, closeReasonByteLength: reasonBytes, closeReasonForwarded: legalReason });
  const recordFailure = error => {
    socketState.closeForwardFailed = true;
    record({ kind: "websocket-close-forward-failed", fromSide, toSide, errorName: safeErrorName(error) });
  };
  try {
    void Promise.resolve(target.close({ ...(legalCode ? { code } : {}), ...(legalReason ? { reason } : {}) }))
      .catch(recordFailure);
  } catch (error) {
    recordFailure(error);
  }
}

async function connectProfileFromLogin(page, gateway) {
  if (CURRENT_OFFICIAL_DIST_MODE) {
    const mobileUrl = new URL("/mobile/", gateway.baseUrl);
    await page.goto(mobileUrl.toString(), { waitUntil: "domcontentloaded" });
    assert.equal(new URL(page.url()).origin, new URL(gateway.baseUrl).origin, "current Mobile Web must load from the owned Gateway origin");
    assert.equal(new URL(page.url()).pathname, "/mobile/", "current official dist must use the mounted Mobile Web route");
  } else {
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
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

async function waitForTaskRoute(context, page, profileId, serverId, threadId, cwd, title) {
  const mountPrefix = CURRENT_OFFICIAL_DIST_MODE ? "/mobile" : "";
  const expectedPath = mountPrefix + "/h/" + encodeURIComponent(profileId) + "/task/" +
    encodeURIComponent(serverId) + "/" + encodeURIComponent(threadId);
  const expected = { profileId, serverId, threadId, cwd, title, mountPrefix };
  try {
    await waitFor(() => {
      try {
        const url = new URL(page.url());
        return url.pathname === expectedPath && url.searchParams.get("cwd") === cwd && url.searchParams.get("title") === title;
      } catch { return false; }
    }, 15_000, "exact Mobile task route profile/server/thread/cwd/title", 50);
  } catch (error) {
    let route;
    try { route = safeTaskRouteEvidence(page.url(), expected); }
    catch (captureError) { route = { parseable: false, captureErrorName: safeErrorName(captureError) }; }
    let screenshot = { status: "skipped", reason: "not-checked" };
    try {
      const credentialFieldVisible = await page.locator(
        'input[type="password"]:visible, input[name="token"]:visible, [data-testid="gateway-token"]:visible',
      ).count() > 0;
      const welcomeVisible = await page.locator('[data-testid="welcome-direct-connection"]:visible').count() > 0;
      if (credentialFieldVisible || welcomeVisible) {
        screenshot = { status: "skipped", reason: "welcome-or-credential-field-visible" };
      } else {
        const name = "mobile-task-route-failure.png";
        await page.screenshot({ path: context.pathInArtifacts(name), fullPage: false });
        screenshot = { status: "captured", artifact: name, sensitiveInputVisible: false, welcomeVisible: false };
      }
    } catch (captureError) {
      screenshot = { status: "failed", errorName: safeErrorName(captureError) };
    }
    try {
      await context.writeArtifactJson("mobile-task-route-failure-evidence.json", {
        schemaVersion: 1,
        scope: "safe Mobile task-route components only; no origin, token, or full URL",
        errorName: safeErrorName(error),
        expected: { mountPrefix, profileMatch: true, serverId, threadId, cwd, title },
        actual: route,
        screenshot,
      });
    } catch {
      // Preserve the original route assertion if diagnostic writing fails.
    }
    throw error;
  }
}

function safeTaskRouteEvidence(rawUrl, expected) {
  let url;
  try { url = new URL(rawUrl); }
  catch { return { parseable: false }; }
  const rawSegments = url.pathname.split("/").filter(Boolean);
  const decoded = rawSegments.map(segment => {
    try { return decodeURIComponent(segment); } catch { return null; }
  });
  const actualMountPrefix = decoded[0] === "mobile" ? "/mobile" : "";
  const segments = actualMountPrefix ? decoded.slice(1) : decoded;
  const isTaskRoute = segments[0] === "h" && segments[2] === "task" && segments.length >= 5;
  const actual = {
    parseable: true,
    routeKind: isTaskRoute ? "task" : actualMountPrefix ? "mobile-other" : "other",
    mountPrefix: actualMountPrefix,
    profileMatchesExpected: isTaskRoute && segments[1] === expected.profileId,
    serverId: isTaskRoute ? segments[3] : null,
    threadId: isTaskRoute ? segments[4] : null,
    cwd: url.searchParams.get("cwd"),
    title: url.searchParams.get("title"),
    hasAuthQueryParameter: url.searchParams.has("token") || url.searchParams.has("auth"),
    unrecordedQueryParameterCount: [...url.searchParams.keys()].filter(key => key !== "cwd" && key !== "title").length,
    fragmentPresent: url.hash.length > 0,
  };
  actual.matches = {
    path: url.pathname === expectedPath(expected),
    mountPrefix: actual.mountPrefix === expected.mountPrefix,
    profile: actual.profileMatchesExpected,
    serverId: actual.serverId === expected.serverId,
    threadId: actual.threadId === expected.threadId,
    cwd: actual.cwd === expected.cwd,
    title: actual.title === expected.title,
  };
  return actual;
}

function expectedPath({ mountPrefix, profileId, serverId, threadId }) {
  return mountPrefix + "/h/" + encodeURIComponent(profileId) + "/task/" +
    encodeURIComponent(serverId) + "/" + encodeURIComponent(threadId);
}

async function runTouchScrollCausalityDiagnostic(page, context) {
  const token = `touch-scroll-causality-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const controlId = `kcoder-touch-control-${token}`;
  const evidence = {
    classification: "DIAGNOSTIC_ONLY",
    status: "running",
    claimScope: "same-page trusted CDP touch against actual Sessions list and a temporary native overflow control; diagnostic only, not product pass, pagination, native-device, or performance evidence",
    input: {
      helper: "private local CDP diagnostic dispatcher, independent of shared browser-touch-input.mjs",
      sharedHelperSha256: "60e99fad3bd9d09aaac89cee8ff90cdc469edb5974c53183e08ae894a1706f65",
      gestures: 1,
      moves: 12,
      force: 0.8,
      browserAnimationFrameAfterEachMove: true,
      displacementCssPx: 45,
      domScrollOffsetWrites: 0,
      paginationActions: 0,
      sameInputShapeForBothCases: true,
    },
    cases: [],
    cleanup: { controlRemoved: false, observersRemoved: false, errors: [] },
  };
  let observerInstalled = false;
  try {
    const installed = await page.evaluate(({ token, controlId, eventLimit }) => {
      if (window.__kcoderTouchScrollCausality) return { status: "observer-already-installed" };
      const list = document.querySelector('[data-testid="sessions-list"]');
      if (!list) return { status: "sessions-list-not-found" };
      const round = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null;
      const describe = element => {
        if (!element || element.nodeType !== 1) return null;
        const control = document.getElementById(controlId);
        const testId = element.getAttribute("data-testid");
        return {
          tag: String(element.tagName).slice(0, 24),
          id: element.id && element.id.length <= 80 ? element.id : null,
          testId: testId && testId.length <= 120 ? testId : null,
          insideList: Boolean(list.contains(element)),
          insideControl: Boolean(control && (element === control || control.contains(element))),
        };
      };
      const metrics = element => {
        if (!element || element.nodeType !== 1) return null;
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return {
          ...describe(element),
          rect: { left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) },
          scrollTop: round(element.scrollTop), scrollHeight: Number(element.scrollHeight), clientHeight: Number(element.clientHeight),
          overflowX: style.overflowX, overflowY: style.overflowY, touchAction: style.touchAction,
          overscrollBehaviorY: style.overscrollBehaviorY, pointerEvents: style.pointerEvents,
          position: style.position, transform: style.transform, zIndex: style.zIndex,
        };
      };
      const ancestors = element => {
        const result = [];
        for (let current = element, depth = 0; current?.nodeType === 1 && depth < 10; current = current.parentElement, depth++)
          result.push(metrics(current));
        return result;
      };
      const events = [];
      let droppedEvents = 0;
      const push = event => {
        if (events.length >= eventLimit) { droppedEvents++; return; }
        events.push({ atPageMs: round(performance.now()), ...event });
      };
      const recordTouch = (event, phase) => {
        const point = event.changedTouches?.[0] ?? event.touches?.[0] ?? null;
        const hit = point ? document.elementFromPoint(point.clientX, point.clientY) : null;
        const path = typeof event.composedPath === "function"
          ? event.composedPath().filter(item => item?.nodeType === 1).slice(0, 8).map(describe)
          : [];
        push({
          kind: event.type, phase, isTrusted: Boolean(event.isTrusted), cancelable: Boolean(event.cancelable),
          defaultPrevented: Boolean(event.defaultPrevented), eventPhase: Number(event.eventPhase),
          target: describe(event.target), hit: describe(hit),
          clientX: point ? round(point.clientX) : null, clientY: point ? round(point.clientY) : null,
          composedPath: path,
          targetAncestors: event.type === "touchstart" ? ancestors(event.target) : null,
        });
      };
      const captureTouch = event => recordTouch(event, "window-capture");
      const bubbleTouch = event => recordTouch(event, "window-bubble");
      const captureScroll = event => {
        const target = event.target === document ? document.scrollingElement : event.target;
        push({
          kind: "scroll", phase: "document-capture", isTrusted: Boolean(event.isTrusted), target: metrics(target),
          pageOffset: { x: round(window.scrollX), y: round(window.scrollY) },
        });
      };
      const snapshot = (label, useControl = false) => {
        const control = document.getElementById(controlId);
        const target = useControl ? control : list;
        if (!target) return { status: "target-missing", label };
        const rect = target.getBoundingClientRect();
        const bounds = {
          left: Math.max(0, rect.left), top: Math.max(0, rect.top),
          right: Math.min(window.innerWidth, rect.right), bottom: Math.min(window.innerHeight, rect.bottom),
        };
        const x = Math.round(bounds.left + (bounds.right - bounds.left) / 2);
        const startY = Math.round(bounds.top + 90), endY = Math.round(bounds.top + 45);
        const hit = y => describe(document.elementFromPoint(x, y));
        return {
          status: "observed", label, atPageMs: round(performance.now()),
          viewport: {
            width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio,
            maxTouchPoints: navigator.maxTouchPoints, scrollX: round(window.scrollX), scrollY: round(window.scrollY),
          },
          list: metrics(list), listAncestors: ancestors(list.parentElement),
          target: metrics(target), targetAncestors: ancestors(target.parentElement),
          visibleIntersection: {
            left: round(bounds.left), top: round(bounds.top), right: round(bounds.right), bottom: round(bounds.bottom),
            width: round(bounds.right - bounds.left), height: round(bounds.bottom - bounds.top),
          },
          input: { start: { x, y: startY }, end: { x, y: endY } },
          hitStart: hit(startY), hitEnd: hit(endY),
          eventCount: events.length, droppedEvents,
        };
      };
      const touchTypes = ["touchstart", "touchmove", "touchend", "touchcancel"];
      for (const type of touchTypes) {
        window.addEventListener(type, captureTouch, { capture: true, passive: true });
        window.addEventListener(type, bubbleTouch, { capture: false, passive: true });
      }
      document.addEventListener("scroll", captureScroll, { capture: true, passive: true });
      window.__kcoderTouchScrollCausality = {
        token, controlId, list, events, maxEvents: eventLimit,
        get droppedEvents() { return droppedEvents; },
        cursor() { return { count: events.length, droppedEvents }; },
        readSince(cursor) { return { events: events.slice(cursor.count), droppedEventDelta: droppedEvents - cursor.droppedEvents, droppedEventTotal: droppedEvents }; },
        snapshot,
        addControl() {
          if (document.getElementById(controlId)) return { status: "control-already-exists" };
          const rect = list.getBoundingClientRect();
          const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
          const right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
          const width = right - left, height = bottom - top;
          if (!(width > 40 && height > 80)) return { status: "invalid-list-intersection", width: round(width), height: round(height) };
          const control = document.createElement("div");
          control.id = controlId;
          control.setAttribute("data-testid", "owned-touch-scroll-diagnostic-native-overflow");
          Object.assign(control.style, {
            position: "fixed", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
            boxSizing: "border-box", margin: "0", padding: "0", zIndex: "2147483647",
            overflowX: "hidden", overflowY: "auto", touchAction: "auto", overscrollBehaviorY: "contain",
            pointerEvents: "auto", background: "rgba(0, 96, 220, 0.08)", outline: "2px solid rgba(0, 70, 180, 0.7)",
          });
          const child = document.createElement("div");
          child.setAttribute("data-testid", "owned-touch-scroll-diagnostic-native-overflow-content");
          Object.assign(child.style, {
            height: `${Math.max(Math.ceil(height * 4), 1200)}px`, width: "100%", boxSizing: "border-box", padding: "12px",
            background: "linear-gradient(#eef6ff, #d7eaff)",
          });
          child.textContent = "Temporary native overflow touch control";
          control.appendChild(child);
          document.body.appendChild(control);
          return { status: "installed", snapshot: snapshot("native-overflow-control-installed", true) };
        },
        removeControl() {
          document.getElementById(controlId)?.remove();
          return document.getElementById(controlId) === null;
        },
        stop() {
          for (const type of touchTypes) {
            window.removeEventListener(type, captureTouch, true);
            window.removeEventListener(type, bubbleTouch, false);
          }
          document.removeEventListener("scroll", captureScroll, true);
        },
      };
      return { status: "capturing", initial: snapshot("before-sessions-touch"), eventLimit };
    }, { token, controlId, eventLimit: 192 });
    evidence.setup = installed;
    if (installed.status !== "capturing") {
      evidence.status = "INVALID_SETUP";
      return evidence;
    }
    observerInstalled = true;

    const product = await dispatchTouchScrollDiagnosticCase(page, context, token, {
      label: "actual-sessions-list", before: installed.initial, useControl: false, id: 181,
    });
    evidence.cases.push(product);

    const nativeSetup = await page.evaluate(({ token }) => {
      const observer = window.__kcoderTouchScrollCausality;
      if (observer?.token !== token) return { status: "observer-unavailable" };
      const result = observer.addControl();
      return { ...result, afterInstall: result.status === "installed" ? observer.snapshot("native-control-ready", true) : null };
    }, { token });
    evidence.nativeControlSetup = nativeSetup;
    if (nativeSetup.status === "installed") {
      evidence.cases.push(await dispatchTouchScrollDiagnosticCase(page, context, token, {
        label: "temporary-native-overflow-control", before: nativeSetup.afterInstall, useControl: true, id: 182,
      }));
    } else {
      evidence.cases.push({ label: "temporary-native-overflow-control", status: "INVALID_SETUP", setup: nativeSetup });
    }
    evidence.comparison = classifyTouchScrollDiagnosticCases(evidence.cases);
    evidence.status = evidence.cases.every(item => item.status === "observed") ? "observations-complete" : "partial-observations";
  } catch (error) {
    evidence.status = "diagnostic-error";
    evidence.error = { name: safeErrorName(error), message: safeDiagnosticErrorMessage(error) };
  } finally {
    if (observerInstalled) {
      try {
        const cleanup = await page.evaluate(({ token }) => {
          const observer = window.__kcoderTouchScrollCausality;
          if (observer?.token !== token) return { observerFound: false, controlRemoved: !document.querySelector('[data-testid="owned-touch-scroll-diagnostic-native-overflow"]') };
          const controlRemoved = observer.removeControl();
          observer.stop();
          delete window.__kcoderTouchScrollCausality;
          return { observerFound: true, controlRemoved, observersRemoved: true };
        }, { token });
        evidence.cleanup.controlRemoved = cleanup.controlRemoved === true;
        evidence.cleanup.observersRemoved = cleanup.observersRemoved === true;
        if (!cleanup.observerFound || !cleanup.controlRemoved || !cleanup.observersRemoved)
          evidence.cleanup.errors.push({ name: "CleanupIncomplete", observerFound: cleanup.observerFound ?? null, controlRemoved: cleanup.controlRemoved ?? null, observersRemoved: cleanup.observersRemoved ?? null });
      } catch (error) {
        evidence.cleanup.errors.push({ name: safeErrorName(error), message: safeDiagnosticErrorMessage(error) });
      }
    } else {
      evidence.cleanup.controlRemoved = true;
      evidence.cleanup.observersRemoved = true;
    }
    if (evidence.cleanup.errors.length) evidence.status += "-cleanup-failed";
  }
  return evidence;
}

async function dispatchTouchScrollDiagnosticCase(page, context, token, { label, before, useControl, id }) {
  const result = { label, status: "INVALID_SETUP", before, input: null, after: null, events: [], error: null };
  try {
    const setup = await page.evaluate(({ token, useControl }) => {
      const observer = window.__kcoderTouchScrollCausality;
      if (observer?.token !== token) return { status: "observer-unavailable" };
      const snapshot = observer.snapshot("touch-input-preflight", useControl);
      const target = useControl ? document.getElementById(observer.controlId) : observer.list;
      return {
        status: snapshot.status,
        snapshot,
        scrollRange: Boolean(target && target.scrollHeight > target.clientHeight + 1),
      };
    }, { token, useControl });
    result.setup = setup;
    if (setup.status !== "observed" || !setup.scrollRange) return result;
    const hitOk = useControl
      ? setup.snapshot.hitStart?.insideControl === true && setup.snapshot.hitEnd?.insideControl === true
      : setup.snapshot.hitStart?.insideList === true && setup.snapshot.hitEnd?.insideList === true;
    const input = setup.snapshot.input;
    if (!hitOk || !input || input.start.y === input.end.y || setup.snapshot.visibleIntersection.height <= 80) return result;
    const cursor = await page.evaluate(({ token }) => {
      const observer = window.__kcoderTouchScrollCausality;
      return observer?.token === token ? observer.cursor() : null;
    }, { token });
    if (!cursor) { result.status = "observer-unavailable"; return result; }
    result.status = "dispatching";
    result.input = { ...input, moves: 12, force: 0.8, id, helper: "dispatchDiagnosticTouchDrag", browserAnimationFrameAfterEachMove: true, domScrollOffsetWrites: 0 };
    result.dispatch = await dispatchDiagnosticTouchDrag(page, {
      start: input.start, end: input.end, moves: 12, force: 0.8, id,
    }, context.abortSignal);
    const settle = await page.evaluate(async ({ token, useControl }) => {
      const observer = window.__kcoderTouchScrollCausality;
      if (observer?.token !== token) return { stable: false, reason: "observer-unavailable" };
      const target = () => useControl ? document.getElementById(observer.controlId) : observer.list;
      let previous = target()?.scrollTop ?? null, stableFrames = 0;
      for (let frame = 0; frame < 45; frame++) {
        await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
        const current = target()?.scrollTop ?? null;
        if (Number.isFinite(current) && Number.isFinite(previous) && Math.abs(current - previous) < 0.5) stableFrames++;
        else stableFrames = 0;
        previous = current;
        if (stableFrames >= 3) return { stable: true, stableFrames, scrollTop: current };
      }
      return { stable: false, stableFrames, scrollTop: target()?.scrollTop ?? null };
    }, { token, useControl });
    const observed = await page.evaluate(({ token, cursor, useControl }) => {
      const observer = window.__kcoderTouchScrollCausality;
      if (observer?.token !== token) return null;
      return {
        after: observer.snapshot("after-touch", useControl),
        ...observer.readSince(cursor),
      };
    }, { token, cursor, useControl });
    result.after = observed?.after ?? null;
    result.events = observed?.events ?? [];
    result.droppedEventDelta = observed?.droppedEventDelta ?? null;
    result.droppedEventTotal = observed?.droppedEventTotal ?? null;
    result.settle = settle;
    const initialTop = Number(setup.snapshot.target?.scrollTop);
    const finalTop = Number(result.after?.target?.scrollTop);
    result.scrollDelta = Number.isFinite(initialTop) && Number.isFinite(finalTop) ? Math.round((finalTop - initialTop) * 100) / 100 : null;
    result.status = observed ? "observed" : "observer-unavailable-after-input";
  } catch (error) {
    result.status = "input-or-observation-error";
    result.error = { name: safeErrorName(error), message: safeDiagnosticErrorMessage(error) };
  }
  return result;
}

async function dispatchDiagnosticTouchDrag(page, { start, end, moves, force, id }, signal) {
  if (![start?.x, start?.y, end?.x, end?.y, force].every(Number.isFinite) ||
      !Number.isInteger(moves) || moves !== 12 || !Number.isInteger(id) || id < 0)
    throw new TypeError("diagnostic touch drag requires finite points and force, exactly 12 moves, and a nonnegative id");
  const cdp = await page.context().newCDPSession(page);
  let primaryError = null;
  let ended = false;
  const stepTimesMs = [];
  const startedAt = performance.now();
  try {
    if (signal?.aborted) throw signal.reason || new Error("Diagnostic touch aborted before touchstart");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: start.x, y: start.y, id, force }],
    });
    for (let index = 1; index <= moves; index++) {
      if (signal?.aborted) throw signal.reason || new Error("Diagnostic touch aborted during touchmove");
      const beforeStep = performance.now();
      const progress = index / moves;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{
          x: start.x + (end.x - start.x) * progress,
          y: start.y + (end.y - start.y) * progress,
          id,
          force,
        }],
      });
      await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => resolveFrame(true))));
      stepTimesMs.push(Math.round((performance.now() - beforeStep) * 100) / 100);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    ended = true;
  } catch (error) {
    primaryError = error;
  } finally {
    if (!ended) {
      try {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } catch (cleanupError) {
        primaryError = primaryError
          ? new AggregateError([primaryError, cleanupError], "diagnostic touch and touchend cleanup failed", { cause: primaryError })
          : cleanupError;
      }
    }
    try {
      await cdp.detach();
    } catch (cleanupError) {
      primaryError = primaryError
        ? new AggregateError([primaryError, cleanupError], "diagnostic touch and CDP detach failed", { cause: primaryError })
        : cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  return {
    status: "dispatched", start, end, moves, force,
    browserAnimationFrameAfterEachMove: true,
    stepTimesMs,
    dispatchWallMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

function classifyTouchScrollDiagnosticCases(cases) {
  const product = cases.find(item => item.label === "actual-sessions-list");
  const control = cases.find(item => item.label === "temporary-native-overflow-control");
  const moved = item => item?.status === "observed" && Number.isFinite(item.scrollDelta) && item.scrollDelta > 0;
  if (!product || !control || product.status !== "observed" || control.status !== "observed") return "INCOMPLETE_DIAGNOSTIC";
  if (moved(product) && moved(control)) return "BOTH_SCROLLED_WITH_SHARED_INPUT";
  if (!moved(product) && moved(control)) return "NATIVE_CONTROL_SCROLLED_PRODUCT_LIST_DID_NOT";
  if (!moved(product) && !moved(control)) return "NEITHER_SCROLLED_INPUT_OR_ANCESTOR_CHAIN_REMAINS_SUSPECT";
  return "PRODUCT_LIST_SCROLLED_NATIVE_CONTROL_DID_NOT";
}

function safeDiagnosticErrorMessage(error) {
  return String(error?.message ?? error ?? "Unknown diagnostic error")
    .slice(0, 300)
    .replace(/\b(?:https?|wss?):\/\/[^\s"']+/gi, "[url]")
    .replace(/\b(token|authorization|access_token|refresh_token)=([^\s&]+)/gi, "$1=[redacted]");
}

async function scrollListWithBrowserInput(page, list) {
  await list.scrollIntoViewIfNeeded();
  const box = await list.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "Sessions list must have a visible scroll box");
  const capture = await startSessionsScrollCapture(page, "before-browser-wheel").catch(error => ({
    schemaVersion: 1,
    status: "capture-install-failed",
    errorName: safeErrorName(error),
    async sample() { return null; },
    async finish() { return this; },
  }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, Math.max(1200, box.height * 3));
  await capture.sample("after-browser-wheel-return").catch(() => null);
  return capture;
}

function createSessionsTouchInputEvidence() {
  return {
    schemaVersion: 1,
    status: "running",
    method: "owned Chromium CDP Input.dispatchTouchEvent; no DOM offset writes and no direct load-more call",
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    gesture: {
      scrollProofCssPx: 45,
      scrollProofFromVisibleTop: { start: 90, end: 45 },
      continuationFromVisibleCentralRow: {
        rowSelector: "session-A_SESSIONS_PREVIEW_FILL_*",
        blankEdgeInsetCssPx: 8,
        endInsetFromTop: 24,
        verticalDisplacement: "computed from the chosen row center to list top + 24px; per-step value recorded and shorter than the prior 452px gesture",
      },
      moves: 12,
      force: 0.8,
      waitForAnimationFrameAfterEachMove: true,
      minimumInterGestureDelayMs: 250,
      requireStableScrollBeforeContinuation: true,
      maximumGestures: 6,
      coordinateSpace: "CSS pixels",
    },
    firstTouchScrollGate: null,
    interGestureWaits: [],
    steps: [],
    droppedEvents: null,
    final: null,
  };
}

async function scrollListWithTrustedTouch(page, list, evidence, onCapture, signal) {
  assert.equal(await list.isVisible(), true, "Sessions list must be visible before trusted touch input");
  let capture;
  try {
    capture = await startSessionsScrollCapture(page, "before-trusted-touch");
  } catch (error) {
    evidence.status = "capture-install-failed";
    evidence.errorName = safeErrorName(error);
    throw error;
  }
  onCapture(capture);
  evidence.captureStatus = capture.status;
  try {
    assert.equal(capture.status, "capturing", "bounded touch evidence capture must install before input");

    const initial = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
    }));
    evidence.actualViewport = initial;
    assert.equal(initial.width, 390, "current Sessions touch fixture requires the approved 390 CSS-pixel viewport");
    assert.equal(initial.height, 844, "current Sessions touch fixture requires the approved 844 CSS-pixel viewport");
    assert.equal(initial.deviceScaleFactor, 3, "current Sessions touch fixture requires DPR 3");
    assert.ok(initial.maxTouchPoints > 0, "Chromium must expose touch capability before trusted touch input");

    const maximumGestures = 6;
    for (let index = 0; index < maximumGestures; index += 1) {
      if (index > 0) {
        const waitStartedAt = performance.now();
        await page.waitForTimeout(250);
        const stableScroll = await page.evaluate(async () => {
          const list = document.querySelector('[data-testid="sessions-list"]');
          if (!list) return { stable: false, reason: "sessions-list-missing", scrollTop: null };
          let previous = list.scrollTop;
          let stableFrames = 0;
          for (let frame = 0; frame < 30; frame += 1) {
            await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
            const current = list.scrollTop;
            stableFrames = Math.abs(current - previous) < 0.5 ? stableFrames + 1 : 0;
            previous = current;
            if (stableFrames >= 3) return { stable: true, stableFrames, scrollTop: current };
          }
          return { stable: false, stableFrames, scrollTop: list.scrollTop };
        });
        const interGestureWait = {
          afterGesture: index,
          minimumDelayMs: 250,
          elapsedWaitMs: Math.round((performance.now() - waitStartedAt) * 10) / 10,
          stableScroll,
        };
        evidence.interGestureWaits.push(interGestureWait);
        assert.equal(stableScroll.stable, true, `Sessions list must have a stable scroll offset before touch gesture ${index + 1}`);
      }
      const smallScrollProof = index === 0;
      const setup = await page.evaluate(({ smallScrollProof, centralRowTextTargetDiagnostic }) => {
        const list = document.querySelector('[data-testid="sessions-list"]');
        if (!list) return { status: "sessions-list-missing" };
        const rect = list.getBoundingClientRect();
        const round = value => Math.round(Number(value) * 100) / 100;
        const visible = {
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          right: Math.min(innerWidth, rect.right),
          bottom: Math.min(innerHeight, rect.bottom),
        };
        const centerX = Math.round(visible.left + (visible.right - visible.left) / 2);
        const describe = element => element && element.nodeType === 1
          ? { tag: element.tagName, testId: element.getAttribute("data-testid") || null }
          : null;
        const point = (x, y) => {
          const hit = document.elementFromPoint(x, y);
          return {
            x,
            y,
            inViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
            inScrollport: x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom,
            hit: describe(hit),
            hitInsideScrollport: Boolean(hit && list.contains(hit)),
          };
        };

        let startX = centerX;
        let startY = Math.round(visible.top + 90);
        let centralRowAnchor = null;
        let textTargetControl = null;
        if (!smallScrollProof) {
          const rowSelector = '[data-testid^="session-A_SESSIONS_PREVIEW_FILL_"]';
          const fullyVisibleRows = [...list.querySelectorAll(rowSelector)]
            .map(row => ({ row, rect: row.getBoundingClientRect(), testId: row.getAttribute("data-testid") }))
            .filter(({ rect: rowRect }) => rowRect.height > 0 && rowRect.top >= visible.top && rowRect.bottom <= visible.bottom)
            .sort((left, right) =>
              Math.abs((left.rect.top + left.rect.bottom) / 2 - (visible.top + visible.bottom) / 2) -
              Math.abs((right.rect.top + right.rect.bottom) / 2 - (visible.top + visible.bottom) / 2));
          const chosen = fullyVisibleRows[0];
          if (chosen) {
            const row = chosen.row;
            const rowRect = chosen.rect;
            const rowCenterY = Math.round((rowRect.top + rowRect.bottom) / 2);
            const textRects = [];
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
              if (!textNode.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(textNode);
              for (const textRect of range.getClientRects()) {
                if (textRect.width > 0 && textRect.height > 0) textRects.push(textRect);
              }
            }
            const edgeInset = 8;
            const edgePoints = [
              { side: "left-blank-edge", x: Math.round(rowRect.left + edgeInset) },
              { side: "right-blank-edge", x: Math.round(rowRect.right - edgeInset) },
            ].map(candidate => {
              const hit = document.elementFromPoint(candidate.x, rowCenterY);
              const path = [];
              let node = hit;
              let reachedRow = false;
              while (node) {
                const style = getComputedStyle(node);
                const nodeRect = node.getBoundingClientRect();
                path.push({
                  ...describe(node),
                  rect: {
                    left: round(nodeRect.left), top: round(nodeRect.top),
                    right: round(nodeRect.right), bottom: round(nodeRect.bottom),
                    width: round(nodeRect.width), height: round(nodeRect.height),
                  },
                  overflowX: style.overflowX,
                  overflowY: style.overflowY,
                  touchAction: style.touchAction,
                });
                if (node === row) {
                  reachedRow = true;
                  break;
                }
                node = node.parentElement;
              }
              const pointOverText = textRects.some(textRect =>
                candidate.x >= textRect.left && candidate.x < textRect.right &&
                rowCenterY >= textRect.top && rowCenterY < textRect.bottom);
              const hasHiddenOverflowAncestor = path.some(item => item.overflowX === "hidden" || item.overflowY === "hidden");
              const targetKind = hit === row ? "session-row" : hit?.tagName === "DIV" ? "plain-view" : "other";
              const accepted = Boolean(hit && row.contains(hit) && reachedRow &&
                (targetKind === "session-row" || targetKind === "plain-view") &&
                !hasHiddenOverflowAncestor && !pointOverText);
              return {
                side: candidate.side,
                x: candidate.x,
                y: rowCenterY,
                hit: describe(hit),
                targetKind,
                hitWithinChosenRow: Boolean(hit && row.contains(hit)),
                reachedChosenRow: reachedRow,
                pointOverText,
                hasHiddenOverflowAncestor,
                path,
                accepted,
              };
            });
            const selected = edgePoints.find(candidate => candidate.accepted) ?? null;
            centralRowAnchor = {
              rowTestId: chosen.testId,
              rowRect: {
                left: round(rowRect.left), top: round(rowRect.top),
                right: round(rowRect.right), bottom: round(rowRect.bottom),
                width: round(rowRect.width), height: round(rowRect.height),
              },
              fullyVisible: true,
              viewportCenterY: round((visible.top + visible.bottom) / 2),
              rowCenterY,
              edgeInsetCssPx: edgeInset,
              edgePoints,
              selectedSide: selected?.side ?? null,
              selectedX: selected?.x ?? null,
              selectedHit: selected?.hit ?? null,
              targetKind: selected?.targetKind ?? null,
              pointOverText: selected?.pointOverText ?? null,
              hasHiddenOverflowAncestor: selected?.hasHiddenOverflowAncestor ?? null,
              accepted: Boolean(selected),
            };
            if (selected) {
              startX = selected.x;
              startY = selected.y;
            }
            if (centralRowTextTargetDiagnostic) {
              const x = 195;
              const hit = document.elementFromPoint(x, rowCenterY);
              const hitRect = hit?.getBoundingClientRect();
              const hitStyle = hit ? getComputedStyle(hit) : null;
              const safeInset = hitRect ? Math.min(x - hitRect.left, hitRect.right - x, rowCenterY - hitRect.top, hitRect.bottom - rowCenterY) : -Infinity;
              const geometryMatches = chosen.testId === "session-A_SESSIONS_PREVIEW_FILL_04" && selected?.x === 24 && rowCenterY === 601 && Math.round(visible.top + 24) === 368;
              const hitsOverflowHiddenText = Boolean(hit && hit !== row && row.contains(hit) && String(hit.textContent ?? "").trim() && (hitStyle?.overflowX === "hidden" || hitStyle?.overflowY === "hidden") && safeInset >= 4);
              textTargetControl = {
                baselineBlankEdgeX: selected?.x ?? null, targetX: x, targetY: rowCenterY,
                rowTestId: chosen.testId, hit: describe(hit),
                hitRect: hitRect ? { left: round(hitRect.left), top: round(hitRect.top), right: round(hitRect.right), bottom: round(hitRect.bottom) } : null,
                overflowX: hitStyle?.overflowX ?? null, overflowY: hitStyle?.overflowY ?? null,
                safeInsetCssPx: Number.isFinite(safeInset) ? round(safeInset) : null,
                geometryMatches, hitsOverflowHiddenText,
                accepted: geometryMatches && hitsOverflowHiddenText,
              };
              if (textTargetControl.accepted) startX = x;
            }
          }
        }

        const endY = Math.round(smallScrollProof ? visible.top + 45 : visible.top + 24);
        const style = getComputedStyle(list);
        const hasUsableAnchor = smallScrollProof || (centralRowTextTargetDiagnostic ? textTargetControl?.accepted === true : centralRowAnchor?.accepted === true);
        return {
          status: hasUsableAnchor ? "ready" : centralRowTextTargetDiagnostic ? "INVALID_SETUP" : "central-visible-session-row-edge-not-ready",
          viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints },
          scrollport: {
            left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom),
            width: round(rect.width), height: round(rect.height),
            scrollTop: round(list.scrollTop), scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
            overflowY: style.overflowY, touchAction: style.touchAction,
          },
          viewportIntersection: {
            left: round(visible.left), top: round(visible.top), right: round(visible.right), bottom: round(visible.bottom),
            width: round(visible.right - visible.left), height: round(visible.bottom - visible.top),
          },
          gestureKind: smallScrollProof ? "45-css-pixel-scroll-proof" : "central-visible-session-row-blank-edge-continuation",
          centralRowAnchor,
          textTargetControl,
          requestedVerticalDisplacementCssPx: round(startY - endY),
          start: point(startX, startY),
          end: point(startX, endY),
        };
      }, { smallScrollProof, centralRowTextTargetDiagnostic: CENTRAL_ROW_TEXT_TARGET_DIAGNOSTIC && index === 1 });

      const step = {
        index: index + 1,
        status: "preflight",
        setup,
        input: {
          kind: "trusted CDP touch drag",
          start: { x: setup.start?.x ?? null, y: setup.start?.y ?? null },
          end: { x: setup.end?.x ?? null, y: setup.end?.y ?? null },
          requestedVerticalDisplacementCssPx: setup.requestedVerticalDisplacementCssPx ?? null,
          centralRowAnchor: setup.centralRowAnchor ?? null,
          moves: 12,
          force: 0.8,
          waitForAnimationFrameAfterEachMove: true,
          domOffsetWrites: 0,
        },
      };
      evidence.steps.push(step);
      assert.equal(setup.status, "ready", "Sessions touch target geometry must be available");
      assert.ok(setup.scrollport.width > 0 && setup.scrollport.height > 0, "Sessions scrollport must have visible geometry");
      assert.ok(setup.viewportIntersection.width > 0 && setup.viewportIntersection.height > 0, "Sessions scrollport must intersect the actual mobile viewport");
      assert.ok(setup.scrollport.scrollHeight > setup.scrollport.clientHeight + 1, "Sessions list must have a real scroll range before touch");
      assert.notEqual(setup.start.y, setup.end.y, "touch drag endpoints must differ within the visible Sessions scrollport");
      for (const name of ["start", "end"]) {
        assert.equal(setup[name].inViewport, true, `touch ${name} point must be inside the mobile viewport`);
        assert.equal(setup[name].inScrollport, true, `touch ${name} point must be inside the Sessions scrollport`);
        assert.equal(setup[name].hitInsideScrollport, true, `touch ${name} hit-test must resolve inside the Sessions scrollport`);
      }
      if (!smallScrollProof && setup.textTargetControl) {
        assert.equal(setup.textTargetControl.accepted, true, "INVALID_SETUP: second touch must hit the safe interior of FILL04 overflow-hidden Text at x195, y601");
        assert.deepEqual([setup.start.x, setup.start.y, setup.end.y, setup.requestedVerticalDisplacementCssPx], [195, 601, 368, 233], "text-target control must change only x and preserve y601→368 / 233px");
      } else if (!smallScrollProof) {
        assert.equal(setup.centralRowAnchor?.fullyVisible, true,
          "continuation touch must start on a completely visible central Sessions row");
        assert.equal(setup.centralRowAnchor?.accepted, true,
          "continuation touch must hit a non-text blank edge on the selected Sessions row");
        assert.ok(["session-row", "plain-view"].includes(setup.centralRowAnchor?.targetKind),
          "continuation touch must hit the Sessions row or a plain View within it");
        assert.equal(setup.centralRowAnchor?.pointOverText, false,
          "continuation touch must start outside rendered text");
        assert.equal(setup.centralRowAnchor?.hasHiddenOverflowAncestor, false,
          "continuation touch target path must not include overflow:hidden");
        assert.ok(Number.isFinite(setup.requestedVerticalDisplacementCssPx) && setup.requestedVerticalDisplacementCssPx > 0,
          "central-row continuation must record its actual requested vertical displacement");
      }

      const cursor = await capture.eventCursor();
      assert.ok(Number.isInteger(cursor?.eventCount) && Number.isInteger(cursor?.droppedEvents), "bounded scroll event cursor must be readable before touch");
      step.status = "dispatching";
      step.eventCursorBefore = cursor;
      step.dispatch = await dispatchTrustedTouchDrag(page, {
        start: { x: setup.start.x, y: setup.start.y },
        end: { x: setup.end.x, y: setup.end.y },
        moves: 12,
        force: 0.8,
        waitForAnimationFrame: true,
        id: 73 + index,
      }, signal);
      step.dispatchCompleted = true;

      const settle = await page.evaluate(async () => {
        const list = document.querySelector('[data-testid="sessions-list"]');
        if (!list) return { stable: false, reason: "sessions-list-missing" };
        let previous = list.scrollTop;
        let stableFrames = 0;
        for (let frame = 0; frame < 30; frame += 1) {
          await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
          const current = list.scrollTop;
          stableFrames = Math.abs(current - previous) < 0.5 ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 3) return { stable: true, stableFrames, scrollTop: current };
        }
        return { stable: false, stableFrames, scrollTop: list.scrollTop };
      });
      const observed = await capture.readSince(`after-trusted-touch-${index + 1}`, cursor);
      step.status = "observed";
      step.settle = settle;
      step.after = observed.sample?.list ?? null;
      step.events = observed.events.map(event => ({
        atPageMs: Number.isFinite(event.atPageMs) ? event.atPageMs : null,
        kind: event.kind,
        isTrusted: event.isTrusted,
        targetInsideList: event.targetInsideList ?? null,
        hitInsideList: event.hitInsideList ?? null,
        target: event.target ?? event.eventTarget ?? null,
        hitTarget: event.hitTarget ?? null,
        clientX: event.clientX ?? null,
        clientY: event.clientY ?? null,
        cancelable: event.cancelable ?? null,
        defaultPreventedAtCapture: event.defaultPreventedAtCapture ?? null,
        defaultPreventedAfterBubble: event.defaultPreventedAfterBubble ?? null,
        defaultPreventedAfterDispatch: event.defaultPreventedAfterDispatch ?? null,
        bubbleReachedWindow: event.bubbleReachedWindow ?? null,
        touchPathToSessionsList: event.touchPathToSessionsList ?? null,
      }));
      step.droppedEventDelta = observed.droppedEventDelta;
      const touchEvents = observed.events.filter(event => ["touchstart", "touchmove", "touchend", "touchcancel"].includes(event.kind));
      const trustedListTouches = touchEvents.filter(event => event.isTrusted && event.targetInsideList);
      const trustedListTouchHits = touchEvents.filter(event => event.isTrusted && event.hitInsideList);
      const scrollEvents = observed.events.filter(event => event.kind === "scroll" && event.isTrusted && event.targetInsideList);
      const beforeTop = setup.scrollport.scrollTop;
      const afterTop = Number(step.after?.scrollTop);
      const afterHeight = Number(step.after?.scrollHeight);
      const afterClientHeight = Number(step.after?.clientHeight);
      step.scroll = {
        beforeTop,
        afterTop: Number.isFinite(afterTop) ? afterTop : null,
        delta: Number.isFinite(afterTop) ? Math.round((afterTop - beforeTop) * 100) / 100 : null,
        afterScrollHeight: Number.isFinite(afterHeight) ? afterHeight : null,
        afterClientHeight: Number.isFinite(afterClientHeight) ? afterClientHeight : null,
        trustedTouchStartCount: trustedListTouches.filter(event => event.kind === "touchstart").length,
        trustedTouchMoveCount: trustedListTouches.filter(event => event.kind === "touchmove").length,
        trustedTouchEndCount: trustedListTouches.filter(event => event.kind === "touchend").length,
        trustedTouchCancelCount: trustedListTouches.filter(event => event.kind === "touchcancel").length,
        trustedTouchHitInsideListCount: trustedListTouchHits.length,
        trustedScrollInsideListCount: scrollEvents.length,
      };
      if (index > 0) {
        const previousTouchEnd = evidence.steps[index - 1].events.findLast(event => event.kind === "touchend");
        const currentTouchStart = step.events.find(event => event.kind === "touchstart");
        const gapMs = Number(previousTouchEnd?.atPageMs) && Number(currentTouchStart?.atPageMs)
          ? Math.round((currentTouchStart.atPageMs - previousTouchEnd.atPageMs) * 10) / 10
          : null;
        step.interGestureTiming = {
          minimumDelayMs: 250,
          touchEndToNextTouchStartMs: gapMs,
          stableScrollBeforeGesture: evidence.interGestureWaits[index - 1]?.stableScroll?.stable === true,
        };
        assert.ok(Number.isFinite(gapMs) && gapMs >= 250,
          `trusted touch gesture ${index + 1} must start at least 250ms after the preceding touchend`);
        assert.equal(step.interGestureTiming.stableScrollBeforeGesture, true,
          `trusted touch gesture ${index + 1} must start after a stable Sessions scroll offset`);
      }
      evidence.droppedEvents = observed.droppedEventTotal;
      evidence.final = {
        scrollTop: Number.isFinite(afterTop) ? afterTop : null,
        scrollHeight: Number.isFinite(afterHeight) ? afterHeight : null,
        clientHeight: Number.isFinite(afterClientHeight) ? afterClientHeight : null,
      };

      assert.equal(step.droppedEventDelta, 0, "touch evidence must not overflow the bounded event collector");
      assert.equal(step.scroll.trustedTouchStartCount, 1, "each touch drag must dispatch one trusted in-list touchstart");
      assert.equal(step.dispatch.dispatchedMoves, 12, "each touch drag must send twelve CDP touchmove updates");
      assert.ok(step.scroll.trustedTouchMoveCount > 0, "browser must observe trusted touchmove events from the CDP updates");
      assert.equal(step.scroll.trustedTouchEndCount, 1, "each touch drag must dispatch one trusted in-list touchend");
      assert.equal(step.scroll.trustedTouchCancelCount, 0, "touch drag must not be cancelled by another target");
      assert.equal(trustedListTouches.length, touchEvents.length, "every observed touch event must target the Sessions list");
      assert.equal(step.scroll.trustedTouchHitInsideListCount, touchEvents.length, "every observed trusted touch point must hit the visible Sessions list");
      assert.ok(step.scroll.trustedScrollInsideListCount > 0, "touch drag must produce an observed trusted Sessions-list scroll event");
      assert.equal(settle.stable, true, "list scroll offset must settle before measuring each touch step");
      assert.ok(Number.isFinite(afterTop) && afterTop > beforeTop, "actual Sessions scrollTop must increase after each trusted drag");
      if (smallScrollProof) {
        evidence.firstTouchScrollGate = {
          passed: step.scroll.trustedTouchStartCount === 1 && step.scroll.trustedTouchMoveCount > 0 &&
            step.scroll.trustedTouchEndCount === 1 && step.scroll.trustedTouchCancelCount === 0 &&
            step.scroll.trustedScrollInsideListCount > 0 && Number.isFinite(afterTop) && afterTop > beforeTop,
          start: step.input.start,
          end: step.input.end,
          requestedMoves: step.dispatch.dispatchedMoves,
          observedTouchMoves: step.scroll.trustedTouchMoveCount,
          trustedScrollEvents: step.scroll.trustedScrollInsideListCount,
          scrollTopBefore: beforeTop,
          scrollTopAfter: afterTop,
        };
        assert.equal(evidence.firstTouchScrollGate.passed, true, "the first short trusted touch must demonstrably scroll the real Sessions list before cursor/pagination gates");
      }

      const atBottom = afterTop + afterClientHeight >= afterHeight - 3;
      step.atBottom = atBottom;
      if (atBottom) {
        evidence.status = "scrolled-to-bottom";
        evidence.completedGestures = index + 1;
        evidence.final = { scrollTop: afterTop, scrollHeight: afterHeight, clientHeight: afterClientHeight };
        evidence.droppedEvents = observed.droppedEventTotal;
        return capture;
      }
    }

    evidence.status = "touch-bound-reached-before-list-bottom";
    evidence.completedGestures = evidence.steps.length;
    const last = evidence.steps.at(-1)?.scroll;
    evidence.final = last ? {
      scrollTop: last.afterTop,
      scrollHeight: last.afterScrollHeight,
      clientHeight: last.afterClientHeight,
    } : null;
    throw new Error("Sessions list did not reach its real scroll end within six trusted touch drags");
  } catch (error) {
    if (evidence.status === "running") evidence.status = "failed";
    evidence.errorName = safeErrorName(error);
    throw error;
  }
}

async function startSessionsScrollCapture(page, initialLabel = "before-sessions-input") {
  const token = `sessions-scroll-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const installed = await page.evaluate(({ token, maxEvents, initialLabel }) => {
    const selector = '[data-testid="sessions-list"]';
    const list = document.querySelector(selector);
    if (!list) return { schemaVersion: 1, status: "capture-unavailable", reason: "sessions-list-not-found" };
    const describe = element => {
      if (!element || element.nodeType !== 1) return null;
      const testId = element.getAttribute("data-testid");
      return { tag: element.tagName, testId: testId && testId.length <= 120 ? testId : null };
    };
    const rectOf = element => {
      const rect = element?.getBoundingClientRect?.();
      return rect ? {
        left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom),
        width: round(rect.width), height: round(rect.height),
      } : null;
    };
    const metricsOf = element => {
      if (!element || element.nodeType !== 1) return null;
      const style = getComputedStyle(element);
      return {
        ...describe(element), rect: rectOf(element),
        scrollTop: round(element.scrollTop), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        overflowX: style.overflowX, overflowY: style.overflowY, touchAction: style.touchAction,
      };
    };
    const round = value => Math.round(Number(value) * 100) / 100;
    const scrollNodes = () => {
      const nodes = [];
      const seen = new Set();
      const add = element => {
        if (!element || element.nodeType !== 1 || seen.has(element) || nodes.length >= 16) return;
        seen.add(element);
        const value = metricsOf(element);
        const scrollable = value.scrollHeight > value.clientHeight + 1 || value.overflowY === "auto" || value.overflowY === "scroll";
        if (scrollable) nodes.push(value);
      };
      for (let element = list, depth = 0; element && depth < 12; element = element.parentElement, depth++) add(element);
      const descendants = list.querySelectorAll("*");
      for (let index = 0; index < Math.min(descendants.length, 256); index++) add(descendants[index]);
      add(document.scrollingElement);
      return { nodes, descendantScanLimit: 256, descendantCount: descendants.length };
    };
    const visibleRows = () => {
      const listRect = list.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const elements = [...list.querySelectorAll('[data-testid^="session-A_SESSIONS_"]')].slice(0, 32);
      const rows = elements.map(element => {
        const rect = element.getBoundingClientRect();
        const intersectsList = rect.right > listRect.left && rect.left < listRect.right && rect.bottom > listRect.top && rect.top < listRect.bottom;
        const intersectsViewport = rect.right > 0 && rect.left < viewport.width && rect.bottom > 0 && rect.top < viewport.height;
        return { testId: element.getAttribute("data-testid"), rect: rectOf(element), intersectsList, intersectsViewport };
      });
      return { totalMatchingRows: list.querySelectorAll('[data-testid^="session-A_SESSIONS_"]').length, rows };
    };
    const snapshot = label => ({
      label,
      atPageMs: round(performance.now()),
      viewport: {
        width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio,
        maxTouchPoints: navigator.maxTouchPoints, scrollX: round(window.scrollX), scrollY: round(window.scrollY),
      },
      list: { ...metricsOf(list), visibleRows: visibleRows() },
      scrollNodes: scrollNodes(),
    });
    const events = [];
    const touchEventRecords = new WeakMap();
    const touchEventReferences = [];
    let droppedEvents = 0;
    const push = value => {
      if (events.length >= maxEvents) { droppedEvents++; return null; }
      const record = { atPageMs: round(performance.now()), ...value };
      events.push(record);
      return record;
    };
    const touchPathToList = target => {
      const nodes = [];
      for (let element = target, depth = 0; element && element.nodeType === 1 && depth < 16; element = element.parentElement, depth++) {
        const style = getComputedStyle(element);
        nodes.push({
          ...describe(element),
          rect: rectOf(element),
          scrollTop: round(element.scrollTop), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
          overflowX: style.overflowX, overflowY: style.overflowY, touchAction: style.touchAction,
          isSessionsList: element === list,
        });
        if (element === list) break;
      }
      return { nodes, reachedSessionsList: nodes.some(node => node.isSessionsList) };
    };
    const onWheel = event => {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      push({
        kind: "wheel", isTrusted: event.isTrusted, deltaX: round(event.deltaX), deltaY: round(event.deltaY), deltaMode: event.deltaMode,
        clientX: round(event.clientX), clientY: round(event.clientY),
        eventTarget: describe(event.target), hitTarget: describe(hit),
        targetInsideList: Boolean(event.target && list.contains(event.target)), hitInsideList: Boolean(hit && list.contains(hit)),
      });
    };
    const onScroll = event => {
      const target = event.target === document ? document.scrollingElement : event.target;
      push({
        kind: "scroll",
        isTrusted: event.isTrusted,
        target: metricsOf(target),
        targetInsideList: Boolean(event.target && list.contains(event.target)),
      });
    };
    const onTouch = event => {
      const point = event.changedTouches?.[0] ?? event.touches?.[0] ?? null;
      const hit = point ? document.elementFromPoint(point.clientX, point.clientY) : null;
      const record = push({
        kind: event.type,
        isTrusted: event.isTrusted,
        cancelable: event.cancelable,
        defaultPreventedAtCapture: event.defaultPrevented,
        defaultPreventedAfterBubble: null,
        defaultPreventedAfterDispatch: null,
        bubbleReachedWindow: false,
        target: describe(event.target),
        targetInsideList: Boolean(event.target && list.contains(event.target)),
        clientX: point ? round(point.clientX) : null,
        clientY: point ? round(point.clientY) : null,
        hitTarget: describe(hit),
        hitInsideList: Boolean(hit && list.contains(hit)),
        touchPathToSessionsList: event.type === "touchstart" ? touchPathToList(event.target) : null,
      });
      if (record) {
        touchEventRecords.set(event, record);
        touchEventReferences.push({ event, record });
      }
    };
    const onTouchBubble = event => {
      const record = touchEventRecords.get(event);
      if (!record) return;
      record.bubbleReachedWindow = true;
      record.defaultPreventedAfterBubble = event.defaultPrevented;
      record.cancelable = event.cancelable;
    };
    const finalizeTouchEvents = () => {
      for (const { event, record } of touchEventReferences) {
        record.defaultPreventedAfterDispatch = event.defaultPrevented;
        record.cancelable = event.cancelable;
      }
    };
    const initial = snapshot(initialLabel);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    document.addEventListener("scroll", onScroll, true);
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      window.addEventListener(type, onTouch, { capture: true, passive: true });
      window.addEventListener(type, onTouchBubble, { capture: false, passive: true });
    }
    window.__kcoderSessionsScrollCapture = {
      token, events, get droppedEvents() { return droppedEvents; }, maxEvents, initial, snapshot, finalizeTouchEvents,
      stop() {
        window.removeEventListener("wheel", onWheel, true);
        document.removeEventListener("scroll", onScroll, true);
        for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
          window.removeEventListener(type, onTouch, true);
          window.removeEventListener(type, onTouchBubble, false);
        }
      },
    };
    return { schemaVersion: 1, status: "capturing", token, initial };
  }, { token, maxEvents: 256, initialLabel });

  if (installed.status !== "capturing")
    return {
      ...installed,
      async sample() { return null; },
      async eventCursor() { return null; },
      async readSince() { return { sample: null, events: [], droppedEventDelta: null, droppedEventTotal: null }; },
      async finish() { return this; },
    };

  const samples = [installed.initial];
  let finished = false;
  let result;
  return {
    schemaVersion: 1,
    status: "capturing",
    token,
    async sample(label) {
      if (finished) return null;
      const sample = await page.evaluate(({ token, label }) => {
        const capture = window.__kcoderSessionsScrollCapture;
        return capture?.token === token ? capture.snapshot(label) : null;
      }, { token, label });
      if (sample && samples.length < 10) samples.push(sample);
      return sample;
    },
    async eventCursor() {
      if (finished) return null;
      return await page.evaluate(({ token }) => {
        const capture = window.__kcoderSessionsScrollCapture;
        if (capture?.token !== token) return null;
        return { eventCount: capture.events.length, droppedEvents: capture.droppedEvents };
      }, { token });
    },
    async readSince(label, cursor) {
      if (finished || !cursor) return { sample: null, events: [], droppedEventDelta: null, droppedEventTotal: null };
      const observed = await page.evaluate(({ token, label, cursor }) => {
        const capture = window.__kcoderSessionsScrollCapture;
        if (capture?.token !== token) return null;
        capture.finalizeTouchEvents();
        return {
          sample: capture.snapshot(label),
          events: capture.events.slice(cursor.eventCount),
          droppedEventDelta: capture.droppedEvents - cursor.droppedEvents,
          droppedEventTotal: capture.droppedEvents,
        };
      }, { token, label, cursor });
      if (observed?.sample && samples.length < 10) samples.push(observed.sample);
      return observed ?? { sample: null, events: [], droppedEventDelta: null, droppedEventTotal: null };
    },
    async finish(stage) {
      if (finished) return result;
      finished = true;
      result = await page.evaluate(({ token, stage, samples }) => {
        const capture = window.__kcoderSessionsScrollCapture;
        if (!capture || capture.token !== token)
          return { schemaVersion: 1, status: "capture-document-unavailable", stage, samples };
        const final = capture.snapshot(`final-${stage}`);
        capture.finalizeTouchEvents();
        capture.stop();
        const output = {
          schemaVersion: 1, status: "captured", stage, maxEvents: capture.maxEvents, droppedEvents: capture.droppedEvents,
          trustedWheelCount: capture.events.filter(event => event.kind === "wheel" && event.isTrusted).length,
          trustedScrollCount: capture.events.filter(event => event.kind === "scroll" && event.isTrusted).length,
          trustedTouchStartCount: capture.events.filter(event => event.kind === "touchstart" && event.isTrusted).length,
          trustedTouchMoveCount: capture.events.filter(event => event.kind === "touchmove" && event.isTrusted).length,
          trustedTouchEndCount: capture.events.filter(event => event.kind === "touchend" && event.isTrusted).length,
          trustedTouchCancelCount: capture.events.filter(event => event.kind === "touchcancel" && event.isTrusted).length,
          trustedListScrollCount: capture.events.filter(event => event.kind === "scroll" && event.isTrusted && event.targetInsideList).length,
          cursorLedger: [], samples: [...samples, final], events: capture.events,
        };
        delete window.__kcoderSessionsScrollCapture;
        return output;
      }, { token, stage, samples });
      return result;
    },
  };
}

async function finishSessionsScrollCapture(capture, stage) {
  if (!capture) return null;
  return await capture.finish(stage);
}

function sessionsCursorLedger(ledger, phase = "sessions-a-first-pages-and-held-peer-cursor") {
  return ledger.events
    .filter(event => event.phase === phase && event.method === "thread/list")
    .map(({ atNodeMs, kind, role, server, hasCursor, held, requestIdFingerprint }) => ({
      atNodeMs,
      kind,
      role,
      server,
      hasCursor: hasCursor ?? null,
      held: held ?? null,
      requestIdFingerprint: requestIdFingerprint ?? null,
    }));
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

function recordForGate(ledger, phases, kind, role, serverId, method, id, socketOrdinal = null) {
  if (ledger.events.length >= MAX_RPC_EVENTS) { ledger.droppedEvents += 1; return; }
  ledger.events.push({ atNodeMs: performance.now(), phase: phases.current, kind, role, server: SERVER_ALIASES[serverId] ?? "unknown", method: safeMethod(method), requestIdFingerprint: shortHash(rpcKey(id)), ...(Number.isSafeInteger(socketOrdinal) ? { socketOrdinal } : {}) });
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

function parseCliOptions(args, flagOptions, valueOptions) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (flagOptions.has(option)) {
      assert.ok(!flags.has(option), `duplicate CLI flag: ${option}`);
      flags.add(option);
      continue;
    }
    if (valueOptions.has(option)) {
      assert.ok(!values.has(option), `duplicate CLI option: ${option}`);
      const value = args[index + 1];
      assert.ok(typeof value === "string" && value.length > 0 && !value.startsWith("--"), `${option} requires a value`);
      values.set(option, value);
      index += 1;
      continue;
    }
    throw new Error(`unrecognized private runner CLI option: ${option}`);
  }
  return { flags, values };
}
