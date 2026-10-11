// Private static candidate for a matched 336/339 public Mobile Home/Sessions
// waterfall. The owner supplies an already-paired in-memory storageState and the
// existing public Rust/Relay/Gateway lifecycle. Importing this file starts nothing.
// Static assets are fulfilled by the reviewed probe; only exact-route HTTP/WSS passes
// through the public route. This is not a pairing, handset, cellular, or Provider test.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { repoRoot } from "../harness/run-context.mjs";
import {
  createNewCatalogProbePage,
  loadFrozenMobileWebBundle,
  matchesObservedRpcPair,
} from "./mobile-public-new-catalog-dom-probe.candidate.mjs";

export const MOBILE_HOME_WATERFALL_PINS = Object.freeze({
  nodeVersion: "v22.17.0",
  nodeExecutable: "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node",
  comparison: "Mobile UI source A336 vs B339; four product paths plus three added review-test paths",
  A: Object.freeze({
    sourceRoot: "target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104",
    sourceMapPath: "target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104/sha256.json",
    sourceManifestPath: "target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104/source-manifest.json",
    sourceMetadataPath: "target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104/metadata.json",
    sourceFiles: 336,
    sourceTreeSha256: "effa93130e74c958a4fd6639e79efab1d1a8bc78bcd18648aa9f70fe26f2b233",
    sourceMapSha256: "d78b6de305d13b7a9ce24798dc8cbd5a9c8afdeae7cc133111634259d97fb916",
    sourceManifestSha256: "604d8915c48d56ac58404990183072b73db0c63abd68821a974b311b2f4924a5",
    sourceMetadataSha256: "9735c1cf961031e235a2811a6f173794b1946d4f4d9282d50566a686c0fb9d3f",
    exportRoot: "target/private-phone-ux-implementation/mobile-web-export-sessions-default-lease-20261009-062104",
    exportManifestPath: "target/private-phone-ux-implementation/mobile-web-export-sessions-default-lease-20261009-062104-manifest.json",
    exportProvenancePath: "target/private-phone-ux-implementation/mobile-web-export-sessions-default-lease-20261009-062104-provenance.json",
    exportManifestSha256: "873acb13320c76f9f770418b909a1acc34aa069e4699a567bc2385756835d7d0",
    exportProvenanceSha256: "aaccffadf796366601b1e169c53b43332748325c7f441869564f1b68b71cf7cd",
    bundleSha256: "73f068775c6d8a24f4051a1caeb05b4275f47af2cb35390704fb28aa58816689",
    bundleFileCount: 37,
  }),
  B: Object.freeze({
    sourceRoot: "target/private-phone-latency-implementation/current-mobile-default-catalog-parallel-20261009-090018",
    sourceMapPath: "target/private-phone-latency-implementation/current-mobile-default-catalog-parallel-20261009-090018/sha256.json",
    sourceManifestPath: "target/private-phone-latency-implementation/current-mobile-default-catalog-parallel-20261009-090018/source-manifest.json",
    sourceMetadataPath: "target/private-phone-latency-implementation/current-mobile-default-catalog-parallel-20261009-090018/metadata.json",
    sourceFiles: 339,
    sourceTreeSha256: "649a35cd63b42a43bb2cba9e74fdc2ba9e1586090f56507a0f4dd3cc4ad6667f",
    sourceMapSha256: "d3f7b230cd925035f3905fb67c8050964fc38bc6b5cf50965da5a52776e19ef8",
    sourceManifestSha256: "2973c553c2d40f010f7c73cb1656079cbc11634ed67e8d983a1116ce15b10c42",
    sourceMetadataSha256: "eea7e49fa96cb37ba1f2e656855fc080c9ef15c41f312652c92007c2293f7713",
    exportRoot: "target/private-phone-ux-implementation/mobile-web-export-default-catalog-parallel-20261009-090018",
    exportManifestPath: "target/private-phone-ux-implementation/mobile-web-export-default-catalog-parallel-20261009-090018-manifest.json",
    exportProvenancePath: "target/private-phone-ux-implementation/mobile-web-export-default-catalog-parallel-20261009-090018-provenance.json",
    exportManifestSha256: "af1066420b8fc817d7aeb7b713658ea8a4cfea284ad49092ff7549f41a2c7518",
    exportProvenanceSha256: "1d0e708adc8c0aa08f82ee9c54022c7d7d8435fee0b83c3e8ad2544940032d7e",
    bundleSha256: "1d00952cd276c22b1c37371e39e8719adcdee46ca724246d768d287e2479d9c7",
    bundleFileCount: 37,
  }),
  dependencyRoot: "target/private-phone-ux-implementation/mobile-dependency-input-pinned",
  dependencySourceTreeSha256: "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c",
  dependencyOwnedTreeSha256: "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29",
  productDelta: Object.freeze([
    "apps/kcoder-studio/mobile/src/app/h/[profileId]/index.tsx",
    "apps/kcoder-studio/mobile/src/app/sessions.tsx",
    "apps/kcoder-studio/mobile/src/runtime/task-runtime/workspaces.ts",
    "apps/kcoder-studio/mobile/src/state/AppContext.tsx",
  ]),
  addedReviewTests: Object.freeze([
    "apps/kcoder-studio/mobile/src/app/__tests__/default-catalog-parallel-routes.review.test.tsx",
    "apps/kcoder-studio/mobile/src/runtime/task-runtime/default-catalog-parallel.review.test.ts",
    "apps/kcoder-studio/mobile/src/state/AppContext.routine-workspace-cache.review.test.tsx",
  ]),
});

export async function loadVerifiedMobileHomeWaterfallInputs() {
  const variants = {};
  const verifiedInputPins = { dependencyRoot: MOBILE_HOME_WATERFALL_PINS.dependencyRoot,
    dependencySourceTreeSha256: MOBILE_HOME_WATERFALL_PINS.dependencySourceTreeSha256,
    dependencyOwnedTreeSha256: MOBILE_HOME_WATERFALL_PINS.dependencyOwnedTreeSha256 };
  for (const variant of ["A", "B"]) {
    const expected = MOBILE_HOME_WATERFALL_PINS[variant];
    const freezeRoot = resolve(repoRoot, expected.sourceRoot);
    const sourceRoot = resolve(freezeRoot, "source");
    await assertCanonicalDirectory(freezeRoot, `${variant} source freeze root`);
    await assertCanonicalDirectory(sourceRoot, `${variant} source payload root`);
    const mapPath = resolve(repoRoot, expected.sourceMapPath);
    const sourceManifestPath = resolve(repoRoot, expected.sourceManifestPath);
    const metadataPath = resolve(repoRoot, expected.sourceMetadataPath);
    const [mapBytes, sourceManifestBytes, metadataBytes] = await Promise.all([
      readPinnedRegular(mapPath, expected.sourceMapSha256, `${variant} source SHA map`),
      readPinnedRegular(sourceManifestPath, expected.sourceManifestSha256, `${variant} source manifest`),
      readPinnedRegular(metadataPath, expected.sourceMetadataSha256, `${variant} source metadata`),
    ]);
    const map = parseJson(mapBytes, `${variant} source SHA map`);
    const sourceManifest = parseJson(sourceManifestBytes, `${variant} source manifest`);
    const metadata = parseJson(metadataBytes, `${variant} source metadata`);
    assert.equal(metadata.status, "CURRENT_SOURCE_FROZEN_FOR_STATIC_EXPORT");
    assert.equal(metadata.sourceDigest, expected.sourceTreeSha256);
    assert.equal(metadata.sourceFiles, expected.sourceFiles);
    assert.equal(metadata.sha256MapSha256, expected.sourceMapSha256);
    assert.equal(metadata.sourceManifestSha256, expected.sourceManifestSha256);
    assert.equal(metadata.sourceUnchangedDuringFreeze, true);
    assert.equal(metadata.copiedSnapshotMatchesLiveSource, true);
    assert.equal(sourceManifest.status, "FROZEN_CURRENT_SOURCE_FOR_STATIC_WEB_EXPORT");
    assert.equal(sourceManifest.sourceDigest, expected.sourceTreeSha256);
    assert.equal(sourceManifest.fileCount, expected.sourceFiles);
    assert.equal(sourceManifest.noCredentialStateCopied, true);
    assert.equal(sourceManifest.files.length, expected.sourceFiles);
    assert.equal(Object.keys(map).length, expected.sourceFiles);
    assert.deepEqual(Object.keys(map).sort(), sourceManifest.files.map(row => row.path).sort(),
      `${variant} source map and freeze manifest paths differ`);

    const computedRoots = [];
    const allEntries = [];
    for (const root of sourceManifest.roots) {
      assert.ok(["mobile", "studio-shared"].includes(root.name), `${variant} unexpected source root`);
      assert.equal(root.destination, root.name === "mobile" ? "apps/kcoder-studio/mobile" : "apps/kcoder-studio/shared");
      const payloadRoot = resolve(sourceRoot, root.destination);
      assert.ok(payloadRoot.startsWith(`${sourceRoot}${sep}`), `${variant} source root escaped freeze`);
      await assertCanonicalDirectory(payloadRoot, `${variant} ${root.name} payload`);
      const entries = await collectFrozenFiles(payloadRoot);
      assert.equal(entries.length, root.fileCount, `${variant} ${root.name} file count`);
      assert.equal(hashJson(entries), root.sha256, `${variant} ${root.name} root digest`);
      const fullEntries = entries.map(row => ({ path: `${root.destination}/${row.path}`,
        size: row.size, sha256: row.sha256 }));
      const manifestEntries = sourceManifest.files.filter(row => row.path.startsWith(`${root.destination}/`));
      assert.deepEqual(fullEntries, manifestEntries, `${variant} ${root.name} files differ from source manifest`);
      for (const entry of fullEntries) assert.equal(map[entry.path], entry.sha256,
        `${variant} frozen file SHA differs: ${entry.path}`);
      allEntries.push(...fullEntries);
      computedRoots.push({ name: root.name, destination: root.destination, sha256: root.sha256 });
    }
    allEntries.sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(allEntries, sourceManifest.files, `${variant} complete source inventory differs`);
    assert.equal(hashJson(computedRoots), expected.sourceTreeSha256, `${variant} aggregate source digest`);

    const exportManifestPath = resolve(repoRoot, expected.exportManifestPath);
    const exportProvenancePath = resolve(repoRoot, expected.exportProvenancePath);
    const [exportManifestBytes, exportProvenanceBytes] = await Promise.all([
      readPinnedRegular(exportManifestPath, expected.exportManifestSha256, `${variant} export manifest`),
      readPinnedRegular(exportProvenancePath, expected.exportProvenanceSha256, `${variant} export provenance`),
    ]);
    const exportManifest = parseJson(exportManifestBytes, `${variant} export manifest`);
    const exportProvenance = parseJson(exportProvenanceBytes, `${variant} export provenance`);
    assert.equal(exportProvenance.status, "complete");
    assert.equal(exportProvenance.candidate.sourceDigest, expected.sourceTreeSha256);
    assert.equal(exportProvenance.candidate.sourceManifestSha256, expected.sourceManifestSha256);
    assert.equal(exportProvenance.candidate.sha256MapSha256, expected.sourceMapSha256);
    assert.equal(exportProvenance.candidate.fileCount, expected.sourceFiles);
    assert.equal(exportProvenance.candidate.sourceUnchangedBeforeCopy, true);
    assert.equal(exportProvenance.candidate.copiedSnapshotMatchesLiveSource, true);
    assert.equal(exportProvenance.candidate.sourceUnchangedAfterExport, true);
    assert.equal(exportProvenance.candidate.credentialStateCopied, false);
    assert.equal(exportProvenance.dependencies.sourceTreeSha256, MOBILE_HOME_WATERFALL_PINS.dependencySourceTreeSha256);
    assert.equal(exportProvenance.dependencies.ownedTreeSha256, MOBILE_HOME_WATERFALL_PINS.dependencyOwnedTreeSha256);
    assert.equal(exportProvenance.dependencies.unchanged, true);
    assert.equal(exportProvenance.bundle.manifestSha256, expected.exportManifestSha256);
    assert.equal(exportProvenance.bundle.bundleSha256, expected.bundleSha256);
    assert.equal(exportProvenance.bundle.fileCount, expected.bundleFileCount);
    assert.equal(exportManifest.sourceTreeSha256, expected.sourceTreeSha256);
    assert.equal(exportManifest.bundleSha256, expected.bundleSha256);
    assert.equal(exportManifest.bundleFileCount, expected.bundleFileCount);
    const bundleRoot = resolve(repoRoot, expected.exportRoot);
    const bundle = await loadFrozenMobileWebBundle(bundleRoot, exportManifestPath);
    assert.equal(bundle.sourceTreeSha256, expected.sourceTreeSha256);
    assert.equal(bundle.bundleSha256, expected.bundleSha256);
    assert.equal(bundle.bundleFileCount, expected.bundleFileCount);
    assert.equal(bundle.indexHtmlSha256, exportManifest.indexHtmlSha256);
    variants[variant] = bundle;
    verifiedInputPins[variant] = {
      sourceRoot: expected.sourceRoot,
      sourceMapPath: expected.sourceMapPath,
      sourceManifestPath: expected.sourceManifestPath,
      sourceMetadataPath: expected.sourceMetadataPath,
      sourceFiles: sourceManifest.fileCount,
      sourceTreeSha256: hashJson(computedRoots),
      sourceMapSha256: hashBytes(mapBytes),
      sourceManifestSha256: hashBytes(sourceManifestBytes),
      sourceMetadataSha256: hashBytes(metadataBytes),
      exportRoot: expected.exportRoot,
      exportManifestPath: expected.exportManifestPath,
      exportManifestSha256: hashBytes(exportManifestBytes),
      exportProvenancePath: expected.exportProvenancePath,
      exportProvenanceSha256: hashBytes(exportProvenanceBytes),
    };
  }
  assertMobileHomeWaterfallBundlePins(variants.A, variants.B, verifiedInputPins);
  return { bundleA: variants.A, bundleB: variants.B, verifiedInputPins };
}

const EXPECTED_PAIR_COUNTS = Object.freeze({ preflight: 1, explore: 10, confirm: 30 });
const EXPECTED_PUBLIC_ORIGIN = "https://hyf2333.top";
const ALLOWED_READ_REQUESTS = new Set([
  "initialize",
  "runtime.workspaces.list",
  "runtime.worktrees.list",
  "runtime.models.list",
  "thread/list",
]);
const ALLOWED_NOTIFICATIONS = new Set([
  "client-to-server:initialized",
  "server-to-client:thread/goal/updated",
]);
const CATALOG_METHODS = Object.freeze([
  "runtime.workspaces.list",
  "runtime.worktrees.list",
  "runtime.models.list",
]);
const MAX_NETWORK_SETTLE_MS = 1_500;
const RPC_QUIET_MS = 200;
const MAX_HTTP_EVENTS = 128;
const ALLOWED_HOME_HTTP = new Set(["GET /api/servers", "GET /api/servers/status"]);

export function assertMobileHomeWaterfallBundlePins(bundleA, bundleB, verifiedInputPins) {
  for (const [variant, bundle] of [["A", bundleA], ["B", bundleB]]) {
    const expected = MOBILE_HOME_WATERFALL_PINS[variant];
    assert.ok(bundle?.files instanceof Map, `${variant} bundle must come from the frozen-export loader`);
    assert.equal(bundle.sourceTreeSha256, expected.sourceTreeSha256, `${variant} source-tree pin`);
    assert.equal(bundle.bundleSha256, expected.bundleSha256, `${variant} bundle pin`);
    assert.equal(bundle.bundleFileCount, expected.bundleFileCount, `${variant} bundle count`);
    assert.equal(bundle.files.size, expected.bundleFileCount, `${variant} loaded file count`);
    assert.ok(bundle.root.endsWith(expected.exportRoot), `${variant} portable bundle root`);
    for (const key of ["sourceRoot", "sourceMapPath", "sourceManifestPath", "sourceMetadataPath",
      "sourceFiles", "sourceTreeSha256", "sourceMapSha256", "sourceManifestSha256", "sourceMetadataSha256",
      "exportRoot", "exportManifestPath", "exportManifestSha256", "exportProvenancePath", "exportProvenanceSha256"])
      assert.equal(verifiedInputPins?.[variant]?.[key], expected[key],
        `${variant} ${key} must come from the corresponding outer source/export gate`);
  }
  assert.equal(verifiedInputPins?.dependencyRoot, MOBILE_HOME_WATERFALL_PINS.dependencyRoot,
    "pinned dependency root");
  assert.equal(verifiedInputPins?.dependencySourceTreeSha256,
    MOBILE_HOME_WATERFALL_PINS.dependencySourceTreeSha256, "dependency source tree pin");
  assert.equal(verifiedInputPins?.dependencyOwnedTreeSha256,
    MOBILE_HOME_WATERFALL_PINS.dependencyOwnedTreeSha256, "owned dependency tree pin");
  assert.notEqual(bundleA.bundleSha256, bundleB.bundleSha256, "A and B must be distinct reviewed bundles");
}

/**
 * Run one preflight pair, ten exploration pairs, or thirty confirmation pairs.
 * Each variant receives a fresh browser context but reuses the same route/session
 * and the same already-running Gateway/Rust backend. Thus JavaScript caches start
 * empty per sample; the Rust/backend is warm after fixture setup and the first sample.
 */
export async function runMobileHomeWaterfallCandidate({
  runContext,
  browser,
  storageState,
  gatewayBaseUrl,
  serverId,
  workspacePath,
  rpcToken,
  bundleA,
  bundleB,
  verifiedInputPins,
  phase,
  pairCount = EXPECTED_PAIR_COUNTS[phase],
}) {
  assert.equal(process.version, MOBILE_HOME_WATERFALL_PINS.nodeVersion);
  assert.equal(process.execPath, MOBILE_HOME_WATERFALL_PINS.nodeExecutable);
  assert.ok(runContext && typeof runContext.writeArtifactJson === "function");
  assert.ok(browser && typeof browser.newContext === "function");
  assert.ok(storageState && typeof storageState === "object", "reuse the already-paired state in memory");
  assert.ok(typeof rpcToken === "string" && rpcToken.length > 0);
  assert.ok(typeof workspacePath === "string" && workspacePath.length > 0);
  assert.match(serverId, /^[A-Za-z0-9._-]{1,80}$/);
  assert.equal(phase in EXPECTED_PAIR_COUNTS, true, "phase must be preflight, explore, or confirm");
  assert.equal(pairCount, EXPECTED_PAIR_COUNTS[phase], "use the fixed sample count for this phase");
  const route = new URL(gatewayBaseUrl);
  assert.equal(route.origin, EXPECTED_PUBLIC_ORIGIN);
  assert.match(route.pathname, /^\/g\/[a-f0-9]{32}\/?$/);
  runContext.registerSecret(rpcToken);
  assertMobileHomeWaterfallBundlePins(bundleA, bundleB, verifiedInputPins);

  const pairs = [];
  for (let pairIndex = 1; pairIndex <= pairCount; pairIndex += 1) {
    const order = pairIndex % 2 === 1 ? ["A", "B"] : ["B", "A"];
    const pair = { pairIndex, order, samples: [], matchedUiContent: null, paired: false };
    for (const variant of order) {
      const sample = await runOneVariant({
        runContext,
        browser,
        storageState,
        gatewayBaseUrl,
        serverId,
        workspacePath,
        rpcToken,
        bundle: variant === "A" ? bundleA : bundleB,
        variant,
        sampleIndex: pairIndex,
      });
      pair.samples.push(sample);
      await runContext.writeArtifactJson(
        `mobile-home-waterfall-${phase}/pair-${String(pairIndex).padStart(2, "0")}-${variant}.json`,
        sample,
      );
    }
    const byVariant = Object.fromEntries(pair.samples.map(sample => [sample.variant, sample]));
    pair.matchedUiContent = {
      homeKind: byVariant.A?.screens?.home?.kind === byVariant.B?.screens?.home?.kind
        ? byVariant.A?.screens?.home?.kind ?? null : null,
      sessionsKind: byVariant.A?.screens?.sessionsFirst?.kind === byVariant.B?.screens?.sessionsFirst?.kind
        ? byVariant.A?.screens?.sessionsFirst?.kind ?? null : null,
    };
    pair.paired = pair.samples.length === 2 && pair.samples.every(sample =>
      sample.uiOutcome === "COMPLETED" && sample.networkOutcome === "COMPLETE") &&
      pair.matchedUiContent.homeKind !== null && pair.matchedUiContent.sessionsKind !== null;
    pairs.push(pair);
  }

  const result = {
    status: pairs.every(pair => pair.paired) ? "COMPLETED" : "PARTIAL",
    phase,
    pairCount,
    sampleCountPerVariant: pairCount,
    evidenceClass: "matched public dynamic API/WSS + browser DOM; one Node-paired in-memory session; locally fulfilled frozen static assets",
    limitations: [
      "not UI pairing or QR scan",
      "not public static bundle download time",
      "not physical-phone, cellular, or model-task evidence",
      "fresh browser JavaScript realm per variant; reused Gateway/Rust backend is warm",
      "Home first-visible is recorded by the page MutationObserver before the separate strict servers/status bootstrap gate completes",
      "page-to-Node event ordering is a bounded same-host monotonic estimate; events inside its measured interval remain uncertain",
      "foreground visibility refresh and the 30-second TTL boundary are NOT_RUN",
      "no injected response hold is used; 300 ms is not measured RTT",
    ],
    pins: {
      A: MOBILE_HOME_WATERFALL_PINS.A,
      B: MOBILE_HOME_WATERFALL_PINS.B,
      sourcePinsComparedToFixedExpectedValues: true,
      sourceInventoryVerificationBoundary: "caller must supply values from successful per-file source/export/dependency verification; this entry point only checks those values against the reviewed pins",
      dependencyRoot: MOBILE_HOME_WATERFALL_PINS.dependencyRoot,
      dependencySourceTreeSha256: MOBILE_HOME_WATERFALL_PINS.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: MOBILE_HOME_WATERFALL_PINS.dependencyOwnedTreeSha256,
      productDelta: MOBILE_HOME_WATERFALL_PINS.productDelta,
      addedReviewTests: MOBILE_HOME_WATERFALL_PINS.addedReviewTests,
    },
    pairCountByOutcome: {
      paired: pairs.filter(pair => pair.paired).length,
      incomplete: pairs.filter(pair => !pair.paired).length,
    },
    metrics: summarizePairs(pairs),
    pairs,
  };
  await runContext.writeArtifactJson(`mobile-home-waterfall-${phase}-summary.json`, result);
  return result;
}

async function runOneVariant({ runContext, browser, storageState, gatewayBaseUrl, serverId,
  workspacePath, rpcToken, bundle, variant, sampleIndex }) {
  const pageId = `new-${variant}-sample-${String(sampleIndex).padStart(2, "0")}`;
  const sample = {
    variant,
    sampleIndex,
    outcome: "ERROR",
    uiOutcome: "ERROR",
    networkOutcome: "UNKNOWN",
    profileSource: "same Node-paired profile state reused in memory; not UI pairing",
    backendWarmth: "same already-running Gateway/Rust process; not a cold backend",
    staticDelivery: "exact pinned bundle fulfilled locally; public static download UNMEASURED",
    fixtureRouteSameAcrossPair: true,
    pageId,
    failureClass: null,
    screens: {},
    network: {},
  };
  let probe;
  let closeFailure = null;
  let stage = "create-context";
  try {
    stage = "install-probes";
    probe = await createNewCatalogProbePage({
      runContext, browser, storageState, bundle, variant, pageId, gatewayBaseUrl, serverId,
    });
    const httpTimeline = createPublicHttpTimeline(probe.page, gatewayBaseUrl);
    await probe.page.addInitScript(installWaterfallDomObserver);
    const routeContract = [];
    let routeContractOverflow = 0;
    let pageErrorCount = 0;
    probe.page.on("pageerror", () => { pageErrorCount += 1; });
    probe.page.on("websocket", socket => {
      if (routeContract.length >= 32) { routeContractOverflow += 1; return; }
      routeContract.push(checkExpectedMobileSocket({
        rawUrl: socket.url(), gatewayBaseUrl, serverId, workspacePath, rpcToken,
      }));
    });

    stage = "home-navigation-first-content-and-strict-bootstrap";
    const homeStartNodeMs = performance.now();
    const homeBootstrapPromise = probe.openHome().then(
      () => ({ outcome: "COMPLETED", completedAtNodeMs: performance.now() }),
      error => ({ outcome: "ERROR", error, completedAtNodeMs: performance.now() }));
    const homeSurfacePromise = waitForSurface(probe.page, "home", 1, 5_000).then(async event => {
      const pageEventReadbackNodeMs = performance.now();
      let clockAlignment = null;
      let alignmentFailure = null;
      try { clockAlignment = await alignPageAndNodeClocks(probe.page, event.firstVisibleAtPageMs); }
      catch (error) { alignmentFailure = safeErrorClass(error); }
      return { outcome: "COMPLETED", event, pageEventReadbackNodeMs,
        observerReadbackNodeMs: performance.now(), clockAlignment, alignmentFailure };
    }, error => ({ outcome: "ERROR", error, observerReadbackNodeMs: performance.now(),
      clockAlignment: null, alignmentFailure: safeErrorClass(error) }));
    const homeSurface = await homeSurfacePromise;
    const homeBootstrap = await homeBootstrapPromise;
    const homeObserverReadbackNodeMs = homeSurface.observerReadbackNodeMs;
    const homeBootstrapGateNodeMs = homeBootstrap.completedAtNodeMs;
    const homeEvent = homeSurface.event ?? null;
    const homeRpcSettle = await waitForRpcQuiet(probe, MAX_NETWORK_SETTLE_MS);
    const homeHttpSettle = await waitForHttpQuiet(httpTimeline, MAX_NETWORK_SETTLE_MS);
    const homeSnapshot = { ...probe.snapshot(), httpTimeline: httpTimeline.snapshot() };
    sample.screens.home = homeEvent ? {
      kind: homeEvent.kind,
      firstVisibleAfterObserverInstallPageMs: homeEvent.firstVisibleAtPageMs - homeEvent.observerInstalledAtPageMs,
      stableAfterTwoRafAfterObserverInstallPageMs: homeEvent.twoRafAtPageMs - homeEvent.observerInstalledAtPageMs,
      firstVisibleAtPageMs: homeEvent.firstVisibleAtPageMs,
      stableAfterTwoRafAtPageMs: homeEvent.twoRafAtPageMs,
      firstVisibleNodeEstimateMs: homeSurface.clockAlignment?.firstVisibleNodeEstimateMs ?? null,
      firstVisibleNodeIntervalMs: homeSurface.clockAlignment?.firstVisibleNodeIntervalMs ?? null,
      firstVisibleAlignmentErrorBoundMs: homeSurface.clockAlignment?.errorBoundMs ?? null,
      pageToNodeClockAlignment: homeSurface.clockAlignment ?? {
        outcome: "UNAVAILABLE", reason: homeSurface.alignmentFailure ?? "page-surface-not-observed",
      },
      nodeNavigationStartMs: homeStartNodeMs,
      nodeFirstSurfaceReadbackMs: homeObserverReadbackNodeMs,
      nodeFirstSurfaceReadbackElapsedMs: homeObserverReadbackNodeMs - homeStartNodeMs,
      nodeStrictBootstrapCompletionMs: homeBootstrapGateNodeMs,
      nodeStrictBootstrapElapsedMs: homeBootstrapGateNodeMs - homeStartNodeMs,
      nodeFirstVisibleToStrictBootstrapMs: homeSurface.clockAlignment?.firstVisibleNodeEstimateMs === null ||
        homeSurface.clockAlignment?.firstVisibleNodeEstimateMs === undefined ? null
        : homeBootstrapGateNodeMs - homeSurface.clockAlignment.firstVisibleNodeEstimateMs,
      homeBootstrap: probe.homeBootstrapEvidence(),
    } : {
      kind: null, firstVisibleAtPageMs: null, stableAfterTwoRafAtPageMs: null,
      firstVisibleNodeEstimateMs: null, firstVisibleNodeIntervalMs: null,
      pageToNodeClockAlignment: { outcome: "UNAVAILABLE", reason: homeSurface.alignmentFailure ?? "home-surface-not-observed" },
      nodeNavigationStartMs: homeStartNodeMs, nodeFirstSurfaceReadbackMs: homeObserverReadbackNodeMs,
      nodeStrictBootstrapCompletionMs: homeBootstrapGateNodeMs,
      homeBootstrap: probe.homeBootstrapEvidence(),
    };
    sample.network.home = buildWindowEvidence({
      snapshot: homeSnapshot,
      startNodeMs: homeStartNodeMs,
      endNodeMs: homeObserverReadbackNodeMs,
      firstVisibleAtPageMs: homeEvent?.firstVisibleAtPageMs ?? null,
      pageClockAlignment: homeSurface.clockAlignment,
      actionDispatchStartNodeMs: null,
      actionDispatchReturnNodeMs: null,
      rpcWindowName: "navigation through the Node readback of Home first-visible MutationObserver event; bootstrap gate runs in parallel",
    });
    sample.network.home.rpcSettle = homeRpcSettle;
    sample.network.home.httpSettle = homeHttpSettle;
    if (homeSurface.outcome !== "COMPLETED") throw homeSurface.error ?? new Error("Home first-visible event was not observed");
    if (homeBootstrap.outcome !== "COMPLETED") throw homeBootstrap.error ?? new Error("Home strict bootstrap gate failed");

    stage = "sessions-first-visit";
    const sessionsFirstWindowStartNodeMs = homeObserverReadbackNodeMs;
    const sessionsFirstStartNodeMs = performance.now();
    await probe.page.getByTestId("sessions").click({ timeout: 15_000 });
    const sessionsFirstClickReturnNodeMs = performance.now();
    const sessionsFirstEvent = await waitForSurface(probe.page, "sessions", 1, 15_000);
    const sessionsFirstVisibleNodeMs = performance.now();
    const sessionsFirstRpcSettle = await waitForRpcQuiet(probe, MAX_NETWORK_SETTLE_MS);
    const sessionsFirstHttpSettle = await waitForHttpQuiet(httpTimeline, MAX_NETWORK_SETTLE_MS);
    const sessionsFirstSnapshot = { ...probe.snapshot(), httpTimeline: httpTimeline.snapshot() };
    sample.screens.sessionsFirst = {
      kind: sessionsFirstEvent.kind,
      visibleAtPageMs: sessionsFirstEvent.firstVisibleAtPageMs,
      stableAfterTwoRafAtPageMs: sessionsFirstEvent.twoRafAtPageMs,
      clickAtPageMs: sessionsFirstEvent.triggerClickAtPageMs,
      clickTrusted: sessionsFirstEvent.triggerClickTrusted,
      clickToStablePageMs: sessionsFirstEvent.triggerClickAtPageMs === null ? null
        : sessionsFirstEvent.twoRafAtPageMs - sessionsFirstEvent.triggerClickAtPageMs,
      nodeClickToPlaywrightSurfaceObservationMs: sessionsFirstVisibleNodeMs - sessionsFirstStartNodeMs,
    };
    sample.network.sessionsFirst = buildWindowEvidence({
      snapshot: sessionsFirstSnapshot,
      startNodeMs: sessionsFirstWindowStartNodeMs,
      endNodeMs: sessionsFirstVisibleNodeMs,
      firstVisibleAtPageMs: sessionsFirstEvent.firstVisibleAtPageMs,
      pageClockAlignment: homeSurface.clockAlignment,
      actionDispatchStartNodeMs: sessionsFirstStartNodeMs,
      actionDispatchReturnNodeMs: sessionsFirstClickReturnNodeMs,
      rpcWindowName: "Home sessions control → first Sessions content",
    });
    sample.network.sessionsFirst.rpcSettle = sessionsFirstRpcSettle;
    sample.network.sessionsFirst.httpSettle = sessionsFirstHttpSettle;

    stage = "return-home-visit";
    const returnHomeWindowStartNodeMs = sessionsFirstVisibleNodeMs;
    const returnHomeStartNodeMs = performance.now();
    await probe.page.getByLabel("返回", { exact: true }).click({ timeout: 15_000 });
    const returnHomeClickReturnNodeMs = performance.now();
    const homeReturnEvent = await waitForSurface(probe.page, "home", 2, 15_000);
    const homeReturnVisibleNodeMs = performance.now();
    const homeReturnRpcSettle = await waitForRpcQuiet(probe, MAX_NETWORK_SETTLE_MS);
    const homeReturnHttpSettle = await waitForHttpQuiet(httpTimeline, MAX_NETWORK_SETTLE_MS);
    const homeReturnSnapshot = { ...probe.snapshot(), httpTimeline: httpTimeline.snapshot() };
    sample.screens.homeReturn = {
      kind: homeReturnEvent.kind,
      visibleAtPageMs: homeReturnEvent.firstVisibleAtPageMs,
      stableAfterTwoRafAtPageMs: homeReturnEvent.twoRafAtPageMs,
      clickAtPageMs: homeReturnEvent.triggerClickAtPageMs,
      clickTrusted: homeReturnEvent.triggerClickTrusted,
      clickToStablePageMs: homeReturnEvent.triggerClickAtPageMs === null ? null
        : homeReturnEvent.twoRafAtPageMs - homeReturnEvent.triggerClickAtPageMs,
      nodeClickToPlaywrightSurfaceObservationMs: homeReturnVisibleNodeMs - returnHomeStartNodeMs,
    };
    sample.network.homeReturn = buildWindowEvidence({
      snapshot: homeReturnSnapshot,
      startNodeMs: returnHomeWindowStartNodeMs,
      endNodeMs: homeReturnVisibleNodeMs,
      firstVisibleAtPageMs: homeReturnEvent.firstVisibleAtPageMs,
      pageClockAlignment: homeSurface.clockAlignment,
      actionDispatchStartNodeMs: returnHomeStartNodeMs,
      actionDispatchReturnNodeMs: returnHomeClickReturnNodeMs,
      rpcWindowName: "Sessions back control → same-runtime Home revisit",
    });
    sample.network.homeReturn.rpcSettle = homeReturnRpcSettle;
    sample.network.homeReturn.httpSettle = homeReturnHttpSettle;

    stage = "sessions-warm-followup";
    const sessionsWarmWindowStartNodeMs = homeReturnVisibleNodeMs;
    const sessionsWarmStartNodeMs = performance.now();
    await probe.page.getByTestId("sessions").click({ timeout: 15_000 });
    const sessionsWarmClickReturnNodeMs = performance.now();
    const sessionsWarmEvent = await waitForSurface(probe.page, "sessions", 2, 15_000);
    const sessionsWarmVisibleNodeMs = performance.now();
    const sessionsWarmRpcSettle = await waitForRpcQuiet(probe, MAX_NETWORK_SETTLE_MS);
    const sessionsWarmHttpSettle = await waitForHttpQuiet(httpTimeline, MAX_NETWORK_SETTLE_MS);
    const sessionsWarmSnapshot = { ...probe.snapshot(), httpTimeline: httpTimeline.snapshot() };
    sample.screens.sessionsWarmFollowup = {
      kind: sessionsWarmEvent.kind,
      visibleAtPageMs: sessionsWarmEvent.firstVisibleAtPageMs,
      stableAfterTwoRafAtPageMs: sessionsWarmEvent.twoRafAtPageMs,
      clickAtPageMs: sessionsWarmEvent.triggerClickAtPageMs,
      clickTrusted: sessionsWarmEvent.triggerClickTrusted,
      clickToStablePageMs: sessionsWarmEvent.triggerClickAtPageMs === null ? null
        : sessionsWarmEvent.twoRafAtPageMs - sessionsWarmEvent.triggerClickAtPageMs,
      nodeClickToPlaywrightSurfaceObservationMs: sessionsWarmVisibleNodeMs - sessionsWarmStartNodeMs,
    };
    sample.network.sessionsWarmFollowup = buildWindowEvidence({
      snapshot: sessionsWarmSnapshot,
      startNodeMs: sessionsWarmWindowStartNodeMs,
      endNodeMs: sessionsWarmVisibleNodeMs,
      firstVisibleAtPageMs: sessionsWarmEvent.firstVisibleAtPageMs,
      pageClockAlignment: homeSurface.clockAlignment,
      actionDispatchStartNodeMs: sessionsWarmStartNodeMs,
      actionDispatchReturnNodeMs: sessionsWarmClickReturnNodeMs,
      rpcWindowName: "same-runtime second Sessions route visit; cache outcome determined from observed requests",
    });
    sample.network.sessionsWarmFollowup.rpcSettle = sessionsWarmRpcSettle;
    sample.network.sessionsWarmFollowup.httpSettle = sessionsWarmHttpSettle;

    stage = "final-observation-and-integrity";
    const finalSnapshot = { ...probe.snapshot(), httpTimeline: httpTimeline.snapshot() };
    const domTrace = await probe.page.evaluate(() => {
      const state = window.__kcoderPublicHomeWaterfall;
      return state ? {
        events: state.events.map(({ surface, kind, occurrence, firstVisibleAtPageMs, twoRafAtPageMs,
          triggerClickAtPageMs, triggerClickTrusted }) => ({ surface, kind, occurrence,
          firstVisibleAtPageMs, twoRafAtPageMs, triggerClickAtPageMs, triggerClickTrusted })),
        clicks: state.clicks.map(({ kind, trusted, atPageMs }) => ({ kind, trusted, atPageMs })),
        droppedEvents: state.droppedEvents,
        droppedClicks: state.droppedClicks,
      } : null;
    });
    sample.domTrace = domTrace;
    const homeGate = sample.screens.home.kind !== null &&
      sample.screens.home.stableAfterTwoRafAtPageMs !== null &&
      sample.screens.homeReturn.kind !== null &&
      sample.screens.homeReturn.stableAfterTwoRafAtPageMs !== null &&
      sample.screens.homeReturn.clickAtPageMs !== null && sample.screens.homeReturn.clickTrusted === true;
    const sessionsGate = sample.screens.sessionsFirst.kind !== null &&
      sample.screens.sessionsFirst.stableAfterTwoRafAtPageMs !== null &&
      sample.screens.sessionsFirst.clickAtPageMs !== null && sample.screens.sessionsFirst.clickTrusted === true &&
      sample.screens.sessionsWarmFollowup.kind !== null &&
      sample.screens.sessionsWarmFollowup.stableAfterTwoRafAtPageMs !== null &&
      sample.screens.sessionsWarmFollowup.clickAtPageMs !== null && sample.screens.sessionsWarmFollowup.clickTrusted === true;
    sample.uiOutcome = homeGate && sessionsGate && domTrace?.droppedEvents === 0 && domTrace?.droppedClicks === 0 &&
      probe.homeBootstrapEvidence()?.outcome === "COMPLETED" ? "COMPLETED" : "ERROR";
    const rpcSettleWindows = [homeRpcSettle, sessionsFirstRpcSettle, homeReturnRpcSettle, sessionsWarmRpcSettle];
    const httpSettleWindows = [homeHttpSettle, sessionsFirstHttpSettle, homeReturnHttpSettle, sessionsWarmHttpSettle];
    sample.networkOutcome = pageErrorCount === 0 &&
      networkIntegrityComplete(finalSnapshot, routeContract, routeContractOverflow, rpcSettleWindows, httpSettleWindows)
      ? "COMPLETE" : "UNKNOWN_OR_ERROR";
    sample.outcome = sample.uiOutcome === "COMPLETED" && sample.networkOutcome === "COMPLETE"
      ? "COMPLETED" : "ERROR";
    sample.network = {
      home: sample.network.home,
      sessionsFirst: sample.network.sessionsFirst,
      homeReturn: sample.network.homeReturn,
      sessionsWarmFollowup: sample.network.sessionsWarmFollowup,
      socketRouteContract: {
        count: routeContract.length,
        overflowCount: routeContractOverflow,
        checks: routeContract,
      },
      static: {
        bundleSha256: finalSnapshot.static.bundleSha256,
        sourceTreeSha256: finalSnapshot.static.sourceTreeSha256,
        bundleFileCount: finalSnapshot.static.bundleFileCount,
        fulfilledCount: finalSnapshot.static.fulfilledCount,
        staticMissCount: finalSnapshot.static.staticMissCount,
        staticAssetOverflowCount: finalSnapshot.static.staticAssetOverflowCount,
        externalRequestCount: finalSnapshot.static.externalRequestCount,
      },
      rpcIntegrity: safeRpcIntegrity(finalSnapshot),
      rpcSettleWindows,
      httpIntegrity: summarizeHttpIntegrity(finalSnapshot.httpTimeline),
      httpSettleWindows,
      pageErrorCount,
      noProviderOrTurnAssertion: finalSnapshot.rpcEvents.every(event =>
        event.kind !== "rpc-request" || ALLOWED_READ_REQUESTS.has(event.method)),
    };
  } catch (error) {
    sample.failureClass = safeErrorClass(error);
    sample.failureStage = stage;
    sample.uiOutcome = Number.isFinite(sample.screens.home?.stableAfterTwoRafAtPageMs) &&
      Number.isFinite(sample.screens.sessionsFirst?.stableAfterTwoRafAtPageMs) ? "PARTIAL" : "ERROR";
    sample.networkOutcome = "UNKNOWN_OR_ERROR";
  } finally {
    if (probe) {
      try { await probe.close(); }
      catch (error) { closeFailure = safeErrorClass(error); }
    }
  }
  sample.cleanup = { browserContextClosed: Boolean(probe) && closeFailure === null, closeFailure };
  if (closeFailure) sample.outcome = "ERROR";
  return sample;
}

async function waitForSurface(page, surface, occurrence, timeoutMs) {
  await page.waitForFunction(({ wantedSurface, wantedOccurrence }) => {
    const state = window.__kcoderPublicHomeWaterfall;
    return Boolean(state && state.events.some(event => event.surface === wantedSurface &&
      event.occurrence === wantedOccurrence && Number.isFinite(event.twoRafAtPageMs)));
  }, { wantedSurface: surface, wantedOccurrence: occurrence }, { polling: "raf", timeout: timeoutMs });
  return page.evaluate(({ wantedSurface, wantedOccurrence }) => {
    const event = window.__kcoderPublicHomeWaterfall.events.find(row =>
      row.surface === wantedSurface && row.occurrence === wantedOccurrence);
    return event ? { ...event } : null;
  }, { wantedSurface: surface, wantedOccurrence: occurrence });
}

async function assertCanonicalDirectory(path, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), path, `${label} must use its canonical path`);
}

async function readPinnedRegular(path, expectedSha256, label) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  const bytes = await readFile(path);
  assert.equal(hashBytes(bytes), expectedSha256, `${label} SHA-256 changed`);
  return bytes;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

async function collectFrozenFiles(root) {
  const entries = [];
  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `source snapshot contains a symlink: ${relative(root, path)}`);
      if (info.isDirectory()) await walk(path);
      else {
        assert.ok(info.isFile(), `source snapshot contains a special file: ${relative(root, path)}`);
        const bytes = await readFile(path);
        entries.push({ path: relative(root, path).split(sep).join("/"), size: bytes.length, sha256: hashBytes(bytes) });
      }
    }
  }
  await walk(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function hashJson(value) { return hashBytes(Buffer.from(JSON.stringify(value))); }

async function waitForRpcQuiet(probe, maxMs) {
  const startedAt = performance.now();
  let previousSignature = "";
  let lastChangeAt = startedAt;
  while (performance.now() - startedAt < maxMs) {
    const snapshot = probe.snapshot();
    const signature = `${snapshot.rpcEvents.length}:${snapshot.rpcIntegrity.pendingAtSnapshot}`;
    if (signature !== previousSignature) {
      previousSignature = signature;
      lastChangeAt = performance.now();
    } else if (performance.now() - lastChangeAt >= RPC_QUIET_MS) {
      return { outcome: snapshot.rpcIntegrity.pendingAtSnapshot === 0 ? "QUIET" : "PENDING",
        elapsedNodeMs: performance.now() - startedAt,
        pendingAtSnapshot: snapshot.rpcIntegrity.pendingAtSnapshot,
        eventCount: snapshot.rpcEvents.length };
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const snapshot = probe.snapshot();
  return { outcome: "DEADLINE", elapsedNodeMs: performance.now() - startedAt,
    pendingAtSnapshot: snapshot.rpcIntegrity.pendingAtSnapshot, eventCount: snapshot.rpcEvents.length,
    deadlineMs: maxMs };
}

function createPublicHttpTimeline(page, gatewayBaseUrl) {
  const route = new URL(gatewayBaseUrl);
  const prefix = `${route.pathname.replace(/\/$/, "")}/`;
  const byRequest = new WeakMap();
  const events = [];
  let nextOrdinal = 0;
  let overflowCount = 0;
  const capture = request => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (url.origin !== route.origin || !url.pathname.startsWith(prefix)) return;
    if (url.pathname.slice(route.pathname.replace(/\/$/, "").length) === "/rpc" &&
        request.resourceType() === "websocket") return;
    const ordinal = ++nextOrdinal;
    if (events.length >= MAX_HTTP_EVENTS) { overflowCount += 1; return; }
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method())
      ? request.method() : "OTHER";
    const rawEndpoint = url.pathname.slice(route.pathname.replace(/\/$/, "").length);
    const endpoint = ALLOWED_HOME_HTTP.has(`${method} ${rawEndpoint}`) ? rawEndpoint : "<unexpected>";
    const event = { ordinal, endpoint, method,
      requestAtNodeMs: performance.now(), completion: "PENDING", status: null,
      responseAtNodeMs: null, failureClass: null };
    events.push(event);
    byRequest.set(request, event);
  };
  page.on("request", capture);
  page.on("response", response => {
    const event = byRequest.get(response.request());
    if (!event) return;
    event.completion = "RESPONSE";
    event.status = response.status();
    event.responseAtNodeMs = performance.now();
  });
  page.on("requestfailed", request => {
    const event = byRequest.get(request);
    if (!event) return;
    event.completion = "FAILED";
    const failure = request.failure()?.errorText ?? "";
    const match = failure.match(/(?:net::)?(ERR_[A-Z0-9_]+)/);
    event.failureClass = match ? match[1] : "OTHER_NETWORK_FAILURE";
    event.responseAtNodeMs = performance.now();
  });
  return {
    snapshot() { return { events: events.map(row => ({ ...row })), overflowCount }; },
  };
}

async function waitForHttpQuiet(timeline, maxMs) {
  const startedAt = performance.now();
  let previousSignature = "";
  let lastChangeAt = startedAt;
  while (performance.now() - startedAt < maxMs) {
    const snapshot = timeline.snapshot();
    const pending = snapshot.events.filter(row => row.completion === "PENDING").length;
    const signature = `${snapshot.events.length}:${pending}:${snapshot.overflowCount}`;
    if (signature !== previousSignature) {
      previousSignature = signature;
      lastChangeAt = performance.now();
    } else if (pending === 0 && performance.now() - lastChangeAt >= RPC_QUIET_MS) {
      return { outcome: "QUIET", elapsedNodeMs: performance.now() - startedAt,
        pendingCount: 0, eventCount: snapshot.events.length, overflowCount: snapshot.overflowCount };
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const snapshot = timeline.snapshot();
  return { outcome: "DEADLINE", elapsedNodeMs: performance.now() - startedAt,
    pendingCount: snapshot.events.filter(row => row.completion === "PENDING").length,
    eventCount: snapshot.events.length, overflowCount: snapshot.overflowCount, deadlineMs: maxMs };
}

function summarizeHttpIntegrity(timelineSnapshot) {
  const events = timelineSnapshot?.events ?? [];
  const unfinished = events.filter(row => row.completion !== "RESPONSE");
  const badStatus = events.filter(row => row.completion === "RESPONSE" &&
    (!Number.isInteger(row.status) || row.status < 200 || row.status >= 300));
  const unexpected = events.filter(row => !ALLOWED_HOME_HTTP.has(`${row.method} ${row.endpoint}`));
  return {
    requestCount: events.length,
    completedResponseCount: events.filter(row => row.completion === "RESPONSE").length,
    failedOrPendingCount: unfinished.length,
    badStatusCount: badStatus.length,
    unexpectedEndpointOrMethodCount: unexpected.length,
    overflowCount: timelineSnapshot?.overflowCount ?? null,
    requests: events,
    allowedEndpoints: [...ALLOWED_HOME_HTTP],
  };
}

function buildWindowEvidence({ snapshot, startNodeMs, endNodeMs, firstVisibleAtPageMs = null,
  pageClockAlignment = null, actionDispatchStartNodeMs, actionDispatchReturnNodeMs, rpcWindowName }) {
  const requests = snapshot.rpcEvents.filter(row => row.kind === "rpc-request" &&
    row.routeOwned === true && row.atNodeMs >= startNodeMs && row.atNodeMs <= endNodeMs);
  const responses = snapshot.rpcEvents.filter(row => row.kind === "rpc-response" && row.routeOwned === true);
  const responseBySequence = new Map(responses.map(row => [`${row.routeSocketId}:${row.requestSequence}`, row]));
  const rows = requests.map(request => {
    const response = responseBySequence.get(`${request.routeSocketId}:${request.requestSequence}`) ?? null;
    const matched = response !== null && matchesObservedRpcPair(request, response);
    let sendPhase = "home-bootstrap";
    if (actionDispatchStartNodeMs !== null) {
      if (request.atNodeMs < actionDispatchStartNodeMs) sendPhase = "setup-before-click";
      else if (actionDispatchReturnNodeMs === null || request.atNodeMs < actionDispatchReturnNodeMs)
        sendPhase = "click-dispatch-boundary-unknown";
      else sendPhase = "after-click-dispatch";
    }
    return {
      routeSocketId: request.routeSocketId,
      method: request.method,
      idFingerprint: request.idFingerprint,
      requestSequence: request.requestSequence,
      requestAtNodeMs: request.atNodeMs,
      sendPhase,
      requestToFirstVisibleRelation: classifyEventAgainstFirstVisible(request.atNodeMs,
        firstVisibleAtPageMs, pageClockAlignment),
      responseMatched: matched,
      responseAtNodeMs: matched ? response.atNodeMs : null,
      responseToFirstVisibleRelation: matched ? classifyEventAgainstFirstVisible(response.atNodeMs,
        firstVisibleAtPageMs, pageClockAlignment) : "UNAVAILABLE_UNMATCHED",
      frameRoundTripObservedMs: matched ? response.elapsedNodeMs : null,
      responseShape: matched ? response.responseShape : null,
      responseError: matched ? response.error : null,
    };
  });
  const windowStart = startNodeMs;
  const windowEnd = endNodeMs;
  const http = (snapshot.httpTimeline?.events ?? []).filter(row =>
    row.requestAtNodeMs >= windowStart && row.requestAtNodeMs <= windowEnd).map(row => ({
      ...row,
      requestToFirstVisibleRelation: classifyEventAgainstFirstVisible(row.requestAtNodeMs,
        firstVisibleAtPageMs, pageClockAlignment),
      responseToFirstVisibleRelation: Number.isFinite(row.responseAtNodeMs)
        ? classifyEventAgainstFirstVisible(row.responseAtNodeMs, firstVisibleAtPageMs, pageClockAlignment)
        : "UNAVAILABLE_NO_RESPONSE",
      elapsedNodeMs: Number.isFinite(row.responseAtNodeMs)
        ? row.responseAtNodeMs - row.requestAtNodeMs : null,
    }));
  const socketOpens = snapshot.sockets.filter(row => row.kind === "rpc-socket-open" &&
    row.atNodeMs >= windowStart && row.atNodeMs <= windowEnd)
    .map(row => ({ routeSocketId: row.routeSocketId, atNodeMs: row.atNodeMs,
      toFirstVisibleRelation: classifyEventAgainstFirstVisible(row.atNodeMs, firstVisibleAtPageMs, pageClockAlignment),
      routeOwned: row.routeOwned, protocolMatches: row.protocolMatches,
      originMatches: row.originMatches, pathMatches: row.pathMatches }));
  const countsByMethod = Object.fromEntries([...new Set(rows.map(row => row.method))].sort().map(method => {
    const items = rows.filter(row => row.method === method);
    return [method, { requests: items.length, matchedResponses: items.filter(row => row.responseMatched).length,
      responseErrors: items.filter(row => row.responseError === true).length,
      routeSocketIds: [...new Set(items.map(row => row.routeSocketId))] }];
  }));
  const matched = rows.filter(row => row.responseMatched);
  const catalogResponses = matched.filter(row => CATALOG_METHODS.includes(row.method));
  const threadRequests = rows.filter(row => row.method === "thread/list");
  const firstThreadListAt = threadRequests.length > 0
    ? Math.min(...threadRequests.map(row => row.requestAtNodeMs)) : null;
  const latestSuccessfulCatalogResponseAt = catalogResponses.filter(row => !row.responseError).length > 0
    ? Math.max(...catalogResponses.filter(row => !row.responseError).map(row => row.responseAtNodeMs)) : null;
  const requestRelations = countFirstVisibleRelations(rows.map(row => row.requestToFirstVisibleRelation));
  const httpRequestRelations = countFirstVisibleRelations(http.map(row => row.requestToFirstVisibleRelation));
  const firstVisibleNodeIntervalMs = Number.isFinite(pageClockAlignment?.firstVisibleNodeIntervalMs?.lower) &&
    Number.isFinite(pageClockAlignment?.firstVisibleNodeIntervalMs?.upper)
    ? { ...pageClockAlignment.firstVisibleNodeIntervalMs } : null;
  return {
    name: rpcWindowName,
    nodeClockWindowMs: { start: startNodeMs, end: endNodeMs },
    firstContentOrdering: {
      outcome: firstVisibleNodeIntervalMs ? "BOUNDED_ESTIMATE" : "UNAVAILABLE",
      method: "page performance.now mapped by three Node-bracketed page.evaluate samples; midpoint offset with measured uncertainty",
      firstVisibleAtPageMs,
      firstVisibleNodeEstimateMs: pageClockAlignment?.firstVisibleNodeEstimateMs ?? null,
      firstVisibleNodeIntervalMs,
      alignmentRoundTripMs: pageClockAlignment?.selectedRoundTripMs ?? null,
      alignmentErrorBoundMs: pageClockAlignment?.errorBoundMs ?? null,
      alignmentAgeAtFirstVisibleMs: pageClockAlignment?.calibrationAgeMs ?? null,
      relationRule: "BEFORE/AFTER only outside the estimated Node interval; events inside it are OVERLAP_ALIGNMENT_UNCERTAINTY",
      rpcRequestRelations: requestRelations,
      httpRequestRelations,
      rpcRequestEvents: rows.map(row => ({ routeSocketId: row.routeSocketId, method: row.method,
        requestSequence: row.requestSequence, requestAtNodeMs: row.requestAtNodeMs,
        relation: row.requestToFirstVisibleRelation })),
      httpRequestEvents: http.map(row => ({ ordinal: row.ordinal, method: row.method, endpoint: row.endpoint,
        requestAtNodeMs: row.requestAtNodeMs, relation: row.requestToFirstVisibleRelation })),
      note: "Node response callback times are from Node performance.now. Page and Node raw timestamps are never directly subtracted; close/overlapping events remain uncertain.",
    },
    http,
    socketOpenCount: socketOpens.length,
    socketOpens,
    rpcRequestCount: rows.length,
    unmatchedRequestCount: rows.filter(row => !row.responseMatched).length,
    routeSocketCount: new Set(rows.map(row => row.routeSocketId)).size,
    countsByMethod,
    rpcFrames: rows,
    catalogThreadListOrder: {
      firstThreadListRequestAtNodeMs: firstThreadListAt,
      latestSuccessfulCatalogResponseAtNodeMs: latestSuccessfulCatalogResponseAt,
      threadListRequestMinusLatestCatalogResponseMs: firstThreadListAt === null || latestSuccessfulCatalogResponseAt === null
        ? null : firstThreadListAt - latestSuccessfulCatalogResponseAt,
      observedOrder: firstThreadListAt === null || latestSuccessfulCatalogResponseAt === null ? "UNAVAILABLE"
        : firstThreadListAt < latestSuccessfulCatalogResponseAt ? "thread-list-request-before-all-observed-catalog-responses"
          : "thread-list-request-after-all-observed-catalog-responses",
      note: "RPC request/response timestamps share Node performance.now. First-content order uses only the bounded page-to-Node estimate above; this is not pure network RTT",
    },
  };
}

function classifyEventAgainstFirstVisible(nodeAtMs, firstVisibleAtPageMs, alignment) {
  const interval = alignment?.firstVisibleNodeIntervalMs;
  if (!Number.isFinite(nodeAtMs) || !Number.isFinite(firstVisibleAtPageMs) ||
      !Number.isFinite(interval?.lower) || !Number.isFinite(interval?.upper)) return "UNALIGNED";
  if (nodeAtMs < interval.lower) return "BEFORE_FIRST_VISIBLE";
  if (nodeAtMs > interval.upper) return "AFTER_FIRST_VISIBLE";
  return "OVERLAP_ALIGNMENT_UNCERTAINTY";
}

function countFirstVisibleRelations(relations) {
  return Object.fromEntries(["BEFORE_FIRST_VISIBLE", "OVERLAP_ALIGNMENT_UNCERTAINTY",
    "AFTER_FIRST_VISIBLE", "UNALIGNED"].map(relation => [relation,
    relations.filter(value => value === relation).length]));
}

async function alignPageAndNodeClocks(page, firstVisibleAtPageMs) {
  assert.ok(Number.isFinite(firstVisibleAtPageMs) && firstVisibleAtPageMs >= 0,
    "first visible page timestamp must be finite");
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    const nodeBeforeMs = performance.now();
    const pageAtMs = await page.evaluate(() => performance.now());
    const nodeAfterMs = performance.now();
    assert.ok(Number.isFinite(pageAtMs) && pageAtMs >= 0 && nodeAfterMs >= nodeBeforeMs,
      "page clock sample was invalid");
    const roundTripMs = nodeAfterMs - nodeBeforeMs;
    samples.push({ sampleIndex: index + 1, nodeBeforeMs, pageAtMs, nodeAfterMs, roundTripMs,
      offsetNodeMinusPageMs: (nodeBeforeMs + nodeAfterMs) / 2 - pageAtMs });
  }
  const selected = [...samples].sort((left, right) => left.roundTripMs - right.roundTripMs)[0];
  const offsetSpreadMs = Math.max(...samples.map(row =>
    Math.abs(row.offsetNodeMinusPageMs - selected.offsetNodeMinusPageMs)));
  const errorBoundMs = selected.roundTripMs / 2 + offsetSpreadMs;
  const firstVisibleNodeEstimateMs = firstVisibleAtPageMs + selected.offsetNodeMinusPageMs;
  return {
    outcome: "BOUNDED_ESTIMATE",
    method: "3 sequential Node-bracketed page.evaluate(performance.now) samples; select lowest round trip and midpoint offset",
    clockDomains: { page: "document.performance.now", node: "node:perf_hooks.performance.now" },
    assumption: "page and Node monotonic clocks run at the same host rate during this single-page sample; offset is estimated, never treated as exact",
    samples,
    selectedSampleIndex: selected.sampleIndex,
    selectedRoundTripMs: selected.roundTripMs,
    offsetNodeMinusPageMs: selected.offsetNodeMinusPageMs,
    offsetSpreadMs,
    errorBoundMs,
    firstVisibleAtPageMs,
    calibrationPageAtMs: selected.pageAtMs,
    calibrationAgeAtFirstVisibleMs: Math.abs(selected.pageAtMs - firstVisibleAtPageMs),
    firstVisibleNodeEstimateMs,
    firstVisibleNodeIntervalMs: {
      lower: firstVisibleNodeEstimateMs - errorBoundMs,
      upper: firstVisibleNodeEstimateMs + errorBoundMs,
    },
  };
}

function networkIntegrityComplete(snapshot, socketContract, socketOverflow, rpcSettleWindows, httpSettleWindows) {
  const failures = snapshot.failClosedCounts;
  const unexpectedRequests = snapshot.rpcEvents.filter(row => row.kind === "rpc-request" &&
    row.routeOwned && !ALLOWED_READ_REQUESTS.has(row.method));
  const unexpectedNotifications = snapshot.notifications.filter(row =>
    !ALLOWED_NOTIFICATIONS.has(`${row.direction}:${row.method}`));
  const routeRequests = snapshot.rpcEvents.filter(row => row.kind === "rpc-request" && row.routeOwned === true);
  const routeResponses = snapshot.rpcEvents.filter(row => row.kind === "rpc-response" && row.routeOwned === true);
  const responseBySequence = new Map(routeResponses.map(row => [`${row.routeSocketId}:${row.requestSequence}`, row]));
  const unmatchedRequests = routeRequests.filter(request => {
    const response = responseBySequence.get(`${request.routeSocketId}:${request.requestSequence}`);
    return !response || !matchesObservedRpcPair(request, response);
  });
  const rpcResponseErrors = routeResponses.filter(row => row.responseShape === "error");
  const httpEvents = snapshot.httpTimeline?.events ?? [];
  const httpOverflow = snapshot.httpTimeline?.overflowCount ?? 1;
  const httpUnfinished = httpEvents.filter(row => row.completion !== "RESPONSE");
  const httpBadStatus = httpEvents.filter(row => row.completion === "RESPONSE" &&
    (!Number.isInteger(row.status) || row.status < 200 || row.status >= 300));
  const httpUnexpected = httpEvents.filter(row => !ALLOWED_HOME_HTTP.has(`${row.method} ${row.endpoint}`));
  const failClosedKeys = [
    "droppedEvents", "staticMissCount", "staticAssetOverflowCount", "externalRequestCount",
    "foreignGatewayCount", "foreignWebSocketCount", "pendingRpcOverflowCount",
    "duplicatePendingRpcCount", "unmatchedRpcResponseCount", "mutatingRequestCount",
    "malformedRpcFrameCount",
  ];
  const hardFailure = failClosedKeys.some(key => failures[key] !== 0) ||
    unexpectedRequests.length > 0 || unexpectedNotifications.length > 0 ||
    socketOverflow !== 0 || socketContract.length === 0 ||
    socketContract.some(row => !row.ok) || snapshot.rpcIntegrity.pendingAtSnapshot !== 0 ||
    unmatchedRequests.length > 0 || rpcResponseErrors.length > 0 ||
    httpOverflow !== 0 || httpUnfinished.length > 0 || httpBadStatus.length > 0 || httpUnexpected.length > 0 ||
    rpcSettleWindows.length !== 4 || rpcSettleWindows.some(row => row.outcome !== "QUIET" || row.pendingAtSnapshot !== 0) ||
    httpSettleWindows.length !== 4 || httpSettleWindows.some(row => row.outcome !== "QUIET" || row.pendingCount !== 0) ||
    snapshot.rpcEvents.some(row => row.kind === "rpc-request" && row.routeOwned && row.method === "thread/list") === false;
  return !hardFailure;
}

function safeRpcIntegrity(snapshot) {
  const integrity = snapshot.rpcIntegrity;
  return {
    pendingAtSnapshot: integrity.pendingAtSnapshot,
    pendingOverflowCount: integrity.pendingOverflowCount,
    duplicatePendingRpcCount: integrity.duplicatePendingRpcCount,
    unmatchedRpcResponseCount: integrity.unmatchedRpcResponseCount,
    unmatchedRequestCount: snapshot.rpcEvents.filter(row => row.kind === "rpc-request" && row.routeOwned)
      .filter(request => !snapshot.rpcEvents.some(response => response.kind === "rpc-response" &&
        response.routeSocketId === request.routeSocketId && response.requestSequence === request.requestSequence &&
        matchesObservedRpcPair(request, response))).length,
    malformedRpcFrameCount: integrity.malformedRpcFrameCount,
    mutatingRequestCount: integrity.mutatingRequestCount,
    matchedErrorResponseCount: snapshot.rpcEvents.filter(row => row.kind === "rpc-response" &&
      row.routeOwned && row.responseShape === "error").length,
    unexpectedNotificationCount: integrity.unexpectedNotificationCount,
    foreignNotificationCount: integrity.foreignNotificationCount,
    setupClassificationIncludesThreadListAsUnexpectedInNewProbe: snapshot.unexpectedRpcEvents.some(row => row.method === "thread/list"),
    classificationNote: "Home/Sessions candidate explicitly allows read-only thread/list; it does not reinterpret thread/list as a New-page catalog action",
  };
}

function checkExpectedMobileSocket({ rawUrl, gatewayBaseUrl, serverId, workspacePath, rpcToken }) {
  try {
    const socketUrl = new URL(rawUrl);
    const routeUrl = new URL(gatewayBaseUrl);
    const expectedOriginUrl = new URL(routeUrl.origin);
    expectedOriginUrl.protocol = "wss:";
    const expectedPath = `${routeUrl.pathname.replace(/\/$/, "")}/rpc`;
    const allowedQuery = new Set(["token", "server", "channel", "workspace"]);
    const queryKeys = [...socketUrl.searchParams.keys()];
    const workspacePresent = socketUrl.searchParams.has("workspace");
    const ok = socketUrl.protocol === "wss:" && socketUrl.origin === expectedOriginUrl.origin &&
      socketUrl.pathname === expectedPath && socketUrl.searchParams.get("token") === rpcToken &&
      socketUrl.searchParams.get("server") === serverId && socketUrl.searchParams.get("channel") === "runtime" &&
      (!workspacePresent || socketUrl.searchParams.get("workspace") === workspacePath) &&
      queryKeys.every(key => allowedQuery.has(key));
    return {
      ok,
      protocolMatches: socketUrl.protocol === "wss:",
      originMatches: socketUrl.origin === expectedOriginUrl.origin,
      pathMatches: socketUrl.pathname === expectedPath,
      tokenMatches: socketUrl.searchParams.get("token") === rpcToken,
      serverMatches: socketUrl.searchParams.get("server") === serverId,
      runtimeChannelMatches: socketUrl.searchParams.get("channel") === "runtime",
      workspacePresent,
      workspaceMatches: !workspacePresent || socketUrl.searchParams.get("workspace") === workspacePath,
      onlyExpectedQueryKeys: queryKeys.every(key => allowedQuery.has(key)),
    };
  } catch {
    return { ok: false, protocolMatches: false, originMatches: false, pathMatches: false,
      tokenMatches: false, serverMatches: false, runtimeChannelMatches: false,
      workspacePresent: false, workspaceMatches: false, onlyExpectedQueryKeys: false };
  }
}

function installWaterfallDomObserver() {
  const state = { events: [], clicks: [], droppedEvents: 0, droppedClicks: 0,
    observerInstalledAtPageMs: performance.now(), currentSurface: null,
    occurrenceBySurface: { home: 0, sessions: 0 } };
  const visible = element => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0;
  };
  const exactVisibleText = expected => [...document.querySelectorAll("body *")].some(element =>
    element.children.length === 0 && element.textContent?.replace(/\s+/g, " ").trim() === expected && visible(element));
  const visibleMatches = selector => [...document.querySelectorAll(selector)].filter(visible);
  const candidateForSurface = () => {
    const sessionsList = visibleMatches('[data-testid="sessions-list"]')[0];
    if (sessionsList) {
      if (visibleMatches('[role="alert"]').length > 0) return null;
      if (visibleMatches('[data-testid^="session-"]').length > 0)
        return { surface: "sessions", kind: "session-row" };
      if (exactVisibleText("暂无任务")) return { surface: "sessions", kind: "sessions-empty" };
      return null;
    }
    if (visibleMatches('[data-testid^="thread-"]').length > 0)
      return { surface: "home", kind: "home-thread-row" };
    if (exactVisibleText("在此项目新建任务"))
      return { surface: "home", kind: "home-empty-workspace-action" };
    return null;
  };
  const check = () => {
    const candidate = candidateForSurface();
    if (!candidate) { state.currentSurface = null; return; }
    if (candidate.surface === state.currentSurface) return;
    state.currentSurface = candidate.surface;
    const occurrence = ++state.occurrenceBySurface[candidate.surface];
    const triggerClick = state.clicks.find(row => row.destination === candidate.surface &&
      row.destinationOccurrence === occurrence);
    const event = { surface: candidate.surface, kind: candidate.kind, occurrence,
      firstVisibleAtPageMs: performance.now(), twoRafAtPageMs: null,
      observerInstalledAtPageMs: state.observerInstalledAtPageMs,
      triggerClickAtPageMs: triggerClick?.atPageMs ?? null,
      triggerClickTrusted: triggerClick?.trusted ?? null };
    if (state.events.length >= 16) { state.droppedEvents += 1; return; }
    state.events.push(event);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const stillVisible = candidateForSurface();
      if (state.currentSurface === candidate.surface && stillVisible?.surface === candidate.surface &&
          state.events.includes(event)) event.twoRafAtPageMs = performance.now();
    }));
  };
  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    const sessions = target?.closest('[data-testid="sessions"]');
    const back = target?.closest('[aria-label="返回"]');
    const kind = sessions ? "open-sessions" : back ? "return-home" : null;
    if (!kind) return;
    const marker = { kind, trusted: event.isTrusted, atPageMs: performance.now() };
    const eventIndex = kind === "open-sessions" ? state.occurrenceBySurface.sessions + 1 : state.occurrenceBySurface.home + 1;
    const destination = kind === "open-sessions" ? "sessions" : "home";
    marker.destination = destination;
    marker.destinationOccurrence = eventIndex;
    const pending = state.events.find(row => row.surface === destination && row.occurrence === eventIndex);
    if (pending) pending.triggerClickAtPageMs = marker.atPageMs;
    if (state.clicks.length >= 16) state.droppedClicks += 1;
    else state.clicks.push(marker);
  }, true);
  const observer = new MutationObserver(check);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window.addEventListener("popstate", check);
  window.addEventListener("hashchange", check);
  document.addEventListener("DOMContentLoaded", check, { once: true });
  Object.defineProperty(window, "__kcoderPublicHomeWaterfall", { value: state });
  requestAnimationFrame(check);
}

function summarizePairs(pairs) {
  const summarize = summarizeValues;
  const byVariant = {};
  for (const variant of ["A", "B"]) {
    const samples = pairs.flatMap(pair => pair.samples).filter(sample => sample.variant === variant);
    byVariant[variant] = {
      sampleCount: samples.length,
      completedUiCount: samples.filter(sample => sample.uiOutcome === "COMPLETED").length,
      completeNetworkCount: samples.filter(sample => sample.networkOutcome === "COMPLETE").length,
      failedOrPartialCount: samples.filter(sample => sample.outcome !== "COMPLETED").length,
      homePageStableAfterTwoRaf: summarize(samples.map(sample => sample.screens.home?.stableAfterTwoRafAtPageMs ?? NaN)),
      homePageStableAfterTwoRafAfterObserverInstall: summarize(samples.map(sample => sample.screens.home?.stableAfterTwoRafAfterObserverInstallPageMs ?? NaN)),
      sessionsPageStableAfterTwoRaf: summarize(samples.map(sample => sample.screens.sessionsFirst?.stableAfterTwoRafAtPageMs ?? NaN)),
      sessionsPageClickToStable: summarize(samples.map(sample => sample.screens.sessionsFirst?.clickToStablePageMs ?? NaN)),
      homePageFirstVisibleAfterObserverInstall: summarize(samples.map(sample => sample.screens.home?.firstVisibleAfterObserverInstallPageMs ?? NaN)),
      homeFirstVisibleNodeEstimate: summarize(samples.map(sample => sample.screens.home?.firstVisibleNodeEstimateMs ?? NaN)),
      homeFirstVisibleAlignmentErrorBound: summarize(samples.map(sample => sample.screens.home?.firstVisibleAlignmentErrorBoundMs ?? NaN)),
      homeNodeStrictBootstrapGate: summarize(samples.map(sample => sample.screens.home?.nodeStrictBootstrapElapsedMs ?? NaN)),
      sessionsNodeClickToPlaywrightObservation: summarize(samples.map(sample => sample.screens.sessionsFirst?.nodeClickToPlaywrightSurfaceObservationMs ?? NaN)),
      warmFollowupSessionsPageClickToStable: summarize(samples.map(sample => sample.screens.sessionsWarmFollowup?.clickToStablePageMs ?? NaN)),
      warmFollowupSessionsNodeClickToPlaywrightObservation: summarize(samples.map(sample => sample.screens.sessionsWarmFollowup?.nodeClickToPlaywrightSurfaceObservationMs ?? NaN)),
      rpcFrameRoundTrips: summarize(samples.flatMap(sample => ["home", "sessionsFirst", "sessionsWarmFollowup"]
        .flatMap(name => sample.network[name]?.rpcFrames ?? []))
        .filter(row => row.responseMatched).map(row => row.frameRoundTripObservedMs)),
      homeThreadListMinusLastCatalogResponse: summarize(samples.map(sample =>
        sample.network.home?.catalogThreadListOrder?.threadListRequestMinusLatestCatalogResponseMs ?? NaN)),
      dynamicHttp: summarizeHttpByEndpoint(samples),
    };
  }
  return { byVariant, pairedCompleteCount: pairs.filter(pair => pair.paired).length,
    pairedIncompleteCount: pairs.filter(pair => !pair.paired).length,
    percentileMethod: "nearest-rank: sorted[ceil(p*n)-1]",
    scope: "page DOM timestamps remain browser performance.now and RPC callbacks remain Node performance.now; a three-sample bounded midpoint alignment supplies an estimated Node interval for first-visible ordering, with overlap reported as uncertain" };
}

function summarizeHttpByEndpoint(samples) {
  const endpoints = [...ALLOWED_HOME_HTTP].map(value => value.slice(value.indexOf(" ") + 1));
  return Object.fromEntries(endpoints.map(endpoint => {
    const requests = samples.flatMap(sample => ["home", "sessionsFirst", "homeReturn", "sessionsWarmFollowup"]
      .flatMap(name => sample.network[name]?.http ?? []))
      .filter(row => row.endpoint === endpoint);
    return [endpoint, {
      sampleCount: samples.length,
      samplesWithRequest: samples.filter(sample => ["home", "sessionsFirst", "homeReturn", "sessionsWarmFollowup"]
        .some(name => (sample.network[name]?.http ?? []).some(row => row.endpoint === endpoint))).length,
      requestCount: requests.length,
      errorCount: requests.filter(row => row.completion !== "RESPONSE" || !Number.isInteger(row.status) ||
        row.status < 200 || row.status >= 300).length,
      responseElapsedMs: summarizeValues(requests.map(row => row.completion === "RESPONSE" ? row.elapsedNodeMs : NaN)),
    }];
  }));
}

function summarizeValues(rows) {
  const values = rows.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    sampleCount: rows.length,
    measuredCount: values.length,
    missingCount: rows.length - values.length,
    medianMs: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    maxMs: values.length ? values.at(-1) : null,
  };
}

function percentile(sortedValues, probability) {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(probability * sortedValues.length) - 1);
  return sortedValues[index];
}

function safeErrorClass(error) {
  const name = error?.name;
  return ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "TimeoutError", "AssertionError"].includes(name)
    ? name : "OtherError";
}
