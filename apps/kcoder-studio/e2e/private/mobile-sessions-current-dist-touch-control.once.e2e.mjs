import { createMobileSessionsCursorDiagnostic } from "../harness/mobile-sessions-cursor-diagnostic.mjs";
// One-shot current official Mobile Web Sessions touch diagnostic.
// The optional RNW control and cursor-page fixture run against an owned current
// Gateway snapshot. The Gateway uses KCODER_STUDIO_MOCK=1; this is not Rust,
// Provider, Relay, or device evidence.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { dispatchTrustedTouchDrag } from "../harness/browser-touch-input.mjs";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { copyOfficialMobileStaticDist, inspectOfficialMobileStaticDist } from "../harness/mobile-static-dist-input.mjs";
import { materializeMatchedMobileStaticDist } from "../harness/matched-mobile-static-dist.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { officialMobileExportReceiptFromEnv, readOfficialMobileExportReceipt, verifyOfficialMobileSourceSnapshot } from "../harness/official-mobile-export-receipt.mjs";

const RUN_FLAG = "KCODER_E2E_PRIVATE_CURRENT_MOBILE_SESSIONS_TOUCH";
const CLI_ARGUMENTS = process.argv.slice(2);
assert.ok(CLI_ARGUMENTS.length <= 1 && CLI_ARGUMENTS.every(argument => ["--row-gap-only", "--touch-shape-diagnostic", "--cursor-pagination-diagnostic", "--matched-992-cursor-pagination-diagnostic", "--cursor-input-source-diagnostic", "--synth-window-bounds-diagnostic"].includes(argument)), "only an explicit row-gap, touch-shape, cursor-input-source, synth-window-bounds, or cursor-pagination diagnostic selector is supported");
const ROW_GAP_ONLY = CLI_ARGUMENTS[0] === "--row-gap-only";
const TOUCH_SHAPE_DIAGNOSTIC = CLI_ARGUMENTS[0] === "--touch-shape-diagnostic";
const LEGACY_CURSOR_PAGINATION_DIAGNOSTIC = CLI_ARGUMENTS[0] === "--cursor-pagination-diagnostic";
const MATCHED_992_CURSOR_DIAGNOSTIC = CLI_ARGUMENTS[0] === "--matched-992-cursor-pagination-diagnostic";
const CURSOR_PAGINATION_DIAGNOSTIC = LEGACY_CURSOR_PAGINATION_DIAGNOSTIC || MATCHED_992_CURSOR_DIAGNOSTIC;
const CURSOR_INPUT_SOURCE_DIAGNOSTIC = CLI_ARGUMENTS[0] === "--cursor-input-source-diagnostic";
const SYNTH_WINDOW_BOUNDS_DIAGNOSTIC = CLI_ARGUMENTS[0] === "--synth-window-bounds-diagnostic";
const PINNED_992_DIAGNOSTIC = LEGACY_CURSOR_PAGINATION_DIAGNOSTIC || CURSOR_INPUT_SOURCE_DIAGNOSTIC || SYNTH_WINDOW_BOUNDS_DIAGNOSTIC;
const PINNED_CURSOR_INPUT_DIAGNOSTIC = PINNED_992_DIAGNOSTIC || MATCHED_992_CURSOR_DIAGNOSTIC;
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const EXPECTED_BROWSER_TOUCH_INPUT_SHA256 = "60e99fad3bd9d09aaac89cee8ff90cdc469edb5974c53183e08ae894a1706f65";
const EXPECTED_CURSOR_EXPORT_RECEIPT_SHA256 = "375eb4c038da738edb3aa6267b3500a930928051f25c5d17a9905176a01d3ef7";
const EXPECTED_CURSOR_EXPORT_RUN_MANIFEST_SHA256 = "8100981519df028f3f98ef4a10318b6a9ca3a661e0e1729053b244958933f4f8";
const CURSOR_SOURCE_SNAPSHOT_RELATIVE_PATH = "target/private-official-export-receipt-wiring-20261009/source-adapter-9925461c";
const EXPECTED_CURSOR_SOURCE_SNAPSHOT_MANIFEST_SHA256 = "7d64b37bb56592f3e33dc222af0e58bf3a2cf44b72261092c42339acd30d935e";
const CURSOR_GATEWAY_SNAPSHOT_RELATIVE_PATH = "target/test/apps/kcoder-studio/e2e/private/mobile-gateway-runtime-freeze-current.once.e2e.mjs/20261009-194714.000Z/artifacts/gateway-runtime-frozen";
const MATCHED_992_GATEWAY_SNAPSHOT_RELATIVE_PATH = "target/private-phone-ux-implementation/shared-gateway-current-20261009/snapshot-20261009-223221.326Z";
const MATCHED_992_GATEWAY_BINARY_RELATIVE_PATH = "target/private-b6-device-revoke-20261009/build-03/owned-kcoder-copy";
const EXPECTED_MATCHED_GATEWAY_BINARY_SHA256 = "bc985854134edffc02415a5d9e72f8905fdc23e7e2263e84f9554e53619dec29";
const EXPECTED_CURSOR_GATEWAY_MANIFEST_SHA256 = "4b587547bb9866987d3d4756d2c1126777d1a19206dabc40dd39b15b786b26cd";
const EXPECTED_CURSOR_GATEWAY_SOURCE_TREE_SHA256 = "48016a39dfdf39664943e73e68623fc600762e8a65338a95cb479733a72a4074";
const EXPECTED_CURSOR_GATEWAY_DEPENDENCY_TREE_SHA256 = "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954";
const EXPECTED_MATCHED_GATEWAY_MANIFEST_SHA256 = "0219dce48d65e6413ce60d0aadfe1fe8047426c6570689ecaf77d757f256cda5";
const EXPECTED_MATCHED_GATEWAY_SOURCE_TREE_SHA256 = "6a8255fa538d6f2534d1784a088de9757283e8935e69a0d78a95358bb49ae197";
const EXPECTED_MATCHED_GATEWAY_DEPENDENCY_TREE_SHA256 = "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954";
const MATCHED_992_EXPORT_MANIFEST_RELATIVE_PATH = "target/private-phone-ux-validation/new-common-dependencies-before10feb-after992-20261009/run-d065c8c452c648f7/comparison-9925461c/export-manifest.json";
const MATCHED_992_SOURCE_ADAPTER_RELATIVE_PATH = "target/private-official-export-receipt-wiring-20261009/source-adapter-9925461c";
const MATCHED_992_SOURCE_COMMIT = "9925461ca047031f3f7f37d1f039d986c305fec3";
const MATCHED_992_SOURCE_ADAPTER_SHA256 = "7d64b37bb56592f3e33dc222af0e58bf3a2cf44b72261092c42339acd30d935e";
const MATCHED_992_SOURCE_FREEZE_SHA256 = "3dba241951fb51215df79d6b8fb76d2939be4d6f5d664ad3f4e9ba7f2aaaa5cb";
const MATCHED_992_PACKAGE_LOCK_SHA256 = "7c47b7ad5427ac56682f19c6fb7e46cff6e442ad8f52edee283665a38cd2e68b";
const MATCHED_992_MOBILE_GIT_TREE = "80d41cf2979f7dab00973c6dd6e45e173734d112";
const MATCHED_992_SHARED_GIT_TREE = "8270e871236a15579a2302e4b46f35642837b1be";
const MATCHED_992_EXPORT_MANIFEST_SHA256 = "f2f262624d4a2286ef31e250fb1752e02ab9a41232196b5591dafc5d8369d14d";
const MATCHED_992_BUNDLE_SHA256 = "e4a7277de6ecb2afb8f68dee52dfdf3b5a270c0e0c2e7f46cbdba02e83e140ab";
const MATCHED_992_SOURCE_TREE_SHA256 = "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020";
const MATCHED_992_DEPENDENCY_SOURCE_TREE_SHA256 = "46b02fc5ac823118f6eb2c034ea3f1d9cbbf79b71041fc2fa848f79a9abca1c6";
const MATCHED_992_DEPENDENCY_OWNED_TREE_SHA256 = "51b0c6987324fa5b6dbc17d8ea34ff83dd832deaa06c9c1193f84465a89001e4";
const MATCHED_992_DEPENDENCY_FILE_COUNT = 52524;
const MATCHED_992_INPUT_ROOTS = Object.freeze([
  Object.freeze({ name: "mobile", destination: "apps/kcoder-studio/mobile", sha256: "8a0963fb62846395dcdf1162470452d20fff84eed51adb44311fb75c5d327455", fileCount: 350 }),
  Object.freeze({ name: "studio-shared", destination: "apps/kcoder-studio/shared", sha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88", fileCount: 19 }),
]);
const BUILDER_COMMIT = "079ea127";
const EXPECTED_DIST_MANIFEST_SHA256 = "5053ac22d3476f7f17513a3c76a71b8993f3752e47bd060b8bead5c07c830752";
const EXPECTED_BUILDER_LOG_SHA256 = "3f0676876bb7dde893f971bb610e853f57ea9254b640fda18f397ad168a8df67";
const EXPECTED_DIST_RESOURCE_COUNT = 37;
const EXPECTED_DIST_RESOURCE_TABLE_SHA256 = "5c476e1a11242c37365d16fb1552edf77b956113b643b502cb74857b36e65186";
const MOBILE_PAGE_OPTIONS = Object.freeze({
  viewport: Object.freeze({ width: 390, height: 844 }),
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
});
const DIST_MANIFEST_NAME = "kcoder-mobile-web.json";
const TOUCH_PROBE_KEY = "__kcoderCurrentSessionsTouchProbe";
const TOUCH_SHAPE_PROBE_KEY = "__kcoderCurrentSessionsTouchShapeProbe";
const FIXTURE_RELATIVE_PATH = "apps/kcoder-studio/e2e/private/fixtures/rnw-sessions-touch-control.jsx";
const THREAD_COUNT = 32;
const TARGET_ROW_PREFIX = "session-touch-session-";
const MUTATING_METHODS = new Set([
  "thread/start", "thread/fork", "thread/delete", "thread/metadata/update", "thread/compact", "thread/rollback",
  "turn/start", "turn/interrupt", "runtime.worktrees.create", "runtime.worktrees.archive", "runtime.worktrees.restore",
]);
const MAX_TOUCH_EVENTS = 256;
const MAX_SCROLL_EVENTS = 128;
const MAX_NETWORK_EVENTS = 256;
const MAX_WS_CONNECTIONS = 8;
const MAX_WS_PENDING = 64;
const CURSOR_TOUCH_MAX_Y = 550;
const PRODUCT_TOUCH_CASES = Object.freeze([
  Object.freeze({ name: "actual-clipped-text", targetKind: "clipped-text" }),
  Object.freeze({ name: "actual-row-gap", targetKind: "row-gap" }),
]);
const ACTIVE_PRODUCT_TOUCH_CASES = ROW_GAP_ONLY ? [PRODUCT_TOUCH_CASES[1]] : PRODUCT_TOUCH_CASES;
const EXPECTED_CASE_COUNT = TOUCH_SHAPE_DIAGNOSTIC ? 4 : ACTIVE_PRODUCT_TOUCH_CASES.length + (ROW_GAP_ONLY ? 0 : 1);
const REQUIRED_TOUCH_GATES = Object.freeze([
  "actualViewport", "realScrollRange", "trustedTouchSequence", "trustedScrollEvent",
  "scrollChanged", "stableAfterInput", "collectorsComplete",
]);
assert.deepEqual(PRODUCT_TOUCH_CASES, [
  { name: "actual-clipped-text", targetKind: "clipped-text" },
  { name: "actual-row-gap", targetKind: "row-gap" },
], "product touch cases must cover the actual clipped text and row gap exactly once");

if (process.env[RUN_FLAG] !== "1") throw new Error(RUN_FLAG + "=1 is required for this private one-shot diagnostic");
if (process.execPath !== EXPECTED_NODE || process.version !== "v22.17.0") throw new Error("pinned Node 22.17.0 is required");
if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1") throw new Error("KCODER_E2E_CHROMIUM_NO_SANDBOX=1 is required");

const { createCursorPaginationFixture, createCursorResponseGate, runCursorPaginationDiagnostic, driveTouchUntilCursor, driveTouchUntilVisibleRow, driveTouchUntilListEnd, performCursorListGesture, readCursorGestureHitTest, cursorListGesture, readCursorListSnapshot, readCursorRowHit, sourceBoundaryStable, isOwnedSessionsRoute } = createMobileSessionsCursorDiagnostic({
  CURSOR_TOUCH_MAX_Y,
  MATCHED_992_CURSOR_DIAGNOSTIC,
  MOBILE_PAGE_OPTIONS,
  PINNED_CURSOR_INPUT_DIAGNOSTIC,
  connectThroughWelcome,
  enterSessions,
  installTouchProbe,
  readActualChromiumProcess,
  readProfileIdentity,
  readScrollport,
  readTouchProbe,
  resetTouchProbe,
  safeDiagnosticMessage,
  safeErrorName,
  safePath,
  sha256,
  touchGates,
  waitForStableScroll,
});

await runE2E(import.meta.url, {
  testId: MATCHED_992_CURSOR_DIAGNOSTIC ? "mobile-sessions-matched-992-cursor-owner-isolation-diagnostic"
    : CURSOR_PAGINATION_DIAGNOSTIC ? "mobile-sessions-current-cursor-owner-isolation-diagnostic"
    : CURSOR_INPUT_SOURCE_DIAGNOSTIC ? "mobile-sessions-current-cursor-input-source-diagnostic"
    : SYNTH_WINDOW_BOUNDS_DIAGNOSTIC ? "mobile-sessions-current-synth-window-bounds-diagnostic"
    : TOUCH_SHAPE_DIAGNOSTIC ? "mobile-sessions-current-touch-shape-diagnostic" : "mobile-sessions-current-official-dist-touch-control",
  tier: "manual-live",
  modelPolicy: MATCHED_992_CURSOR_DIAGNOSTIC
    ? "matched Git 992 Mobile Web export adapted to Gateway static manifest; KCODER_STUDIO_MOCK=1; actual app-facing WebSocket requests, trusted touch scrolling, clicked task route, and owner-close prevention of late cursor-frame delivery; late-answer consumer coverage is separate unit evidence; no original Expo receipt, Rust app-server, Provider, Relay, public service, or native-device claim"
    : CURSOR_PAGINATION_DIAGNOSTIC
    ? "current official Mobile Web Sessions cursor-page owner-isolation diagnostic; KCODER_STUDIO_MOCK=1; actual app-facing WebSocket requests, trusted touch scrolling, clicked task route, and owner-close prevention of late cursor-frame delivery; late-answer consumer coverage is separate unit evidence; no Rust app-server, Provider, Relay, public service, or native-device claim"
    : CURSOR_INPUT_SOURCE_DIAGNOSTIC
    ? "current official Mobile Sessions input-source diagnostic; KCODER_STUDIO_MOCK=1; compares the existing trusted CDP touch helper on Sessions and same-geometry native overflow with Input.synthesizeScrollGesture gestureSourceType=touch on Sessions; no pagination or product verdict"
    : SYNTH_WINDOW_BOUNDS_DIAGNOSTIC
    ? "two fresh Chromium contexts on a plain test-only native overflow page served by the owned Gateway origin; Chromium launched with --window-size=390,844 while page viewport remains 390x844 DPR3; compares synthesized-touch anchors y=550 and y=832, then at y=550 compares the same gesture via stepwise trusted CDP touch input if synth produced no scroll; no Sessions UI, Provider, pagination, or product verdict"
    : TOUCH_SHAPE_DIAGNOSTIC
    ? "four fresh Chromium browser contexts comparing current Sessions and a same-geometry test-only native overflow document with identical trusted touch coordinates; KCODER_STUDIO_MOCK=1 for Sessions only; diagnostic, no pagination or product verdict"
    : "one current official Mobile Web dist on an owned frozen Gateway snapshot; KCODER_STUDIO_MOCK=1; bounded app-facing thread/list protocol fixture; no Rust app-server, Provider, turn, Relay, SSH, public service, or native device",
  retainSuccessLogs: true,
}, async context => {
  const receiptInput = officialMobileExportReceiptFromEnv();
  if (MATCHED_992_CURSOR_DIAGNOSTIC) {
    assert.equal(receiptInput, null, "matched 992 mode must not consume or impersonate an official Expo RunContext receipt");
  }
  const officialSourceOptions = PINNED_992_DIAGNOSTIC ? {
    sourceSnapshotRoot: resolve(repoRoot, CURSOR_SOURCE_SNAPSHOT_RELATIVE_PATH),
    sourceSnapshotManifestSha256: EXPECTED_CURSOR_SOURCE_SNAPSHOT_MANIFEST_SHA256,
  } : {};
  if (PINNED_992_DIAGNOSTIC) {
    assert.equal(receiptInput?.receiptSha256, EXPECTED_CURSOR_EXPORT_RECEIPT_SHA256, "the cursor input diagnostic must use the pinned 992 official export receipt");
    assert.equal(receiptInput?.runManifestSha256, EXPECTED_CURSOR_EXPORT_RUN_MANIFEST_SHA256, "the cursor input diagnostic must use the completed 992 export RunContext manifest");
  }
  const officialInput = receiptInput ? await readOfficialMobileExportReceipt(receiptInput, officialSourceOptions) : null;
  if (PINNED_992_DIAGNOSTIC) {
    assert.ok(officialInput, "the cursor diagnostic requires the explicit pinned official Mobile export receipt");
    assert.equal(officialInput.builderSourceProvenance?.mode, "immutableSnapshot", "the cursor diagnostic requires the approved immutable Git 992 source snapshot");
  }
  const verifySourceBoundary = async () => MATCHED_992_CURSOR_DIAGNOSTIC
    ? await readMatched992SourceBoundary()
    : officialInput
      ? (await readOfficialMobileExportReceipt(receiptInput, officialSourceOptions)).builderSourceProvenance
      : verifyBuilderSourceBoundary();
  const sourceBoundaryBefore = officialInput?.builderSourceProvenance ?? await verifySourceBoundary();
  const targetRoot = resolve(repoRoot, "..");
  const builderRunRoot = resolve(targetRoot, "private-phone-ux-implementation/mobile-combined-validation-f2b0df88-20261009-01");
  const builderLogPath = resolve(builderRunRoot, "gateway-web-export.stdout");
  const builderExitPath = resolve(builderRunRoot, "gateway-web-export.exit");
  let distRoot;
  let expectedDistManifestSha256;
  let expectedResourceTableSha256;
  let sourceDist;
  let ownedDist;
  let matchedDistEvidence = null;
  if (MATCHED_992_CURSOR_DIAGNOSTIC) {
    const exportManifestPath = resolve(repoRoot, MATCHED_992_EXPORT_MANIFEST_RELATIVE_PATH);
    const bundleRoot = resolve(dirname(exportManifestPath), "bundle");
    matchedDistEvidence = await materializeMatchedMobileStaticDist(context, {
      bundleRoot,
      exportManifestPath,
      expectedExportManifestSha256: MATCHED_992_EXPORT_MANIFEST_SHA256,
      expectedBundleSha256: MATCHED_992_BUNDLE_SHA256,
      expectedSourceTreeSha256: MATCHED_992_SOURCE_TREE_SHA256,
      expectedDependencySourceTreeSha256: MATCHED_992_DEPENDENCY_SOURCE_TREE_SHA256,
      expectedDependencyOwnedTreeSha256: MATCHED_992_DEPENDENCY_OWNED_TREE_SHA256,
      expectedDependencyFileCount: MATCHED_992_DEPENDENCY_FILE_COUNT,
      expectedInputRoots: MATCHED_992_INPUT_ROOTS,
      outputName: "matched-992-mobile-static-dist",
      stagingName: "matched-992-mobile-static-dist-staging",
      artifactName: "matched-992-deploy-mounted-mobile-dist.json",
      comparisonId: "git-992-matched-export",
    });
    distRoot = matchedDistEvidence.ownedRoot;
    expectedDistManifestSha256 = matchedDistEvidence.manifestSha256;
    expectedResourceTableSha256 = matchedDistEvidence.resourceTableSha256;
    const inspected = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256: expectedDistManifestSha256 });
    sourceDist = {
      ...inspected,
      inputKind: matchedDistEvidence.inputKind,
      matchedBundleSha256: matchedDistEvidence.sourceBundleSha256,
      matchedExportManifestSha256: matchedDistEvidence.sourceExportManifestSha256,
    };
    ownedDist = matchedDistEvidence;
  } else {
    expectedDistManifestSha256 = officialInput?.manifestSha256 ?? EXPECTED_DIST_MANIFEST_SHA256;
    expectedResourceTableSha256 = officialInput?.sourceDist.resourceTableSha256 ?? EXPECTED_DIST_RESOURCE_TABLE_SHA256;
    distRoot = officialInput?.distRoot ?? resolve(repoRoot, "target/worktree/2026/10/09/mobile-ux-all-changes-20261009/apps/kcoder-studio/mobile/dist");
    if (!officialInput) {
      assert.equal(sha256(await readFile(builderLogPath)), EXPECTED_BUILDER_LOG_SHA256, "official Mobile dist builder log changed");
      assert.equal((await readFile(builderExitPath, "utf8")).trim(), "0", "official Mobile dist builder did not exit successfully");
    }
    sourceDist = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256: expectedDistManifestSha256 });
    assert.equal(sourceDist.resourceCount, EXPECTED_DIST_RESOURCE_COUNT);
    assert.equal(sourceDist.resourceTableSha256, expectedResourceTableSha256);
    ownedDist = await copyOfficialMobileStaticDist(context, {
      distRoot,
      expectedManifestSha256: expectedDistManifestSha256,
      outputName: "current-official-mobile-static-dist",
    });
    assert.equal(ownedDist.ownedCopyVerified, true);
    assert.equal(ownedDist.sourceStableDuringCopy, true);
    assert.equal(ownedDist.resourceCount, EXPECTED_DIST_RESOURCE_COUNT);
    assert.equal(ownedDist.resourceTableSha256, expectedResourceTableSha256);
  }

  const hashBytes = bytes => sha256(bytes);
  const latencyHelpers = createMobileLatencyHelpers({ sha256: hashBytes });
  const gatewaySnapshotDirectory = MATCHED_992_CURSOR_DIAGNOSTIC
    ? MATCHED_992_GATEWAY_SNAPSHOT_RELATIVE_PATH
    : PINNED_992_DIAGNOSTIC ? CURSOR_GATEWAY_SNAPSHOT_RELATIVE_PATH : undefined;
  const gatewayRuntime = await latencyHelpers.prepareGatewayRuntimeSnapshot(
    context,
    gatewaySnapshotDirectory,
    MATCHED_992_CURSOR_DIAGNOSTIC ? resolve(repoRoot, MATCHED_992_GATEWAY_BINARY_RELATIVE_PATH) : undefined,
    MATCHED_992_CURSOR_DIAGNOSTIC ? EXPECTED_MATCHED_GATEWAY_BINARY_SHA256 : undefined,
  );
  if (PINNED_992_DIAGNOSTIC) {
    assert.equal(gatewayRuntime.manifestSha256, EXPECTED_CURSOR_GATEWAY_MANIFEST_SHA256, "the cursor diagnostic must use the verified 194714 Gateway snapshot");
    assert.equal(gatewayRuntime.manifest.sourceTreeSha256, EXPECTED_CURSOR_GATEWAY_SOURCE_TREE_SHA256);
    assert.equal(gatewayRuntime.manifest.dependencyTreeSha256, EXPECTED_CURSOR_GATEWAY_DEPENDENCY_TREE_SHA256);
  }
  if (MATCHED_992_CURSOR_DIAGNOSTIC) {
    assert.equal(gatewayRuntime.manifestSha256, EXPECTED_MATCHED_GATEWAY_MANIFEST_SHA256, "matched 992 diagnostic must use the shared current frozen Gateway snapshot");
    assert.equal(gatewayRuntime.manifest.sourceTreeSha256, EXPECTED_MATCHED_GATEWAY_SOURCE_TREE_SHA256);
    assert.equal(gatewayRuntime.manifest.dependencyTreeSha256, EXPECTED_MATCHED_GATEWAY_DEPENDENCY_TREE_SHA256);
  }
  const gatewaySources = gatewayRuntime.manifest.sourceFiles;
  assert.ok(gatewaySources.some(file => file.path === "dev-server.mjs"), "owned Gateway snapshot must include dev-server.mjs");
  assert.ok(gatewaySources.some(file => file.path === "src/mobile-web-static.js"), "owned Gateway snapshot must include the current mobile-web-static handler");
  assert.equal(gatewayRuntime.manifest.status, "complete");
  const gatewayWebSource = gatewaySources.find(file => file.path === "src/mobile-web-static.js");
  const browserTouchInputPath = resolve(repoRoot, "apps/kcoder-studio/e2e/harness/browser-touch-input.mjs");
  const browserTouchInputSha256 = PINNED_CURSOR_INPUT_DIAGNOSTIC ? sha256(await readFile(browserTouchInputPath)) : null;
  if (PINNED_CURSOR_INPUT_DIAGNOSTIC) {
    assert.equal(browserTouchInputSha256, EXPECTED_BROWSER_TOUCH_INPUT_SHA256, "validated shared trusted-touch helper changed");
  }

  const fixtureBundle = ROW_GAP_ONLY || TOUCH_SHAPE_DIAGNOSTIC || CURSOR_PAGINATION_DIAGNOSTIC || CURSOR_INPUT_SOURCE_DIAGNOSTIC || SYNTH_WINDOW_BOUNDS_DIAGNOSTIC ? null : await buildRnwControlBundle(context);
  await context.writeArtifactJson("input-provenance.json", {
    schemaVersion: 1,
    scope: MATCHED_992_CURSOR_DIAGNOSTIC
      ? "Git 992 Mobile/Shared source adapter and its matched 37-resource Mobile Web export bundle; Gateway static manifest is derived by the pinned harness materializer, not an original Expo RunContext receipt; mock WebSocket UI only"
      : PINNED_992_DIAGNOSTIC
      ? "official Mobile dist tied to the immutable Git 992 source snapshot; current worktree parity is not claimed; Gateway runtime is the independently pinned 194714 snapshot"
      : "current official mobile/dist plus current owned Gateway source/dependency snapshot; source parity is limited to Mobile/Shared and mobile/package-lock.json",
    build: {
      inputKind: matchedDistEvidence?.inputKind ?? "official-mobile-static-dist",
      builderCommit: officialInput?.builderCommit ?? (MATCHED_992_CURSOR_DIAGNOSTIC ? MATCHED_992_SOURCE_COMMIT : BUILDER_COMMIT),
      ...(sourceBoundaryBefore?.mode === "immutableSnapshot"
        ? { sourceParity: null, sourceSnapshotProvenance: sourceBoundaryBefore }
        : { sourceParity: sourceBoundaryBefore }),
      builderLogPath: officialInput || MATCHED_992_CURSOR_DIAGNOSTIC ? null : relative(targetRoot, builderLogPath),
      builderLogSha256: officialInput || MATCHED_992_CURSOR_DIAGNOSTIC ? null : EXPECTED_BUILDER_LOG_SHA256,
      exportReceipt: officialInput ? { path: officialInput.receiptPath, sha256: officialInput.receiptSha256, runManifestSha256: officialInput.runManifestSha256 } : null,
      builderExitCode: MATCHED_992_CURSOR_DIAGNOSTIC ? null : 0,
      manifestPath: sourceDist.manifestPath,
      manifestSha256: sourceDist.manifestSha256,
      manifestSize: sourceDist.manifestSize,
      resourceCount: sourceDist.resourceCount,
      resourceBytes: sourceDist.totalResourceBytes,
      resourceTableSha256: sourceDist.resourceTableSha256,
      ownedCopy: {
        root: ownedDist.ownedRoot,
        manifestSha256: ownedDist.manifestSha256,
        resourceCount: ownedDist.resourceCount,
        sourceStableDuringCopy: ownedDist.sourceStableDuringCopy,
        verified: ownedDist.ownedCopyVerified,
        directoryMode: ownedDist.ownedDirectoryMode,
        fileMode: ownedDist.ownedFileMode,
      },
      dependencyTreeImmutabilityClaimed: false,
      matchedExport: matchedDistEvidence ? {
        sourceManifestPath: matchedDistEvidence.sourceExportManifestPath,
        sourceManifestSha256: matchedDistEvidence.sourceExportManifestSha256,
        bundleSha256: matchedDistEvidence.sourceBundleSha256,
        derivedManifestSha256: matchedDistEvidence.derivedManifestSha256,
        claimBoundary: matchedDistEvidence.matchedEvidence.claimBoundary,
      } : null,
    },
    gateway: {
      root: gatewayRuntime.root,
      manifestPath: gatewayRuntime.manifestPath,
      manifestSha256: gatewayRuntime.manifestSha256,
      status: gatewayRuntime.manifest.status,
      sourceTreeSha256: gatewayRuntime.manifest.sourceTreeSha256,
      sourceFileCount: gatewaySources.length,
      mobileWebStaticSource: gatewayWebSource,
      dependencyTreeSha256: gatewayRuntime.manifest.dependencyTreeSha256,
      dependencyFileCount: gatewayRuntime.manifest.dependencyFiles.length,
      nodeVersion: gatewayRuntime.manifest.nodeVersion,
      executionClassification: "owned snapshot from this followup checkout; KCODER_STUDIO_MOCK=1; no CLI/Engine child is expected",
      snapshotSelection: MATCHED_992_CURSOR_DIAGNOSTIC ? "shared current frozen Gateway snapshot 20261009-223221.326Z" : PINNED_992_DIAGNOSTIC ? "pre-frozen 194714 Gateway source/dependency snapshot" : "captured from this checkout for the RunContext",
    },
    browserTouchInput: PINNED_CURSOR_INPUT_DIAGNOSTIC
      ? { path: "apps/kcoder-studio/e2e/harness/browser-touch-input.mjs", sha256: browserTouchInputSha256, contractTest: "5/5 PASS at target/test/apps/kcoder-studio/e2e/harness/browser-touch-input.test.mjs/20261009-193254.535Z" }
      : null,
    fixtureBundle: fixtureBundle?.evidence ?? { status: "NOT_RUN", reason: TOUCH_SHAPE_DIAGNOSTIC ? "plain native overflow diagnostic does not build or inject an RNW fixture" : CURSOR_PAGINATION_DIAGNOSTIC ? "cursor-pagination mode uses the matched/deployed Mobile UI and no RNW control bundle" : CURSOR_INPUT_SOURCE_DIAGNOSTIC ? "input-source mode uses only official Mobile UI and plain native overflow; no RNW fixture bundle" : SYNTH_WINDOW_BOUNDS_DIAGNOSTIC ? "synth-window-bounds mode uses only a test-only plain native overflow page; no RNW fixture bundle" : "row-gap-only scope" },
    browser: { viewport: MOBILE_PAGE_OPTIONS.viewport, deviceScaleFactor: MOBILE_PAGE_OPTIONS.deviceScaleFactor, isMobile: true, hasTouch: true },
  });

  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversPath = await context.writeStateJson("servers.json", [{
    id: "touch-local",
    label: "Touch fixture",
    runtime: "kcoder",
    transport: "local",
    command: process.execPath,
    workspace,
  }]);
  const gatewayHome = context.pathInState("gateway-home");
  await mkdir(gatewayHome, { recursive: true, mode: 0o700 });
  const gateway = await startGateway(context, {
    label: "current-mobile-touch-mock-gateway",
    auth: true,
    workspace,
    serversFile: serversPath,
    gatewayRoot: gatewayRuntime.root,
    cwd: gatewayRuntime.root,
    env: {
      KCODER_STUDIO_MOCK: "1",
      KCODER_HOME: gatewayHome,
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: ownedDist.ownedRoot,
    },
  });

  const chromium = await startChromium(context, {
    label: "current-mobile-sessions-touch-chromium",
    ...(SYNTH_WINDOW_BOUNDS_DIAGNOSTIC || CURSOR_PAGINATION_DIAGNOSTIC ? { windowSize: { width: 390, height: 844 } } : {}),
  });
  if (SYNTH_WINDOW_BOUNDS_DIAGNOSTIC) {
    return runSynthWindowBoundsDiagnostic(context, {
      chromium,
      gateway,
      sourceBoundaryBefore,
      verifySourceBoundary,
      expectedDistManifestSha256,
      sourceDist,
      distRoot,
      latencyHelpers,
      gatewayRuntime,
      browserTouchInputPath,
      browserTouchInputSha256,
    });
  }
  if (CURSOR_INPUT_SOURCE_DIAGNOSTIC) {
    return runCursorTouchSourceDiagnostic(context, {
      chromium,
      gateway,
      workspace,
      sourceBoundaryBefore,
      verifySourceBoundary,
      expectedDistManifestSha256,
      sourceDist,
      distRoot,
      latencyHelpers,
      gatewayRuntime,
      browserTouchInputPath,
      browserTouchInputSha256,
    });
  }
  if (TOUCH_SHAPE_DIAGNOSTIC) {
    return runTouchShapeDiagnostic(context, {
      chromium,
      gateway,
      workspace,
      sourceBoundaryBefore,
      verifySourceBoundary,
      expectedDistManifestSha256,
      sourceDist,
      distRoot,
      latencyHelpers,
      gatewayRuntime,
    });
  }
  const page = await chromium.newPage(MOBILE_PAGE_OPTIONS);
  page.setDefaultTimeout(15_000);
  context.addCleanup("close current official Mobile touch page", async () => {
    if (!page.isClosed()) await page.close();
  });

  const ledger = {
    websocketConnections: 0,
    websocketRejected: 0,
    websocketFixtureErrors: 0,
    requestCount: 0,
    threadListRequests: 0,
    threadListReplies: 0,
    duplicateCursorRequestCount: 0,
    paginationEvents: [],
    paginationEventOverflow: 0,
    forbiddenMutationRequests: [],
    foreignHttpBlocked: 0,
    mobileHttpResponses: [],
    httpResponseOverflow: 0,
    pageErrors: 0,
    consoleErrors: 0,
  };
  installOwnedNetworkGuards(page, gateway.baseUrl, ledger);
  const paginationFixture = CURSOR_PAGINATION_DIAGNOSTIC
    ? createCursorPaginationFixture(workspace, ledger)
    : null;
  await installMockThreadListWebSocket(page, gateway, workspace, ledger, paginationFixture);
  page.on("pageerror", () => { ledger.pageErrors += 1; });
  page.on("console", message => { if (message.type() === "error") ledger.consoleErrors += 1; });
  page.on("response", response => {
    try {
      const url = new URL(response.url());
      if (url.origin !== new URL(gateway.baseUrl).origin || !url.pathname.startsWith("/mobile/")) return;
      if (ledger.mobileHttpResponses.length >= MAX_NETWORK_EVENTS) { ledger.httpResponseOverflow += 1; return; }
      ledger.mobileHttpResponses.push({ path: safePath(url.pathname), status: response.status(), resourceType: response.request().resourceType() });
    } catch { ledger.httpResponseOverflow += 1; }
  });

  if (CURSOR_PAGINATION_DIAGNOSTIC) {
    return runCursorPaginationDiagnostic(context, {
      chromium,
      page,
      gateway,
      workspace,
      ledger,
      paginationFixture,
      sourceBoundaryBefore,
      verifySourceBoundary,
      expectedDistManifestSha256,
      sourceDist,
      distRoot,
      latencyHelpers,
      gatewayRuntime,
      browserTouchInputPath,
      browserTouchInputSha256,
    });
  }

  const cases = [];
  let postflight = {};
  try {
    await connectThroughWelcome(page, gateway);
    await enterSessions(page);
    const firstRow = await firstVisibleSessionRow(page);
    assert.match(firstRow.testId, /^session-touch-session-[0-9]{2}$/);
    await context.writeArtifactJson("setup.json", {
      schemaVersion: 1,
      route: { origin: new URL(gateway.baseUrl).origin, pathname: await page.evaluate(() => location.pathname) },
      uiFlow: ["Mobile static route", "Welcome direct connection", "Home", "Sessions"],
      selectedVisibleRowTestId: firstRow.testId,
      mockProtocol: {
        mode: "KCODER_STUDIO_MOCK=1",
        method: "thread/list response replacement at the app-facing WebSocket boundary",
        syntheticThreadCount: THREAD_COUNT,
        mutationMethodsForwarded: false,
        observedThreadListReplies: ledger.threadListReplies,
      },
      mobileStaticDistKind: sourceDist.inputKind,
      mobileStaticManifestSha256: sourceDist.manifestSha256,
      ownedGatewaySourceTreeSha256: gatewayRuntime.manifest.sourceTreeSha256,
    });

    for (const [index, target] of ACTIVE_PRODUCT_TOUCH_CASES.entries()) {
      if (index > 0) await reloadSessions(page, gateway.baseUrl);
      cases.push(await captureSessionsTouchCase(page, context, {
        rowTestId: firstRow.testId,
        workspace,
        name: target.name,
        targetKind: target.targetKind,
      }));
    }

    if (!ROW_GAP_ONLY) {
      await reloadSessions(page, gateway.baseUrl);
      cases.push(await captureRnwViewControl(page, context, firstRow.testId, fixtureBundle, workspace));
    }
  } finally {
    try {
      const sourceDistAfter = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256: expectedDistManifestSha256 });
      postflight.sourceDistStable = sourceDistAfter.resourceTableSha256 === sourceDist.resourceTableSha256;
      postflight.sourceDistAfter = { manifestSha256: sourceDistAfter.manifestSha256, resourceCount: sourceDistAfter.resourceCount, resourceTableSha256: sourceDistAfter.resourceTableSha256 };
    } catch (error) {
      postflight.sourceDistStable = false;
      postflight.sourceDistErrorName = safeErrorName(error);
    }
    try {
      postflight.sourceBoundaryAfter = await verifySourceBoundary();
      postflight.sourceBoundaryStable = sourceBoundaryStable(sourceBoundaryBefore, postflight.sourceBoundaryAfter);
    } catch (error) {
      postflight.sourceBoundaryStable = false;
      postflight.sourceBoundaryErrorName = safeErrorName(error);
    }
    try {
      const gatewayRuntimeAfter = await latencyHelpers.inspectGatewayRuntimeSnapshot(gatewayRuntime.root);
      postflight.gatewayRuntimeStable = gatewayRuntimeAfter.sourceDigest === gatewayRuntime.manifest.sourceTreeSha256
        && gatewayRuntimeAfter.dependencyDigest === gatewayRuntime.manifest.dependencyTreeSha256;
      postflight.gatewayAfter = { sourceDigest: gatewayRuntimeAfter.sourceDigest, dependencyDigest: gatewayRuntimeAfter.dependencyDigest };
    } catch (error) {
      postflight.gatewayRuntimeStable = false;
      postflight.gatewayRuntimeErrorName = safeErrorName(error);
    }
    const expectedProductCases = ACTIVE_PRODUCT_TOUCH_CASES.map(({ name, targetKind }) => ({ name, targetKind }));
    const actualProductCases = cases.slice(0, ACTIVE_PRODUCT_TOUCH_CASES.length).map(({ name, targetKind }) => ({ name, targetKind }));
    const productCaseIdentityMatches = JSON.stringify(actualProductCases) === JSON.stringify(expectedProductCases);
    const caseGatesComplete = cases.length === EXPECTED_CASE_COUNT && cases.every(item => item.status === "observed"
      && REQUIRED_TOUCH_GATES.every(name => item.gates?.[name] === true));
    const caseCleanupComplete = cases.every(item => !Array.isArray(item.cleanupErrors) || item.cleanupErrors.length === 0);
    const protocolGuardsClean = ledger.forbiddenMutationRequests.length === 0
      && ledger.websocketRejected === 0 && ledger.websocketFixtureErrors === 0
      && ledger.foreignHttpBlocked === 0 && ledger.httpResponseOverflow === 0
      && ledger.pageErrors === 0 && ledger.consoleErrors === 0;
    const postflightComplete = postflight.sourceDistStable === true
      && postflight.sourceBoundaryStable === true && postflight.gatewayRuntimeStable === true;
    await context.writeArtifactJson("touch-control-result.json", {
      schemaVersion: 1,
      status: caseGatesComplete && caseCleanupComplete && productCaseIdentityMatches && protocolGuardsClean && postflightComplete
        ? "observations-complete" : "partial",
      claimScope: ROW_GAP_ONLY
        ? "one real Chromium touch sample on the actual current Mobile Web Sessions row gap only; app-facing thread/list is a mock protocol fixture, not Rust/Provider/public/native evidence"
        : "three real Chromium touch samples over current official Mobile Web UI plus one same-page RNW View control; app-facing thread/list is a mock protocol fixture, not Rust/Provider/public/native evidence",
      selectedScope: ROW_GAP_ONLY ? "one-row-gap-only" : "three-touch-controls",
      cases,
      completionGates: {
        productCaseIdentityMatches,
        caseGatesComplete,
        caseCleanupComplete,
        protocolGuardsClean,
        postflightComplete,
      },
      protocol: {
        websocketConnections: ledger.websocketConnections,
        websocketRejected: ledger.websocketRejected,
        websocketFixtureErrors: ledger.websocketFixtureErrors,
        requestCount: ledger.requestCount,
        threadListRequests: ledger.threadListRequests,
        threadListReplies: ledger.threadListReplies,
        forbiddenMutationRequests: ledger.forbiddenMutationRequests,
      },
      browserNetwork: {
        foreignHttpBlocked: ledger.foreignHttpBlocked,
        mobileHttpResponses: ledger.mobileHttpResponses,
        overflow: ledger.httpResponseOverflow,
        pageErrors: ledger.pageErrors,
        consoleErrors: ledger.consoleErrors,
      },
      postflight,
      nativeDevice: "NOT_RUN",
      publicRelay: "NOT_RUN",
      rustEngineOrProvider: "NOT_RUN",
    });
  }

  assert.equal(postflight.sourceDistStable, true, "official Mobile dist changed during the browser run");
  assert.equal(postflight.sourceBoundaryStable, true, "Mobile/Shared source parity changed during the run");
  assert.equal(postflight.gatewayRuntimeStable, true, "owned Gateway runtime snapshot changed during the run");

  assert.equal(ledger.forbiddenMutationRequests.length, 0, "browser fixture must not issue mutating thread/turn RPCs");
  assert.equal(ledger.websocketRejected, 0, "all browser WebSocket connections must remain on the owned Gateway /rpc route");
  assert.equal(ledger.websocketFixtureErrors, 0, "mock thread/list WebSocket fixture must remain healthy");
  assert.equal(ledger.foreignHttpBlocked, 0, "current Mobile Web must not request a foreign HTTP origin");
  assert.equal(ledger.httpResponseOverflow, 0, "bounded Mobile HTTP response ledger must not overflow");
  assert.equal(ledger.pageErrors, 0, "Mobile page must not report uncaught JavaScript errors");
  assert.equal(ledger.consoleErrors, 0, "Mobile page must not report console errors");
  assert.equal(cases.length, EXPECTED_CASE_COUNT, ROW_GAP_ONLY ? "the selected row-gap diagnostic must produce exactly one observation" : "all three diagnostic controls must produce an observation");
  const requiredGates = REQUIRED_TOUCH_GATES;
  const invalidSetup = cases.filter(item => item.status === "INVALID_SETUP");
  assert.equal(invalidSetup.length, 0, "touch target geometry/input setup was invalid; this is not product scroll evidence");
  assert.deepEqual(cases.slice(0, ACTIVE_PRODUCT_TOUCH_CASES.length).map(({ name, targetKind }) => ({ name, targetKind })), ACTIVE_PRODUCT_TOUCH_CASES,
    "the observed product cases must match the explicitly selected touch-control scope");
  const invalidCapture = cases.filter(item => item.status === "CAPTURE_ERROR" || item.status === "CLEANUP_ERROR");
  assert.equal(invalidCapture.length, 0, "trusted input capture or owned fixture cleanup failed; inspect per-case artifacts");
  const cleanupFailures = cases.filter(item => item.cleanupErrors?.length > 0);
  assert.equal(cleanupFailures.length, 0, "per-case fixture cleanup failed; inspect its recorded cleanup errors");
  const unverifiedInput = cases.filter(item => item.status === "UNVERIFIED_INPUT");
  assert.equal(unverifiedInput.length, 0, "touch/scroll observation did not meet the trusted-input or collector gates; no product cause is inferred");
  const noScroll = cases.filter(item => item.status === "OBSERVED_NO_SCROLL");
  assert.equal(noScroll.length, 0, "trusted input was observed without scroll movement; cause is UNVERIFIED, not a product diagnosis");
  const failures = cases.filter(item => item.status !== "observed" || requiredGates.some(name => item.gates?.[name] !== true));
  assert.equal(failures.length, 0, "each control must show complete trusted touch, stable real scroll movement, and bounded collectors; see per-case artifacts");
  return { status: ROW_GAP_ONLY ? "one-row-gap-touch-observed" : "three-control-touch-observed", caseCount: cases.length };
});

async function connectThroughWelcome(page, gateway) {
  const mobileUrl = new URL("/mobile/", gateway.baseUrl).toString();
  await page.goto(mobileUrl, { waitUntil: "domcontentloaded" });
  const loaded = new URL(page.url());
  assert.equal(loaded.origin, new URL(gateway.baseUrl).origin, "Mobile Web must load from the owned Gateway origin");
  assert.equal(loaded.pathname, "/mobile/", "Mobile Web must be served from the current static mount");
  await page.waitForSelector('[data-testid="welcome-direct-connection"]', { state: "visible", timeout: 30_000 });
  await visible(page, "welcome-direct-connection").click();
  await visible(page, "gateway-endpoint").fill(gateway.baseUrl);
  await visible(page, "gateway-token").fill(gateway.authToken);
  await visible(page, "gateway-connect").click();
  await visible(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function runTouchShapeDiagnostic(context, { chromium, gateway, workspace, sourceBoundaryBefore, verifySourceBoundary, expectedDistManifestSha256, sourceDist, distRoot, latencyHelpers, gatewayRuntime }) {
  const ledger = {
    websocketConnections: 0, websocketRejected: 0, websocketFixtureErrors: 0,
    requestCount: 0, threadListRequests: 0, threadListReplies: 0,
    forbiddenMutationRequests: [], foreignHttpBlocked: 0, mobileHttpResponses: [],
    httpResponseOverflow: 0, pageErrors: 0, consoleErrors: 0,
  };
  const cases = [];
  const browserContexts = new Set();
  // Keep both surfaces at the old successful sample's interior viewport point.
  // The current scrollport is re-measured for every context and the existing
  // inside-scrollport gate rejects these coordinates if that geometry changes.
  const centerStart = Object.freeze({ x: 195, y: 560 });
  const shortEnd = Object.freeze({ x: 195, y: 515 });
  const longEnd = Object.freeze({ x: 195, y: 234 });
  const specs = [
    { id: "sessions-45px", surface: "sessions", start: centerStart, end: shortEnd },
    { id: "sessions-326px", surface: "sessions", start: centerStart, end: longEnd },
    { id: "native-overflow-45px", surface: "native-overflow", start: centerStart, end: shortEnd },
    { id: "native-overflow-326px", surface: "native-overflow", start: centerStart, end: longEnd },
  ];
  let matchedProductGeometry = null;

  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const record = await captureTouchShapeSample(context, {
      chromium, gateway, workspace, ledger, browserContexts, spec,
      matchedProductGeometry,
    });
    cases.push(record);
    if (spec.surface === "sessions" && !matchedProductGeometry && record.before?.scrollport) {
      matchedProductGeometry = record.before.scrollport;
    }
    await context.writeArtifactJson("touch-shape-" + spec.id + ".json", record);
  }

  const sourceDistAfter = await inspectOfficialMobileStaticDist({
    distRoot, expectedManifestSha256: expectedDistManifestSha256,
  });
  const sourceBoundaryAfter = await verifySourceBoundary();
  const gatewayRuntimeAfter = await latencyHelpers.inspectGatewayRuntimeSnapshot(gatewayRuntime.root);
  const postflight = {
    sourceDistStable: sourceDistAfter.resourceTableSha256 === sourceDist.resourceTableSha256,
    sourceDistAfter: {
      manifestSha256: sourceDistAfter.manifestSha256,
      resourceCount: sourceDistAfter.resourceCount,
      resourceTableSha256: sourceDistAfter.resourceTableSha256,
    },
    sourceBoundaryStable: sourceBoundaryStable(sourceBoundaryBefore, sourceBoundaryAfter),
    sourceBoundaryAfter,
    gatewayRuntimeStable: gatewayRuntimeAfter.sourceDigest === gatewayRuntime.manifest.sourceTreeSha256
      && gatewayRuntimeAfter.dependencyDigest === gatewayRuntime.manifest.dependencyTreeSha256,
    gatewayRuntimeAfter: {
      sourceDigest: gatewayRuntimeAfter.sourceDigest,
      dependencyDigest: gatewayRuntimeAfter.dependencyDigest,
    },
  };
  const fourDistinctContexts = browserContexts.size === 4;
  const allInputsObserved = cases.length === 4 && cases.every(item =>
    item.status === "observed"
      && item.cleanupErrors?.length === 0
      && item.gates?.nativeFixtureRequestExact === true
      && item.gates?.freshBrowserContext === true
      && item.gates?.fixedMobileViewport === true
      && item.gates?.naturalInitialScrollTopZero === true
      && item.gates?.realScrollRange === true
      && item.gates?.startAndEndInsideScrollport === true
      && item.gates?.trustedTouchStartMoveEnd === true
      && item.gates?.collectorsComplete === true
      && item.gates?.stableAfterTouchEnd === true);
  const nativeCases = cases.filter(item => item.surface === "native-overflow");
  const allNativeGeometryMatched = nativeCases.length === 2
    && nativeCases.every(item => item.gates?.nativeGeometryMatchesSessions === true);
  const protocolGuardsClean = ledger.forbiddenMutationRequests.length === 0
    && ledger.websocketRejected === 0 && ledger.websocketFixtureErrors === 0
    && ledger.foreignHttpBlocked === 0 && ledger.httpResponseOverflow === 0
    && ledger.pageErrors === 0 && ledger.consoleErrors === 0;
  const postflightComplete = postflight.sourceDistStable && postflight.sourceBoundaryStable && postflight.gatewayRuntimeStable;
  const observationsComplete = fourDistinctContexts && allInputsObserved && allNativeGeometryMatched && protocolGuardsClean && postflightComplete;
  const result = {
    schemaVersion: 1,
    classification: "DIAGNOSTIC_ONLY",
    status: observationsComplete ? "observations-complete" : "partial",
    claimScope: "four fresh Chromium browser contexts; current official Sessions page versus a test-only plain DOM native overflow control on the owned Gateway origin; same coordinates and trusted touch input; no pagination, product pass, Rust/Provider, public service, or native-device claim",
    browser: {
      viewport: MOBILE_PAGE_OPTIONS.viewport,
      deviceScaleFactor: MOBILE_PAGE_OPTIONS.deviceScaleFactor,
      isMobile: MOBILE_PAGE_OPTIONS.isMobile,
      hasTouch: MOBILE_PAGE_OPTIONS.hasTouch,
      contextsCreated: browserContexts.size,
      freshContextPerCase: fourDistinctContexts,
    },
    input: {
      mechanism: "existing local CDP Input.dispatchTouchEvent helper",
      moves: 12,
      force: 0.8,
      waitAfterEveryMove: "one browser requestAnimationFrame",
      start: centerStart,
      shortEnd,
      longEnd,
      domScrollOffsetWrites: 0,
    },
    cases,
    comparisons: {
      sessions45Vs326ScrollDelta: cases.filter(item => item.surface === "sessions").map(item => ({
        id: item.id,
        scrollDelta: item.outcome?.scrollDelta ?? null,
        trustedScrollEvents: item.outcome?.trustedScrollEventCount ?? null,
        startTarget: item.startPoint?.hit?.path?.[0] ?? null,
      })),
      native45Vs326ScrollDelta: cases.filter(item => item.surface === "native-overflow").map(item => ({
        id: item.id,
        scrollDelta: item.outcome?.scrollDelta ?? null,
        trustedScrollEvents: item.outcome?.trustedScrollEventCount ?? null,
        startTarget: item.startPoint?.hit?.path?.[0] ?? null,
      })),
      nativeGeometryMatchesSessions: allNativeGeometryMatched,
      interpretationBoundary: "a long-drag failure on both surfaces leaves input shape unresolved; native long-drag success with Sessions-only failure narrows the difference to the real Sessions DOM/responder path; a 45px delta helps isolate start-target effects. No case alone proves a product defect.",
    },
    gates: { fourDistinctContexts, allInputsObserved, allNativeGeometryMatched, protocolGuardsClean, postflightComplete },
    protocol: {
      websocketConnections: ledger.websocketConnections,
      websocketRejected: ledger.websocketRejected,
      websocketFixtureErrors: ledger.websocketFixtureErrors,
      requestCount: ledger.requestCount,
      threadListRequests: ledger.threadListRequests,
      threadListReplies: ledger.threadListReplies,
      forbiddenMutationRequests: ledger.forbiddenMutationRequests,
    },
    browserNetwork: {
      foreignHttpBlocked: ledger.foreignHttpBlocked,
      mobileHttpResponses: ledger.mobileHttpResponses,
      overflow: ledger.httpResponseOverflow,
      pageErrors: ledger.pageErrors,
      consoleErrors: ledger.consoleErrors,
    },
    postflight,
    pagination: "NOT_RUN",
    rustEngineOrProvider: "NOT_RUN",
    publicRelay: "NOT_RUN",
    nativeDevice: "NOT_RUN",
  };
  await context.writeArtifactJson("touch-shape-diagnostic-result.json", result);
  assert.equal(observationsComplete, true, "touch-shape input, fresh-context, matched-geometry or provenance collection was incomplete; see saved per-case artifacts");
  return {
    status: result.status,
    diagnosticClass: result.classification,
    caseCount: cases.length,
    scrollDeltas: cases.map(item => ({ id: item.id, delta: item.outcome?.scrollDelta ?? null })),
  };
}

async function runSynthWindowBoundsDiagnostic(context, { chromium, gateway, sourceBoundaryBefore, verifySourceBoundary,
  expectedDistManifestSha256, sourceDist, distRoot, latencyHelpers, gatewayRuntime, browserTouchInputPath, browserTouchInputSha256 }) {
  const ledger = {
    websocketConnections: 0, websocketRejected: 0, websocketFixtureErrors: 0,
    requestCount: 0, threadListRequests: 0, threadListReplies: 0,
    forbiddenMutationRequests: [], foreignHttpBlocked: 0, mobileHttpResponses: [],
    httpResponseOverflow: 0, pageErrors: 0, consoleErrors: 0,
  };
  const browserContexts = new Set();
  const chromiumProcess = await readActualChromiumProcess(chromium, context);
  const controlGeometry = {
    box: { x: 0, y: 0, width: MOBILE_PAGE_OPTIONS.viewport.width, height: MOBILE_PAGE_OPTIONS.viewport.height },
    clientWidth: MOBILE_PAGE_OPTIONS.viewport.width,
    clientHeight: MOBILE_PAGE_OPTIONS.viewport.height,
    scrollHeight: MOBILE_PAGE_OPTIONS.viewport.height + 1_200,
  };
  const startX = Math.round(MOBILE_PAGE_OPTIONS.viewport.width / 2);
  const specs = [
    { id: "native-synth-anchor-y550", start: { x: startX, y: 550 }, end: { x: startX, y: 86 } },
    { id: "native-synth-anchor-y832", start: { x: startX, y: 832 }, end: { x: startX, y: 368 } },
  ];
  const cases = [];
  const fixtureHtml = buildTouchShapeNativeDocument(controlGeometry);
  const fixtureBytes = Buffer.from(fixtureHtml, "utf8");
  const fixtureSha256 = sha256(fixtureBytes);

  for (const spec of specs) {
    const record = {
      schemaVersion: 1,
      id: spec.id,
      classification: "DIAGNOSTIC_ONLY",
      surface: "plain-native-overflow-control",
      status: "starting",
      browserContext: null,
      target: null,
      input: {
        command: "Input.synthesizeScrollGesture",
        gestureSourceType: "touch",
        start: spec.start,
        end: spec.end,
        xDistance: spec.end.x - spec.start.x,
        yDistance: spec.end.y - spec.start.y,
        preventFling: true,
        offsetWrites: 0,
      },
      fixture: {
        kind: "plain-native-overflow-html-fulfilled-by-exact-owned-origin-route",
        sha256: fixtureSha256,
        path: null,
        requestCount: 0,
        fulfilledCount: 0,
        rejectedRequestCount: 0,
        credentialsObserved: false,
      },
      chromiumProcess,
      windowDiagnostics: null,
      before: null,
      startPoint: null,
      endPoint: null,
      commandResult: null,
      stability: null,
      after: null,
      events: null,
      outcome: null,
      gates: {},
      cleanupErrors: [],
    };
    let page = null;
    let routeUrl = null;
    let routeHandler = null;
    let stage = "context-creation";
    try {
      page = await chromium.newPage(MOBILE_PAGE_OPTIONS);
      const pageContext = page.context();
      const freshContext = !browserContexts.has(pageContext);
      browserContexts.add(pageContext);
      page.setDefaultTimeout(15_000);
      context.addCleanup("close synth window bounds page " + spec.id, async () => {
        if (page && !page.isClosed()) await page.close();
      });
      const initialCookies = await pageContext.cookies();
      record.browserContext = {
        ordinal: browserContexts.size,
        freshObject: freshContext,
        initialUrl: page.url(),
        initialCookieCount: initialCookies.length,
      };
      assert.equal(freshContext, true, "each synth coordinate must use its own fresh BrowserContext");
      assert.equal(page.url(), "about:blank", "each coordinate case must start at about:blank");
      assert.equal(initialCookies.length, 0, "each coordinate context must start without inherited cookies");

      await installOwnedNetworkGuards(page, gateway.baseUrl, ledger);
      page.on("pageerror", () => { ledger.pageErrors += 1; });
      page.on("console", message => { if (message.type() === "error") ledger.consoleErrors += 1; });

      const routePath = "/__e2e_synth_bounds_native_" + fixtureSha256 + ".html";
      routeUrl = new URL(routePath, new URL(gateway.baseUrl).origin).toString();
      record.fixture.path = routePath;
      routeHandler = async route => {
        const request = route.request();
        let requestUrl = null;
        try { requestUrl = new URL(request.url()); } catch { /* rejected below */ }
        const headers = request.headers();
        record.fixture.credentialsObserved ||= Boolean(headers.cookie || headers.authorization);
        if (request.url() !== routeUrl || request.method() !== "GET" || request.resourceType() !== "document"
          || !requestUrl || requestUrl.origin !== new URL(gateway.baseUrl).origin) {
          record.fixture.rejectedRequestCount += 1;
          await route.abort("blockedbyclient");
          return;
        }
        record.fixture.requestCount += 1;
        if (record.fixture.requestCount !== 1) {
          record.fixture.rejectedRequestCount += 1;
          await route.abort("blockedbyclient");
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          body: fixtureBytes,
        });
        record.fixture.fulfilledCount += 1;
      };
      await page.route(routeUrl, routeHandler);
      stage = "fixture-navigation";
      await page.goto(routeUrl, { waitUntil: "domcontentloaded" });
      record.target = { origin: new URL(page.url()).origin, pathname: new URL(page.url()).pathname };
      assert.equal(record.fixture.requestCount, 1, "the exact native fixture route must be requested once");
      assert.equal(record.fixture.fulfilledCount, 1, "the exact native fixture route must be fulfilled once");
      assert.equal(record.fixture.rejectedRequestCount, 0, "the native fixture must not receive a rejected request");
      assert.equal(record.fixture.credentialsObserved, false, "the test-only fixture request must carry no credentials");

      const selector = "#native-touch-scrollport";
      await installTouchShapeProbe(page, selector);
      record.windowDiagnostics = await captureAndPrepareGestureWindow({
        browser: chromium.browser,
        page,
        context,
        start: spec.start,
        end: spec.end,
        prepareForSynthesizedInput: false,
      });
      record.before = await readTouchShapeMetrics(page, selector);
      record.startPoint = await readTouchShapePoint(page, selector, spec.start);
      record.endPoint = await readTouchShapePoint(page, selector, spec.end);
      const scrollport = record.before.scrollport;
      const exactViewport = record.before.viewport.width === MOBILE_PAGE_OPTIONS.viewport.width
        && record.before.viewport.height === MOBILE_PAGE_OPTIONS.viewport.height
        && record.before.viewport.devicePixelRatio === MOBILE_PAGE_OPTIONS.deviceScaleFactor
        && record.before.viewport.maxTouchPoints > 0;
      const initialOffsetZero = scrollport.scrollTop === 0;
      const actualScrollRange = scrollport.scrollHeight > scrollport.clientHeight;
      const coordinatesInside = pointInsideBox(spec.start, scrollport.box)
        && pointInsideBox(spec.end, scrollport.box)
        && record.startPoint.hit.withinScrollport && record.endPoint.hit.withinScrollport;
      const windowMetricsCaptured = record.windowDiagnostics.status === "captured"
        && record.windowDiagnostics.before?.target?.type === "page"
        && record.windowDiagnostics.before?.boundsFromWindow?.width > 0
        && record.windowDiagnostics.before?.boundsFromWindow?.height > 0
        && record.windowDiagnostics.before?.page?.innerWidth === MOBILE_PAGE_OPTIONS.viewport.width
        && record.windowDiagnostics.before?.page?.innerHeight === MOBILE_PAGE_OPTIONS.viewport.height
        && record.windowDiagnostics.before?.page?.devicePixelRatio === MOBILE_PAGE_OPTIONS.deviceScaleFactor;
      const windowSizeArgumentCaptured = chromiumProcess.windowSizeArguments?.length === 1
        && chromiumProcess.windowSizeArguments[0] === "--window-size=390,844";
      record.gates = {
        freshBrowserContext: freshContext,
        exactNativeFixtureRoute: record.fixture.requestCount === 1 && record.fixture.fulfilledCount === 1
          && record.fixture.rejectedRequestCount === 0 && record.fixture.credentialsObserved === false,
        fixedMobileViewport: exactViewport,
        initialScrollTopZero: initialOffsetZero,
        realScrollRange: actualScrollRange,
        startAndEndInsideScrollport: coordinatesInside,
        windowMetricsCaptured,
        windowSizeArgumentCaptured,
        actualChromiumArgvCaptured: chromiumProcess.status === "captured",
      };
      assert.equal(exactViewport, true, "the fixed mobile viewport must match the 390x844 DPR3 input");
      assert.equal(initialOffsetZero, true, "each fresh native control must start at scrollTop zero");
      assert.equal(actualScrollRange, true, "the plain native control must have natural overflow");
      assert.equal(coordinatesInside, true, "both synth coordinates must hit inside the native scrollport");
      assert.equal(windowMetricsCaptured, true, "the page target, Browser window, and emulated page metrics must be captured");
      await resetTouchShapeProbe(page, spec.id);

      stage = "synthesized-input";
      try {
        const dispatch = await dispatchSynthesizedTouchScroll(page, spec.start, spec.end, context.abortSignal);
        record.commandResult = { status: "completed", responseReceived: dispatch.responseReceived, parameters: dispatch.parameters };
        record.stability = await waitForStableScrollportAfterCommand(page, selector);
      } catch (error) {
        record.commandResult = {
          status: "rejected",
          errorName: safeErrorName(error),
          errorMessage: context.redactText(error instanceof Error ? error.message : "Unknown synthesized input error").slice(0, 300),
          parameters: { x: spec.start.x, y: spec.start.y, xDistance: record.input.xDistance,
            yDistance: record.input.yDistance, preventFling: true, gestureSourceType: "touch" },
        };
        record.stability = { status: "NOT_RUN", reason: "CDP command rejected before gesture completion" };
      }
      record.after = await readTouchShapeMetrics(page, selector);
      record.events = await readTouchShapeProbe(page);
      const scrollDelta = record.after.scrollport.scrollTop - scrollport.scrollTop;
      record.outcome = {
        scrollTopBefore: scrollport.scrollTop,
        scrollTopAfter: record.after.scrollport.scrollTop,
        scrollHeightBefore: scrollport.scrollHeight,
        scrollHeightAfter: record.after.scrollport.scrollHeight,
        clientHeightBefore: scrollport.clientHeight,
        clientHeightAfter: record.after.scrollport.clientHeight,
        scrollDelta,
        trustedTouchEventCount: record.events.touchEvents.filter(event => event.trusted).length,
        trustedScrollEventCount: record.events.scrollEvents.filter(event => event.trusted).length,
        touchEventCount: record.events.touchEvents.length,
        scrollEventCount: record.events.scrollEvents.length,
        droppedTouchEvents: record.events.droppedTouchEvents,
        droppedScrollEvents: record.events.droppedScrollEvents,
        domScrollOffsetWrites: 0,
      };
      record.stepwiseInput = { status: "NOT_RUN", reason: "stepwise trusted touch is only attempted for the y=550 case when synthesized input leaves the native scrollport unchanged" };
      if (spec.id === "native-synth-anchor-y550" && record.outcome.scrollDelta === 0) {
        await resetTouchShapeProbe(page, "stepwise-trusted-touch-drag");
        const stepwiseBefore = await readTouchShapeMetrics(page, selector);
        record.stepwiseInput = {
          status: "starting",
          command: "Input.dispatchTouchEvent via dispatchTrustedTouchDrag",
          gesture: { start: spec.start, end: spec.end, moves: 12, force: 0.8, waitForAnimationFrame: true },
          scrollTopBefore: stepwiseBefore.scrollport.scrollTop,
          domScrollOffsetWrites: 0,
          dispatch: null,
          after: null,
          events: null,
          scrollDelta: null,
        };
        try {
          assert.equal(stepwiseBefore.scrollport.scrollTop, 0, "stepwise input must begin at the native control's unchanged initial offset");
          const dispatch = await dispatchTrustedTouchDrag(page, {
            start: spec.start,
            end: spec.end,
            moves: 12,
            force: 0.8,
            waitForAnimationFrame: true,
            animationFrameTimeoutMs: 1000,
          }, context.abortSignal);
          record.stepwiseInput.dispatch = dispatch;
          record.stepwiseInput.stability = await waitForStableScrollportAfterCommand(page, selector);
          record.stepwiseInput.after = await readTouchShapeMetrics(page, selector);
          record.stepwiseInput.events = await readTouchShapeProbe(page);
          record.stepwiseInput.scrollDelta = record.stepwiseInput.after.scrollport.scrollTop - record.stepwiseInput.scrollTopBefore;
          record.stepwiseInput.status = "completed";
        } catch (error) {
          record.stepwiseInput.status = "rejected";
          record.stepwiseInput.errorName = safeErrorName(error);
          record.stepwiseInput.errorMessage = context.redactText(error instanceof Error ? error.message : "Unknown stepwise touch error").slice(0, 300);
          try { record.stepwiseInput.after ??= await readTouchShapeMetrics(page, selector); }
          catch (captureError) { record.stepwiseInput.afterCaptureErrorName = safeErrorName(captureError); }
          try { record.stepwiseInput.events ??= await readTouchShapeProbe(page); }
          catch (captureError) { record.stepwiseInput.eventsCaptureErrorName = safeErrorName(captureError); }
        }
      }
      record.gates.commandOutcomeCaptured = record.commandResult?.status === "completed" || record.commandResult?.status === "rejected"
        && typeof record.commandResult.errorName === "string" && typeof record.commandResult.errorMessage === "string";
      record.gates.metricsAndEventsCaptured = Boolean(record.after?.scrollport && record.events
        && record.events.droppedTouchEvents === 0 && record.events.droppedScrollEvents === 0);
      record.status = record.gates.commandOutcomeCaptured && record.gates.metricsAndEventsCaptured ? record.commandResult.status : "INCOMPLETE_EVIDENCE";
    } catch (error) {
      record.status = stage === "context-creation" || stage === "fixture-navigation" ? "INVALID_SETUP" : "CAPTURE_ERROR";
      record.errorName = safeErrorName(error);
      record.errorMessage = context.redactText(error instanceof Error ? error.message : "Unknown window-boundary diagnostic error").slice(0, 300);
      if (page && !page.isClosed()) {
        try { record.after ??= await readTouchShapeMetrics(page, "#native-touch-scrollport"); } catch (captureError) { record.afterCaptureErrorName = safeErrorName(captureError); }
        try { record.events ??= await readTouchShapeProbe(page); } catch (captureError) { record.eventsCaptureErrorName = safeErrorName(captureError); }
      }
    } finally {
      if (page && routeUrl && routeHandler) {
        try {
          await page.unroute(routeUrl, routeHandler);
          record.fixture.unrouteCompleted = true;
        } catch (error) {
          record.fixture.unrouteCompleted = false;
          record.cleanupErrors.push({ action: "unroute exact native fixture", errorName: safeErrorName(error) });
        }
      }
      if (page && !page.isClosed()) {
        try { await page.close(); } catch (error) { record.cleanupErrors.push({ action: "close fresh page", errorName: safeErrorName(error) }); }
      }
      if (record.cleanupErrors.length > 0) record.status = "CLEANUP_ERROR";
    }
    cases.push(record);
    await context.writeArtifactJson("synth-window-bounds-" + spec.id + ".json", record);
  }

  const sourceDistAfter = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256: expectedDistManifestSha256 });
  const sourceBoundaryAfter = await verifySourceBoundary();
  const gatewayRuntimeAfter = await latencyHelpers.inspectGatewayRuntimeSnapshot(gatewayRuntime.root);
  let browserTouchInputSha256After = null;
  let browserTouchInputStable = false;
  try {
    browserTouchInputSha256After = sha256(await readFile(browserTouchInputPath));
    browserTouchInputStable = browserTouchInputSha256After === browserTouchInputSha256;
  } catch { /* represented by the false stability gate */ }
  const postflight = {
    sourceDistStable: sourceDistAfter.resourceTableSha256 === sourceDist.resourceTableSha256,
    sourceDistManifestSha256: sourceDistAfter.manifestSha256,
    sourceDistResourceCount: sourceDistAfter.resourceCount,
    sourceBoundaryStable: sourceBoundaryStable(sourceBoundaryBefore, sourceBoundaryAfter),
    gatewayRuntimeStable: gatewayRuntimeAfter.sourceDigest === gatewayRuntime.manifest.sourceTreeSha256
      && gatewayRuntimeAfter.dependencyDigest === gatewayRuntime.manifest.dependencyTreeSha256,
    gatewaySourceTreeSha256: gatewayRuntimeAfter.sourceDigest,
    gatewayDependencyTreeSha256: gatewayRuntimeAfter.dependencyDigest,
    browserTouchInputSha256: browserTouchInputSha256After,
    browserTouchInputStable,
  };
  const distinctContexts = browserContexts.size === 2;
  const recordsComplete = cases.length === 2 && cases.every(record =>
    ["completed", "rejected"].includes(record.commandResult?.status)
      && record.status === record.commandResult.status
      && record.gates?.freshBrowserContext === true
      && record.gates?.exactNativeFixtureRoute === true
      && record.gates?.fixedMobileViewport === true
      && record.gates?.initialScrollTopZero === true
      && record.gates?.realScrollRange === true
      && record.gates?.startAndEndInsideScrollport === true
      && record.gates?.windowMetricsCaptured === true
      && record.gates?.windowSizeArgumentCaptured === true
      && record.gates?.actualChromiumArgvCaptured === true
      && record.gates?.metricsAndEventsCaptured === true
      && record.cleanupErrors.length === 0
      && record.fixture.unrouteCompleted === true);
  const postflightComplete = postflight.sourceDistStable && postflight.sourceBoundaryStable
    && postflight.gatewayRuntimeStable && postflight.browserTouchInputStable;
  const evidenceComplete = distinctContexts && recordsComplete && postflightComplete
    && ledger.forbiddenMutationRequests.length === 0 && ledger.foreignHttpBlocked === 0
    && ledger.httpResponseOverflow === 0 && ledger.pageErrors === 0 && ledger.consoleErrors === 0;
  const result = {
    schemaVersion: 1,
    classification: "DIAGNOSTIC_ONLY",
    status: evidenceComplete ? "observations-complete" : "partial",
    claimScope: "two fresh Chromium contexts, each loading only a plain native overflow HTML fixture through one exact owned-origin route; Chromium has --window-size=390,844 while each page uses 390x844 DPR3; compare synth-scroll anchors y=550 and y=832 and, if y=550 synth leaves offset unchanged, perform the same gesture with stepwise trusted CDP touch; no Sessions route, Provider, pagination, product verdict, Rust, public service, or device claim",
    browser: { viewport: MOBILE_PAGE_OPTIONS.viewport, deviceScaleFactor: MOBILE_PAGE_OPTIONS.deviceScaleFactor,
      isMobile: MOBILE_PAGE_OPTIONS.isMobile, hasTouch: MOBILE_PAGE_OPTIONS.hasTouch,
      contextsCreated: browserContexts.size, freshContextPerCoordinate: distinctContexts, launch: chromiumProcess },
    controlGeometry: { box: controlGeometry.box, scrollportClientWidth: controlGeometry.clientWidth,
      scrollportClientHeight: controlGeometry.clientHeight, contentHeight: controlGeometry.scrollHeight,
      fixtureSha256, scrollTopWrites: 0 },
    comparison: cases.map(record => ({ id: record.id, coordinate: record.input.start,
      windowDecision: record.windowDiagnostics?.decision ?? null,
      browserWindowBounds: record.windowDiagnostics?.before?.boundsFromWindow ?? null,
      pageMetrics: record.windowDiagnostics?.before?.page ?? null,
      layoutMetrics: record.windowDiagnostics?.before?.layoutMetrics ?? null,
      commandStatus: record.commandResult?.status ?? null,
      commandErrorName: record.commandResult?.errorName ?? null,
      commandErrorMessage: record.commandResult?.errorMessage ?? null,
      scrollTopBefore: record.outcome?.scrollTopBefore ?? null,
      scrollTopAfter: record.outcome?.scrollTopAfter ?? null,
      scrollDelta: record.outcome?.scrollDelta ?? null,
      trustedTouchEventCount: record.outcome?.trustedTouchEventCount ?? null,
      trustedScrollEventCount: record.outcome?.trustedScrollEventCount ?? null,
      windowSizeArgumentCaptured: record.gates?.windowSizeArgumentCaptured ?? false,
      stepwiseInputStatus: record.stepwiseInput?.status ?? "NOT_RUN",
      stepwiseScrollTopBefore: record.stepwiseInput?.scrollTopBefore ?? null,
      stepwiseScrollTopAfter: record.stepwiseInput?.after?.scrollport?.scrollTop ?? null,
      stepwiseScrollDelta: record.stepwiseInput?.scrollDelta ?? null,
      stepwiseTrustedTouchEventCount: record.stepwiseInput?.events?.touchEvents?.filter(event => event.trusted).length ?? null,
      stepwiseTrustedScrollEventCount: record.stepwiseInput?.events?.scrollEvents?.filter(event => event.trusted).length ?? null })),
    cases,
    gates: { distinctContexts, recordsComplete, postflightComplete, evidenceComplete },
    network: { requestCount: ledger.requestCount, foreignHttpBlocked: ledger.foreignHttpBlocked,
      forbiddenMutationRequests: ledger.forbiddenMutationRequests, pageErrors: ledger.pageErrors,
      consoleErrors: ledger.consoleErrors, httpResponseOverflow: ledger.httpResponseOverflow },
    postflight,
    actualRenderWidgetViewBounds: "NOT_DIRECTLY_EXPOSED_BY_THE_SAMPLED_PUBLIC_CDP_FIELDS; synth command error is retained as its own result",
    interpretationBoundary: "If y=550 is accepted while y=832 is rejected, the failure depends on coordinate/host-view bounds beyond the recorded Browser window and CSS viewport metrics; if both reject, the CDP target/coordinate setup remains unresolved. A rejected command has no gesture/scroll outcome and is not evidence of Sessions behavior.",
  };
  await context.writeArtifactJson("synth-window-bounds-diagnostic-result.json", result);
  assert.equal(evidenceComplete, true, "two-point synth-window-boundary evidence or pinned input postflight was incomplete; see per-case artifacts");
  return { status: result.status, classification: result.classification, caseCount: cases.length,
    commandStatuses: cases.map(record => ({ id: record.id, status: record.commandResult?.status ?? record.status })) };
}

async function runCursorTouchSourceDiagnostic(context, { chromium, gateway, workspace, sourceBoundaryBefore, verifySourceBoundary,
  expectedDistManifestSha256, sourceDist, distRoot, latencyHelpers, gatewayRuntime, browserTouchInputPath, browserTouchInputSha256 }) {
  const ledger = {
    websocketConnections: 0, websocketRejected: 0, websocketFixtureErrors: 0,
    requestCount: 0, threadListRequests: 0, threadListReplies: 0,
    forbiddenMutationRequests: [], foreignHttpBlocked: 0, mobileHttpResponses: [],
    httpResponseOverflow: 0, pageErrors: 0, consoleErrors: 0,
  };
  const cases = [];
  const browserContexts = new Set();
  const chromiumProcess = await readActualChromiumProcess(chromium, context);
  const start = Object.freeze({ x: 195, y: 832 });
  const end = Object.freeze({ x: 195, y: 368 });
  const specs = [
    { id: "sessions-shared-touch-helper", surface: "sessions", inputSource: "shared-touch-helper", start, end },
    { id: "native-overflow-shared-touch-helper", surface: "native-overflow", inputSource: "shared-touch-helper", start, end },
    { id: "native-overflow-synthesize-scroll-touch", surface: "native-overflow", inputSource: "synthesize-scroll-touch", start, end },
    { id: "sessions-synthesize-scroll-touch", surface: "sessions", inputSource: "synthesize-scroll-touch", start, end },
  ];
  let matchedProductGeometry = null;
  for (const spec of specs) {
    const record = await captureTouchShapeSample(context, { chromium, chromiumProcess, gateway, workspace, ledger, browserContexts, spec, matchedProductGeometry });
    cases.push(record);
    if (spec.surface === "sessions" && !matchedProductGeometry && record.before?.scrollport) matchedProductGeometry = record.before.scrollport;
    await context.writeArtifactJson("cursor-input-" + spec.id + ".json", record);
  }

  const sourceDistAfter = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256: expectedDistManifestSha256 });
  const sourceBoundaryAfter = await verifySourceBoundary();
  const gatewayRuntimeAfter = await latencyHelpers.inspectGatewayRuntimeSnapshot(gatewayRuntime.root);
  let browserTouchInputSha256After = null;
  let browserTouchInputStable = false;
  let browserTouchInputPostflightErrorName = null;
  try {
    browserTouchInputSha256After = sha256(await readFile(browserTouchInputPath));
    browserTouchInputStable = browserTouchInputSha256After === browserTouchInputSha256;
  } catch (error) {
    browserTouchInputPostflightErrorName = safeErrorName(error);
  }
  const postflight = {
    sourceDistStable: sourceDistAfter.resourceTableSha256 === sourceDist.resourceTableSha256,
    sourceDistManifestSha256: sourceDistAfter.manifestSha256,
    sourceDistResourceCount: sourceDistAfter.resourceCount,
    sourceBoundaryStable: sourceBoundaryStable(sourceBoundaryBefore, sourceBoundaryAfter),
    gatewayRuntimeStable: gatewayRuntimeAfter.sourceDigest === gatewayRuntime.manifest.sourceTreeSha256
      && gatewayRuntimeAfter.dependencyDigest === gatewayRuntime.manifest.dependencyTreeSha256,
    gatewaySourceTreeSha256: gatewayRuntimeAfter.sourceDigest,
    gatewayDependencyTreeSha256: gatewayRuntimeAfter.dependencyDigest,
    browserTouchInputSha256: browserTouchInputSha256After,
    browserTouchInputStable,
    ...(browserTouchInputPostflightErrorName ? { browserTouchInputPostflightErrorName } : {}),
  };
  const expectedIds = specs.map(spec => spec.id);
  const fourFreshContexts = browserContexts.size === 4 && cases.length === 4
    && new Set(cases.map(item => item.id)).size === 4 && expectedIds.every(id => cases.some(item => item.id === id));
  const allInputRecordsComplete = fourFreshContexts && cases.every(item => item.status === "observed"
    && item.cleanupErrors?.length === 0 && item.gates?.freshBrowserContext === true
    && item.gates?.fixedMobileViewport === true && item.gates?.naturalInitialScrollTopZero === true
    && item.gates?.realScrollRange === true && item.gates?.startAndEndInsideScrollport === true
    && item.gates?.collectorsComplete === true && item.gates?.stableAfterInput === true
    && item.gates?.actualChromiumArgvCaptured === true
    && (item.input.inputSource !== "synthesize-scroll-touch" || item.gates?.windowCoordinatesResolved === true));
  const nativeControl = cases.find(item => item.id === "native-overflow-shared-touch-helper");
  const nativeGeometryMatched = nativeControl?.gates?.nativeGeometryMatchesSessions === true
    && nativeControl?.gates?.nativeFixtureRequestExact === true;
  const nativeSynthControl = cases.find(item => item.id === "native-overflow-synthesize-scroll-touch");
  const allNativeGeometryMatched = nativeGeometryMatched
    && nativeSynthControl?.gates?.nativeGeometryMatchesSessions === true
    && nativeSynthControl?.gates?.nativeFixtureRequestExact === true;
  const sessionsSamples = cases.filter(item => item.surface === "sessions");
  const sessionsGeometryMatched = sessionsSamples.length === 2
    && sessionsSamples.every(item => item.gates?.nativeGeometryMatchesSessions === true);
  const sessionsProtocolObserved = ledger.websocketConnections >= 2
    && ledger.threadListRequests >= 2 && ledger.threadListReplies >= 2;
  const protocolClean = ledger.forbiddenMutationRequests.length === 0 && ledger.websocketRejected === 0
    && ledger.websocketFixtureErrors === 0 && ledger.foreignHttpBlocked === 0
    && ledger.httpResponseOverflow === 0 && ledger.pageErrors === 0 && ledger.consoleErrors === 0;
  const postflightComplete = postflight.sourceDistStable && postflight.sourceBoundaryStable && postflight.gatewayRuntimeStable
    && postflight.browserTouchInputStable === true;
  const observationsComplete = fourFreshContexts && allInputRecordsComplete && allNativeGeometryMatched
    && sessionsGeometryMatched && sessionsProtocolObserved && protocolClean && postflightComplete;
  const outcome = item => ({ id: item.id, inputSource: item.input.inputSource,
    scrollDelta: item.outcome?.scrollDelta ?? null,
    trustedTouchStartMoveEnd: item.gates?.trustedTouchStartMoveEnd ?? null,
    trustedScrollEventCount: item.outcome?.trustedScrollEventCount ?? null,
    synthesizedCommandCompleted: item.gates?.synthesizedTouchCommandCompleted ?? null,
    stableAfterInput: item.gates?.stableAfterInput ?? null,
    collectorDrops: { touch: item.events?.droppedTouchEvents ?? null, scroll: item.events?.droppedScrollEvents ?? null },
    startHit: item.startPoint?.hit ?? null,
  });
  const result = {
    schemaVersion: 1,
    classification: "DIAGNOSTIC_ONLY",
    status: observationsComplete ? "observations-complete" : "partial",
    claimScope: "four fresh Chromium contexts on official 992 Mobile Web dist: shared trusted touch-helper cases on Sessions and native overflow, then same-coordinate CDP synthesized touch on native overflow and Sessions. Input/window diagnostic only; no pagination, product verdict, Rust/Provider, Relay/public service, or native-device claim.",
    browser: { viewport: MOBILE_PAGE_OPTIONS.viewport, deviceScaleFactor: MOBILE_PAGE_OPTIONS.deviceScaleFactor,
      isMobile: MOBILE_PAGE_OPTIONS.isMobile, hasTouch: MOBILE_PAGE_OPTIONS.hasTouch,
      contextsCreated: browserContexts.size, freshContextPerCase: fourFreshContexts, launch: chromiumProcess },
    matchedGesture: { start, end, moves: 12, force: 0.8, waitAfterEachSharedHelperMove: "one bounded browser animation frame",
      nativeFixtureUsesMeasuredSessionsScrollportBoxAndContentHeight: true, scrollOffsetWrites: 0 },
    cases: cases.map(outcome),
    synthesizedTouch: cases.filter(item => item.input.inputSource === "synthesize-scroll-touch").map(item => ({
      id: item.id,
      surface: item.surface,
      status: item.status,
      windowDecision: item.windowDiagnostics?.decision ?? null,
      windowBefore: item.windowDiagnostics?.before?.windowBounds ?? null,
      windowAfter: item.windowDiagnostics?.after?.windowBounds ?? null,
      scrollDelta: item.outcome?.scrollDelta ?? null,
    })),
    gates: { fourFreshContexts, allInputRecordsComplete, nativeGeometryMatched, allNativeGeometryMatched, sessionsGeometryMatched,
      actualChromiumArgvCaptured: chromiumProcess.status === "captured", sessionsProtocolObserved, protocolClean, postflightComplete },
    protocol: { websocketConnections: ledger.websocketConnections, websocketRejected: ledger.websocketRejected,
      websocketFixtureErrors: ledger.websocketFixtureErrors, requestCount: ledger.requestCount,
      threadListRequests: ledger.threadListRequests, threadListReplies: ledger.threadListReplies,
      forbiddenMutationRequests: ledger.forbiddenMutationRequests },
    browserNetwork: { foreignHttpBlocked: ledger.foreignHttpBlocked, mobileHttpResponses: ledger.mobileHttpResponses,
      overflow: ledger.httpResponseOverflow, pageErrors: ledger.pageErrors, consoleErrors: ledger.consoleErrors },
    postflight,
    pagination: "NOT_RUN",
    productConclusion: "NONE; each input source is reported as an observation, and zero scroll is not treated as a product regression by this diagnostic",
  };
  await context.writeArtifactJson("cursor-input-source-diagnostic-result.json", result);
  assert.equal(observationsComplete, true, "input-source evidence, matched control geometry, or provenance collection was incomplete; inspect per-case artifacts");
  return { status: result.status, classification: result.classification, caseCount: cases.length };
}

async function readActualChromiumProcess(chromium, context) {
  const pid = chromium.child?.pid ?? null;
  const evidence = {
    status: "unavailable",
    pid,
    executablePath: chromium.executablePath ?? null,
    argv: null,
    flags: null,
    windowSizeArgumentPresent: null,
    windowSizeArguments: null,
    errorName: null,
  };
  if (!Number.isInteger(pid) || pid <= 0) {
    evidence.errorName = "CHROMIUM_PID_UNAVAILABLE";
    return evidence;
  }
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    const argv = raw.toString("utf8").split("\0").filter(Boolean);
    if (argv.length < 2 || !argv[0]) throw new Error("owned Chromium cmdline was empty or incomplete");
    const safeArgv = argv.map(argument => context.redactText(argument));
    evidence.status = "captured";
    evidence.argv = safeArgv;
    evidence.flags = safeArgv.filter(argument => argument.startsWith("--"));
    evidence.windowSizeArguments = safeArgv.filter(argument => argument.startsWith("--window-size"));
    evidence.windowSizeArgumentPresent = evidence.windowSizeArguments.length > 0;
  } catch (error) {
    evidence.errorName = safeErrorName(error);
  }
  return evidence;
}

async function captureAndPrepareGestureWindow({ browser, page, context, start, end, prepareForSynthesizedInput }) {
  const evidence = {
    schemaVersion: 1,
    status: "unresolved",
    decision: prepareForSynthesizedInput ? "pending-bounds-check" : "passive-only",
    inputCoordinatesCss: { start, end },
    coordinateMapping: null,
    requiredCssWindowSize: null,
    resizeRequest: null,
    before: null,
    after: null,
    windowContainsGesture: null,
    viewportStableAfterResize: null,
    errorName: null,
    errorMessage: null,
    cleanupErrors: [],
  };
  let browserCdp = null;
  let pageCdp = null;
  let windowId = null;
  let targetId = null;
  const captureSnapshot = async () => {
    const targetResponse = await browserCdp.send("Target.getTargets");
    const pageUrl = page.url();
    const matches = (targetResponse.targetInfos ?? []).filter(info => info.type === "page" && info.url === pageUrl);
    if (matches.length !== 1) throw new Error(`owned page target match count was ${matches.length}`);
    const target = matches[0];
    if (targetId !== null && targetId !== target.targetId) throw new Error("owned page target changed during window measurement");
    targetId = target.targetId;
    const [windowForTarget, pageLayout, pageMetrics] = await Promise.all([
      browserCdp.send("Browser.getWindowForTarget", { targetId }),
      pageCdp.send("Page.getLayoutMetrics"),
      page.evaluate(() => ({
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        devicePixelRatio,
        maxTouchPoints: Number(navigator.maxTouchPoints) || 0,
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
        },
        visualViewport: window.visualViewport ? {
          width: visualViewport.width,
          height: visualViewport.height,
          offsetLeft: visualViewport.offsetLeft,
          offsetTop: visualViewport.offsetTop,
          pageLeft: visualViewport.pageLeft,
          pageTop: visualViewport.pageTop,
          scale: visualViewport.scale,
        } : null,
        documentElement: {
          clientWidth: document.documentElement?.clientWidth ?? null,
          clientHeight: document.documentElement?.clientHeight ?? null,
        },
      })),
    ]);
    if (windowId !== null && windowForTarget.windowId !== windowId) throw new Error("owned page window id changed during window measurement");
    windowId = windowForTarget.windowId;
    const { bounds: currentBounds } = await browserCdp.send("Browser.getWindowBounds", { windowId });
    const numericFields = (value, fields) => Object.fromEntries(fields
      .filter(field => typeof value?.[field] === "number" && Number.isFinite(value[field]))
      .map(field => [field, value[field]]));
    const pageTargetUrl = new URL(pageUrl);
    return {
      target: { type: target.type, origin: pageTargetUrl.origin, pathname: pageTargetUrl.pathname },
      windowId,
      boundsFromTarget: numericFields(windowForTarget.bounds, ["left", "top", "width", "height"]),
      boundsFromWindow: {
        ...numericFields(currentBounds, ["left", "top", "width", "height"]),
        windowState: currentBounds?.windowState ?? null,
      },
      page: pageMetrics,
      layoutMetrics: {
        cssLayoutViewport: numericFields(pageLayout.cssLayoutViewport, ["pageX", "pageY", "clientWidth", "clientHeight"]),
        cssVisualViewport: numericFields(pageLayout.cssVisualViewport, ["offsetX", "offsetY", "pageX", "pageY", "clientWidth", "clientHeight", "scale"]),
        cssContentSize: numericFields(pageLayout.cssContentSize, ["x", "y", "width", "height"]),
      },
    };
  };

  try {
    browserCdp = await browser.newBrowserCDPSession();
    pageCdp = await page.context().newCDPSession(page);
    const before = await captureSnapshot();
    evidence.before = before;
    if (!prepareForSynthesizedInput) {
      evidence.status = "captured";
      evidence.windowContainsGesture = null;
      evidence.viewportStableAfterResize = true;
      return evidence;
    }

    const mapping = inferBrowserBoundsCssScale(before.boundsFromWindow, before.page);
    evidence.coordinateMapping = mapping;
    if (mapping.status !== "known") {
      evidence.decision = "UNRESOLVED_COORDINATE_UNITS";
      return evidence;
    }
    const maxX = Math.max(start.x, end.x);
    const maxY = Math.max(start.y, end.y);
    const requiredCssWindowSize = {
      width: Math.max(MOBILE_PAGE_OPTIONS.viewport.width, maxX + 1),
      height: Math.max(MOBILE_PAGE_OPTIONS.viewport.height, maxY + 1),
    };
    evidence.requiredCssWindowSize = requiredCssWindowSize;
    const sizeInCssPixels = bounds => ({
      width: bounds.width / mapping.browserBoundsUnitsPerCssPixel,
      height: bounds.height / mapping.browserBoundsUnitsPerCssPixel,
    });
    const beforeCssSize = sizeInCssPixels(before.boundsFromWindow);
    const containsGesture = beforeCssSize.width >= maxX + 1 && beforeCssSize.height >= maxY + 1;
    evidence.windowContainsGesture = containsGesture;
    if (containsGesture) {
      evidence.decision = "existing-window-covers-css-gesture";
      evidence.after = before;
      evidence.status = "resolved";
      evidence.viewportStableAfterResize = true;
      return evidence;
    }
    if (before.boundsFromWindow.windowState !== "normal") {
      evidence.decision = "UNRESOLVED_WINDOW_STATE";
      return evidence;
    }

    const scale = mapping.browserBoundsUnitsPerCssPixel;
    const requestedBounds = {
      width: Math.max(before.boundsFromWindow.width, Math.ceil(requiredCssWindowSize.width * scale)),
      height: Math.max(before.boundsFromWindow.height, Math.ceil(requiredCssWindowSize.height * scale)),
    };
    evidence.decision = "resize-owned-window-to-cover-css-viewport";
    evidence.resizeRequest = { windowId, bounds: requestedBounds };
    await browserCdp.send("Browser.setWindowBounds", { windowId, bounds: requestedBounds });
    let after = null;
    try {
      after = await waitFor(async () => {
        const sample = await captureSnapshot();
        const sampleMapping = inferBrowserBoundsCssScale(sample.boundsFromWindow, sample.page);
        if (sampleMapping.status !== "known" || sampleMapping.browserBoundsUnitsPerCssPixel !== scale) return null;
        const cssSize = sizeInCssPixels(sample.boundsFromWindow);
        return cssSize.width >= requiredCssWindowSize.width && cssSize.height >= requiredCssWindowSize.height ? sample : null;
      }, 2_000, "owned Chromium window to cover the pinned CSS gesture", 40, context.abortSignal);
    } catch (error) {
      evidence.resizeWaitErrorName = safeErrorName(error);
      try { after = await captureSnapshot(); } catch (captureError) { evidence.afterCaptureErrorName = safeErrorName(captureError); }
    }
    evidence.after = after;
    if (!after) {
      evidence.decision = "UNRESOLVED_WINDOW_RESIZE";
      return evidence;
    }
    const mappingAfter = inferBrowserBoundsCssScale(after.boundsFromWindow, after.page);
    evidence.coordinateMappingAfter = mappingAfter;
    if (mappingAfter.status !== "known" || mappingAfter.browserBoundsUnitsPerCssPixel !== scale) {
      evidence.decision = "UNRESOLVED_COORDINATE_MAPPING_CHANGED";
      return evidence;
    }
    const cssSizeAfter = sizeInCssPixels(after.boundsFromWindow);
    evidence.windowContainsGesture = cssSizeAfter.width >= maxX + 1 && cssSizeAfter.height >= maxY + 1;
    evidence.viewportStableAfterResize = pageViewportUnchanged(before.page, after.page, before.layoutMetrics, after.layoutMetrics);
    evidence.status = evidence.windowContainsGesture && evidence.viewportStableAfterResize ? "resolved" : "unresolved";
    if (!evidence.viewportStableAfterResize) evidence.decision = "UNRESOLVED_EMULATED_VIEWPORT_CHANGED";
    else if (!evidence.windowContainsGesture) evidence.decision = "UNRESOLVED_WINDOW_STILL_TOO_SMALL";
  } catch (error) {
    evidence.errorName = safeErrorName(error);
    evidence.errorMessage = context.redactText(error instanceof Error ? error.message : "unknown browser window diagnostic error").slice(0, 300);
    evidence.decision = evidence.decision === "passive-only" ? "PASSIVE_CAPTURE_FAILED" : "UNRESOLVED_WINDOW_DIAGNOSTICS";
  } finally {
    for (const [label, session] of [["page CDP session", pageCdp], ["browser CDP session", browserCdp]]) {
      if (!session) continue;
      try { await session.detach(); }
      catch (error) { evidence.cleanupErrors.push({ action: `detach ${label}`, errorName: safeErrorName(error) }); }
    }
    if (evidence.cleanupErrors.length > 0) evidence.status = "unresolved";
  }
  return evidence;
}

function inferBrowserBoundsCssScale(bounds, page) {
  const dpr = page?.devicePixelRatio;
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0 || !Number.isFinite(dpr) || dpr <= 0) {
    return { status: "unknown", reason: "window bounds or device scale was not finite" };
  }
  const references = [
    { name: "outer-window", width: page.outerWidth, height: page.outerHeight },
    { name: "screen", width: page.screen?.width, height: page.screen?.height },
  ].filter(reference => Number.isFinite(reference.width) && Number.isFinite(reference.height)
    && reference.width > 0 && reference.height > 0);
  const scales = [...new Set([1, dpr])];
  const matches = [];
  for (const scale of scales) {
    const matchingReferences = references.filter(reference =>
      Math.abs(bounds.width / scale - reference.width) <= 2
      && Math.abs(bounds.height / scale - reference.height) <= 2);
    if (matchingReferences.length > 0) matches.push({ scale, references: matchingReferences.map(reference => reference.name) });
  }
  if (matches.length !== 1) {
    return { status: "unknown", reason: matches.length === 0 ? "browser bounds did not match outer or screen CSS dimensions" : "browser bounds matched multiple coordinate scales", matches };
  }
  return { status: "known", browserBoundsUnitsPerCssPixel: matches[0].scale, matchedPageDimensions: matches[0].references };
}

function pageViewportUnchanged(beforePage, afterPage, beforeLayout, afterLayout) {
  const equalFields = (before, after, fields) => fields.every(field =>
    Number.isFinite(before?.[field]) && Number.isFinite(after?.[field]) && before[field] === after[field]);
  return equalFields(beforePage, afterPage, ["innerWidth", "innerHeight", "devicePixelRatio"])
    && equalFields(beforePage.visualViewport, afterPage.visualViewport, ["width", "height", "scale"])
    && equalFields(beforeLayout.cssLayoutViewport, afterLayout.cssLayoutViewport, ["clientWidth", "clientHeight"])
    && equalFields(beforeLayout.cssVisualViewport, afterLayout.cssVisualViewport, ["clientWidth", "clientHeight", "scale"]);
}

async function captureTouchShapeSample(context, { chromium, chromiumProcess = { status: "not-requested" }, gateway, workspace, ledger, browserContexts, spec, matchedProductGeometry }) {
  const record = {
    schemaVersion: 1,
    id: spec.id,
    surface: spec.surface,
    classification: "DIAGNOSTIC_ONLY",
    status: "starting",
    input: {
      inputSource: spec.inputSource ?? "existing-local-trusted-touch-dispatch",
      start: spec.start, end: spec.end, moves: 12, force: 0.8,
      pacing: spec.inputSource === "synthesize-scroll-touch" ? "CDP Input.synthesizeScrollGesture; browser command completion followed by bounded stable-frame sampling" : "await one browser animation frame after each trusted touchmove",
      offsetWrites: 0,
    },
    chromiumProcess,
    windowDiagnostics: null,
    browserContext: null,
    before: null,
    startPoint: null,
    endPoint: null,
    events: null,
    after: null,
    outcome: null,
    gates: {},
    cleanupErrors: [],
  };
  let page = null;
  let selector = null;
  let nativeRouteUrl = null;
  let nativeRouteHandler = null;
  let stage = "context-creation";
  try {
    page = await chromium.newPage(MOBILE_PAGE_OPTIONS);
    const playwrightContext = page.context();
    const contextWasFresh = !browserContexts.has(playwrightContext);
    browserContexts.add(playwrightContext);
    page.setDefaultTimeout(15_000);
    context.addCleanup("close touch-shape page " + spec.id, async () => {
      if (page && !page.isClosed()) await page.close();
    });
    const cookiesBeforeNavigation = await playwrightContext.cookies();
    record.browserContext = {
      ordinal: browserContexts.size,
      uniqueObject: contextWasFresh,
      initialUrl: page.url(),
      initialCookieCount: cookiesBeforeNavigation.length,
      pageCloseClosesFreshBrowserContext: true,
    };
    assert.equal(contextWasFresh, true, "each shape sample must use a distinct fresh BrowserContext");
    assert.equal(page.url(), "about:blank", "each fresh touch-shape page must start at about:blank");
    assert.equal(cookiesBeforeNavigation.length, 0, "fresh browser context must start without inherited cookies");

    await installOwnedNetworkGuards(page, gateway.baseUrl, ledger);
    page.on("pageerror", () => { ledger.pageErrors += 1; });
    page.on("console", message => { if (message.type() === "error") ledger.consoleErrors += 1; });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (url.origin !== new URL(gateway.baseUrl).origin || !url.pathname.startsWith("/mobile/")) return;
        if (ledger.mobileHttpResponses.length >= MAX_NETWORK_EVENTS) { ledger.httpResponseOverflow += 1; return; }
        ledger.mobileHttpResponses.push({ path: safePath(url.pathname), status: response.status(), resourceType: response.request().resourceType() });
      } catch { ledger.httpResponseOverflow += 1; }
    });

    stage = "surface-setup";
    if (spec.surface === "sessions") {
      await installMockThreadListWebSocket(page, gateway, workspace, ledger);
      await connectThroughWelcome(page, gateway);
      await enterSessions(page);
      const row = await firstVisibleSessionRow(page);
      record.route = { origin: new URL(page.url()).origin, pathname: new URL(page.url()).pathname };
      record.mockFixture = { mode: "KCODER_STUDIO_MOCK=1", appFacingThreadList: "bounded thread/list WebSocket fixture", firstVisibleRowTestId: row.testId };
      selector = '[data-testid="sessions-list"]';
    } else {
      assert.ok(matchedProductGeometry, "native overflow control requires measured Sessions geometry from the first sample");
      const html = buildTouchShapeNativeDocument(matchedProductGeometry);
      const htmlBytes = Buffer.from(html, "utf8");
      const fixtureHash = sha256(htmlBytes);
      const routePath = "/__e2e_touch_shape_native_" + fixtureHash + ".html";
      nativeRouteUrl = new URL(routePath, new URL(gateway.baseUrl).origin).toString();
      record.nativeFixture = {
        classification: "test-only plain DOM overflow page fulfilled for one exact same-origin GET; not part of the Mobile app or Gateway export",
        path: routePath,
        bodySha256: fixtureHash,
        requestCount: 0,
        fulfilledCount: 0,
        rejectedRequestCount: 0,
        credentialsObserved: false,
      };
      const routeEvidence = record.nativeFixture;
      nativeRouteHandler = async route => {
        const request = route.request();
        let requestUrl = null;
        try { requestUrl = new URL(request.url()); } catch { /* reject below */ }
        const headers = request.headers();
        routeEvidence.credentialsObserved ||= Boolean(headers.cookie || headers.authorization);
        if (request.url() !== nativeRouteUrl || request.method() !== "GET" || request.resourceType() !== "document"
          || !requestUrl || requestUrl.origin !== new URL(gateway.baseUrl).origin) {
          routeEvidence.rejectedRequestCount += 1;
          await route.abort("blockedbyclient");
          return;
        }
        routeEvidence.requestCount += 1;
        if (routeEvidence.requestCount !== 1) {
          routeEvidence.rejectedRequestCount += 1;
          await route.abort("blockedbyclient");
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          body: htmlBytes,
        });
        routeEvidence.fulfilledCount += 1;
      };
      await page.route(nativeRouteUrl, nativeRouteHandler);
      await page.goto(nativeRouteUrl, { waitUntil: "domcontentloaded" });
      assert.equal(routeEvidence.requestCount, 1);
      assert.equal(routeEvidence.fulfilledCount, 1);
      assert.equal(routeEvidence.rejectedRequestCount, 0);
      assert.equal(routeEvidence.credentialsObserved, false);
      selector = "#native-touch-scrollport";
    }

    stage = "browser-window-diagnostics";
    record.windowDiagnostics = CURSOR_INPUT_SOURCE_DIAGNOSTIC
      ? await captureAndPrepareGestureWindow({
        browser: chromium.browser,
        page,
        context,
        start: spec.start,
        end: spec.end,
        prepareForSynthesizedInput: spec.inputSource === "synthesize-scroll-touch",
      })
      : { status: "not-requested", decision: "outside-window-bounds-diagnostic", cleanupErrors: [] };
    for (const error of record.windowDiagnostics.cleanupErrors ?? []) record.cleanupErrors.push(error);

    stage = "passive-observer-setup";
    await installTouchShapeProbe(page, selector);
    record.before = await readTouchShapeMetrics(page, selector);
    record.startPoint = await readTouchShapePoint(page, selector, spec.start);
    record.endPoint = await readTouchShapePoint(page, selector, spec.end);
    const exactViewport = record.before.viewport.width === MOBILE_PAGE_OPTIONS.viewport.width
      && record.before.viewport.height === MOBILE_PAGE_OPTIONS.viewport.height
      && record.before.viewport.devicePixelRatio === MOBILE_PAGE_OPTIONS.deviceScaleFactor
      && record.before.viewport.maxTouchPoints > 0;
    const scrollport = record.before.scrollport;
    const startEndInside = pointInsideBox(spec.start, scrollport.box) && pointInsideBox(spec.end, scrollport.box)
      && record.startPoint.hit.withinScrollport && record.endPoint.hit.withinScrollport;
    const naturalInitialZero = scrollport.scrollTop === 0;
    const realScrollRange = scrollport.scrollHeight > scrollport.clientHeight;
    let nativeGeometryMatchesSessions = true;
    if (spec.surface === "sessions" && matchedProductGeometry) {
      nativeGeometryMatchesSessions = sameScrollportGeometry(scrollport, matchedProductGeometry);
    } else if (spec.surface === "native-overflow") {
      nativeGeometryMatchesSessions = sameScrollportGeometry(scrollport, matchedProductGeometry)
        && scrollport.scrollHeight >= matchedProductGeometry.scrollHeight;
    }
    record.gates = {
      freshBrowserContext: contextWasFresh,
      fixedMobileViewport: exactViewport,
      naturalInitialScrollTopZero: naturalInitialZero,
      realScrollRange,
      startAndEndInsideScrollport: startEndInside,
      nativeGeometryMatchesSessions,
      nativeFixtureRequestExact: spec.surface !== "native-overflow" || record.nativeFixture?.requestCount === 1
        && record.nativeFixture?.fulfilledCount === 1 && record.nativeFixture?.rejectedRequestCount === 0
        && record.nativeFixture?.credentialsObserved === false,
      actualChromiumArgvCaptured: chromiumProcess.status === "captured",
      windowCoordinatesResolved: spec.inputSource !== "synthesize-scroll-touch"
        || record.windowDiagnostics?.status === "resolved" && record.windowDiagnostics?.windowContainsGesture === true
          && record.windowDiagnostics?.viewportStableAfterResize === true,
    };
    assert.equal(exactViewport, true, "touch-shape browser viewport must match the pinned mobile dimensions");
    assert.equal(naturalInitialZero, true, "each fresh context must begin at natural scrollTop 0; no offset is written");
    assert.equal(realScrollRange, true, "surface must have sufficient natural overflow content");
    assert.equal(startEndInside, true, "the exact touch coordinates must remain inside the measured scrollport");
    assert.equal(nativeGeometryMatchesSessions, true, "native overflow control must match measured Sessions geometry/content");
    if (spec.inputSource === "synthesize-scroll-touch" && !record.gates.windowCoordinatesResolved) {
      record.status = "UNRESOLVED_WINDOW_COORDINATES";
      record.errorMessage = "window bounds or CSS coordinate mapping could not be verified; synthesized input was not dispatched";
      record.events = await readTouchShapeProbe(page);
      record.after = await readTouchShapeMetrics(page, selector);
      record.stability = { status: "NOT_RUN", reason: "window coordinates unresolved" };
      return record;
    }
    await resetTouchShapeProbe(page, spec.id);
    stage = "trusted-touch-dispatch";
    if (spec.inputSource === "synthesize-scroll-touch") {
      record.input.cdpParameters = { x: spec.start.x, y: spec.start.y,
        xDistance: spec.end.x - spec.start.x, yDistance: spec.end.y - spec.start.y,
        preventFling: true, gestureSourceType: "touch" };
      record.dispatch = await dispatchSynthesizedTouchScroll(page, spec.start, spec.end, context.abortSignal);
      record.stability = await waitForStableScrollportAfterCommand(page, selector);
    } else if (spec.inputSource === "shared-touch-helper") {
      record.dispatch = await dispatchTrustedTouchDrag(page, { start: spec.start, end: spec.end, moves: 12,
        force: 0.8, waitForAnimationFrame: true, animationFrameTimeoutMs: 1_000 }, context.abortSignal);
      record.stability = await waitForStableTouchShapeScroll(page, selector);
    } else {
      record.dispatch = await dispatchTrustedTouch(page, { start: spec.start, end: spec.end, moves: 12, force: 0.8 });
      record.stability = await waitForStableTouchShapeScroll(page, selector);
    }
    stage = "stable-scroll-observation";
    record.after = await readTouchShapeMetrics(page, selector);
    record.events = await readTouchShapeProbe(page);
    const touchTypes = ["touchstart", "touchmove", "touchend"];
    const trustedTouchStartMoveEnd = touchTypes.every(type => ["capture", "bubble"].every(phase =>
      record.events.touchEvents.some(event => event.type === type && event.phase === phase && event.trusted && event.targetWithinScrollport)));
    const collectorsComplete = record.events.droppedTouchEvents === 0 && record.events.droppedScrollEvents === 0;
    const stableAfterTouchEnd = record.stability?.stableFrames >= 2;
    const stableAfterInput = record.stability?.stableFrames >= 2;
    const scrollDelta = record.after.scrollport.scrollTop - record.before.scrollport.scrollTop;
    const trustedScrollEventCount = record.events.scrollEvents.filter(event => event.trusted).length;
    record.gates = {
      ...record.gates,
      trustedTouchStartMoveEnd,
      trustedScrollEventObserved: trustedScrollEventCount > 0,
      collectorsComplete,
      stableAfterTouchEnd,
      stableAfterInput,
      ...(spec.inputSource === "synthesize-scroll-touch" ? { synthesizedTouchCommandCompleted: record.dispatch?.status === "dispatched" } : {}),
    };
    record.outcome = {
      scrollDelta,
      absScrollDelta: Math.abs(scrollDelta),
      scrollChanged: Math.abs(scrollDelta) > 1,
      trustedScrollEventCount,
      scrollOutcome: Math.abs(scrollDelta) > 1 ? "SCROLLED" : "NO_SCROLL",
      windowScrollDelta: {
        x: record.after.viewport.scrollX - record.before.viewport.scrollX,
        y: record.after.viewport.scrollY - record.before.viewport.scrollY,
      },
    };
    record.status = spec.inputSource === "synthesize-scroll-touch"
      ? record.gates.synthesizedTouchCommandCompleted && record.gates.windowCoordinatesResolved
        && collectorsComplete && stableAfterInput ? "observed" : "UNVERIFIED_INPUT"
      : trustedTouchStartMoveEnd && collectorsComplete && stableAfterTouchEnd ? "observed" : "UNVERIFIED_INPUT";
  } catch (error) {
    record.status = stage === "surface-setup" || stage === "context-creation" || stage === "passive-observer-setup"
      ? "INVALID_SETUP" : "CAPTURE_ERROR";
    record.errorName = safeErrorName(error);
    record.errorMessage = context.redactText(error instanceof Error ? error.message : "Unknown error").slice(0, 300);
  } finally {
    if (nativeRouteUrl && nativeRouteHandler && page) {
      try {
        await page.unroute(nativeRouteUrl, nativeRouteHandler);
        record.nativeFixtureUnrouteCompleted = true;
      } catch (error) {
        record.nativeFixtureUnrouteCompleted = false;
        record.cleanupErrors.push({ action: "unroute exact native fixture", errorName: safeErrorName(error) });
      }
    }
    if (page && !page.isClosed()) {
      try {
        await page.close();
        record.browserContext.pageClosed = page.isClosed();
      } catch (error) {
        record.cleanupErrors.push({ action: "close fresh browser context page", errorName: safeErrorName(error) });
      }
    } else if (record.browserContext) {
      record.browserContext.pageClosed = true;
    }
    if (record.cleanupErrors.length > 0) record.status = "CLEANUP_ERROR";
  }
  return record;
}

function buildTouchShapeNativeDocument(sessionsScrollport) {
  const box = sessionsScrollport.box;
  const width = Math.round(sessionsScrollport.clientWidth);
  const height = Math.round(sessionsScrollport.clientHeight);
  const contentHeight = Math.max(height + 1, Math.round(sessionsScrollport.scrollHeight));
  const left = Number(box.x.toFixed(2));
  const top = Number(box.y.toFixed(2));
  return [
    "<!doctype html>",
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    "<style>",
    "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}",
    "#native-touch-scrollport{position:fixed;left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height + "px;box-sizing:border-box;overflow-x:hidden;overflow-y:auto;touch-action:auto;overscroll-behavior-y:auto;pointer-events:auto;-webkit-overflow-scrolling:touch}",
    "#native-touch-content{width:100%;height:" + contentHeight + "px;background:linear-gradient(#fff,#ddd)}",
    "</style></head><body>",
    '<div id="native-touch-scrollport" data-testid="native-touch-scrollport"><div id="native-touch-content"></div></div>',
    "</body></html>",
  ].join("");
}

async function installTouchShapeProbe(page, selector) {
  await page.evaluate(({ key, selector, maxTouchEvents, maxScrollEvents }) => {
    const state = { selector, phase: "setup", touchEvents: [], scrollEvents: [], droppedTouchEvents: 0, droppedScrollEvents: 0 };
    const save = (list, droppedKey, maximum, row) => {
      if (list.length >= maximum) state[droppedKey] += 1;
      else list.push(row);
    };
    const describe = node => {
      if (!(node instanceof Element)) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName,
        id: node.id || null,
        testId: node.getAttribute("data-testid"),
        role: node.getAttribute("role"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        touchAction: style.touchAction,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        pointerEvents: style.pointerEvents,
        overscrollBehaviorY: style.overscrollBehaviorY,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      };
    };
    const selected = () => document.querySelector(state.selector);
    const touchInfo = (event, phase) => {
      const target = event.target instanceof Element ? event.target : null;
      const port = selected();
      const point = event.touches?.[0] ?? event.changedTouches?.[0] ?? null;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const composedPath = path.filter(node => node instanceof Element).slice(0, 12).map(describe);
      const ancestors = [];
      for (let node = target; node instanceof Element && ancestors.length < 12; node = node.parentElement) {
        ancestors.push(describe(node));
        if (node === port) break;
      }
      return {
        type: event.type,
        phase,
        atPageMs: performance.now(),
        trusted: event.isTrusted,
        cancelable: event.cancelable,
        defaultPrevented: event.defaultPrevented,
        x: point?.clientX ?? null,
        y: point?.clientY ?? null,
        target: describe(target),
        targetWithinScrollport: Boolean(port && target && port.contains(target)),
        composedPath,
        ancestors,
      };
    };
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      document.addEventListener(type, event => save(state.touchEvents, "droppedTouchEvents", maxTouchEvents, touchInfo(event, "capture")), { capture: true, passive: true });
      document.addEventListener(type, event => save(state.touchEvents, "droppedTouchEvents", maxTouchEvents, touchInfo(event, "bubble")), { capture: false, passive: true });
    }
    const scrollInfo = event => {
      const target = event.target instanceof Element ? event.target : null;
      const port = selected();
      if (!target || !port || !(target === port || port.contains(target) || target.contains(port))) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      save(state.scrollEvents, "droppedScrollEvents", maxScrollEvents, {
        atPageMs: performance.now(),
        trusted: event.isTrusted,
        target: describe(target),
        targetContainsPort: target.contains(port),
        composedPath: path.filter(node => node instanceof Element).slice(0, 12).map(describe),
        scrollport: describe(port),
      });
    };
    document.addEventListener("scroll", scrollInfo, { capture: true, passive: true });
    Object.defineProperty(window, key, { value: state, configurable: true });
  }, { key: TOUCH_SHAPE_PROBE_KEY, selector, maxTouchEvents: MAX_TOUCH_EVENTS, maxScrollEvents: MAX_SCROLL_EVENTS });
}

async function resetTouchShapeProbe(page, phase) {
  await page.evaluate(({ key, phase }) => {
    const state = window[key];
    state.phase = phase;
    state.touchEvents.length = 0;
    state.scrollEvents.length = 0;
    state.droppedTouchEvents = 0;
    state.droppedScrollEvents = 0;
  }, { key: TOUCH_SHAPE_PROBE_KEY, phase });
}

async function readTouchShapeProbe(page) {
  return page.evaluate(key => {
    const state = window[key];
    return {
      touchEvents: state.touchEvents.slice(),
      scrollEvents: state.scrollEvents.slice(),
      droppedTouchEvents: state.droppedTouchEvents,
      droppedScrollEvents: state.droppedScrollEvents,
    };
  }, TOUCH_SHAPE_PROBE_KEY);
}

async function readTouchShapeMetrics(page, selector) {
  return page.locator(selector).evaluate(port => {
    const describe = node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName,
        id: node.id || null,
        testId: node.getAttribute("data-testid"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        touchAction: style.touchAction,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        pointerEvents: style.pointerEvents,
        overscrollBehaviorY: style.overscrollBehaviorY,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      };
    };
    const ancestors = [];
    for (let node = port; node instanceof Element && ancestors.length < 12; node = node.parentElement) ancestors.push(describe(node));
    const rect = port.getBoundingClientRect();
    return {
      viewport: {
        width: innerWidth, height: innerHeight, devicePixelRatio,
        maxTouchPoints: Number(navigator.maxTouchPoints) || 0,
        scrollX, scrollY,
      },
      scrollport: describe(port),
      scrollportBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scrollAncestors: ancestors,
    };
  });
}

async function readTouchShapePoint(page, selector, point) {
  return page.evaluate(({ selector, point }) => {
    const port = document.querySelector(selector);
    const hit = document.elementFromPoint(point.x, point.y);
    const describe = node => {
      if (!(node instanceof Element)) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName,
        id: node.id || null,
        testId: node.getAttribute("data-testid"),
        role: node.getAttribute("role"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        touchAction: style.touchAction,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        pointerEvents: style.pointerEvents,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      };
    };
    const path = [];
    for (let node = hit; node instanceof Element && path.length < 12; node = node.parentElement) {
      path.push(describe(node));
      if (node === port) break;
    }
    const rect = port?.getBoundingClientRect();
    return {
      point,
      hit: { path, withinScrollport: Boolean(hit && port && port.contains(hit)) },
      pointInsideScrollport: Boolean(rect && point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom),
    };
  }, { selector, point });
}

async function waitForStableTouchShapeScroll(page, selector) {
  return page.evaluate(({ selector, key }) => new Promise(resolveStable => {
    const started = performance.now();
    let previous = null;
    let stableFrames = 0;
    let latest = null;
    const frame = () => {
      const port = document.querySelector(selector);
      const state = window[key];
      latest = port ? { scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight } : null;
      const ended = state?.touchEvents.some(event => event.type === "touchend" && event.phase === "bubble");
      if (ended) {
        if (previous && latest && previous.scrollTop === latest.scrollTop
          && previous.scrollHeight === latest.scrollHeight && previous.clientHeight === latest.clientHeight) stableFrames += 1;
        else stableFrames = 0;
      }
      if (stableFrames >= 2 || performance.now() - started >= 1500) {
        resolveStable({ stableFrames, elapsedMs: performance.now() - started, scrollport: latest });
      } else {
        previous = latest;
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
  }), { selector, key: TOUCH_SHAPE_PROBE_KEY });
}

async function waitForStableScrollportAfterCommand(page, selector, timeoutMs = 1_500) {
  return page.evaluate(({ selector, timeoutMs }) => new Promise(resolveStable => {
    const started = performance.now();
    let previous = null;
    let stableFrames = 0;
    let latest = null;
    let finished = false;
    let timer;
    const finish = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveStable({ stableFrames, elapsedMs: performance.now() - started, reason, scrollport: latest });
    };
    const frame = () => {
      const port = document.querySelector(selector);
      latest = port ? { scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight } : null;
      if (previous && latest && previous.scrollTop === latest.scrollTop
        && previous.scrollHeight === latest.scrollHeight && previous.clientHeight === latest.clientHeight) stableFrames += 1;
      else stableFrames = 0;
      if (stableFrames >= 2) finish("two-stable-animation-frames");
      else if (performance.now() - started >= timeoutMs) finish("bounded-timeout");
      else { previous = latest; requestAnimationFrame(frame); }
    };
    timer = setTimeout(() => finish("bounded-timeout"), timeoutMs);
    requestAnimationFrame(frame);
  }), { selector, timeoutMs });
}

function pointInsideBox(point, box) {
  return Boolean(box && point.x >= box.x && point.x < box.x + box.width
    && point.y >= box.y && point.y < box.y + box.height);
}

function sameScrollportGeometry(actual, reference) {
  return Boolean(actual && reference
    && actual.box.x === reference.box.x && actual.box.y === reference.box.y
    && actual.clientWidth === reference.clientWidth && actual.clientHeight === reference.clientHeight
    && actual.scrollHeight === reference.scrollHeight);
}

async function enterSessions(page) {
  await visible(page, "sessions").waitFor({ state: "visible", timeout: 30_000 });
  await visible(page, "sessions").click();
  await visible(page, "sessions-list").waitFor({ state: "visible", timeout: 30_000 });
}

async function readProfileIdentity(page, gatewayBaseUrl) {
  const currentUrl = new URL(page.url());
  assert.equal(currentUrl.origin, new URL(gatewayBaseUrl).origin, "profile identity must come from the owned Gateway route");
  assert.equal(currentUrl.pathname, "/mobile/sessions", "the actual route must be the official Mobile Sessions route");
  const profileIds = currentUrl.searchParams.getAll("profileId");
  assert.equal(profileIds.length, 1, "the actual Sessions URL must carry exactly one profile owner");
  const id = profileIds[0];
  assert.ok(id.length > 0, "profile id from the actual Sessions route must not be empty");
  return { id, origin: currentUrl.origin, pathname: currentUrl.pathname };
}



async function reloadSessions(page, gatewayUrl) {
  const expectedOrigin = new URL(gatewayUrl).origin;
  assert.equal(new URL(page.url()).origin, expectedOrigin, "page must remain on the owned Gateway origin");
  await page.goto(new URL("/mobile/", expectedOrigin).toString(), { waitUntil: "domcontentloaded" });
  await enterSessions(page);
}

async function firstVisibleSessionRow(page) {
  const rows = page.locator('[data-testid^="session-touch-session-"]:visible');
  await rows.first().waitFor({ state: "visible", timeout: 20_000 });
  const testId = await rows.first().getAttribute("data-testid");
  assert.ok(typeof testId === "string" && testId.startsWith(TARGET_ROW_PREFIX), "a mock thread row must be visible in Sessions");
  return { testId };
}

async function captureSessionsTouchCase(page, context, { rowTestId, workspace, name, targetKind }) {
  const record = { name, source: "actual current Sessions screen", targetKind, status: "starting", geometry: null, before: null, after: null, events: null, gates: {} };
  let stage = "setup";
  try {
    await installTouchProbe(page, '[data-testid="sessions-list"]');
    const geometry = await readSessionsTouchGeometry(page, rowTestId, workspace);
    record.geometry = geometry;
    assert.equal(geometry.gates?.clippedTextFound, true, "current workspace path must resolve to the real clipped Sessions text");
    assert.equal(geometry.gates?.clippedTargetPathFound, true, "the measured clipped text must have a bounded path within its actual row");
    assert.equal(geometry.gates?.clippedPointWithinList, true, "clipped text touch point must be inside the Sessions list");
    const point = targetKind === "clipped-text" ? geometry.clippedPoint : geometry.gap?.point;
    assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), "requested Sessions geometry point is unavailable");
    if (targetKind === "row-gap") {
      assert.equal(geometry.gates?.gapFound, true, "actual row must expose a measurable gap point");
      assert.equal(geometry.gates?.gapPointWithinList, true, "row gap touch point must be inside the Sessions list");
      assert.equal(geometry.gap?.hitNotClippedTarget, true, "measured gap must not hit the clipped cwd text");
    }
    assert.ok(Array.isArray(geometry.clippedTargetPath), "the measured clipped Sessions target must have a stable row-relative path");
    const startHit = await readHitAt(page, {
      x: point.x,
      y: point.y,
      rowTestId,
      workspace,
      clippedTargetPath: geometry.clippedTargetPath,
    });
    record.startHit = startHit;
    assert.equal(startHit.clippedTargetFound, true, "independent hit-test must resolve the same current clipped text element");
    assert.equal(startHit.measuredTargetPathResolved, true, "independent hit-test must resolve the exact measured clipped node by its row-relative path");
    assert.equal(startHit.pointWithinList, true, "touch start point must be within the live Sessions list rectangle");
    if (targetKind === "clipped-text") {
      assert.equal(startHit.hitWithinExpectedRow, true, "clipped text hit must belong to the selected Sessions row");
      assert.equal(startHit.hitMatchesClippedTarget, true, "touch start must hit the measured clipped text");
    }
    else {
      assert.equal(startHit.hitWithinExpectedRow, true, "gap touch start must remain inside the measured Sessions row");
      assert.equal(startHit.hitNotClippedTarget, true, "gap touch start must not hit the actual clipped cwd text");
    }
    const listBox = geometry.scrollport.box;
    const travel = Math.min(240, Math.max(80, point.y - listBox.top - 28));
    const end = { x: point.x, y: Math.max(listBox.top + 16, point.y - travel) };
    assert.ok(end.y < point.y && end.y < listBox.bottom, "touch path must have a visible upward movement inside Sessions list");
    record.gesture = { kind: "trusted CDP Input.dispatchTouchEvent", start: point, end, moves: 12, domOffsetWrites: 0 };
    record.before = await readScrollport(page, '[data-testid="sessions-list"]');
    assert.equal(record.before.viewport.width, MOBILE_PAGE_OPTIONS.viewport.width, "touch case viewport width differs from the pinned mobile viewport");
    assert.equal(record.before.viewport.height, MOBILE_PAGE_OPTIONS.viewport.height, "touch case viewport height differs from the pinned mobile viewport");
    assert.equal(record.before.viewport.devicePixelRatio, MOBILE_PAGE_OPTIONS.deviceScaleFactor, "touch case device scale differs from the pinned mobile viewport");
    assert.ok(record.before.scrollHeight > record.before.clientHeight, "actual Sessions list must have a real scroll range before touch");
    await resetTouchProbe(page, name);
    stage = "trusted-touch-dispatch";
    await dispatchTrustedTouch(page, record.gesture);
    stage = "post-touch-observation";
    record.after = await waitForStableScroll(page, '[data-testid="sessions-list"]');
    record.events = await readTouchProbe(page);
    record.gates = touchGates(record.before, record.after, record.events, '[data-testid="sessions-list"]');
    record.status = classifyTouchObservation(record.gates);
    record.interpretation = record.status === "OBSERVED_NO_SCROLL" ? "trusted touch was captured but the scroll offset did not change; cause remains UNVERIFIED" : null;
    if (record.status !== "observed") await saveTouchFailureScreenshot(page, context, record, name + "-failure.png");
  } catch (error) {
    record.status = stage === "setup" ? "INVALID_SETUP" : "CAPTURE_ERROR";
    record.errorName = safeErrorName(error);
    record.errorMessage = context.redactText(error instanceof Error ? error.message : "Unknown error").slice(0, 300);
    record.stageEvidence = { before: record.before, after: record.after, geometry: record.geometry, events: record.events };
    try {
      const path = context.pathInArtifacts(name + "-failure.png");
      await page.screenshot({ path, fullPage: false });
      record.screenshot = path;
    } catch (screenshotError) {
      record.screenshotErrorName = safeErrorName(screenshotError);
    }
  }
  return record;
}

async function captureRnwViewControl(page, context, rowTestId, bundle, workspace) {
  const record = { name: "same-page-rnw-non-pressable-view", source: "test-only RNW ScrollView/View/Pressable fixture overlay", status: "starting", gates: {} };
  let routeHandler = null;
  let scriptUrl = null;
  let mounted = false;
  let cleanupErrors = [];
  let stage = "setup";
  try {
    const product = await readSessionsTouchGeometry(page, rowTestId, workspace);
    record.productGeometry = product;
    assert.equal(product.gates?.clippedTextFound, true, "current workspace path must resolve before aligning the RNW control");
    const productPoint = product.clippedPoint;
    assert.ok(productPoint && Number.isFinite(productPoint.x) && Number.isFinite(productPoint.y), "product text point is required to align the RNW control");
    const gatewayOrigin = new URL(page.url()).origin;
    const currentUrl = new URL(page.url());
    assert.equal(currentUrl.origin, gatewayOrigin);
    const bytes = await readFile(bundle.path);
    assert.equal(sha256(bytes), bundle.evidence.bundleSha256, "RNW fixture bundle changed before serving");
    const scriptPath = "/__e2e_current_sessions_rnw_view_" + bundle.evidence.bundleSha256 + ".js";
    scriptUrl = new URL(scriptPath, gatewayOrigin).toString();
    routeHandler = async route => {
      const request = route.request();
      if (request.url() !== scriptUrl || request.method() !== "GET" || request.resourceType() !== "script") {
        record.fixtureRouteRejected = (record.fixtureRouteRejected ?? 0) + 1;
        await route.abort("blockedbyclient");
        return;
      }
      record.fixtureRouteRequests = (record.fixtureRouteRequests ?? 0) + 1;
      if (record.fixtureRouteRequests !== 1) {
        record.fixtureRouteDuplicate = (record.fixtureRouteDuplicate ?? 0) + 1;
        await route.abort("blockedbyclient");
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: bytes });
      record.fixtureRouteBodySha256 = sha256(bytes);
    };
    await page.route(scriptUrl, routeHandler);
    await page.addScriptTag({ url: scriptUrl });
    assert.equal(record.fixtureRouteRequests, 1, "exact same-origin RNW test script must be requested once");
    assert.equal(record.fixtureRouteRejected ?? 0, 0, "no unexpected request may use the RNW fixture route");
    await page.evaluate(() => window.KCoderRnwSessionsTouchControlBundle.mountRnwTouchControl("non-pressable-same-action"));
    mounted = true;
    const alignment = await page.evaluate(({ listSelector, rowTestId: expectedRow, targetPoint }) => {
      const productList = document.querySelector(listSelector);
      const overlay = document.querySelector('[data-testid="rnw-control-overlay"]');
      const outer = document.querySelector('[data-testid="rnw-control-outer"]');
      const list = document.querySelector('[data-testid="rnw-control-scrollport"]');
      const target = document.querySelector('[data-testid="rnw-control-clipped-text"]');
      const row = document.querySelector('[data-testid="rnw-control-row-3"]');
      if (![productList, overlay, outer, list, target, row].every(value => value instanceof Element)) return { ready: false };
      const productRect = productList.getBoundingClientRect();
      for (const element of [overlay, outer, list]) {
        element.style.left = "0px";
        element.style.top = "0px";
        element.style.width = productList.clientWidth + "px";
        element.style.height = productList.clientHeight + "px";
      }
      overlay.style.left = productRect.left + "px";
      overlay.style.top = productRect.top + "px";
      overlay.style.width = productList.clientWidth + "px";
      overlay.style.height = productList.clientHeight + "px";
      const beforeTarget = target.getBoundingClientRect();
      const dx = targetPoint.x - (beforeTarget.left + beforeTarget.width / 2);
      const dy = targetPoint.y - (beforeTarget.top + beforeTarget.height / 2);
      row.style.transform = "translate(" + dx + "px, " + dy + "px)";
      const targetRect = target.getBoundingClientRect();
      const hit = document.elementFromPoint(targetPoint.x, targetPoint.y);
      const hitRow = hit?.closest('[data-testid="rnw-control-row-3"]') ?? null;
      const styles = getComputedStyle(list);
      return {
        ready: true,
        productList: { x: productRect.x, y: productRect.y, width: productList.clientWidth, height: productList.clientHeight, scrollTop: productList.scrollTop },
        controlScrollport: { x: list.getBoundingClientRect().x, y: list.getBoundingClientRect().y, width: list.clientWidth, height: list.clientHeight, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, overflowY: styles.overflowY, touchAction: styles.touchAction },
        requestedPoint: targetPoint,
        targetRect: { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height },
        targetCenterError: { x: targetRect.x + targetRect.width / 2 - targetPoint.x, y: targetRect.y + targetRect.height / 2 - targetPoint.y },
        hitTarget: hit === target || target.contains(hit),
        hitRowTestId: hitRow?.getAttribute("data-testid") ?? null,
        hitNonPressableRow: hitRow?.tagName === "DIV" && !hitRow.hasAttribute("role"),
        sameListBox: Math.abs(productRect.x - list.getBoundingClientRect().x) <= 1 && Math.abs(productRect.y - list.getBoundingClientRect().y) <= 1 && productList.clientWidth === list.clientWidth && productList.clientHeight === list.clientHeight,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        requestedRowTestId: expectedRow,
      };
    }, { listSelector: '[data-testid="sessions-list"]', rowTestId, targetPoint: productPoint });
    record.alignment = alignment;
    assert.equal(alignment.ready, true);
    assert.equal(alignment.sameListBox, true, "RNW control scrollport must share the actual Sessions list viewport geometry");
    assert.equal(alignment.hitTarget, true, "aligned RNW control touch point must hit its clipped text");
    assert.equal(alignment.hitNonPressableRow, true, "control target must be inside a non-Pressable RNW View row");
    assert.ok(Math.abs(alignment.targetCenterError.x) <= 1 && Math.abs(alignment.targetCenterError.y) <= 1, "RNW control target must align to the product text point within 1 CSS px");
    assert.ok(alignment.controlScrollport.scrollHeight > alignment.controlScrollport.height, "RNW control must have a real scroll range");

    await installTouchProbe(page, '[data-testid="rnw-control-scrollport"]');
    const targetPoint = productPoint;
    const listBox = alignment.productList;
    const travel = Math.min(240, Math.max(80, targetPoint.y - listBox.y - 28));
    const end = { x: targetPoint.x, y: Math.max(listBox.y + 16, targetPoint.y - travel) };
    record.gesture = { kind: "trusted CDP Input.dispatchTouchEvent", start: targetPoint, end, moves: 12, domOffsetWrites: 0 };
    record.before = await readScrollport(page, '[data-testid="rnw-control-scrollport"]');
    assert.equal(record.before.viewport.width, MOBILE_PAGE_OPTIONS.viewport.width, "RNW control viewport width differs from the pinned mobile viewport");
    assert.equal(record.before.viewport.height, MOBILE_PAGE_OPTIONS.viewport.height, "RNW control viewport height differs from the pinned mobile viewport");
    assert.equal(record.before.viewport.devicePixelRatio, MOBILE_PAGE_OPTIONS.deviceScaleFactor, "RNW control device scale differs from the pinned mobile viewport");
    assert.ok(record.before.scrollHeight > record.before.clientHeight, "RNW control scrollport must have a real scroll range before touch");
    await resetTouchProbe(page, record.name);
    stage = "trusted-touch-dispatch";
    await dispatchTrustedTouch(page, record.gesture);
    stage = "post-touch-observation";
    record.after = await waitForStableScroll(page, '[data-testid="rnw-control-scrollport"]');
    record.events = await readTouchProbe(page);
    record.gates = touchGates(record.before, record.after, record.events, '[data-testid="rnw-control-scrollport"]');
    record.fixtureState = await page.evaluate(() => {
      const fixture = window.__kcoderRnwSessionsTouchControl;
      return fixture ? {
        mode: fixture.mode,
        pressCount: fixture.state.pressCount,
        pressLifecycle: fixture.state.pressLifecycle.slice(0, 32),
        scrollViewResponderEvents: fixture.state.scrollViewResponderEvents.slice(0, 32),
      } : null;
    });
    record.gates.nonPressableView = record.fixtureState?.mode === "non-pressable-same-action" && record.fixtureState?.pressCount === 0;
    assert.equal(record.gates.nonPressableView, true, "RNW control must receive no Pressable activation on the non-Pressable View row");
    record.status = classifyTouchObservation(record.gates);
    record.interpretation = record.status === "OBSERVED_NO_SCROLL" ? "trusted touch was captured but the RNW scroll offset did not change; cause remains UNVERIFIED" : null;
    if (record.status !== "observed") await saveTouchFailureScreenshot(page, context, record, "same-page-rnw-non-pressable-view-failure.png");
  } catch (error) {
    record.status = stage === "setup" ? "INVALID_SETUP" : "CAPTURE_ERROR";
    record.errorName = safeErrorName(error);
    record.errorMessage = context.redactText(error instanceof Error ? error.message : "Unknown error").slice(0, 300);
    try {
      const path = context.pathInArtifacts("same-page-rnw-non-pressable-view-failure.png");
      await page.screenshot({ path, fullPage: false });
      record.screenshot = path;
    } catch (screenshotError) {
      record.screenshotErrorName = safeErrorName(screenshotError);
    }
  } finally {
    if (mounted) {
      try { await page.evaluate(() => window.__kcoderRnwSessionsTouchControl?.unmount()); }
      catch { cleanupErrors.push("fixture-unmount"); }
    }
    if (routeHandler && scriptUrl) {
      try { await page.unroute(scriptUrl, routeHandler); record.unrouteCompleted = true; }
      catch { cleanupErrors.push("fixture-unroute"); record.unrouteCompleted = false; }
    }
    record.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length > 0 && record.status === "observed") record.status = "CLEANUP_ERROR";
  }
  return record;
}

async function readSessionsTouchGeometry(page, rowTestId, workspace) {
  return page.evaluate(({ rowTestId, workspace }) => {
    const list = document.querySelector('[data-testid="sessions-list"]');
    const row = document.querySelector('[data-testid="' + CSS.escape(rowTestId) + '"]');
    if (!list || !row) return { gates: { listFound: Boolean(list), rowFound: Boolean(row) } };
    const describe = element => {
      if (!(element instanceof Element)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { tag: element.tagName, testId: element.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        role: element.getAttribute("role"), className: typeof element.className === "string" ? element.className.slice(0, 120) : null,
        box: { x: rect.x, y: rect.y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        overflowX: style.overflowX, overflowY: style.overflowY, touchAction: style.touchAction, pointerEvents: style.pointerEvents,
        scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    };
    const rowRelativeElementPath = (root, element) => {
      const path = [];
      let node = element;
      while (node && node !== root && path.length < 32) {
        const parent = node.parentElement;
        if (!parent) return null;
        const index = Array.prototype.indexOf.call(parent.children, node);
        if (index < 0) return null;
        path.unshift(index);
        node = parent;
      }
      return node === root ? path : null;
    };
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const target = [...row.querySelectorAll("*")].map(element => ({ element, info: describe(element) }))
      .filter(value => value.info && value.info.box.height > 0 && value.info.box.height <= 24 && value.info.box.width >= 80 &&
        (value.info.overflowX === "hidden" || value.info.overflowY === "hidden") && (value.element.textContent ?? "").includes(workspace))
      .sort((left, right) => right.info.box.width - left.info.box.width)[0];
    if (!target) return { gates: { listFound: true, rowFound: true, clippedTextFound: false }, scrollport: describe(list), row: describe(row) };
    const clipped = target.element;
    const clippedTargetPath = rowRelativeElementPath(row, clipped);
    const clippedRect = clipped.getBoundingClientRect();
    const clippedPoint = { x: clippedRect.left + clippedRect.width / 2, y: clippedRect.top + clippedRect.height / 2 };
    const clipHit = document.elementFromPoint(clippedPoint.x, clippedPoint.y);
    let gap = null;
    for (let branch = clipped; branch && branch !== row && !gap; branch = branch.parentElement) {
      const branchRect = branch.getBoundingClientRect();
      const siblings = [...(branch.parentElement?.children ?? [])].filter(sibling => sibling !== branch).map(sibling => {
        const rect = sibling.getBoundingClientRect();
        return { sibling, rect, overlapTop: Math.max(branchRect.top, rect.top), overlapBottom: Math.min(branchRect.bottom, rect.bottom) };
      });
      const left = siblings.filter(item => item.overlapBottom > item.overlapTop && item.rect.right <= branchRect.left + 1)
        .sort((a, b) => b.rect.right - a.rect.right)[0];
      if (left && branchRect.left > left.rect.right) {
        const x = (left.rect.right + branchRect.left) / 2;
        const y = (left.overlapTop + left.overlapBottom) / 2;
        const hit = document.elementFromPoint(x, y);
        gap = { point: { x, y }, geometry: { left: left.rect.right, right: branchRect.left, overlapTop: left.overlapTop, overlapBottom: left.overlapBottom }, hit: describe(hit),
          hitWithinRow: Boolean(hit && row.contains(hit)), hitNotClippedTarget: Boolean(hit && !(hit === clipped || clipped.contains(hit))) };
      }
    }
    const listBox = { x: listRect.x, y: listRect.y, left: listRect.left, top: listRect.top, right: listRect.right, bottom: listRect.bottom, width: list.clientWidth, height: list.clientHeight };
    const pointWithinList = point => Boolean(point && point.x >= listRect.left && point.x < listRect.right && point.y >= listRect.top && point.y < listRect.bottom);
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, maxTouchPoints: Number(navigator.maxTouchPoints) || 0 },
      scrollport: { ...describe(list), box: listBox }, row: describe(row), clippedTarget: target.info,
      clippedTargetPath,
      clippedPoint: { ...clippedPoint, hitMatchesClippedTarget: clipHit === clipped || clipped.contains(clipHit), hitWithinRow: Boolean(clipHit && row.contains(clipHit)), hit: describe(clipHit) },
      gap: gap ? { ...gap, pointWithinList: pointWithinList(gap.point) } : null,
      gates: { listFound: true, rowFound: true, clippedTextFound: true, clippedTargetPathFound: Array.isArray(clippedTargetPath), clippedPointWithinList: pointWithinList(clippedPoint), gapFound: Boolean(gap), gapPointWithinList: pointWithinList(gap?.point), rowWithinList: rowRect.bottom > listRect.top && rowRect.top < listRect.bottom },
    };
  }, { rowTestId, workspace });
}

async function installTouchProbe(page, selector) {
  await page.evaluate(({ key, selector, maxTouchEvents, maxScrollEvents }) => {
    let state = window[key];
    if (!state) {
      state = { phase: "idle", touchEvents: [], scrollEvents: [], droppedTouchEvents: 0, droppedScrollEvents: 0 };
      const save = (items, droppedKey, maximum, row) => { if (items.length >= maximum) state[droppedKey] += 1; else items.push(row); };
      const selected = () => document.querySelector(state.selector);
      const targetInfo = event => {
        const target = event.target instanceof Element ? event.target : null;
        const port = selected();
        const touch = event.touches?.[0] ?? event.changedTouches?.[0] ?? null;
        return { type: event.type, trusted: event.isTrusted, phase: state.phase,
          targetTag: target?.tagName ?? null, targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
          targetWithinScrollport: Boolean(port && target && port.contains(target)), x: touch?.clientX ?? null, y: touch?.clientY ?? null,
          defaultPrevented: event.defaultPrevented, cancelable: event.cancelable };
      };
      for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) document.addEventListener(type, event => {
        save(state.touchEvents, "droppedTouchEvents", maxTouchEvents, targetInfo(event));
      }, { capture: true, passive: true });
      document.addEventListener("scroll", event => {
        const target = event.target instanceof Element ? event.target : null;
        const port = selected();
        if (!port || !target || !(port === target || port.contains(target) || target.contains(port))) return;
        save(state.scrollEvents, "droppedScrollEvents", maxScrollEvents, { trusted: event.isTrusted, phase: state.phase,
          targetTag: target.tagName, targetTestId: target.getAttribute("data-testid"),
          scrollportScrollTop: port.scrollTop, scrollportScrollHeight: port.scrollHeight, scrollportClientHeight: port.clientHeight });
      }, { capture: true, passive: true });
      Object.defineProperty(window, key, { value: state });
    }
    state.selector = selector;
  }, { key: TOUCH_PROBE_KEY, selector, maxTouchEvents: MAX_TOUCH_EVENTS, maxScrollEvents: MAX_SCROLL_EVENTS });
}

async function resetTouchProbe(page, phase) {
  await page.evaluate(({ key, phase }) => {
    const state = window[key];
    state.phase = phase;
    state.touchEvents.length = 0;
    state.scrollEvents.length = 0;
    state.droppedTouchEvents = 0;
    state.droppedScrollEvents = 0;
  }, { key: TOUCH_PROBE_KEY, phase });
}

async function readTouchProbe(page) {
  return page.evaluate(key => {
    const state = window[key];
    return { touchEvents: state.touchEvents.slice(), scrollEvents: state.scrollEvents.slice(),
      droppedTouchEvents: state.droppedTouchEvents, droppedScrollEvents: state.droppedScrollEvents };
  }, TOUCH_PROBE_KEY);
}

async function readHitAt(page, { x, y, rowTestId, workspace, clippedTargetPath }) {
  return page.evaluate(({ x, y, rowTestId, workspace, clippedTargetPath }) => {
    const list = document.querySelector('[data-testid="sessions-list"]');
    const expectedRow = document.querySelector('[data-testid="' + CSS.escape(rowTestId) + '"]');
    const point = document.elementFromPoint(x, y);
    const hitRow = point?.closest('[data-testid^="session-touch-session-"]') ?? null;
    const style = point ? getComputedStyle(point) : null;
    let clipped = expectedRow;
    if (!Array.isArray(clippedTargetPath) || clippedTargetPath.length > 32) clipped = null;
    else for (const childIndex of clippedTargetPath) {
      if (!Number.isInteger(childIndex) || childIndex < 0 || !clipped?.children?.[childIndex]) { clipped = null; break; }
      clipped = clipped.children[childIndex];
    }
    const clippedRect = clipped instanceof Element ? clipped.getBoundingClientRect() : null;
    const clippedStyle = clipped instanceof Element ? getComputedStyle(clipped) : null;
    const clippedTargetFound = Boolean(clipped instanceof Element && clippedRect.height > 0 && clippedRect.height <= 24
      && clippedRect.width >= 80 && (clippedStyle.overflowX === "hidden" || clippedStyle.overflowY === "hidden")
      && (clipped.textContent ?? "").includes(workspace));
    const measuredTargetBox = clippedTargetFound ? {
      x: clippedRect.x, y: clippedRect.y, width: clippedRect.width, height: clippedRect.height,
    } : null;
    return { x, y, hitTag: point?.tagName ?? null, hitTestId: point?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
      hitClassName: typeof point?.className === "string" ? point.className.slice(0, 120) : null,
      hitWithinExpectedRow: Boolean(point && expectedRow && expectedRow.contains(point)),
      hitWithinAnyFixtureRow: Boolean(point && hitRow),
      clippedTargetFound,
      measuredTargetPathResolved: Boolean(clippedTargetFound && (clipped === expectedRow || expectedRow?.contains(clipped))),
      measuredTargetBox,
      hitNotClippedTarget: Boolean(point && clippedTargetFound && point !== clipped && !clipped.contains(point)),
      hitMatchesClippedTarget: Boolean(point && clippedTargetFound && (point === clipped || clipped.contains(point))),
      pointWithinList: Boolean(list && x >= list.getBoundingClientRect().left && x < list.getBoundingClientRect().right && y >= list.getBoundingClientRect().top && y < list.getBoundingClientRect().bottom),
      touchAction: style?.touchAction ?? null, pointerEvents: style?.pointerEvents ?? null,
      scrollAncestorTestIds: (() => { const result = []; for (let node = point; node instanceof Element && result.length < 12; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 1) result.push({ testId: node.getAttribute("data-testid"), scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY });
      } return result; })() };
  }, { x, y, rowTestId, workspace, clippedTargetPath });
}

async function readScrollport(page, selector) {
  return page.locator(selector).evaluate(port => {
    const rect = port.getBoundingClientRect();
    const style = getComputedStyle(port);
    return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, maxTouchPoints: Number(navigator.maxTouchPoints) || 0 },
      scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight,
      scrollLeft: port.scrollLeft, scrollWidth: port.scrollWidth, clientWidth: port.clientWidth,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, overflowY: style.overflowY, touchAction: style.touchAction };
  });
}

async function waitForStableScroll(page, selector) {
  return page.evaluate(({ selector, key }) => new Promise(resolveStable => {
    const started = performance.now();
    let previous = null;
    let stableFrames = 0;
    let latest = null;
    const frame = () => {
      const port = document.querySelector(selector);
      const state = window[key];
      latest = port ? { scrollTop: port.scrollTop, scrollHeight: port.scrollHeight, clientHeight: port.clientHeight } : null;
      if (state?.touchEvents.some(event => event.phase && event.type === "touchend")) {
        if (previous && latest && previous.scrollTop === latest.scrollTop && previous.scrollHeight === latest.scrollHeight && previous.clientHeight === latest.clientHeight) stableFrames += 1;
        else stableFrames = 0;
      }
      if (stableFrames >= 2 || performance.now() - started >= 1500) resolveStable({ stableFrames, elapsedMs: performance.now() - started, scrollport: latest });
      else { previous = latest; requestAnimationFrame(frame); }
    };
    requestAnimationFrame(frame);
  }), { selector, key: TOUCH_PROBE_KEY });
}

function touchGates(before, afterResult, events, selector) {
  const after = afterResult?.scrollport;
  const touch = events?.touchEvents ?? [];
  const scroll = events?.scrollEvents ?? [];
  const has = type => touch.some(event => event.type === type && event.trusted && event.targetWithinScrollport);
  const beforeTop = before?.scrollTop;
  const afterTop = after?.scrollTop;
  return {
    actualViewport: before?.viewport?.width === MOBILE_PAGE_OPTIONS.viewport.width
      && before?.viewport?.height === MOBILE_PAGE_OPTIONS.viewport.height
      && before?.viewport?.devicePixelRatio === MOBILE_PAGE_OPTIONS.deviceScaleFactor,
    realScrollRange: Number.isFinite(before?.scrollHeight) && Number.isFinite(before?.clientHeight) && before.scrollHeight > before.clientHeight,
    trustedTouchStartInsidePort: has("touchstart"),
    trustedTouchMoveInsidePort: has("touchmove"),
    trustedTouchEndInsidePort: has("touchend"),
    trustedTouchSequence: has("touchstart") && has("touchmove") && has("touchend"),
    trustedScrollEvent: scroll.some(event => event.trusted),
    scrollChanged: Number.isFinite(beforeTop) && Number.isFinite(afterTop) && Math.abs(afterTop - beforeTop) > 1,
    stableAfterInput: afterResult?.stableFrames >= 2,
    collectorsComplete: events?.droppedTouchEvents === 0 && events?.droppedScrollEvents === 0,
    selector,
  };
}

function classifyTouchObservation(gates) {
  const inputEvidenceComplete = gates.actualViewport
    && gates.realScrollRange
    && gates.trustedTouchSequence
    && gates.trustedScrollEvent
    && gates.stableAfterInput
    && gates.collectorsComplete;
  if (!inputEvidenceComplete) return "UNVERIFIED_INPUT";
  return gates.scrollChanged ? "observed" : "OBSERVED_NO_SCROLL";
}

async function saveTouchFailureScreenshot(page, context, record, fileName) {
  try {
    const path = context.pathInArtifacts(fileName);
    await page.screenshot({ path, fullPage: false });
    record.screenshot = path;
  } catch (error) {
    record.screenshotErrorName = safeErrorName(error);
  }
}

async function dispatchTrustedTouch(page, gesture) {
  const cdp = await page.context().newCDPSession(page);
  let primaryError = null;
  let ended = false;
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: gesture.start.x, y: gesture.start.y, id: 71, force: 0.8 }] });
    for (let index = 1; index <= gesture.moves; index += 1) {
      const progress = index / gesture.moves;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
        x: gesture.start.x + (gesture.end.x - gesture.start.x) * progress,
        y: gesture.start.y + (gesture.end.y - gesture.start.y) * progress,
        id: 71,
        force: 0.8,
      }] });
      await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    ended = true;
  } catch (error) {
    primaryError = error;
  } finally {
    if (!ended) {
      try { await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); }
      catch (cleanupError) { primaryError = primaryError ? new AggregateError([primaryError, cleanupError], "touch dispatch and end cleanup failed", { cause: primaryError }) : cleanupError; }
    }
    try { await cdp.detach(); }
    catch (cleanupError) { primaryError = primaryError ? new AggregateError([primaryError, cleanupError], "touch dispatch and CDP cleanup failed", { cause: primaryError }) : cleanupError; }
  }
  if (primaryError) throw primaryError;
}

async function dispatchSynthesizedTouchScroll(page, start, end, signal) {
  const cdp = await page.context().newCDPSession(page);
  const parameters = {
    x: start.x,
    y: start.y,
    xDistance: end.x - start.x,
    yDistance: end.y - start.y,
    preventFling: true,
    gestureSourceType: "touch",
  };
  let timer;
  let abortListener;
  let response;
  let primaryError = null;
  let detachError = null;
  try {
    if (signal?.aborted) throw signal.reason || new Error("synthesized touch scroll aborted before dispatch");
    const pending = [
      cdp.send("Input.synthesizeScrollGesture", parameters),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Input.synthesizeScrollGesture exceeded 5000ms")), 5_000); }),
    ];
    if (signal) pending.push(new Promise((_, reject) => {
      abortListener = () => reject(signal.reason || new Error("synthesized touch scroll aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
    }));
    response = await Promise.race(pending);
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    try { await cdp.detach(); } catch (error) { detachError = error; }
  }
  if (primaryError && detachError) throw new AggregateError([primaryError, detachError], "synthesized scroll and CDP detach failed", { cause: primaryError });
  if (primaryError) throw primaryError;
  if (detachError) throw detachError;
  return { status: "dispatched", command: "Input.synthesizeScrollGesture", parameters,
    responseReceived: response !== undefined };
}

async function buildRnwControlBundle(context) {
  const mobileRoot = resolve(repoRoot, "apps/kcoder-studio/mobile");
  const packagePath = resolve(mobileRoot, "package.json");
  const lockPath = resolve(mobileRoot, "package-lock.json");
  const nodeModules = resolve(mobileRoot, "node_modules");
  const nodeModulesRealPath = await realpath(nodeModules);
  const packageBytes = await readFile(packagePath);
  const lockBytes = await readFile(lockPath);
  const packageJson = JSON.parse(packageBytes.toString("utf8"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const modulePins = [];
  for (const [name, version] of [["react", "19.1.0"], ["react-dom", "19.1.0"], ["react-native-web", "0.21.2"], ["esbuild", "0.28.1"]]) {
    const packageJsonPath = resolve(nodeModules, name, "package.json");
    const realPackageJsonPath = await realpath(packageJsonPath);
    const pathFromNodeModules = relative(nodeModulesRealPath, realPackageJsonPath);
    assert.ok(pathFromNodeModules && pathFromNodeModules !== ".." && !pathFromNodeModules.startsWith(".." + sep) && !isAbsolute(pathFromNodeModules), name + " package escapes Mobile node_modules");
    const bytes = await readFile(realPackageJsonPath);
    const actual = JSON.parse(bytes.toString("utf8"));
    assert.equal(actual.version, version, name + " runtime version changed");
    assert.equal(lock.packages?.["node_modules/" + name]?.version, version, name + " package-lock version changed");
    modulePins.push({ name, version, packageJsonSha256: sha256(bytes) });
  }
  assert.equal(packageJson.dependencies?.react, "19.1.0");
  assert.equal(packageJson.dependencies?.["react-dom"], "19.1.0");
  assert.equal(packageJson.dependencies?.["react-native-web"], "~0.21.0");
  assert.equal(packageJson.devDependencies?.esbuild, "^0.28.1");

  const fixturePath = resolve(repoRoot, FIXTURE_RELATIVE_PATH);
  const fixtureBytes = await readFile(fixturePath);
  const mobileRequire = createRequire(packagePath);
  const esbuild = mobileRequire("esbuild");
  assert.equal(esbuild.version, "0.28.1");
  const built = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [fixturePath],
    bundle: true,
    write: false,
    metafile: true,
    format: "iife",
    globalName: "KCoderRnwSessionsTouchControlBundle",
    platform: "browser",
    target: ["chrome120"],
    jsx: "automatic",
    alias: { "react-native": "react-native-web" },
    nodePaths: [nodeModules],
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: false,
    logLevel: "silent",
  });
  assert.equal(built.outputFiles.length, 1, "RNW control must produce exactly one in-memory browser bundle");
  const bundleBytes = Buffer.from(built.outputFiles[0].contents);
  const bundlePath = context.pathInState("rnw-touch-control.js");
  await writeFile(bundlePath, bundleBytes, { flag: "wx", mode: 0o600 });
  await chmod(bundlePath, 0o600);
  const evidence = {
    fixturePath: FIXTURE_RELATIVE_PATH,
    fixtureSha256: sha256(fixtureBytes),
    packageSha256: sha256(packageBytes),
    packageLockSha256: sha256(lockBytes),
    nodeModulesRealPathRelation: relative(repoRoot, nodeModulesRealPath),
    modulePins,
    esbuildVersion: esbuild.version,
    bundleSha256: sha256(bundleBytes),
    bundleBytes: bundleBytes.byteLength,
    buildInputCount: Object.keys(built.metafile.inputs).length,
    outputCount: built.outputFiles.length,
    classification: "test-only RNW fixture bundle, fulfilled from an exact same-owned-origin URL; not part of the official product dist",
  };
  context.addCleanup("verify RNW test fixture dependencies unchanged", async () => {
    assert.equal(sha256(await readFile(fixturePath)), evidence.fixtureSha256);
    assert.equal(sha256(await readFile(packagePath)), evidence.packageSha256);
    assert.equal(sha256(await readFile(lockPath)), evidence.packageLockSha256);
    assert.equal(await realpath(nodeModules), nodeModulesRealPath);
    for (const pin of modulePins) assert.equal(sha256(await readFile(resolve(nodeModules, pin.name, "package.json"))), pin.packageJsonSha256);
  });
  return { path: bundlePath, evidence };
}

async function installOwnedNetworkGuards(page, gatewayUrl, ledger) {
  const origin = new URL(gatewayUrl).origin;
  await page.route("**/*", async route => {
    const request = route.request();
    let url = null;
    try { url = new URL(request.url()); } catch { ledger.foreignHttpBlocked += 1; await route.abort("blockedbyclient"); return; }
    if (url.origin !== origin || url.username || url.password) {
      ledger.foreignHttpBlocked += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function installMockThreadListWebSocket(page, gateway, workspace, ledger, pagination = null) {
  const expectedBase = new URL(gateway.baseUrl);
  assert.ok(["http:", "https:"].includes(expectedBase.protocol), "owned Gateway base URL must use HTTP(S)");
  const expectedSocket = new URL(expectedBase.toString());
  expectedSocket.protocol = expectedBase.protocol === "https:" ? "wss:" : "ws:";
  expectedSocket.pathname = `${expectedBase.pathname.replace(/\/+$/, "")}/rpc`;
  const contractIdentity = { token: "static-contract-only", serverId: "touch-local", channel: "runtime", workspace: "/static/contract-workspace" };
  expectedSocket.searchParams.set("token", contractIdentity.token);
  expectedSocket.searchParams.set("server", contractIdentity.serverId);
  expectedSocket.searchParams.set("channel", contractIdentity.channel);
  expectedSocket.searchParams.set("workspace", contractIdentity.workspace);
  assert.equal(isOwnedGatewayRpcUrl(expectedSocket, gateway.baseUrl, contractIdentity), true, "the Gateway RPC HTTP→WebSocket URL contract must admit its exact owned host, port and route identity");
  const foreignSocket = new URL(expectedSocket.toString());
  foreignSocket.hostname = "192.0.2.1";
  assert.equal(isOwnedGatewayRpcUrl(foreignSocket, gateway.baseUrl, contractIdentity), false, "the WebSocket route must reject a foreign host even when the path matches");
  const foreignTokenSocket = new URL(expectedSocket.toString());
  foreignTokenSocket.searchParams.set("token", "not-the-owned-token");
  assert.equal(isOwnedGatewayRpcUrl(foreignTokenSocket, gateway.baseUrl, contractIdentity), false, "the WebSocket route must reject a mismatched token while preserving the owned route identity");
  await page.routeWebSocket("**/*", async routed => {
    ledger.websocketConnections += 1;
    const ordinal = ledger.websocketConnections;
    let url = null;
    try { url = new URL(typeof routed.url === "function" ? routed.url() : routed.url); } catch { /* rejected below */ }
    if (ordinal > MAX_WS_CONNECTIONS || !url || !isOwnedGatewayRpcUrl(url, gateway.baseUrl, {
      token: "cookie-auth",
      serverId: "touch-local",
      channel: "runtime",
      workspace,
    })) {
      ledger.websocketRejected += 1;
      await routed.close({ code: 1008, reason: "one-shot fixture permits only owned Gateway /rpc" });
      return;
    }
    const upstream = routed.connectToServer();
    const pending = new Map();
    let closed = false;
    const closeUpstream = async () => {
      if (closed) return;
      closed = true;
      pagination?.socketClosed(ordinal);
      pending.clear();
      try { await upstream.close(); } catch { ledger.websocketFixtureErrors += 1; }
    };
    routed.onClose(() => { void closeUpstream(); });
    routed.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")); }
      catch { ledger.websocketFixtureErrors += 1; return; }
      ledger.requestCount += 1;
      if (typeof frame?.method === "string" && MUTATING_METHODS.has(frame.method)) {
        ledger.forbiddenMutationRequests.push(frame.method.slice(0, 80));
        if (Object.hasOwn(frame, "id")) routed.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "mutation blocked by one-shot UI fixture" } }));
        return;
      }
      if (Object.hasOwn(frame ?? {}, "id") && typeof frame?.method === "string") {
        if (pending.size >= MAX_WS_PENDING) { ledger.websocketFixtureErrors += 1; return; }
        const params = frame.params && typeof frame.params === "object" && !Array.isArray(frame.params) ? frame.params : {};
        let routeKind = null;
        if (pagination) {
          try { routeKind = pagination.routeKind(page.url()); }
          catch { routeKind = "unknown"; }
        }
        pending.set(idKey(frame.id), { method: frame.method, params, routeKind, connectionOrdinal: ordinal,
          idFingerprint: sha256(Buffer.from(idKey(frame.id))).slice(0, 16) });
        if (frame.method === "thread/list") ledger.threadListRequests += 1;
      }
      upstream.send(raw);
    });
    upstream.onMessage(async raw => {
      let frame;
      try { frame = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")); }
      catch { ledger.websocketFixtureErrors += 1; return; }
      const request = Object.hasOwn(frame ?? {}, "id") ? pending.get(idKey(frame.id)) : null;
      if (request) pending.delete(idKey(frame.id));
      const method = request?.method ?? null;
      if (pagination && method === "thread/list") {
        const pageResult = pagination.pageFor(request.routeKind, request.params);
        if (!pageResult) {
          ledger.websocketFixtureErrors += 1;
          routed.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "unrecognized cursor fixture request" } }));
          return;
        }
        frame.result = { ...(frame.result && typeof frame.result === "object" ? frame.result : {}),
          threads: pageResult.threads, nextCursor: pageResult.nextCursor ?? null, completeness: "complete", issueCount: 0 };
        pagination.recordResponsePrepared(request, pageResult);
        if (pageResult.requestCursor) {
          const holdResult = await pagination.holdResponse(pageResult.requestCursor, {
            method: request.method,
            routeKind: request.routeKind,
            connectionOrdinal: request.connectionOrdinal,
            cursor: typeof request.params.cursor === "string" ? request.params.cursor : null,
            nextCursor: pageResult.nextCursor,
            limit: Number.isSafeInteger(request.params.limit) ? request.params.limit : null,
            requestIdFingerprint: request.idFingerprint,
            rowCount: pageResult.threads.length,
          }, () => closed);
          if (holdResult === "socket-closed" || holdResult === "not-sent" || closed) return;
        }
        if (closed) return;
        routed.send(JSON.stringify(frame));
        pagination.recordResponseSent(request, pageResult);
        ledger.threadListReplies += 1;
        return;
      }
      if (pagination && method === "thread/read" && frame?.result && typeof frame.result === "object") {
        const threadId = typeof request.params.threadId === "string" ? request.params.threadId : "";
        const thread = pagination.threadFor(threadId);
        if (thread) {
          frame.result = { ...frame.result, thread, messages: [{ id: "history-" + thread.id, role: "user",
            content: "CURSOR_HISTORY_" + thread.id, timestampMs: thread.updatedAt, blocks: [] }],
          rangeStart: 0, rangeEnd: 1, hasMoreBefore: false, beforeCursor: null };
          pagination.recordRpc("thread-read-response", { threadId, connectionOrdinal: request.connectionOrdinal, requestIdFingerprint: request.idFingerprint });
        }
      } else if (method === "thread/list" && frame?.result && typeof frame.result === "object") {
        const archived = frame.result.threads?.some(thread => thread?.archivedAt) === true;
        frame.result.threads = archived ? [] : syntheticThreads(workspace);
        frame.result.nextCursor = null;
        frame.result.completeness = "complete";
        frame.result.issueCount = 0;
        ledger.threadListReplies += 1;
      }
      routed.send(JSON.stringify(frame));
    });
  });
}

function isOwnedGatewayRpcUrl(candidate, gatewayBaseUrl, identity) {
  const base = new URL(gatewayBaseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return false;
  if (!(candidate instanceof URL) || !identity || typeof identity !== "object") return false;
  const candidateHttpProtocol = candidate.protocol === "wss:" ? "https:" : candidate.protocol === "ws:" ? "http:" : null;
  const expectedPath = `${base.pathname.replace(/\/+$/, "")}/rpc`;
  const expectedQuery = new Map([
    ["token", identity.token],
    ["server", identity.serverId],
    ["channel", identity.channel],
  ]);
  if (identity.workspace) expectedQuery.set("workspace", identity.workspace);
  const candidateEntries = [...candidate.searchParams.entries()];
  return candidateHttpProtocol === base.protocol
    && candidate.host === base.host
    && candidate.pathname === expectedPath
    && !candidate.username
    && !candidate.password
    && !candidate.hash
    && candidateEntries.length === expectedQuery.size
    && [...expectedQuery].every(([key, value]) => candidate.searchParams.getAll(key).length === 1 && candidate.searchParams.get(key) === value);
}

function syntheticThreads(workspace) {
  const now = Date.now();
  return Array.from({ length: THREAD_COUNT }, (_value, index) => ({
    id: "touch-session-" + String(index).padStart(2, "0"),
    title: "Touch fixture session " + String(index).padStart(2, "0"),
    cwd: workspace,
    status: "idle",
    model: "mock-mobile",
    createdAt: now - index * 60_000,
    updatedAt: now - index * 1000,
  }));
}























function safeDiagnosticMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\b(token|authorization|password)\b\s*[:=]\s*[^\s,;]+/ig, "$1=[redacted]").slice(0, 500);
}

async function readMatched992SourceBoundary() {
  const adapterRoot = resolve(repoRoot, MATCHED_992_SOURCE_ADAPTER_RELATIVE_PATH);
  const rootInfo = await lstat(adapterRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "matched 992 source adapter must be a real directory");
  assert.equal(await realpath(adapterRoot), adapterRoot, "matched 992 source adapter must not traverse a symlink");
  const readPinnedJson = async (name, expectedSha256, maxBytes) => {
    const path = resolve(adapterRoot, name);
    assert.equal(relative(adapterRoot, path).startsWith(".."), false, "matched source adapter metadata escaped its root");
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes, `matched source adapter ${name} must be a bounded regular file`);
    assert.equal(await realpath(path), path, `matched source adapter ${name} must not traverse a symlink`);
    const bytes = await readFile(path);
    assert.ok(bytes.length <= maxBytes, `matched source adapter ${name} exceeded its read bound`);
    assert.equal(sha256(bytes), expectedSha256, `matched source adapter ${name} SHA-256 changed`);
    return JSON.parse(bytes.toString("utf8"));
  };
  const freeze = await readPinnedJson("freeze.json", MATCHED_992_SOURCE_FREEZE_SHA256, 64 * 1024);
  const hashManifest = await readPinnedJson("sha256.json", MATCHED_992_SOURCE_ADAPTER_SHA256, 1024 * 1024);
  assert.equal(freeze.schemaVersion, 1);
  assert.equal(freeze.status, "CURRENT_SOURCE_FROZEN_FROM_COMPLETED_OFFICIAL_EXPORT");
  assert.equal(freeze.sourceCommit, MATCHED_992_SOURCE_COMMIT);
  assert.equal(freeze.sourceDigest, MATCHED_992_SOURCE_ADAPTER_SHA256);
  assert.equal(freeze.manifestDigest, MATCHED_992_SOURCE_ADAPTER_SHA256);
  assert.equal(freeze.sourceFiles, 370);
  assert.deepEqual(freeze.sourceRoots, [
    { path: "apps/kcoder-studio/mobile", gitTree: MATCHED_992_MOBILE_GIT_TREE, trackedFiles: 351 },
    { path: "apps/kcoder-studio/shared", gitTree: MATCHED_992_SHARED_GIT_TREE, trackedFiles: 19 },
  ]);
  assert.equal(Object.keys(hashManifest).length, 370, "matched 992 source adapter must list exactly 370 Git source files");
  const verified = await verifyOfficialMobileSourceSnapshot(adapterRoot, MATCHED_992_SOURCE_COMMIT, { repoRoot });
  const packageLockPath = resolve(adapterRoot, "apps/kcoder-studio/mobile/package-lock.json");
  const packageLockInfo = await lstat(packageLockPath);
  assert.ok(packageLockInfo.isFile() && !packageLockInfo.isSymbolicLink(), "matched source package lock must be a regular file");
  assert.equal(sha256(await readFile(packageLockPath)), MATCHED_992_PACKAGE_LOCK_SHA256, "matched source package lock changed");
  return {
    mode: "immutableSnapshot",
    sourceAdapterKind: "verified-git-992-source-snapshot",
    sourceSnapshotPath: MATCHED_992_SOURCE_ADAPTER_RELATIVE_PATH,
    sourceSnapshotManifestSha256: MATCHED_992_SOURCE_ADAPTER_SHA256,
    sourceAdapterFreezeSha256: MATCHED_992_SOURCE_FREEZE_SHA256,
    sourceCommit: MATCHED_992_SOURCE_COMMIT,
    sourceTreeSha256: MATCHED_992_SOURCE_ADAPTER_SHA256,
    mobileTree: MATCHED_992_MOBILE_GIT_TREE,
    sharedTree: MATCHED_992_SHARED_GIT_TREE,
    packageLockSha256: MATCHED_992_PACKAGE_LOCK_SHA256,
    verifiedGitBlobs: verified.verifiedGitBlobs,
    exactScopedSnapshot: verified.exactScopedSnapshot,
    originalOfficialExportReceipt: "NOT_READ; source adapter records its source receipt digest but no completed RunContext receipt is claimed here",
  };
}

function verifyBuilderSourceBoundary() {
  const currentHead = git(["rev-parse", "HEAD"]).trim();
  const scopedPaths = ["apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"];
  git(["diff", "--quiet", BUILDER_COMMIT, currentHead, "--", ...scopedPaths]);
  git(["diff", "--quiet", "HEAD", "--", ...scopedPaths]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...scopedPaths]).trim();
  assert.equal(untracked, "", "Mobile/Shared contains untracked source outside the official builder scope");
  return { builderCommit: BUILDER_COMMIT, currentHead, comparedPaths: scopedPaths, commitTreeEqual: true, worktreeTrackedClean: true, untrackedSources: 0, dependencyTreeImmutabilityClaimed: false };
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function idKey(value) { return typeof value + ":" + JSON.stringify(value); }
function safePath(value) { return value.split("/").filter(Boolean).slice(0, 8).join("/").slice(0, 180); }
function visible(page, testId) { return page.locator('[data-testid="' + testId + '"]:visible'); }
function safeErrorName(error) { return error instanceof Error ? error.name.slice(0, 80) : "NonError"; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
