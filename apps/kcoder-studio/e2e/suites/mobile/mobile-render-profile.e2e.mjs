import { createMobileTranscriptGestureHelpers } from "../../harness/mobile-transcript-gesture-helpers.mjs";
import { createMobileTranscriptViewportReader } from "../../harness/mobile-transcript-viewport-reader.mjs";
import { createMobileRenderProfileHelpers } from "../../harness/mobile-render-profile-helpers.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../../harness/chromium.mjs";
import { copyOfficialMobileStaticDist, inspectOfficialMobileStaticDist } from "../../harness/mobile-static-dist-input.mjs";
import { assertPathWithinApprovedRoots, readVerifiedMobileExportFile, verifyMobileExportManifestEnvelope } from "../../harness/mobile-web-export-input.mjs";
import { addOfficialMobileExportPostflight, readOfficialMobileExportReceipt } from "../../harness/official-mobile-export-receipt.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { makeCoreAttributionRecord, mapGeneratedProfilePosition, recordScriptUrlIdentity, resolveScriptMapBinding, validateCoreAttributionMode, verifyPinnedSourceInventoryBytes, verifySourceMapBundleEvidence } from "../../harness/render-profile-attribution-contract.mjs";
import { derivePinnedGitExportSourceEvidence } from "../../harness/render-profile-git-source-evidence.mjs";
import { classifyRenderProfileSourceEvidenceV1, selectLegacyRenderProfileMappingEvidenceV1, selectRenderProfileMappingEvidenceV1 } from "../../harness/render-profile-source-evidence-v1.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { measuredTranscriptLatestDistance } from "../../harness/transcript-logical-distance.mjs";
import { createMobileRenderProfileSourceInputs } from "../../harness/mobile-render-profile-source-inputs.mjs";
import { createMobileRenderProfileFollowScenarios } from "../../harness/mobile-render-profile-follow-scenarios.mjs";
import { createMobileRenderProfileMeasurements } from "../../harness/mobile-render-profile-measurements.mjs";
import { observeSeparatedSuiteSourceInputs } from "../../harness/separated-suite-source-inputs.mjs";

const MATRIX_EPSILON = 1e-9;

const sampleCount = Number(optionValue("--samples", "30"));
const captureStackDiagnosticValue = optionValue("--capture-stack-diagnostic", "false");
assert.ok(captureStackDiagnosticValue === "true" || captureStackDiagnosticValue === "false", "--capture-stack-diagnostic must be true or false");
const captureStackDiagnostic = captureStackDiagnosticValue === "true";
const captureSeedUiDomTraceValue = optionValue("--capture-seed-ui-dom-trace", "false");
assert.ok(captureSeedUiDomTraceValue === "true" || captureSeedUiDomTraceValue === "false", "--capture-seed-ui-dom-trace must be true or false");
const captureSeedUiDomTrace = captureSeedUiDomTraceValue === "true";
const runtimeConsumerDiagnosticValue = optionValue("--runtime-consumer-diagnostic", "false");
assert.ok(runtimeConsumerDiagnosticValue === "true" || runtimeConsumerDiagnosticValue === "false", "--runtime-consumer-diagnostic must be true or false");
const runtimeConsumerDiagnostic = runtimeConsumerDiagnosticValue === "true";
const followGestureRegressionValue = optionValue("--follow-gesture-regression", "false");
assert.ok(followGestureRegressionValue === "true" || followGestureRegressionValue === "false", "--follow-gesture-regression must be true or false");
const followGestureRegression = followGestureRegressionValue === "true";
const tailWindowProductRegressionValue = optionValue("--tail-window-product-regression", "false");
assert.ok(tailWindowProductRegressionValue === "true" || tailWindowProductRegressionValue === "false", "--tail-window-product-regression must be true or false");
const tailWindowProductRegression = tailWindowProductRegressionValue === "true";
const tailWindowProductStage = optionValue("--tail-window-product-stage", "combined");
assert.ok(["combined", "stable-reader"].includes(tailWindowProductStage), "--tail-window-product-stage must be combined or stable-reader");
const tailWindowPaginationRegressionValue = optionValue("--tail-window-pagination-regression", "false");
assert.ok(tailWindowPaginationRegressionValue === "true" || tailWindowPaginationRegressionValue === "false", "--tail-window-pagination-regression must be true or false");
const tailWindowPaginationRegression = tailWindowPaginationRegressionValue === "true";
const naturalFollowDiagnosticValue = optionValue("--natural-follow-diagnostic", "false");
assert.ok(naturalFollowDiagnosticValue === "true" || naturalFollowDiagnosticValue === "false", "--natural-follow-diagnostic must be true or false");
const naturalFollowDiagnostic = naturalFollowDiagnosticValue === "true";
const mobileMountSmokeValue = optionValue("--mobile-mount-smoke", "false");
assert.ok(mobileMountSmokeValue === "true" || mobileMountSmokeValue === "false", "--mobile-mount-smoke must be true or false");
const mobileMountSmoke = mobileMountSmokeValue === "true";
const coreAttributionOnlyValue = optionValue("--core-attribution-only", "false");
assert.ok(coreAttributionOnlyValue === "true" || coreAttributionOnlyValue === "false", "--core-attribution-only must be true or false");
const coreAttributionOnly = coreAttributionOnlyValue === "true";
const suppressN1DiagnosticP95 = captureStackDiagnostic && sampleCount === 1;
assert.ok(!(tailWindowProductRegression && tailWindowPaginationRegression), "core follow and older-page pagination diagnostics are separate selectors");
const tailWindowDiagnostic = tailWindowProductRegression || tailWindowPaginationRegression || naturalFollowDiagnostic;
const sourceNames = optionValue("--sources", "before,after").split(",").map((value) => value.trim());
const messageCounts = optionValue("--messages", "50,500,2000")
  .split(",")
  .map((value) => Number(value.trim()));
const fixturePageSize = 50;
const serverId = "backend4a";
const threadId = "mock-active-session";
const SOURCE_MAP_TRUSTED_DEPLOY_MOUNT_PATH = "/__kcoder_mobile_mount_v1__";
const SOURCE_MAP_TRUSTED_OFFICIAL_MOBILE_MOUNT_PATH = "/mobile";
const MOCK_CONFIGURED_KCODER_BINARY_SHA256 = "6c092b9258bee3f9ac2c2d82e566fc575ad5d256d0d512b3bec411c1b465b79b";
const activeDeltaChunksPerStream = 30;
const transcriptVirtualizationTraceLimits = Object.freeze({
  maxViewportSamples: 220,
  maxWalkNodesPerSample: 96,
  maxMountedHistoryRowsPerSample: 24,
  maxEmptyLayoutCandidatesPerSample: 24,
  maxChildrenPerNode: 32,
  maxDepth: 8,
  maxScrollEvents: 256,
  maxScrollEventsPerSample: 16,
  maxTestIdLength: 48,
  maxDomPathLength: 64,
});
const readTranscriptViewport = createMobileTranscriptViewportReader(transcriptVirtualizationTraceLimits);
const allowedMessages = new Set([50, 500, 2000]);
const suiteSourceSha256 = sha256(await readFile(new URL(import.meta.url)));

assert.ok(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 100, "--samples must be between 1 and 100");
assert.ok(sourceNames.length > 0 && sourceNames.every((value) => value === "before" || value === "after") && new Set(sourceNames).size === sourceNames.length, "--sources must be a unique comma-separated subset of before,after");
assert.ok(messageCounts.length > 0 && new Set(messageCounts).size === messageCounts.length && messageCounts.every((value) => allowedMessages.has(value)), "--messages must be a unique subset of 50,500,2000");
const coreAttributionPolicy = validateCoreAttributionMode({
  enabled: coreAttributionOnly,
  sampleCount,
  sourceNames,
  messageCounts,
  captureStackDiagnostic,
  captureSeedUiDomTrace,
  runtimeConsumerDiagnostic,
  followGestureRegression,
  tailWindowDiagnostic,
});
if (runtimeConsumerDiagnostic) {
  assert.equal(sampleCount, 1, "runtime-consumer diagnostic is a single seed diagnostic, not a performance sample set");
  assert.deepEqual(sourceNames, ["after"], "runtime-consumer diagnostic requires exactly one frozen after source");
  assert.equal(messageCounts.length, 1, "runtime-consumer diagnostic requires exactly one loaded history count");
  assert.ok(allowedMessages.has(messageCounts[0]), "runtime-consumer diagnostic history count must be 50, 500, or 2000");
  assert.equal(captureStackDiagnostic, false, "runtime-consumer diagnostic must not enable V8 profiling");
  assert.equal(captureSeedUiDomTrace, false, "runtime-consumer diagnostic must not enable the separate seed DOM observer");
}
if (followGestureRegression) {
  assert.equal(sampleCount, 1, "follow-gesture regression is one functional diagnosis, not a performance sample set");
  assert.deepEqual(sourceNames, ["after"], "follow-gesture regression requires exactly one pinned after Web source");
  assert.equal(messageCounts.length, 1, "follow-gesture regression requires one loaded history count");
  assert.ok([500, 2000].includes(messageCounts[0]), "follow-gesture regression supports one 500- or 2000-message fixture");
  assert.equal(captureStackDiagnostic, false, "follow-gesture regression must not enable V8 profiling");
  assert.equal(captureSeedUiDomTrace, false, "follow-gesture regression must not enable seed DOM observers");
  assert.equal(runtimeConsumerDiagnostic, false, "follow-gesture regression must use the uninstrumented Mobile Web runtime");
}
if (tailWindowProductRegression) {
  assert.ok(["combined", "stable-reader"].includes(tailWindowProductStage), "product stage must be combined or the separate stable-reader case");
  assert.equal(sampleCount, 1, "tail-window product regression is one functional Web diagnostic, not a performance sample set");
  assert.deepEqual(sourceNames, ["after"], "tail-window product regression requires exactly one pinned after Web source");
  assert.deepEqual(messageCounts, [500], "tail-window product regression uses the existing 500-message heterogeneous fixture");
  assert.equal(captureStackDiagnostic, false, "tail-window product regression must not enable V8 profiling");
  assert.equal(captureSeedUiDomTrace, false, "tail-window product regression must not enable seed DOM observers");
  assert.equal(runtimeConsumerDiagnostic, false, "tail-window product regression must not enable a Runtime projection probe");
  assert.equal(followGestureRegression, false, "tail-window product regression is separate from the legacy follow-gesture diagnostic");
}
if (tailWindowPaginationRegression) {
  assert.equal(sampleCount, 1, "tail-window pagination regression is one functional Web diagnostic, not a performance sample set");
  assert.deepEqual(sourceNames, ["after"], "tail-window pagination regression requires exactly one pinned after Web source");
  assert.deepEqual(messageCounts, [500], "tail-window pagination regression uses the existing 500-message heterogeneous fixture");
  assert.equal(captureStackDiagnostic, false, "tail-window pagination regression must not enable V8 profiling");
  assert.equal(captureSeedUiDomTrace, false, "tail-window pagination regression must not enable seed DOM observers");
  assert.equal(runtimeConsumerDiagnostic, false, "tail-window pagination regression must not enable a Runtime projection probe");
  assert.equal(followGestureRegression, false, "tail-window pagination regression is separate from the legacy follow-gesture diagnostic");
}
if (naturalFollowDiagnostic) {
  assert.equal(sampleCount, 1, "natural-follow diagnostic is one functional diagnosis, not a performance sample set");
  assert.deepEqual(sourceNames, ["after"], "natural-follow diagnostic requires exactly one verified official after export");
  assert.deepEqual(messageCounts, [500], "natural-follow diagnostic uses the existing heterogeneous 500-message fixture");
  assert.equal(runtimeConsumerDiagnostic, true, "natural-follow diagnostic attempts the passive Runtime/panel probe when present; an absent official-bundle probe is recorded as NOT_OBSERVED");
  assert.equal(captureStackDiagnostic, false, "natural-follow diagnostic must not enable V8 profiling");
  assert.equal(captureSeedUiDomTrace, false, "natural-follow diagnostic uses the existing bounded DOM/Range observation");
  assert.equal(followGestureRegression, false, "natural-follow diagnostic does not include a post-seed gesture");
  assert.equal(tailWindowProductRegression, false, "natural-follow diagnostic stops at the natural tail gate");
  assert.equal(tailWindowPaginationRegression, false, "natural-follow diagnostic does not include older-page pagination");
  assert.equal(coreAttributionOnly, false, "natural-follow diagnostic is not a CPU profile");
}
if (mobileMountSmoke) {
  assert.equal(sampleCount, 1, "Mobile mount smoke is one entry/pairing check, not a sample set");
  assert.deepEqual(sourceNames, ["after"], "Mobile mount smoke requires exactly one pinned after source");
  assert.deepEqual(messageCounts, [50], "Mobile mount smoke uses the single-cell 50-row fixture selector; it does not load history rows");
  assert.equal(captureStackDiagnostic, false, "Mobile mount smoke must not enable CPU profiling");
  assert.equal(captureSeedUiDomTrace, false, "Mobile mount smoke must not enable seed DOM tracing");
  assert.equal(runtimeConsumerDiagnostic, false, "Mobile mount smoke must not install a Runtime consumer probe");
  assert.equal(followGestureRegression, false, "Mobile mount smoke must not run follow-gesture checks");
  assert.equal(tailWindowProductRegression, false, "Mobile mount smoke must not run tail-window product checks");
  assert.equal(tailWindowPaginationRegression, false, "Mobile mount smoke must not run pagination checks");
  assert.equal(naturalFollowDiagnostic, false, "Mobile mount smoke must not load the natural-follow history fixture");
  assert.equal(coreAttributionOnly, false, "Mobile mount smoke must not run core CPU attribution");
}

const {
  resolveProvenanceReference,
  readFrozenGatewayRuntime,
  startFrozenGateway,
  assertSafeBundleRelativePath,
  assertNoSymlinkAncestors,
  verifyExactBundleTree,
  installPerformanceInstrumentation,
  configureRuntimeConsumerProbe,
  safeSeedErrorMessage,
  safeSeedErrorStack,
  beginSeedUiTraceInPage,
  endSeedUiTraceInPage,
  captureSeedFailureDom,
} = createMobileRenderProfileHelpers({
  requiredOption,
  requiredDigest,
  optionValue,
  sha256,
  sha256File,
  threadId,
  serverId,
});

const initialEntryRpcLedgerLimits = Object.freeze({
  maxEvents: 256,
  maxConnections: 16,
  maxEventBytes: 1024,
  maxBytes: 32_768,
  maxPendingPerSocket: 64,
});
const initialEntryRpcMethodAllowlist = new Set([
  "initialize",
  "initialized",
  "server/info",
  "server/status",
  "server/models",
  "thread/list",
  "thread/read",
  "thread/read/indexed",
  "thread/resume",
  "thread/search",
  "thread/metadata/update",
]);
const initialEntryRpcCapabilityAllowlist = Object.freeze([
  "threadResumeHistoryPageV1",
  "threadIndexedPagesV1",
  "threadListCompleteness",
]);

const { readFocusState, installTranscriptFollowGestureInputTrace, readProductHistoryViewport, waitForStableProductHistoryAnchor, waitForStableProductHistoryWindow, prepareProductTouchStroke, performProductTouchStroke, normalizeStableReaderAnchorWithTrustedInput, performProductTouchToOlderHistory, performProductWheelToOlderHistoryControl } = createMobileTranscriptGestureHelpers({
  readProductHistoryAnchor,
  readTranscriptFollowGestureInputTrace,
  safeSeedErrorMessage,
  safeSeedErrorStack,
  transcriptInputEventsSince,
  waitForTwoFrames,
});

const { readSourceSpec, deriveCandidateSourceEvidence, readPinnedPrivateEvidenceFile, readPinnedGitArchiveBlobs, parsePinnedGitTreeRows, collectPinnedGitArchiveFiles, gitBlobSha1, runOwnedSourceCommand, readOfficial992SourceSpec, copyAndVerifyRetainedBuilderExport, materializeProfileMobileStaticDist, trustedSourceMapMountPathForEntry, copyPinnedConfiguredGatewayBinary } = createMobileRenderProfileSourceInputs({
  SOURCE_MAP_TRUSTED_DEPLOY_MOUNT_PATH,
  SOURCE_MAP_TRUSTED_OFFICIAL_MOBILE_MOUNT_PATH,
  addOfficialMobileExportPostflight,
  assert,
  assertNoSymlinkAncestors,
  assertPathWithinApprovedRoots,
  assertSafeBundleRelativePath,
  basename,
  buildGatewayMobileWebManifest,
  captureStackDiagnostic,
  chmod,
  classifyRenderProfileSourceEvidenceV1,
  constants,
  copyFile,
  copyOfficialMobileStaticDist,
  coreAttributionOnly,
  createHash,
  derivePinnedGitExportSourceEvidence,
  dirname,
  inspectOfficialMobileStaticDist,
  lstat,
  mkdir,
  mobileMountSmoke,
  naturalFollowDiagnostic,
  optionValue,
  readFile,
  readOfficialMobileExportReceipt,
  readVerifiedMobileExportFile,
  readdir,
  relative,
  repoRoot,
  requiredDigest,
  requiredOption,
  resolve,
  resolveProvenanceReference,
  rm,
  sep,
  sha256,
  sha256File,
  verifyExactBundleTree,
  verifyMobileExportManifestEnvelope,
  verifyPinnedSourceInventoryBytes,
  verifySourceMapBundleEvidence,
  waitFor,
  writeFile,
  writeGatewayMobileWebManifest,
});

const { summarizeSeedDispatchEvidence, scrollTranscriptToLatest, beginTranscriptVirtualizationScrollTrace, stopTranscriptVirtualizationScrollTrace, scrollTranscriptToLatestCore, waitForProductTailMarkerWithoutAction, assertProductHistoryAnchorPreserved, assertProductVisibleHistoryOrder, chooseVisibleProductCodeAnchor, makeLongTailWindowAppendDelta, expandProductHistoryCodeDisclosure, runTailWindowProductRegression, runTailWindowPaginationRegression, runTranscriptFollowGestureRegression, disposeTranscriptFollowGestureInputTrace, waitForProductAppendCommit, performTrustedTranscriptTouch, waitForTranscriptTouchSettled, waitForProgrammaticFollowScrollEvent, waitForFollowAppendLayout, assertNoFollowPull, readVisibleHistoryAnchor, readCompletedAssistantMarkerUi, trustedJumpClickEventsSince, summarizeFollowGestureNotification, emitSyntheticTaskSnapshot } = createMobileRenderProfileFollowScenarios({
  areNotificationBatchesOrdered,
  assert,
  fixturePageSize,
  installTranscriptFollowGestureInputTrace,
  measuredTranscriptLatestDistance,
  normalizeStableReaderAnchorWithTrustedInput,
  performProductTouchStroke,
  performProductTouchToOlderHistory,
  performProductWheelToOlderHistoryControl,
  performance,
  prepareProductTouchStroke,
  readProductHistoryViewport,
  readTranscriptFollowGestureInputTrace,
  readTranscriptViewport,
  safeSeedErrorMessage,
  safeSeedErrorStack,
  serverId,
  threadId,
  transcriptInputEventsSince,
  transcriptVirtualizationTraceLimits,
  waitFor,
  waitForStableProductHistoryAnchor,
  waitForStableProductHistoryWindow,
  waitForTwoFrames,
});

const { measureInputFeedback, measureScrollFeedback, summarizeScrollCausalityViewport, summarizeScrollCausalityTailGate, summarizeScrollCausalityWheel, summarizeScrollCausalityTouchTrace, evaluateScrollCausalityTouchEvidence, measureActiveMarkdownDelta, dispatchActiveFrame, dispatchActiveStreamFrames, makeLongMarkdownDelta, measureSnapshotUpdates, captureCdpClockAnchor, summarizeCpuProfile, mapCpuProfileWithSourceMaps, sendSyntheticSnapshot, readRuntimeConsumerProbe, drainRuntimeConsumerProbe, buildRuntimeConsumerSeedDiagnostic, summarizeRuntimeConsumerSeedFailure, summarizeSeedTranscriptViewport } = createMobileRenderProfileMeasurements({
  activeDeltaChunksPerStream,
  assert,
  beginSeedUiTraceInPage,
  captureSeedFailureDom,
  captureSeedUiDomTrace,
  collectLongTasks,
  configureRuntimeConsumerProbe,
  createRequire,
  disposeTranscriptFollowGestureInputTrace,
  emitSyntheticTaskSnapshot,
  endSeedUiTraceInPage,
  installTranscriptFollowGestureInputTrace,
  manualHistoryLogicalDistanceFromLatest,
  mapGeneratedProfilePosition,
  moveAwayFromLatestWithTrustedWheel,
  performance,
  readTranscriptFollowGestureInputTrace,
  readTranscriptViewport,
  readVerifiedMobileExportFile,
  recordScriptUrlIdentity,
  repoRoot,
  resolve,
  resolveScriptMapBinding,
  resolveTranscriptScrollportTransform,
  runtimeConsumerDiagnostic,
  safePath,
  safeSeedErrorMessage,
  safeSeedErrorStack,
  scrollTranscriptToLatest,
  selectLegacyRenderProfileMappingEvidenceV1,
  selectRenderProfileMappingEvidenceV1,
  serverId,
  sha256,
  summarizeManualHistoryResetViewport,
  summarizeSeedDispatchEvidence,
  threadId,
  transcriptInputEventsSince,
  transcriptVirtualizationTraceLimits,
  waitForTwoFrames,
});

await runE2E(import.meta.url, {
  testId: mobileMountSmoke
    ? "mobile-render-profile-official-mobile-mount-smoke"
    : naturalFollowDiagnostic
    ? "mobile-render-profile-official-992-natural-follow"
    : tailWindowDiagnostic
    ? "mobile-render-profile-tail-window-product-regression"
    : coreAttributionOnly ? "mobile-render-profile-core-attribution-diagnostic"
      : followGestureRegression ? "mobile-render-profile-follow-gesture-regression" : "mobile-render-profile-high-history",
  tier: "manual-live",
  modelPolicy: mobileMountSmoke
    ? "one-cell mounted Mobile Web entry and pairing smoke using the pinned after export; no history seeding, performance sample, Provider, model turn, or native-device claim"
  : coreAttributionOnly
    ? "isolated Mobile Web CDP V8 profile of the actual core active-Markdown burst with a source-map-enabled, full-bundle-pinned after/500 fixture; DIAGNOSTIC_ONLY, excluded from performance distributions, no provider/model/Rust turn, and native remains unverified"
  : naturalFollowDiagnostic
      ? "official Git 992 Mobile Web receipt served by the isolated Gateway at /mobile/; one 499-history-plus-one-seed natural-follow UI gate, optional passive TaskRuntime/panel probe marked NOT_OBSERVED when absent, no Provider/Rust turn, no post-seed scroll action, and no performance claim"
    : tailWindowProductRegression
    ? `isolated Mobile Web product UI diagnostic (${tailWindowProductStage} stage) in Chromium with heterogeneous 500-message synthetic history and ordered app-facing WebSocketMock notifications; stable-reader uses trusted input to normalize its same-ID anchor before code/append checks; race uses preplanned touch and touchstart-time geometry; no provider, model, Rust app-server turn, Runtime probe, native validation, or performance sample`
    : tailWindowPaginationRegression
      ? "isolated Mobile Web pagination UI diagnostic in Chromium with synthetic history and trusted wheel/click against the real fixture route; no provider, model, Rust app-server turn, Runtime probe, native validation, or performance sample"
    : followGestureRegression
    ? "isolated Mobile Web UI follow-state diagnostic in Chromium with synthetic history and ordered app-facing WebSocketMock notifications plus trusted browser touch input; no provider, model, Runtime probe, or Rust app-server turn; not a performance sample or native validation"
    : "real Mobile Web UI in isolated Chromium with synthetic history pages and synthetic completed-task notifications; no provider or model calls; optional one-seed runtime-consumer diagnostic uses a private bounded read-only TaskRuntime projection and is not a performance sample or real app-server turn",
  retainSuccessLogs: true,
}, async (context) => {
  await observeSeparatedSuiteSourceInputs(context, [
    new URL("../../harness/mobile-render-profile-source-inputs.mjs", import.meta.url),
    new URL("../../harness/mobile-render-profile-follow-scenarios.mjs", import.meta.url),
    new URL("../../harness/mobile-render-profile-measurements.mjs", import.meta.url),
  ]);
  const prevalidatedSources = coreAttributionOnly || captureStackDiagnostic || naturalFollowDiagnostic || mobileMountSmoke
    ? await Promise.all(sourceNames.map((sourceName) => readSourceSpec(sourceName, context)))
    : null;
  const gatewayBinarySourcePath = requiredOption("--gateway-binary");
  const gatewayBinarySha256 = requiredDigest("--gateway-binary-sha256");
  if (naturalFollowDiagnostic) {
    assert.equal(gatewayBinarySha256, MOCK_CONFIGURED_KCODER_BINARY_SHA256, "official natural-follow diagnostic must use the pinned current mock-configured KCoder binary");
  }
  const gatewayBinaryCopy = naturalFollowDiagnostic
    ? await copyPinnedConfiguredGatewayBinary(context, gatewayBinarySourcePath, gatewayBinarySha256)
    : { path: gatewayBinarySourcePath, evidence: null };
  const gatewayRuntime = await readFrozenGatewayRuntime(
    requiredOption("--gateway-runtime-root"),
    gatewayBinaryCopy.path,
    gatewayBinarySha256,
    requiredDigest("--gateway-source-tree-sha256"),
    requiredDigest("--gateway-dependency-tree-sha256"),
    requiredDigest("--gateway-runtime-manifest-sha256"),
  );
  if (gatewayBinaryCopy.evidence) gatewayRuntime.provenance.configuredBinaryCopy = gatewayBinaryCopy.evidence;
  const hostCpuBefore = mobileMountSmoke ? null : await sampleHostCpuWindow("before-owned-browser-and-gateway-work");
  const chromium = await startChromium(context, {
    label: "mobile-render-profile-chromium",
    noSandbox: true,
    startTimeoutMs: 60_000,
  });
  const observations = [];
  const fixtureEvidence = [];
  const cpuProfiles = [];
  const phaseProvenance = [];
  const browserErrors = [];
  const sources = [];
  const runtimeConsumerDiagnosticCases = [];
  const coreAttributionCases = [];
  const followGestureRegressionCases = [];
  const tailWindowProductRegressionCases = [];
  const tailWindowPaginationRegressionCases = [];
  const naturalFollowDiagnosticCases = [];
  const browserInfo = {
    version: await chromium.browser.version(),
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    evidenceKind: "system Chromium Mobile Web viewport emulation; does not measure Android/iOS native JS, UI, keyboard, or storage",
  };

  for (const sourceName of sourceNames) {
    const source = prevalidatedSources?.find((candidate) => candidate.name === sourceName)
      ?? await readSourceSpec(sourceName, context);
    if (mobileMountSmoke) assert.equal(source.builderManifest.deployMount, true, "Mobile mount smoke requires an export with the official deployment mount enabled");
    sources.push(source);
    const mobileWeb = await copyAndVerifyRetainedBuilderExport(context, source);
    const officialMobileMount = source.builderManifest.deployMount === true;
    const mobileDeployment = officialMobileMount
      ? await materializeProfileMobileStaticDist(context, source, mobileWeb)
      : null;

    const workspace = context.pathInState(`workspace-${source.name}`);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const serversFile = await context.writeStateJson(`servers-${source.name}.json`, [{
      id: serverId,
      label: `Render fixture ${source.name}`,
      runtime: "kcoder",
      transport: "local",
      command: process.execPath,
      workspace,
    }]);
    const gatewayLabel = `render-profile-${source.name}-gateway`;
    const gateway = await startFrozenGateway(context, gatewayRuntime, {
      label: gatewayLabel,
      workspace,
      serversFile,
      webRoot: officialMobileMount ? "" : mobileWeb.path,
      ...(officialMobileMount ? { mobileWebRoot: mobileDeployment.ownedRoot } : {}),
    });
    phaseProvenance.push({
      source: source.name,
      sourceFreezeEvidenceDigest: source.sourceFreezeEvidenceDigest,
      sourceFreezeEvidenceKind: source.sourceFreezeEvidenceKind,
      sourceTreeSha256: source.sourceTreeSha256,
      mobileSourceComponentSha256: source.mobileSourceComponentSha256,
      mobileExportInputFileCount: source.mobileExportInputFileCount,
      sourceComplementSha256: source.sourceComplementSha256,
      relocationSidecarSha256: source.relocationSidecarSha256,
      sharedSourceInputSha256: source.sharedSourceInputSha256,
      sharedExportInputFileCount: source.sharedExportInputFileCount,
      frozenSourceEntryCount: source.frozenSourceEntryCount,
      sourceCompleteness: source.sourceCompleteness,
      sourceComplementMode: source.sourceComplementMode,
      builderSourceProvenance: source.builderSourceProvenance ?? null,
      exportManifestSha256: mobileWeb.sourceManifestSha256,
      bundleSha256: mobileWeb.bundleSha256,
      indexHtmlSha256: mobileWeb.indexHtmlSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      ...(mobileDeployment ? { mobileDeploymentAdapter: mobileDeployment.evidence } : {}),
      ...(source.builderManifest.sourceMapEvidence ? { sourceMapEvidence: source.builderManifest.sourceMapEvidence } : {}),
      dependencySourceTreeSha256: source.dependencySourceTreeSha256,
      complementarySourceDescription: source.complementarySourceDescription,
      exportPerformedInMeasurementRun: false,
      bundleReuseProvenance: mobileWeb.provenancePath,
      isolatedGateway: {
        port: gateway.port,
        pid: gateway.child.pid,
        mock: true,
        cwd: gateway.cwd,
        script: gateway.script,
        nodeExecutable: gateway.nodeExecutable,
        kcoderBinaryPath: gateway.kcoderBinaryPath,
        kcoderBinarySha256: gatewayRuntime.provenance.kcoderBinarySha256,
        runtimeFreezeManifestSha256: gatewayRuntime.manifestSha256,
        mobileMountPath: officialMobileMount ? `${SOURCE_MAP_TRUSTED_OFFICIAL_MOBILE_MOUNT_PATH}/` : "/",
        mobileWebRootConfigured: gateway.mobileWebRoot !== null,
        configuredBinaryCopy: gatewayRuntime.provenance.configuredBinaryCopy ?? null,
        binaryExecutionStatus: "CONFIGURED_BUT_NOT_EXERCISED_KCODER_STUDIO_MOCK_1",
      },
    });

    for (const count of messageCounts) {
      const panelStates = followGestureRegression || tailWindowDiagnostic ? ["unmounted"] : ["unmounted", "mounted-hidden"];
      for (const panelState of panelStates) {
        const pageState = createPageState(source.name, count, panelState, workspace, {
          reserveOlderHistoryPage: tailWindowPaginationRegression,
          markLatestHistoryTailForVisibility: tailWindowDiagnostic,
        });
        const page = await chromium.newPage({
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          locale: "zh-CN",
        });
        page.on("pageerror", (error) => browserErrors.push({ source: source.name, message: context.redactText(error.message).slice(0, 500) }));
        page.on("requestfailed", (request) => {
          const pathname = safePath(request.url());
          pageState.failedRequests[pathname] = (pageState.failedRequests[pathname] ?? 0) + 1;
        });
        await page.addInitScript(installPerformanceInstrumentation);
        await installHistoryAndNotificationFixture(page, pageState, officialMobileMount ? gateway.baseUrl : null);
        const mobileEntry = await connectMobile(page, gateway, pageState, {
          officialMobileMount,
          context,
        });
        const trustedSourceMapMountPath = trustedSourceMapMountPathForEntry(source, mobileEntry);
        if (mobileMountSmoke) {
          const rpcLedger = snapshotInitialEntryRpcLedger(pageState);
          const endpointCoverage = rpcLedger.endpointCoverage;
          const validEndpointIdentity = endpointCoverage.length > 0 && endpointCoverage.every((endpoint) =>
            endpoint.originMatchesGateway === true
            && endpoint.rpcPathMatches === true
            && endpoint.serverMatchesFixture === true
            && ["runtime", "browser"].includes(endpoint.channel)
            && (!endpoint.workspacePresent || endpoint.workspaceMatchesFixture === true));
          const runtimeWorkspaceEndpointObserved = endpointCoverage.some((endpoint) =>
            endpoint.channel === "runtime"
            && endpoint.workspacePresent === true
            && endpoint.workspaceMatchesFixture === true);
          const allObservedSocketsIntercepted = rpcLedger.observedWebSocketCount > 0
            && rpcLedger.routeInterceptCount === rpcLedger.observedWebSocketCount
            && endpointCoverage.every((endpoint) => endpoint.observedWebSocketCount === endpoint.routeInterceptCount);
          const initializeObserved = rpcLedger.events.some((event) =>
            event.kind === "rpc-frame"
            && event.direction === "client-to-server"
            && event.method === "initialize");
          const threadListResponseMatched = rpcLedger.events.some((event) =>
            event.kind === "rpc-frame"
            && event.direction === "server-to-client"
            && event.matchedRequestMethod === "thread/list"
            && event.responseMatch === "MATCHED");
          const noTurnStarted = (pageState.rpcMethods["turn/start"] ?? 0) === 0;
          const noLedgerLoss = rpcLedger.overflow === false
            && rpcLedger.droppedEventCount === 0
            && rpcLedger.droppedConnectionCount === 0
            && rpcLedger.pendingCorrelationOverflowCount === 0
            && rpcLedger.unpairedResponseCount === 0
            && rpcLedger.malformedResponseCount === 0;
          const gates = {
            officialMobileEntryAndAssets: mobileEntry?.status === "PASS"
              && mobileEntry.path === "/mobile/"
              && mobileEntry.entryStatus === 200
              && mobileEntry.documentLoaded === true
              && mobileEntry.javascriptLoaded === true
              && mobileEntry.stylesheetLoaded === true
              && mobileEntry.responses.length > 0
              && mobileEntry.responses.every((response) => response.status === 200),
            pairingAndFixtureThreadVisible: mobileEntry?.pairingStatus === "PASS",
            expectedGatewayRpcEndpoints: validEndpointIdentity && runtimeWorkspaceEndpointObserved,
            observedSocketsInterceptedByFixture: allObservedSocketsIntercepted,
            initializeAndThreadListObserved: initializeObserved && threadListResponseMatched,
            boundedLedgerComplete: noLedgerLoss,
            noModelTurnStarted: noTurnStarted,
            noBrowserPageErrors: browserErrors.length === 0,
          };
          const smoke = {
            schemaVersion: 1,
            status: Object.values(gates).every(Boolean) ? "PASS" : "FAIL",
            classification: "DIAGNOSTIC_ONLY",
            diagnosticOnly: true,
            smoke: true,
            performanceSample: false,
            performanceDistributionEligible: false,
            scenario: "official-mobile-mounted-entry-and-pairing-smoke",
            cellCount: 1,
            sampleCount: 1,
            source: source.name,
            requestedMessagesSelector: 50,
            historyRowsSeeded: 0,
            mobileEntry,
            trustedSourceMapMountPath,
            rpcLedger,
            gates,
            browserErrors,
            failedRequests: pageState.failedRequests,
            input: phaseProvenance[0] ?? null,
            evidenceBoundary: "single official /mobile/ entry and synthetic WebSocket pairing/thread-list smoke using an isolated KCODER_STUDIO_MOCK Gateway; no history load or seed, no Rust app-server turn, Provider, CPU profile, latency sample, or native-device claim",
          };
          await context.writeArtifactJson("phone-render-profile-mobile-mount-smoke.json", smoke);
          assert.equal(smoke.status, "PASS", "official Mobile mount smoke gates must pass; see phone-render-profile-mobile-mount-smoke.json");
          await page.context().close();
          await context.stopOwned(gatewayLabel);
          await chromium.close();
          return smoke;
        }
        const initialEntryStartPageTimeMs = tailWindowDiagnostic
          ? await page.evaluate(() => Number(performance.now().toFixed(3)))
          : null;
        await page.getByTestId("thread-mock-active-session").click();
        await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
        await page.getByTestId("message-list").waitFor({ state: "visible", timeout: 30_000 });
        let initialEntryTailEvidence = null;
        if (tailWindowDiagnostic) {
          initialEntryTailEvidence = await verifyInitialEntryNaturalTailBeforeHistoryPreload(
            context,
            page,
            pageState,
            source.name,
            count,
            panelState,
            initialEntryStartPageTimeMs,
          );
        }
        await loadHistoryToCount(page, pageState, count - 1);
        assert.equal(pageState.historyRowsDelivered, count - 1, `${source.name}/${count}/${panelState}: all requested fixture history rows must be delivered`);
        await waitForTwoFrames(page);
        let manualHistoryFollowResetEvidence = null;
        if (tailWindowDiagnostic) {
          manualHistoryFollowResetEvidence = await restoreFollowAfterManualHistoryPreload(
            context,
            page,
            pageState,
            source.name,
            count,
            panelState,
          );
        }

        let seed;
        try {
          seed = await sendSyntheticSnapshot(page, pageState, `seed-${source.name}-${count}-${panelState}`, 0, false, {
            deferTailGate: tailWindowDiagnostic,
          });
          seed.initialEntryTailEvidence = initialEntryTailEvidence;
          seed.manualHistoryFollowResetEvidence = manualHistoryFollowResetEvidence;
          if (tailWindowDiagnostic) {
            seed.transcriptViewport = await waitForProductTailMarkerWithoutAction(
              page,
              `seed-${source.name}-${count}-${panelState}`,
              seed.seedDispatch?.dispatchStartedAtPageTimeMs,
              "initial-seed",
              { captureVisibilityDiagnostics: true },
            );
          }
        } catch (error) {
          const failureArtifact = `phone-render-profile-seed-failure-${source.name}-${count}-${panelState}.json`;
          const screenshotArtifact = `phone-render-profile-seed-failure-${source.name}-${count}-${panelState}.png`;
          let screenshot = { status: "not-captured", artifact: null, error: null };
          try {
            await page.screenshot({ path: context.pathInArtifacts(screenshotArtifact), fullPage: false });
            screenshot = { status: "captured", artifact: screenshotArtifact, error: null };
          } catch (screenshotError) {
            screenshot = {
              status: "failed",
              artifact: null,
              error: safeSeedErrorMessage(screenshotError),
            };
          }
          await context.writeArtifactJson(failureArtifact, {
            schemaVersion: 1,
            failureStage: error?.seedFailureEvidence?.failurePhase ?? "seed-notification-or-visible-tail-gate",
            source: source.name,
            requestedMessages: count,
            panelState,
            historyRowsDelivered: pageState.historyRowsDelivered,
            initialEntryTailEvidence: pageState.initialEntryTailEvidence ?? initialEntryTailEvidence,
            manualHistoryFollowResetEvidence: pageState.manualHistoryFollowResetEvidence ?? manualHistoryFollowResetEvidence,
            expectedHistoryRows: count - 1,
            expectedLoadedMessagesAfterSeed: count,
            activeThreadReadRequestId: pageState.activeThreadReadRequestId,
            activeRoute: pageState.activeSocketRoute ? {
              routeOrdinal: pageState.activeSocketRoute.routeOrdinal,
              server: pageState.activeSocketRoute.server,
              channel: pageState.activeSocketRoute.channel,
              workspaceMatchesFixture: pageState.activeSocketRoute.workspaceMatchesFixture,
              threadReadRequestId: pageState.activeSocketRoute.threadReadRequestId,
            } : null,
            seedDispatch: error?.seedFailureEvidence?.seedDispatch ?? pageState.lastSeedDispatchEvidence ?? null,
            runtimeProbe: error?.seedFailureEvidence?.runtimeProbe ?? null,
            runtimeConsumerDiagnostic: runtimeConsumerDiagnostic
              ? summarizeRuntimeConsumerSeedFailure(source, pageState, error, mobileWeb)
              : null,
            transcriptViewport: error?.seedFailureEvidence?.transcriptViewport ?? null,
            diagnosticDom: error?.seedFailureEvidence?.diagnosticDom ?? null,
            seedUiTrace: error?.seedFailureEvidence?.seedUiTrace ?? null,
            productTailGate: error?.productTailGateEvidence ?? null,
            screenshot,
            error: error?.seedFailureEvidence?.error ?? {
              name: error?.name ?? "Error",
              message: safeSeedErrorMessage(error),
              stack: safeSeedErrorStack(error),
            },
          });
          throw new Error(`seed gate failed for ${source.name}/${count}/${panelState}; see ${failureArtifact}`);
        }
        assert.ok(seed.ok, "synthetic history completion must render before measured updates");
        pageState.seedTranscriptViewport = seed.transcriptViewport ?? null;
        pageState.seedDeliveryEvidence = seed.seedDispatch ?? null;
        assert.equal(pageState.historyRowsDelivered + 1, count, "fixture must have the requested total message count after its one synthetic seed message");
        await context.writeArtifactJson(`phone-render-profile-seed-ui-trace-${source.name}-${count}-${panelState}.json`, {
          schemaVersion: 1,
          source: source.name,
          requestedMessages: count,
          panelState,
          seedMarker: `seed-${source.name}-${count}-${panelState}`,
          seedDispatch: seed.seedDispatch,
          transcriptViewport: seed.transcriptViewport,
          seedUiTrace: seed.seedUiTrace,
          runtimeProbe: seed.runtimeProbe ?? null,
        });

        if (tailWindowDiagnostic) {
          let tailEvidence;
          let naturalRuntimeConsumerEvidence = null;
          try {
            assert.equal(await page.getByTestId("changes-panel").count(), 0, "tail-window diagnostic requires ChangesPanel to be actually unmounted");
            pageState.changesPanelMounted = false;
            if (naturalFollowDiagnostic) {
              naturalRuntimeConsumerEvidence = buildRuntimeConsumerSeedDiagnostic(source, pageState, seed, mobileWeb);
              const projection = naturalRuntimeConsumerEvidence.consumerProjection;
              const probeUnavailable = ["PROBE_GLOBAL_UNAVAILABLE", "PROBE_NOT_CONFIGURED"].includes(projection.configurationStatus);
              projection.observationStatus = probeUnavailable ? "NOT_OBSERVED" : "OBSERVED";
              if (probeUnavailable) {
                projection.probeAbsenceBoundary = "official 992 bundle does not expose the optional passive Runtime/panel probe; no product instrumentation was injected";
              } else {
                assert.equal(projection.configurationStatus, "CONFIGURED", "if the optional probe exists, configuration errors remain failures");
                assert.equal(projection.status, "RUNTIME_AND_PANEL_MARKER_TERMINAL_PROJECTED", "an available probe must project the exact seed marker and completed state in both Runtime and panel");
                assert.equal(projection.runtimeProjection.messageCount, count, "Runtime projection must contain all requested messages");
                assert.equal(projection.panelProjection.messageCount, count, "panel projection must contain all requested messages");
                assert.equal(projection.panelSnapshotSameAsRuntimeAtEffect, true, "panel projection must match its Runtime snapshot at commit");
                assert.equal(projection.panelAndRuntimeInstanceOrdinalMatch, true, "panel and Runtime projections must belong to the same runtime instance");
                assert.equal(projection.configuredIdentityFingerprintsMatch, true, "Runtime probe must match the active fixture thread, turn, and item fingerprints");
              }
              assert.equal(seed.transcriptViewport?.status, "PASS", "seed must pass the existing unassisted visible-tail gate");
              assert.equal(seed.transcriptViewport?.action, "none-inside-tail-gate", "no scroll or Jump action is permitted after seed dispatch");
              tailEvidence = {
                schemaVersion: 1,
                status: "PASS",
                diagnosticOnly: true,
                performanceSample: false,
                scenario: "official-992-500-unmounted-natural-follow-after-completed-seed",
                source: source.name,
                requestedMessages: count,
                panelState,
                evidenceClass: "official Git 992 Mobile Web export served at Gateway /mobile/ in isolated KCODER_STUDIO_MOCK mode; app-facing WebSocketMock notifications and optional passive Runtime/panel probe (NOT_OBSERVED if absent); configured KCoder binary is not exercised; no real Rust turn, Provider, or native-device validation",
                mobileEntry,
                seedNotification: seed.seedDispatch,
                initialEntryTail: initialEntryTailEvidence,
                preSeedFollowReset: manualHistoryFollowResetEvidence,
                runtimeConsumer: naturalRuntimeConsumerEvidence,
                naturalTailGate: seed.transcriptViewport,
                noPostSeedScrollAction: true,
              };
              naturalFollowDiagnosticCases.push(tailEvidence);
              await context.writeArtifactJson("phone-render-profile-official-992-natural-follow-after-500-unmounted.json", tailEvidence);
            } else if (tailWindowPaginationRegression) {
              tailEvidence = await runTailWindowPaginationRegression(page, pageState, source.name, count, seed);
              tailWindowPaginationRegressionCases.push(tailEvidence);
              await context.writeArtifactJson(`phone-render-tail-window-pagination-after-${count}-unmounted.json`, tailEvidence);
            } else {
              tailEvidence = await runTailWindowProductRegression(page, pageState, source.name, count, seed, tailWindowProductStage);
              tailWindowProductRegressionCases.push(tailEvidence);
              await context.writeArtifactJson(`phone-render-tail-window-core-after-${count}-unmounted.json`, tailEvidence);
            }
            await page.context().close();
          } catch (error) {
            const scenario = naturalFollowDiagnostic ? "natural-follow" : tailWindowPaginationRegression ? "pagination" : "core";
            const screenshotArtifact = `phone-render-tail-window-${scenario}-failure-after-${count}-unmounted.png`;
            let screenshot = { status: "not-captured", artifact: null, error: null };
            try {
              await page.screenshot({ path: context.pathInArtifacts(screenshotArtifact), fullPage: false });
              screenshot = { status: "captured", artifact: screenshotArtifact, error: null };
            } catch (screenshotError) {
              screenshot = { status: "failed", artifact: null, error: safeSeedErrorMessage(screenshotError) };
            }
            const failureEvidence = (naturalFollowDiagnostic ? error?.naturalFollowEvidence
              : tailWindowPaginationRegression ? error?.tailWindowPaginationEvidence : error?.tailWindowProductEvidence) ?? {
              schemaVersion: 1,
              status: "FAIL",
              scenario,
              source: source.name,
              requestedMessages: count,
              panelState,
              seedTranscriptViewport: seed.transcriptViewport ?? null,
              initialEntryTailEvidence,
              manualHistoryFollowResetEvidence,
              mobileEntry: pageState.mobileEntryEvidence ?? null,
              historyPages: pageState.historyPages,
              rpcLedger: snapshotInitialEntryRpcLedger(pageState),
              notificationBatches: pageState.notificationBatches,
              runtimeConsumer: naturalRuntimeConsumerEvidence,
              error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) },
            };
            let pageContextClose = { status: "closing" };
            let pageContextCloseError = null;
            try {
              await page.context().close();
              pageContextClose = { status: "closed" };
            } catch (closeError) {
              pageContextCloseError = closeError;
              pageContextClose = { status: "failed", error: { name: closeError?.name ?? "Error", message: safeSeedErrorMessage(closeError), stack: safeSeedErrorStack(closeError) } };
            }
            const completeFailureEvidence = { ...failureEvidence, screenshot, cleanup: { pageContextClose } };
            const failureJsonArtifact = `phone-render-tail-window-${scenario}-failure-after-${count}-unmounted.json`;
            await context.writeArtifactJson(failureJsonArtifact, completeFailureEvidence);
            const message = `tail-window ${scenario} diagnostic failed for ${source.name}/${count}/unmounted; see ${failureJsonArtifact}`;
            if (pageContextCloseError) {
              const combinedError = new AggregateError([error, pageContextCloseError], message, { cause: error });
              if (naturalFollowDiagnostic) combinedError.naturalFollowEvidence = completeFailureEvidence;
              else if (tailWindowPaginationRegression) combinedError.tailWindowPaginationEvidence = completeFailureEvidence;
              else combinedError.tailWindowProductEvidence = completeFailureEvidence;
              throw combinedError;
            }
            throw new Error(message, { cause: error });
          }
          continue;
        }

        if (followGestureRegression) {
          let followEvidence;
          try {
            assert.equal(await page.getByTestId("changes-panel").count(), 0, "follow-gesture diagnostic requires ChangesPanel to be actually unmounted, not merely hidden");
            pageState.changesPanelMounted = false;
            followEvidence = await runTranscriptFollowGestureRegression(page, pageState, source.name, count, seed);
            followGestureRegressionCases.push(followEvidence);
            await context.writeArtifactJson(`phone-render-follow-gesture-after-${count}-${panelState}.json`, followEvidence);
          } catch (error) {
            const screenshotArtifact = `phone-render-follow-gesture-failure-after-${count}-${panelState}.png`;
            let screenshot = { status: "not-captured", artifact: null, error: null };
            try {
              await page.screenshot({ path: context.pathInArtifacts(screenshotArtifact), fullPage: false });
              screenshot = { status: "captured", artifact: screenshotArtifact, error: null };
            } catch (screenshotError) {
              screenshot = { status: "failed", artifact: null, error: safeSeedErrorMessage(screenshotError) };
            }
            const failureEvidence = error?.followGestureEvidence ?? {
              schemaVersion: 1,
              status: "FAIL",
              source: source.name,
              requestedMessages: count,
              panelState,
              seedTranscriptViewport: seed.transcriptViewport ?? null,
              notificationBatches: pageState.notificationBatches,
              error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) },
            };
            let pageContextCloseError = null;
            let pageContextClose = { status: "closing" };
            try {
              await page.context().close();
              pageContextClose = { status: "closed" };
            } catch (closeError) {
              pageContextCloseError = closeError;
              pageContextClose = {
                status: "failed",
                error: {
                  name: closeError?.name ?? "Error",
                  message: safeSeedErrorMessage(closeError),
                  stack: safeSeedErrorStack(closeError),
                },
              };
            }
            const completeFailureEvidence = {
              ...failureEvidence,
              screenshot,
              cleanup: { pageContextClose },
            };
            await context.writeArtifactJson(`phone-render-follow-gesture-failure-after-${count}-${panelState}.json`, {
              ...completeFailureEvidence,
            });
            const message = `follow-gesture regression failed for ${source.name}/${count}/${panelState}; see phone-render-follow-gesture-failure-after-${count}-${panelState}.json`;
            if (pageContextCloseError) {
              const combinedError = new AggregateError([error, pageContextCloseError], message, { cause: error });
              combinedError.followGestureEvidence = completeFailureEvidence;
              throw combinedError;
            }
            throw new Error(message, { cause: error });
          }
          await page.context().close();
          continue;
        }

        if (panelState === "mounted-hidden") {
          await page.getByTestId("task-more").click();
          await page.getByTestId("task-menu-workspace").click();
          await waitForTwoFrames(page);
          pageState.tabFocusTrace.push(await readFocusState(page, "tab-switcher-open"));
          await page.getByTestId("workspace-tab-changes").click();
          await waitForTwoFrames(page);
          pageState.tabFocusTrace.push(await readFocusState(page, "changes-selected"));
          await page.getByTestId("changes-panel").waitFor({ state: "attached", timeout: 15_000 });
          await page.getByTestId("changes-mode-turn").click();
          await waitForTwoFrames(page);
          pageState.changesSeedTurnViewContainsFile = await page.getByTestId("changes-panel").innerText().then((value) => value.includes("seed-0.ts"));
          assert.equal(pageState.changesSeedTurnViewContainsFile, true, "Changes turn view must render the seed file-change fixture before it is hidden");
          await page.getByTestId("task-more").click();
          await page.getByTestId("task-menu-workspace").click();
          await waitForTwoFrames(page);
          pageState.tabFocusTrace.push(await readFocusState(page, "tab-switcher-reopened"));
          const tabDialog = page.locator('[role="dialog"][aria-label="工作区标签"]');
          const dialogVisibleBeforeAgentSelection = await tabDialog.isVisible().catch(() => false);
          const modalDismissStartedAt = performance.now();
          await page.getByTestId("workspace-tab-agent").click();
          await waitForTwoFrames(page);
          pageState.tabFocusTrace.push(await readFocusState(page, "agent-selected-before-modal-dismiss"));
          let modalDismissError = null;
          try {
            await tabDialog.waitFor({ state: "hidden", timeout: 2_000 });
          } catch (error) {
            modalDismissError = String(error.message || error).slice(0, 300);
          }
          const modalDismissWaitMs = Number((performance.now() - modalDismissStartedAt).toFixed(3));
          await waitForTwoFrames(page);
          const modalVisibleAfterDismiss = await tabDialog.isVisible().catch(() => false);
          pageState.tabModalDismiss = {
            dialogVisibleBeforeAgentSelection,
            dialogVisibleAfterDismiss: modalVisibleAfterDismiss,
            waitMs: modalDismissWaitMs,
            dismissed: !modalVisibleAfterDismiss,
            timeout: modalDismissError,
            timingClassification: "workspace-tab modal slide/fade and onDismiss focus-trap teardown; excluded from input feedback latency",
          };
          pageState.tabFocusTrace.push(await readFocusState(page, "agent-selected-after-modal-dismiss"));
          const hiddenPanel = await page.getByTestId("changes-panel").evaluate((element) => ({
            attached: element.isConnected,
            panelDisplay: getComputedStyle(element).display,
            retainedPanelDisplay: element.parentElement ? getComputedStyle(element.parentElement).display : null,
            retainedPanelPointerEvents: element.parentElement ? getComputedStyle(element.parentElement).pointerEvents : null,
            retainedPanelBounds: element.parentElement?.getBoundingClientRect().toJSON() ?? null,
          }));
          assert.ok(hiddenPanel.attached && hiddenPanel.retainedPanelDisplay === "none" && hiddenPanel.retainedPanelPointerEvents === "none", "mounted-hidden case must keep Changes mounted under the hidden RetainedPanel");
          pageState.hiddenPanelEvidence = hiddenPanel;
          pageState.changesPanelMounted = true;
          pageState.inputFocusAfterTabReturn = await page.getByTestId("message-input").evaluate((element) => {
            element.focus();
            return { focusedImmediately: document.activeElement === element };
          });
          await waitForTwoFrames(page);
          pageState.inputFocusAfterTabReturn.focusedAfterTwoFrames = await page.getByTestId("message-input").evaluate((element) => document.activeElement === element);
          pageState.inputFocusAfterTabReturn.trace = await page.evaluate(() => window.__phoneRenderFocusEvents?.() ?? []);
          pageState.inputFocusAfterTabReturn.activeState = await readFocusState(page, "after-tab-focus-attempt");
        } else {
          assert.equal(await page.getByTestId("changes-panel").count(), 0, "unmounted case must not instantiate ChangesPanel");
          pageState.changesPanelMounted = false;
        }

        if (runtimeConsumerDiagnostic) {
          const diagnostic = buildRuntimeConsumerSeedDiagnostic(source, pageState, seed, mobileWeb);
          runtimeConsumerDiagnosticCases.push(diagnostic);
          await context.writeArtifactJson(`phone-render-runtime-consumer-seed-${panelState}.json`, diagnostic);
          await page.context().close();
          continue;
        }

        pageState.transcriptBeforeMeasuredInteractions = await captureTranscriptEvidence(page);
        const hiddenUpdates = [];
        if (coreAttributionOnly) {
          pageState.memoryBeforeMeasuredInteractions = null;
          pageState.memoryAfterMeasuredInteractions = null;
          pageState.hiddenUpdateTurnsCompleted = 0;
        } else {
          pageState.memoryBeforeMeasuredInteractions = await captureBrowserMemory(page);
          observations.push(...await measureInputFeedback(page, pageState, source.name, count, panelState, sampleCount));
          observations.push(...await measureScrollFeedback(page, pageState, source.name, count, panelState, sampleCount, context));

          hiddenUpdates.push(...await measureSnapshotUpdates(page, pageState, source.name, count, panelState, sampleCount, context));
          observations.push(...hiddenUpdates);
          pageState.hiddenUpdateTurnsCompleted = hiddenUpdates.filter((entry) => entry.ok).length;
          const missingHiddenUpdateSamples = Array.from({ length: sampleCount }, (_, index) => index + 1)
            .filter((sample) => !hiddenUpdates.some((entry) => entry.sample === sample));
          const failedHiddenUpdateSamples = hiddenUpdates
            .filter((entry) => entry.ok !== true
              || entry.agentRevision?.fixtureMarkerPresent !== true
              || entry.syntheticNotificationFramesDispatchedToAppMock !== 4)
            .map((entry) => entry.sample);
          const failedOrMissingHiddenUpdateSamples = [...new Set([...failedHiddenUpdateSamples, ...missingHiddenUpdateSamples])].sort((left, right) => left - right);
          if (hiddenUpdates.length !== sampleCount || failedOrMissingHiddenUpdateSamples.length > 0) {
            const failure = {
              schemaVersion: 1,
              failureStage: "hidden-update-commit-gate-before-active-stream",
              source: source.name,
              requestedMessages: count,
              panelState,
              expectedUpdateCount: sampleCount,
              resultCount: hiddenUpdates.length,
              successfulCommitCount: hiddenUpdates.length - failedHiddenUpdateSamples.length,
              failedOrMissingSampleIndices: failedOrMissingHiddenUpdateSamples,
              hiddenUpdateResults: hiddenUpdates,
            };
            await context.writeArtifactJson(`phone-render-profile-failure-${source.name}-${count}-${panelState}.json`, failure);
            throw new Error(`hidden Changes update commit gate failed for ${source.name}/${count}/${panelState}: expected ${sampleCount}/${sampleCount} committed markers; failed or missing sample indices: ${failedOrMissingHiddenUpdateSamples.join(",") || "unknown"}`);
          }
          pageState.memoryAfterMeasuredInteractions = await captureBrowserMemory(page);
        }

        // Formal/core performance samples keep Profiler disabled. The explicit
        // attribution-only selector profiles this same core burst and never enters
        // the performance observations or percentile output.
        let activeStream;
        try {
          activeStream = await measureActiveMarkdownDelta(page, pageState, source.name, count, panelState, sampleCount, coreAttributionOnly, {
            diagnosticOnly: coreAttributionOnly,
            profileKind: coreAttributionOnly ? "actual core active-Markdown burst; DIAGNOSTIC_ONLY, not a performance sample" : undefined,
            initialTailMarker: coreAttributionOnly ? `seed-${source.name}-${count}-${panelState}` : undefined,
          });
        } catch (error) {
          await context.writeArtifactJson(`phone-render-profile-failure-${source.name}-${count}-${panelState}.json`, {
            schemaVersion: 1,
            ...(coreAttributionOnly ? {
              classification: "DIAGNOSTIC_ONLY",
              performanceSample: false,
              performanceDistributionEligible: false,
              sourceMapEvidence: source.builderManifest.sourceMapEvidence,
            } : {}),
            failureStage: "active-markdown-stream-or-tail-follow",
            source: source.name,
            requestedMessages: count,
            panelState,
            expectedHiddenUpdateCount: sampleCount,
            successfulHiddenUpdateCount: pageState.hiddenUpdateTurnsCompleted,
            hiddenUpdateResults: hiddenUpdates,
            helperViewport: error?.transcriptViewport ?? error?.cause?.transcriptViewport ?? null,
            activeStreamFailureEvidence: error?.activeStreamFailureEvidence ?? error?.cause?.activeStreamFailureEvidence ?? null,
            error: {
              name: error?.name ?? "Error",
              message: String(error?.message || error).slice(0, 2000),
              stack: typeof error?.stack === "string" ? error.stack.slice(0, 8000) : null,
            },
          });
          throw error;
        }
        observations.push(...activeStream.observations);
        pageState.activeStreamEvidence = activeStream.evidence;
        pageState.memoryAfterActiveStream = coreAttributionOnly ? null : await captureBrowserMemory(page);

        if (coreAttributionOnly) {
          const burst = activeStream.evidence?.bursts?.[0] ?? null;
          let sourceMapAttribution = null;
          let sourceMapAttributionError = null;
          if (activeStream.cpuProfile) {
            try {
              sourceMapAttribution = await mapCpuProfileWithSourceMaps(
                activeStream.cpuProfile,
                mobileWeb.path,
                source.builderManifest.sourceMapEvidence,
                mobileWeb.bundleSha256,
                {
                  trustedMountPath: trustedSourceMapMountPath,
                  candidateSourceInventory: source.candidateSourceInventory,
                  sourceMappingEvidenceKind: source.sourceMappingEvidenceKind,
                },
              );
            } catch (error) {
              sourceMapAttributionError = String(error?.message || error).slice(0, 500);
            }
          }
          const record = makeCoreAttributionRecord({
            source: source.name,
            requestedMessages: count,
            panelState,
            bundleSha256: mobileWeb.bundleSha256,
            profile: activeStream.cpuProfile,
            burst,
            captureError: activeStream.evidence?.cpuProfileError,
          });
          record.classification = coreAttributionPolicy.classification;
          record.sourceMapEvidence = source.builderManifest.sourceMapEvidence;
          record.trustedSourceMapMountPath = trustedSourceMapMountPath ?? null;
          record.sourceMapAttribution = sourceMapAttribution;
          record.sourceMapAttributionError = sourceMapAttributionError;
          record.sourceAttributionStatus = sourceMapAttribution?.mappedFrameCount > 0 ? "MAPPED" : "UNRESOLVED";
          record.fixture = {
            historyRowsDelivered: pageState.historyRowsDelivered,
            historyResponseBytes: pageState.historyResponseBytes,
            threadReadPageCount: pageState.historyPages.length,
            websocketConnections: pageState.websocketConnections,
            activeSocketRoute: pageState.activeSocketRoute ?? null,
            notificationDispatchOrderValid: areNotificationBatchesOrdered(pageState.notificationBatches),
            seedTranscriptViewport: pageState.seedTranscriptViewport ?? null,
            changesPanelMounted: pageState.changesPanelMounted,
            hiddenPanelEvidence: pageState.hiddenPanelEvidence ?? null,
            turnStartRpcCount: pageState.rpcMethods["turn/start"] ?? 0,
          };
          coreAttributionCases.push(record);
          const artifact = `phone-render-core-attribution-${source.name}-${count}-${panelState}.json`;
          await context.writeArtifactJson(artifact, record);
          await page.context().close();
          assert.equal(record.coreBurstStatus, "PASS", `${panelState} core active-Markdown burst must pass its existing UI/terminal gate; see ${artifact}`);
          assert.equal(record.profileCaptureStatus, "CAPTURED", `${panelState} core attribution profile must contain V8 samples; see ${artifact}`);
          continue;
        }

        let activeMarkdownStackDiagnostic = null;
        if (captureStackDiagnostic) {
          const measuredStreamEvidence = pageState.activeStreamEvidence;
          const diagnostic = await measureActiveMarkdownDelta(page, pageState, source.name, count, panelState, 1, true, {
            diagnosticOnly: true,
            sampleOffset: sampleCount,
          });
          let sourceMapAttribution = null;
          let sourceMapAttributionError = null;
          if (diagnostic.cpuProfile) {
            try {
              sourceMapAttribution = await mapCpuProfileWithSourceMaps(
                diagnostic.cpuProfile,
                mobileWeb.path,
                source.builderManifest.sourceMapEvidence,
                mobileWeb.bundleSha256,
                {
                  trustedMountPath: trustedSourceMapMountPath,
                  candidateSourceInventory: source.candidateSourceInventory,
                  sourceMappingEvidenceKind: source.sourceMappingEvidenceKind,
                },
              );
            } catch (error) {
              sourceMapAttributionError = String(error?.message || error).slice(0, 500);
            }
          }
          activeMarkdownStackDiagnostic = {
            classification: "separate one-burst CDP V8 diagnostic; excluded from performance summaries and sample counts",
            source: source.name,
            requestedMessages: count,
            panelState,
            priorMeasuredActiveStreams: sampleCount,
            profile: diagnostic.cpuProfile,
            burst: diagnostic.evidence?.bursts?.[0] ?? null,
            sourceMapEvidence: source.builderManifest.sourceMapEvidence,
            trustedSourceMapMountPath: trustedSourceMapMountPath ?? null,
            sourceMapAttribution,
            sourceMapAttributionError,
            sourceAttributionStatus: !diagnostic.cpuProfile
              ? "PROFILE_NOT_CAPTURED"
              : sourceMapAttribution?.mappedFrameCount > 0 ? "MAPPED" : "UNRESOLVED",
          };
          if (diagnostic.cpuProfile) cpuProfiles.push(diagnostic.cpuProfile);
          // The diagnostic is a real additional completed assistant message, but it
          // must not replace the primary n=30 coverage evidence for this fixture.
          pageState.activeStreamEvidence = measuredStreamEvidence;
        }

        const transcriptEvidence = await captureTranscriptEvidence(page);

        fixtureEvidence.push({
          source: source.name,
          requestedMessages: count,
          panelState,
          historyRowsDelivered: pageState.historyRowsDelivered,
          historyResponseBytes: pageState.historyResponseBytes,
          threadReadPageCount: pageState.historyPages.length,
          pageRanges: pageState.historyPages,
          websocketConnections: pageState.websocketConnections,
          activeSocketRoute: pageState.activeSocketRoute ?? null,
          syntheticNotificationFramesSent: pageState.syntheticNotificationFramesSent ?? 0,
          syntheticNotificationBatches: pageState.notificationBatches,
          notificationDispatchOrderValid: areNotificationBatchesOrdered(pageState.notificationBatches),
          seedTranscriptViewport: pageState.seedTranscriptViewport ?? null,
          seedDeliveryEvidence: pageState.seedDeliveryEvidence ?? null,
          activeMarkdownStream: pageState.activeStreamEvidence,
          activeMarkdownStackDiagnostic,
          syntheticSeedMessages: 1,
          totalLoadedMessagesBeforeMeasuredUpdates: pageState.historyRowsDelivered + 1,
          measuredHiddenUpdateTurnsCompleted: hiddenUpdates.filter((entry) => entry.ok).length,
          expectedLogicalMessagesBeforeActiveStreams: pageState.historyRowsDelivered + 1 + pageState.hiddenUpdateTurnsCompleted,
          activeAssistantTurnsCompleted: pageState.activeStreamEvidence?.activeAssistantTurnsAdded ?? 0,
          expectedLogicalMessagesAfterActiveStreams: pageState.historyRowsDelivered + 1 + pageState.hiddenUpdateTurnsCompleted + (pageState.activeStreamEvidence?.activeAssistantTurnsAdded ?? 0),
          transcriptEvidence,
          transcriptBeforeMeasuredInteractions: pageState.transcriptBeforeMeasuredInteractions,
          markdownCodeToolFixture: pageState.fixtureShape,
          changesPanelMounted: pageState.changesPanelMounted,
          changesPanelVisibilityEvidence: pageState.hiddenPanelEvidence ?? null,
          changesModeTurnViewConfirmed: pageState.changesSeedTurnViewContainsFile ?? false,
          memoryBeforeMeasuredInteractions: pageState.memoryBeforeMeasuredInteractions,
          memoryAfterActiveStream: pageState.memoryAfterActiveStream,
          memoryAfterMeasuredInteractions: pageState.memoryAfterMeasuredInteractions,
          tabFocusTrace: pageState.tabFocusTrace ?? [],
          tabModalDismiss: pageState.tabModalDismiss ?? null,
          inputFocusAfterTabReturn: pageState.inputFocusAfterTabReturn ?? null,
          measuredSnapshotUpdateCount: hiddenUpdates.filter((entry) => entry.ok).length,
          rpcMethods: pageState.rpcMethods,
          turnStartRpcCount: pageState.rpcMethods["turn/start"] ?? 0,
          failedRequests: pageState.failedRequests,
          profileDiagnosticAssistantTurnsAdded: activeMarkdownStackDiagnostic?.burst?.finalAssistantRow?.finalMarkerPresent === true ? 1 : 0,
          expectedLogicalMessagesAfterProfileDiagnostic: pageState.historyRowsDelivered + 1 + pageState.hiddenUpdateTurnsCompleted
            + (pageState.activeStreamEvidence?.activeAssistantTurnsAdded ?? 0)
            + (activeMarkdownStackDiagnostic?.burst?.finalAssistantRow?.finalMarkerPresent === true ? 1 : 0),
        });
        await context.writeArtifactJson(`phone-render-profile-progress-${source.name}-${count}-${panelState}.json`, {
          schemaVersion: 1,
          observations,
          fixtureEvidence,
          cpuProfiles,
          phaseProvenance,
          browserErrors,
        });
        await page.context().close();
      }
    }
    await context.stopOwned(gatewayLabel);
  }

  if (coreAttributionOnly) {
    await chromium.close();
    const hostCpuAfter = await sampleHostCpuWindow("after-owned-browser-and-gateway-work");
    assert.equal(coreAttributionCases.length, 2, "core attribution must preserve one actual burst for each panel state");
    const result = {
      schemaVersion: 1,
      status: "DIAGNOSTIC_ONLY",
      classification: "DIAGNOSTIC_ONLY",
      diagnosticOnly: true,
      performanceSample: false,
      performanceDistributionEligible: false,
      outcomeStatus: !coreAttributionCases.every((entry) => entry.coreBurstStatus === "PASS" && entry.profileCaptureStatus === "CAPTURED")
        ? "PARTIAL"
        : coreAttributionCases.every((entry) => entry.sourceAttributionStatus === "MAPPED")
          ? "CORE_PROFILES_CAPTURED_AND_SOURCE_MAPPED"
          : "CORE_PROFILES_CAPTURED_SOURCE_MAP_UNRESOLVED",
      source: "after",
      requestedMessages: 500,
      coreBurstSamplesPerPanelState: 1,
      profilerSamplingIntervalUs: 500,
      panelStates: coreAttributionCases.map((entry) => entry.panelState),
      sourceMapInput: phaseProvenance[0] ?? null,
      hostCpuContext: { before: hostCpuBefore, after: hostCpuAfter },
      cases: coreAttributionCases,
      artifact: "phone-render-core-attribution-diagnostic.json",
      evidenceBoundary: "isolated KCODER_STUDIO_MOCK Mobile Web renderer; actual core active-Markdown burst is profiled in place and is diagnostic-only; no Rust app-server/model turn, no public relay, and no Android/iOS native measurement",
    };
    await context.writeArtifactJson(result.artifact, result);
    assert.notEqual(result.outcomeStatus, "PARTIAL", "both actual core bursts must produce profiles; see per-panel attribution artifacts");
    return result;
  }

  if (followGestureRegression) {
    await chromium.close();
    assert.equal(followGestureRegressionCases.length, 1, "follow-gesture diagnostic must complete exactly one after/count/unmounted fixture");
    const result = {
      status: "DIAGNOSTIC_ONLY",
      diagnosticOnly: true,
      performanceSample: false,
      source: sourceNames[0],
      requestedMessages: messageCounts[0],
      panelState: "unmounted",
      caseCount: followGestureRegressionCases.length,
      case: followGestureRegressionCases[0],
      artifact: `phone-render-follow-gesture-after-${messageCounts[0]}-unmounted.json`,
      evidenceBoundary: "isolated KCODER_STUDIO_MOCK Mobile Web UI using trusted Chromium input and synthetic ordered app-facing notifications; not a Rust app-server/model turn and not Android/iOS native validation",
    };
    await context.writeArtifactJson("phone-render-follow-gesture-diagnostic.json", result);
    return result;
  }

  if (naturalFollowDiagnostic) {
    await chromium.close();
    assert.equal(naturalFollowDiagnosticCases.length, 1, "natural-follow diagnostic must complete exactly one official-992 after/500/unmounted fixture");
    const result = {
      status: "DIAGNOSTIC_ONLY",
      functionalOutcome: "PASS",
      diagnosticOnly: true,
      performanceSample: false,
      scenario: "official-992-500-unmounted-natural-follow-after-completed-seed",
      source: sourceNames[0],
      requestedMessages: messageCounts[0],
      panelState: "unmounted",
      caseCount: naturalFollowDiagnosticCases.length,
      case: naturalFollowDiagnosticCases[0],
      input: phaseProvenance[0],
      artifact: "phone-render-profile-official-992-natural-follow-after-500-unmounted.json",
      evidenceBoundary: "official Git 992 Mobile Web export copied from its verified receipt and served at Gateway /mobile/; isolated KCODER_STUDIO_MOCK Gateway and synthetic four-frame WebSocketMock turn; optional passive TaskRuntime/panel probe is NOT_OBSERVED if absent; configured KCoder binary is not exercised; no real Rust turn, Provider, real-device, or performance claim",
    };
    await context.writeArtifactJson("phone-render-profile-official-992-natural-follow-summary.json", result);
    return result;
  }

  if (tailWindowProductRegression) {
    await chromium.close();
    assert.equal(tailWindowProductRegressionCases.length, 1, "tail-window product diagnostic must complete exactly one after/500/unmounted fixture");
    const result = {
      status: "DIAGNOSTIC_ONLY",
      diagnosticOnly: true,
      performanceSample: false,
      scenario: tailWindowProductRegressionCases[0].scenario,
      stage: tailWindowProductRegressionCases[0].stage,
      interruptionStatus: tailWindowProductRegressionCases[0].interruptionStatus,
      pagingStatus: "NOT_RUN_SEPARATE_SCENARIO",
      source: sourceNames[0],
      requestedMessages: messageCounts[0],
      panelState: "unmounted",
      caseCount: tailWindowProductRegressionCases.length,
      case: tailWindowProductRegressionCases[0],
      artifact: "phone-render-tail-window-core-after-500-unmounted.json",
      evidenceBoundary: "isolated KCODER_STUDIO_MOCK Mobile Web TaskTranscript/MessageBubble using trusted Chromium input and synthetic ordered app-facing WebSocketMock fixtures; not a Rust app-server/model turn and not Android/iOS native validation",
    };
    await context.writeArtifactJson("phone-render-tail-window-core-diagnostic.json", result);
    return result;
  }

  if (tailWindowPaginationRegression) {
    await chromium.close();
    assert.equal(tailWindowPaginationRegressionCases.length, 1, "tail-window pagination diagnostic must complete exactly one after/500/unmounted fixture");
    const result = {
      status: "DIAGNOSTIC_ONLY",
      diagnosticOnly: true,
      performanceSample: false,
      scenario: "trusted-wheel-older-page-prepend-anchor",
      coreStatus: "NOT_RUN_SEPARATE_SCENARIO",
      source: sourceNames[0],
      requestedMessages: messageCounts[0],
      panelState: "unmounted",
      caseCount: tailWindowPaginationRegressionCases.length,
      case: tailWindowPaginationRegressionCases[0],
      artifact: "phone-render-tail-window-pagination-after-500-unmounted.json",
      evidenceBoundary: "isolated KCODER_STUDIO_MOCK Mobile Web TaskTranscript/MessageBubble using trusted Chromium wheel/click and synthetic ordered app-facing WebSocketMock fixtures; not a Rust app-server/model turn, performance sample, or Android/iOS native validation",
    };
    await context.writeArtifactJson("phone-render-tail-window-pagination-diagnostic.json", result);
    return result;
  }

  if (runtimeConsumerDiagnostic) {
    assert.equal(runtimeConsumerDiagnosticCases.length, 2, "runtime-consumer diagnostic must preserve one seed observation for each panel state");
    await chromium.close();
    const result = {
      status: "DIAGNOSTIC_ONLY",
      diagnosticOnly: true,
      performanceSample: false,
      source: sourceNames[0],
      requestedMessages: messageCounts[0],
      seedSamplesPerPanelState: 1,
      panelStates: ["unmounted", "mounted-hidden"],
      cases: runtimeConsumerDiagnosticCases.map((entry) => ({
        panelState: entry.fixture.panelState,
        consumerProjectionStatus: entry.consumerProjection.status,
        domTailGatePassed: entry.domBoundary.passedSeedVisibleTailGate,
        runtimeInstanceOrdinals: entry.consumerProjection.runtimeInstanceOrdinals,
        identityFingerprintStatus: entry.consumerProjection.identityFingerprintStatus,
        panelAndRuntimeInstanceOrdinalMatch: entry.consumerProjection.panelAndRuntimeInstanceOrdinalMatch,
        panelSnapshotSameAsRuntimeAtEffect: entry.consumerProjection.panelSnapshotSameAsRuntimeAtEffect,
        legacyAllFourMethodsEntered: entry.consumerProjection.legacyIngressEvidence.allFourMethodsEntered,
        legacyAllFourMethodsProtocolAccepted: entry.consumerProjection.legacyIngressEvidence.allFourMethodsProtocolAccepted,
        markerPresentInRuntimeSnapshot: entry.consumerProjection.markerPresentInRuntimeSnapshot,
        runtimeCompletedStatusObserved: entry.consumerProjection.completedStatusObservedInRuntimeSnapshot,
        markerPresentInPanelProjection: entry.consumerProjection.markerPresentInPanelProjection,
        panelCompletedStatusObserved: entry.consumerProjection.completedStatusObservedInPanelProjection,
      })),
      artifact: "phone-render-runtime-consumer-seed-diagnostic.json",
    };
    await context.writeArtifactJson(result.artifact, {
      schemaVersion: 1,
      diagnosticOnly: true,
      performanceSample: false,
      evidenceClass: `two single-seed Mobile Web consumer diagnoses with one ${messageCounts[0]}-message after fixture per panel state; not part of the n=30 performance matrix`,
      source: sourceNames[0],
      requestedMessages: messageCounts[0],
      samplesPerPanelState: 1,
      cases: runtimeConsumerDiagnosticCases,
      claimBoundary: "isolated KCODER_STUDIO_MOCK Mobile Web app-facing Mock path with passive private TaskRuntime projection; does not prove Rust app-server receipt, Provider behavior, or native performance",
    });
    return result;
  }

  await chromium.close();
  const hostCpuAfter = await sampleHostCpuWindow("after-owned-browser-and-gateway-work");

  const summaries = summarizeObservations(observations, { suppressP95: suppressN1DiagnosticP95 });
  const longTaskSummary = summarizeLongTasks(observations, { suppressP95: suppressN1DiagnosticP95 });
  const profileSummary = {
    kind: captureStackDiagnostic
      ? "isolated Chromium CDP V8 CPU stack profiles from one additional active Markdown diagnostic burst per selected fixture; excluded from core latency samples"
      : "no CDP V8 CPU profile requested; core/formal latency samples ran with the profiler disabled",
    profiles: cpuProfiles,
  };
  const coverage = createCoverage(sourceNames, messageCounts, sampleCount, observations, fixtureEvidence, browserErrors, phaseProvenance, cpuProfiles);
  await context.writeArtifactJson("phone-render-profile-metrics.json", {
    schemaVersion: 1,
    measurement: {
      sampleCountPerCoreScenario: sampleCount,
      messageCounts,
      activeMarkdownBurstSamplesPerCoreScenario: sampleCount,
      activeMarkdownDeltaFramesPerBurst: activeDeltaChunksPerStream,
      testSuiteSha256: suiteSourceSha256,
      fixtureHistoryPageSize: fixturePageSize,
      fixtureShape: "long Markdown paragraphs and tables, code blocks, structured tool inputs/outputs, and file-change artifacts; test-side WebSocket page responses",
      hiddenChangesUpdate: "synthetic ordered turn/started, item/started, item/delta, turn/completed notifications are delivered to the isolated Mobile runtime WebSocket; both panel states use changed Agent assistant-row content followed by two requestAnimationFrame callbacks as the primary boundary; mounted-hidden Changes filename is supplemental; no model, Provider, or user session",
      activeMarkdownStream: `${sampleCount} independent active agentMessage bursts per core scenario, each adds ${activeDeltaChunksPerStream} long Markdown/table/code item/delta frames in separate fast MessageChannel browser tasks; the final delta and turn/completed are dispatched in the same browser task to exercise a pending-delta terminal flush; core latency bursts do not run V8 Profiler; synchronous per-frame handler time, Agent-row revision through two requestAnimationFrame opportunities, and exact final-marker visibility after real tail-follow are separate measurements; the final marker's last-character DOM Range must intersect the message-list viewport after two stable scroll observations and two requestAnimationFrame opportunities`,
      activeMarkdownFinalFlush: "terminal turn/completed handler synchronous cost remains a separate task metric; visible-final-flush duration runs from completion dispatch to the exact final-marker glyph intersecting message-list after auto-follow or one real jump-to-latest touch, stable viewport polling, and two requestAnimationFrame opportunities; scroll wait is excluded from synchronous handler and Agent-row revision latency",
      activeMarkdownDeltaHandler: `${activeDeltaChunksPerStream} delta-handler timing subsamples per burst are reported separately; they do not count as independent stream samples or replace the ${sampleCount} active stream samples`,
      mockSocketInstrumentation: "App-facing Playwright 1.62 WebSocketMock is identified by open-event registration plus its private _id/_apiSendToPage surface; a wrapper records only small outbound RPC method/id/threadId before fixture measurement. Synthetic incoming deltas are delivered through that same Mock and are not JSON-parsed by a measurement observer.",
      inputBoundary: "browser keydown event to next animation frame after the React Native Web input value updates; separate automation elapsed time also includes CDP/test harness delivery",
      scrollBoundary: "CDP mobile touchstart to first actual list scroll followed by next animation frame; separate automation elapsed time also includes CDP/test harness delivery",
      synchronousEventTaskBoundary: "capture-phase event listener entry through a microtask queued after synchronous target/bubble handlers",
      longTaskBoundary: "PerformanceObserver longtask entries, browser-defined tasks over 50ms; supplemental long-animation-frame script attribution is reported separately",
      notificationFeedbackBoundary: "test-side app-facing WebSocketMock injection timestamp through changed Agent assistant-row text and two requestAnimationFrame opportunities; exact final-marker last-character viewport intersection after auto-follow or a real jump-to-latest touch is a separate user-visible-tail boundary; per-frame Mock delivery/handler synchronous cost is separate, and no compositor paint timestamp or Gateway network transport is included",
      memoryBoundary: "Chromium CDP heap and DOM counter snapshots before and after interactions; no forced garbage collection; fixture response byte count is recorded separately and conversation history is not persisted by this harness",
    },
    browser: browserInfo,
    hostCpuContext: { before: hostCpuBefore, after: hostCpuAfter, interpretation: "one-second host-wide and non-suite-process CPU windows around the owned browser/Gateway workload; this is context only and does not prove the whole run was idle" },
    summaries,
      longTasks: longTaskSummary,
      longAnimationFrames: summarizeLongAnimationFrames(observations),
    observations,
    fixtureEvidence,
    cpuProfile: profileSummary,
    coverage,
  });
  await context.writeArtifactJson("phone-render-profile-provenance.json", {
    schemaVersion: 1,
    gitCommit: context.gitCommit,
    beforeAndAfter: phaseProvenance,
    testSuiteSha256: suiteSourceSha256,
    browser: browserInfo,
    hostCpuContext: { before: hostCpuBefore, after: hostCpuAfter },
    frozenGatewayRuntime: gatewayRuntime.provenance,
    nativeStatus: "UNVERIFIED: Chromium Mobile Web emulation only; no Android/iOS app, Hermes, operating-system keyboard, or native storage was measured",
    testIsolation: {
      gatewayMode: "KCODER_STUDIO_MOCK",
      realProviderConfigured: false,
      turnStartRpcCount: fixtureEvidence.reduce((total, item) => total + item.turnStartRpcCount, 0),
      activeUserSession: false,
      workspacePathsOwnedByRun: true,
      generatedFixtureContentPersisted: false,
    },
  });
  await context.writeArtifactJson("phone-render-profile-coverage.json", coverage);

  assert.equal(fixtureEvidence.length, sources.length * messageCounts.length * 2, "every source/count/panel-state fixture must complete");
  assert.equal(observations.filter((entry) => entry.scenario === "input-feedback" && entry.ok).length, sources.length * messageCounts.length * 2 * sampleCount, "all required input samples must complete for both panel states");
  assert.equal(observations.filter((entry) => entry.scenario === "scroll-feedback" && entry.ok).length, sources.length * messageCounts.length * 2 * sampleCount, "all required scroll samples must complete for both panel states");
  assert.equal(observations.filter((entry) => entry.scenario === "active-markdown-stream" && entry.ok).length, sources.length * messageCounts.length * 2 * sampleCount, "all independent active Markdown stream samples must render a real Agent row in both panel states");
  assert.equal(observations.filter((entry) => entry.scenario === "active-markdown-delta-handler" && entry.ok).length, sources.length * messageCounts.length * 2 * sampleCount * activeDeltaChunksPerStream, "all per-delta handler subsamples must reach the actual TaskRuntime handler");
  assert.equal(observations.filter((entry) => entry.scenario === "active-markdown-final-flush" && entry.ok).length, sources.length * messageCounts.length * 2 * sampleCount, "each independent active stream must verify a pending final delta flush");
  assert.equal(observations.filter((entry) => entry.scenario.startsWith("hidden-changes-update-") && entry.ok).length, sources.length * messageCounts.length * 2 * sampleCount, "all hidden Changes update samples must complete");
  assert.equal(fixtureEvidence.filter((item) => item.activeMarkdownStream?.dispatchOrderValid && item.activeMarkdownStream.burstCount === sampleCount && item.activeMarkdownStream.activeAssistantTurnsAdded === sampleCount && item.activeMarkdownStream.bursts.every((burst) => burst.finalFlushPendingAtCompletion && burst.finalAssistantRow?.finalMarkerPresent && burst.finalAssistantRow?.finalMarkerVisibleWithinMessageList && burst.finalAssistantRow?.runtimeTerminalUi && !burst.finalAssistantRow?.failureMarkerPresent && !burst.finalAssistantRow?.unknownMarkerPresent)).length, sources.length * messageCounts.length * 2, `each fixture must preserve ${sampleCount} independent active turns, append completed Assistant rows, and flush the final pending delta into a visible final marker`);
  assert.equal(fixtureEvidence.reduce((total, item) => total + item.turnStartRpcCount, 0), 0, "the isolated fixture must not start a model turn");
  assert.equal(browserErrors.length, 0, "Mobile Web profile pages must not produce browser errors");

  return {
    status: coverage.overallStatus,
    sampleCount,
    messageCounts,
    summaries,
    longTasks: longTaskSummary,
    hostCpuContext: { before: hostCpuBefore, after: hostCpuAfter },
    topProfile: cpuProfiles.map((profile) => ({ source: profile.source, requestedMessages: profile.requestedMessages, topFunctions: profile.topFunctions.slice(0, 10) })),
    coverageArtifact: "phone-render-profile-coverage.json",
    provenanceArtifact: "phone-render-profile-provenance.json",
    metricsArtifact: "phone-render-profile-metrics.json",
  };
});

function appendInitialEntryRpcLedgerEvent(state, event) {
  const ledger = state.initialEntryRpcLedger;
  ledger.seenEventCount += 1;
  const boundedEvent = {
    sequence: ledger.seenEventCount,
    elapsedNodeMs: Number((performance.now() - ledger.startedAtNodeMs).toFixed(3)),
    ...event,
  };
  const bytes = Buffer.byteLength(JSON.stringify(boundedEvent));
  if (ledger.events.length >= initialEntryRpcLedgerLimits.maxEvents
    || bytes > initialEntryRpcLedgerLimits.maxEventBytes
    || ledger.recordedBytes + bytes > initialEntryRpcLedgerLimits.maxBytes) {
    ledger.droppedEventCount += 1;
    ledger.overflow = true;
    return false;
  }
  ledger.events.push(boundedEvent);
  ledger.recordedBytes += bytes;
  return true;
}

function initialEntryRpcEndpoint(url, gatewayBaseUrl, fixtureWorkspace) {
  try {
    const parsed = new URL(url);
    const expected = new URL(gatewayBaseUrl);
    expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
    expected.pathname = `${expected.pathname.replace(/\/+$/, "")}/rpc`;
    expected.search = "";
    const channelValues = parsed.searchParams.getAll("channel");
    const serverValues = parsed.searchParams.getAll("server");
    const workspaceValues = parsed.searchParams.getAll("workspace");
    const channelValue = channelValues.length === 1 ? channelValues[0] : null;
    const routeWorkspace = workspaceValues.length === 1 ? workspaceValues[0] : null;
    return {
      originMatchesGateway: parsed.origin === expected.origin,
      rpcPathMatches: parsed.pathname === expected.pathname,
      channel: channelValues.length === 0
        ? "missing"
        : channelValues.length > 1
          ? "ambiguous"
          : channelValue === "runtime" || channelValue === "browser" ? channelValue : "other",
      serverMatchesFixture: serverValues.length === 1 && serverValues[0] === serverId,
      workspacePresent: workspaceValues.length === 1,
      workspaceMatchesFixture: routeWorkspace === fixtureWorkspace,
    };
  } catch {
    return {
      originMatchesGateway: false,
      rpcPathMatches: false,
      channel: "invalid",
      serverMatchesFixture: false,
      workspacePresent: false,
      workspaceMatchesFixture: false,
    };
  }
}

function initialEntryRpcIdFingerprint(id) {
  if (typeof id !== "string" && typeof id !== "number") return null;
  return sha256(`${typeof id}:${String(id)}`).slice(0, 16);
}

function initialEntryRpcMethodSummary(method) {
  if (typeof method !== "string") return { method: null, methodFingerprint: null };
  return initialEntryRpcMethodAllowlist.has(method)
    ? { method, methodFingerprint: null }
    : { method: "other", methodFingerprint: sha256(method).slice(0, 12) };
}

function isValidInitialEntryRpcResponse(frame) {
  if (frame?.jsonrpc !== "2.0" || !Object.hasOwn(frame ?? {}, "id")) return false;
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  return Boolean(frame.error && typeof frame.error === "object" && !Array.isArray(frame.error)
    && Number.isInteger(frame.error.code) && typeof frame.error.message === "string");
}

function initialEntryRpcResponseSummary(frame, request) {
  const result = frame && typeof frame.result === "object" && frame.result !== null && !Array.isArray(frame.result)
    ? frame.result
    : null;
  const thread = result?.thread && typeof result.thread === "object" && !Array.isArray(result.thread)
    ? result.thread
    : null;
  const messages = Array.isArray(result?.messages) ? result.messages : null;
  const summary = {
    responseEnvelopeStatus: isValidInitialEntryRpcResponse(frame) ? "VALID_JSONRPC_RESPONSE" : "MALFORMED_OR_UNEXPECTED_RESPONSE",
    hasResult: Object.hasOwn(frame ?? {}, "result"),
    hasError: Object.hasOwn(frame ?? {}, "error"),
    errorCodeIsInteger: Number.isInteger(frame?.error?.code),
    resultHasThread: thread !== null,
    resultThreadMatchesFixture: thread?.id === threadId,
    resultHasMessages: messages !== null,
    resultMessageCount: messages?.length ?? null,
    resultHasInlineHistory: Boolean(result && Object.hasOwn(result, "history")),
  };
  if (request?.method === "initialize") {
    const experimental = result?.capabilities?.experimental;
    summary.serverCapabilities = {
      threadResume: result?.capabilities?.threadResume === true,
      experimental: Object.fromEntries(initialEntryRpcCapabilityAllowlist.map((name) => [name, experimental?.[name] === true])),
    };
  }
  if (request?.method === "thread/resume") {
    summary.resumeInlineHistoryPresent = Boolean(result && Object.hasOwn(result, "history"));
    summary.resumeThreadMatchesFixture = thread?.id === threadId;
  }
  return summary;
}

function snapshotInitialEntryRpcLedger(state) {
  const ledger = state.initialEntryRpcLedger;
  const endpointCoverage = [...ledger.endpointCounts.values()].map((entry) => ({
    ...entry.endpoint,
    observedWebSocketCount: entry.observedWebSocketCount,
    routeInterceptCount: entry.routeInterceptCount,
    interceptionStatus: entry.observedWebSocketCount === 0
      ? "NO_OBSERVED_WEBSOCKET"
      : entry.routeInterceptCount === entry.observedWebSocketCount
        ? "COUNT_MATCHED"
        : entry.routeInterceptCount === 0
          ? "OBSERVED_NOT_INTERCEPTED"
          : "PARTIAL_OR_UNPAIRED",
  }));
  const pendingRequestCount = ledger.sockets.reduce((count, socket) => count + socket.pending.size, 0);
  return {
    schemaVersion: 1,
    status: ledger.overflow
      ? "INCOMPLETE_OVERFLOW"
      : ledger.unpairedResponseCount > 0 || ledger.malformedResponseCount > 0 || pendingRequestCount > 0
        ? "BOUNDED_CAPTURE_WITH_UNPAIRED_OR_MALFORMED_RPC"
        : "BOUNDED_CAPTURE_COMPLETE",
    limits: initialEntryRpcLedgerLimits,
    observedWebSocketCount: ledger.observedWebSocketCount,
    routeInterceptCount: ledger.routeInterceptCount,
    seenEventCount: ledger.seenEventCount,
    recordedEventCount: ledger.events.length,
    droppedEventCount: ledger.droppedEventCount,
    droppedConnectionCount: ledger.droppedConnectionCount,
    pendingCorrelationOverflowCount: ledger.pendingCorrelationOverflowCount,
    unpairedResponseCount: ledger.unpairedResponseCount,
    malformedResponseCount: ledger.malformedResponseCount,
    pendingRequestCount,
    recordedBytes: ledger.recordedBytes,
    overflow: ledger.overflow,
    endpointCoverage,
    events: structuredClone(ledger.events),
  };
}

function initialEntryRpcFrameMetadata(direction, payload, socket) {
  const frame = parseFrame(payload);
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return {
      kind: "non-json-websocket-frame",
      direction,
      payloadBytes: Buffer.byteLength(Buffer.isBuffer(payload) ? payload : String(payload ?? "")),
      socketOrdinal: socket.ordinal,
      ...socket.endpoint,
    };
  }
  const hasMethod = typeof frame.method === "string";
  const idPresent = Object.hasOwn(frame, "id");
  const idFingerprint = idPresent ? initialEntryRpcIdFingerprint(frame.id) : null;
  const methodSummary = initialEntryRpcMethodSummary(hasMethod ? frame.method : null);
  let matchedRequest = null;
  if (direction === "sent" && hasMethod && idPresent && idFingerprint !== null) {
    if (socket.pending.size >= initialEntryRpcLedgerLimits.maxPendingPerSocket) {
      socket.pendingOverflow += 1;
      socket.ledger.pendingCorrelationOverflowCount += 1;
      socket.ledger.overflow = true;
    } else if (socket.pending.has(idFingerprint)) {
      socket.pendingOverflow += 1;
      socket.ledger.pendingCorrelationOverflowCount += 1;
      socket.ledger.overflow = true;
    } else {
      socket.pending.set(idFingerprint, { method: frame.method, idFingerprint });
    }
  } else if (direction === "received" && !hasMethod) {
    if (idPresent) {
      matchedRequest = idFingerprint === null ? null : socket.pending.get(idFingerprint) ?? null;
      if (matchedRequest) socket.pending.delete(idFingerprint);
      else socket.ledger.unpairedResponseCount += 1;
    }
    if (!isValidInitialEntryRpcResponse(frame)) socket.ledger.malformedResponseCount += 1;
  }
  return {
    kind: "rpc-frame",
    direction: direction === "sent" ? "client-to-server" : "server-to-client",
    socketOrdinal: socket.ordinal,
    ...socket.endpoint,
    ...methodSummary,
    idPresent,
    idFingerprint,
    matchedRequestMethod: matchedRequest ? initialEntryRpcMethodSummary(matchedRequest.method).method : null,
    responseMatch: direction === "received" && idPresent && !hasMethod ? matchedRequest ? "MATCHED" : "UNPAIRED" : null,
    ...(hasMethod ? {
      threadIdMatchesFixture: typeof frame.params?.threadId === "string" ? frame.params.threadId === threadId : null,
      ...(frame.method === "thread/read" ? {
        limit: Number.isSafeInteger(frame.params?.limit) ? frame.params.limit : null,
        beforeCursorPresent: typeof frame.params?.beforeCursor === "string" && frame.params.beforeCursor.length > 0,
      } : {}),
      ...(frame.method === "thread/resume" ? {
        historyPresent: Boolean(frame.params && Object.hasOwn(frame.params, "history")),
        indexedRequested: frame.params?.history?.indexed === true,
      } : {}),
      ...(frame.method === "initialize" ? {
        offeredCapabilities: Object.fromEntries(initialEntryRpcCapabilityAllowlist.map((name) => [name, frame.params?.capabilities?.experimental?.[name] === true])),
      } : {}),
    } : {}),
    ...(direction === "received" && !hasMethod ? initialEntryRpcResponseSummary(frame, matchedRequest) : {}),
  };
}

async function installHistoryAndNotificationFixture(page, state, gatewayBaseUrl) {
  const ledger = gatewayBaseUrl ? state.initialEntryRpcLedger : null;
  if (ledger) {
    page.on("websocket", (websocket) => {
      ledger.observedWebSocketCount += 1;
      const endpoint = initialEntryRpcEndpoint(websocket.url(), gatewayBaseUrl, state.workspacePath);
      const endpointKey = JSON.stringify(endpoint);
      let coverage = ledger.endpointCounts.get(endpointKey);
      if (!coverage) {
        coverage = { endpoint, observedWebSocketCount: 0, routeInterceptCount: 0 };
        ledger.endpointCounts.set(endpointKey, coverage);
      }
      coverage.observedWebSocketCount += 1;
      const ordinal = ledger.observedWebSocketCount;
      if (ordinal > initialEntryRpcLedgerLimits.maxConnections) {
        ledger.droppedConnectionCount += 1;
        ledger.overflow = true;
        return;
      }
      const socket = { ordinal, endpoint, pending: new Map(), pendingOverflow: 0, ledger };
      ledger.sockets.push(socket);
      appendInitialEntryRpcLedgerEvent(state, { kind: "websocket-observed", socketOrdinal: ordinal, ...endpoint });
      websocket.on("framesent", (event) => appendInitialEntryRpcLedgerEvent(state, initialEntryRpcFrameMetadata("sent", event?.payload, socket)));
      websocket.on("framereceived", (event) => appendInitialEntryRpcLedgerEvent(state, initialEntryRpcFrameMetadata("received", event?.payload, socket)));
      websocket.on("socketerror", () => appendInitialEntryRpcLedgerEvent(state, { kind: "websocket-error", socketOrdinal: ordinal, ...endpoint }));
      websocket.on("close", () => appendInitialEntryRpcLedgerEvent(state, { kind: "websocket-close", socketOrdinal: ordinal, ...endpoint }));
    });
  }
  await page.routeWebSocket("**/rpc*", (socket) => {
    const socketUrl = new URL(socket.url());
    const routeOrdinal = state.websocketConnections.length;
    const routeWorkspace = socketUrl.searchParams.get("workspace");
    const safeEndpoint = ledger ? initialEntryRpcEndpoint(socket.url(), gatewayBaseUrl, state.workspacePath) : null;
    if (ledger) {
      ledger.routeInterceptCount += 1;
      const endpointKey = JSON.stringify(safeEndpoint);
      let coverage = ledger.endpointCounts.get(endpointKey);
      if (!coverage) {
        coverage = { endpoint: safeEndpoint, observedWebSocketCount: 0, routeInterceptCount: 0 };
        ledger.endpointCounts.set(endpointKey, coverage);
      }
      coverage.routeInterceptCount += 1;
      appendInitialEntryRpcLedgerEvent(state, {
        kind: "fixture-route-intercepted",
        routeOrdinal,
        routeIntercepted: true,
        ...safeEndpoint,
      });
    }
    const routeInfo = {
      routeOrdinal,
      server: socketUrl.searchParams.get("server"),
      channel: socketUrl.searchParams.get("channel"),
      workspace: routeWorkspace,
      workspaceMatchesFixture: routeWorkspace === state.workspacePath,
    };
    state.websocketConnections.push(routeInfo);
    const upstream = socket.connectToServer();
    const socketRecord = { socket, routeInfo, closed: false, closeReason: null };
    state.websocketSocketRecords.push(socketRecord);
    socket.onClose((_code, reason) => {
      socketRecord.closed = true;
      socketRecord.closeReason = String(reason ?? "").slice(0, 100);
    });
    upstream.onClose((_code, reason) => {
      socketRecord.closed = true;
      socketRecord.closeReason = String(reason ?? "").slice(0, 100);
    });
    const requests = new Map();
    socket.onMessage((raw) => {
      const frame = parseFrame(raw);
      if (frame && typeof frame.method === "string") {
        state.rpcMethods[frame.method] = (state.rpcMethods[frame.method] ?? 0) + 1;
        let fixtureReadDecision = null;
        if (frame.method === "thread/read" && frame.id !== undefined) {
          state.readRequestStarted(frame);
          if (ledger) {
            const guardReasons = [];
            if (frame.params?.threadId !== threadId) guardReasons.push("thread-id-mismatch");
            if (!safeEndpoint.serverMatchesFixture) guardReasons.push("server-mismatch");
            if (safeEndpoint.channel !== "runtime") guardReasons.push("channel-not-runtime");
            if (!safeEndpoint.workspaceMatchesFixture) guardReasons.push("workspace-mismatch");
            fixtureReadDecision = {
              matchedFixtureGuard: guardReasons.length === 0,
              guardReasons,
              forwardingMode: frame.params?.limit === 1 ? "PASSTHROUGH_LIMIT_1" : "SYNTHETIC_HISTORY_PAGE",
              limit: Number.isSafeInteger(frame.params?.limit) ? frame.params.limit : null,
            };
            appendInitialEntryRpcLedgerEvent(state, {
              kind: "fixture-thread-read-decision",
              routeOrdinal,
              idFingerprint: initialEntryRpcIdFingerprint(frame.id),
              threadIdMatchesFixture: frame.params?.threadId === threadId,
              ...safeEndpoint,
              ...fixtureReadDecision,
            });
          }
          if (frame.params?.threadId === threadId
            && routeInfo.server === serverId
            && routeInfo.channel === "runtime"
            && routeInfo.workspaceMatchesFixture) {
            state.activeSocketRoute = { ...routeInfo, threadReadRequestId: frame.id };
            state.activeThreadReadRequestId = frame.id;
          }
        }
        if (frame.id !== undefined) requests.set(String(frame.id), { frame, fixtureReadDecision });
      }
      upstream.send(raw);
    });
    upstream.onMessage((raw) => {
      let outbound = raw;
      const frame = parseFrame(raw);
      const requestEntry = frame?.id === undefined ? null : requests.get(String(frame.id));
      const request = requestEntry?.frame ?? null;
      if (frame && request?.method === "thread/read") {
        const actualMessages = Array.isArray(frame.result?.messages) ? frame.result.messages.length : null;
        if (request.params?.limit === 1) {
          if (ledger) {
            appendInitialEntryRpcLedgerEvent(state, {
              kind: "fixture-thread-read-response",
              routeOrdinal,
              idFingerprint: initialEntryRpcIdFingerprint(frame.id),
              forwardingMode: requestEntry.fixtureReadDecision?.forwardingMode ?? "UNCLASSIFIED",
              matchedFixtureGuard: requestEntry.fixtureReadDecision?.matchedFixtureGuard ?? null,
              guardReasons: requestEntry.fixtureReadDecision?.guardReasons ?? [],
              actualMessageCount: actualMessages,
              responseThreadMatchesFixture: frame.result?.thread?.id === threadId,
            });
          }
          if (frame.id !== undefined) requests.delete(String(frame.id));
          socket.send(raw);
          return;
        }
        const requestedLimit = Number.isSafeInteger(request.params?.limit) && request.params.limit > 0
          ? request.params.limit
          : fixturePageSize;
        const initialHistoryRemaining = Number.isSafeInteger(state.initialHistoryTarget)
          ? Math.max(0, state.initialHistoryTarget - state.historyRowsDelivered)
          : 0;
        const boundedInitialLimit = initialHistoryRemaining > 0
          ? Math.min(requestedLimit, initialHistoryRemaining)
          : requestedLimit;
        const pageData = makeHistoryPage(
          state.historyMessageCount,
          request.params?.beforeCursor,
          boundedInitialLimit,
          state.workspacePath,
          state.markLatestHistoryTailForVisibility,
        );
        frame.result = {
          thread: { id: threadId, title: "Mobile render profile fixture", status: "idle", cwd: state.workspacePath, model: "mock-mobile" },
          ...pageData,
        };
        for (const message of pageData.messages) state.historyMessageIds.add(message.id);
        state.historyRowsDelivered = state.historyMessageIds.size;
        state.historyPages.push({
          requestId: String(frame.id),
          start: pageData.rangeStart,
          end: pageData.rangeEnd,
          count: pageData.messages.length,
          cursor: request.params?.beforeCursor ?? null,
          requestedLimit,
          boundedInitialLimit,
        });
        if (ledger) {
          appendInitialEntryRpcLedgerEvent(state, {
            kind: "fixture-thread-read-response",
            routeOrdinal,
            idFingerprint: initialEntryRpcIdFingerprint(frame.id),
            forwardingMode: "SYNTHETIC_HISTORY_PAGE",
            matchedFixtureGuard: requestEntry.fixtureReadDecision?.matchedFixtureGuard ?? null,
            guardReasons: requestEntry.fixtureReadDecision?.guardReasons ?? [],
            actualMessageCount: actualMessages,
            syntheticMessageCount: pageData.messages.length,
            responseThreadMatchesFixture: frame.result?.thread?.id === threadId,
          });
        }
        outbound = JSON.stringify(frame);
        state.historyResponseBytes = (state.historyResponseBytes ?? 0) + Buffer.byteLength(outbound);
      }
      if (frame?.id !== undefined) requests.delete(String(frame.id));
      socket.send(outbound);
    });
  });
}



async function connectMobile(page, gateway, pageState, { officialMobileMount = false, context } = {}) {
  let mobileEntry = null;
  const mobileEntryArtifact = `official-mobile-mounted-entry-and-pairing-${pageState.source}-${pageState.count}-${pageState.panelState}.json`;
  if (officialMobileMount) {
    const gatewayOrigin = new URL(gateway.baseUrl).origin;
    const mobileResourceResponses = [];
    const evidence = {
      status: "RUNNING",
      path: "/mobile/",
      sameOrigin: true,
      entryStatus: null,
      pairingStatus: "NOT_STARTED",
      responses: mobileResourceResponses,
      documentLoaded: false,
      javascriptLoaded: false,
      stylesheetLoaded: false,
    };
    pageState.mobileEntryEvidence = evidence;
    const recordMobileResource = (response) => {
      try {
        const url = new URL(response.url());
        if (url.origin !== gatewayOrigin || !(url.pathname === "/mobile" || url.pathname.startsWith("/mobile/"))) return;
        const headers = response.headers();
        mobileResourceResponses.push({
          path: url.pathname,
          resourceType: response.request().resourceType(),
          status: response.status(),
          contentType: headers["content-type"] || null,
          contentLength: headers["content-length"] || null,
        });
      } catch { /* ignore non-URL response objects */ }
    };
    page.on("response", recordMobileResource);
    try {
      const response = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      evidence.entryStatus = response?.status() ?? null;
      assert.equal(response?.status(), 200, "official Mobile Web document must be served by the isolated Gateway at /mobile/");
      await page.waitForLoadState("load", { timeout: 30_000 });
      await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 15_000 });
      evidence.documentLoaded = mobileResourceResponses.some((row) => row.resourceType === "document" && row.status === 200 && row.contentType?.includes("text/html"));
      evidence.javascriptLoaded = mobileResourceResponses.some((row) => row.resourceType === "script" && row.status === 200);
      evidence.stylesheetLoaded = mobileResourceResponses.some((row) => row.resourceType === "stylesheet" && row.status === 200);
      assert.equal(evidence.documentLoaded, true, "official Mobile Web HTML must load from Gateway /mobile/");
      assert.equal(evidence.javascriptLoaded, true, "official Mobile Web JavaScript must load from Gateway /mobile/");
      assert.equal(evidence.stylesheetLoaded, true, "official Mobile Web stylesheet must load from Gateway /mobile/");
      assert.ok(mobileResourceResponses.every((row) => row.status === 200), "every observed same-origin /mobile/ response must succeed");
      evidence.status = "PASS";
    } catch (error) {
      evidence.status = "FAIL";
      evidence.error = safeSeedErrorMessage(error);
      await context.writeArtifactJson(mobileEntryArtifact, evidence);
      throw error;
    } finally {
      page.off("response", recordMobileResource);
    }
    mobileEntry = evidence;
  } else {
    const login = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    assert.equal(login?.status(), 200, "isolated fixture Gateway must serve the selected Mobile Web bundle");
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  try {
    await page.getByTestId("welcome-direct-connection").click();
    await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
    await page.getByTestId("gateway-token").fill(gateway.authToken);
    const mockObserver = await page.evaluate(() => window.__phoneRenderInstallMockSocketSendObserver?.() ?? { installed: false, reason: "instrumentation init script did not run" });
    assert.equal(mockObserver.installed, true, `the app-facing Playwright WebSocketMock must be instrumented before Mobile opens its RPC clients: ${JSON.stringify(mockObserver)}`);
    await page.getByTestId("gateway-connect").click();
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
    const serverToggle = page.getByTestId(`toggle-server-${serverId}`);
    if ((await serverToggle.getAttribute("aria-expanded")) !== "true") await serverToggle.click();
    await page.getByTestId(`thread-${threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    if (mobileEntry) {
      mobileEntry.pairingStatus = "PASS";
      await context.writeArtifactJson(mobileEntryArtifact, mobileEntry);
    }
  } catch (error) {
    if (mobileEntry) {
      mobileEntry.pairingStatus = "FAIL";
      mobileEntry.pairingError = safeSeedErrorMessage(error);
      await context.writeArtifactJson(mobileEntryArtifact, mobileEntry);
    }
    throw error;
  }
  return mobileEntry;
}

async function loadHistoryToCount(page, state, targetCount) {
  const expectedRows = targetCount;
  let guard = 0;
  while (state.historyRowsDelivered < expectedRows) {
    assert.ok(guard++ < 50, "history pagination exceeded the fixture safety bound");
    const beforePages = state.historyPages.length;
    const button = page.getByTestId("load-older-messages");
    await button.waitFor({ state: "attached", timeout: 15_000 });
    await button.evaluate((element) => element.click());
    await waitFor(() => Promise.resolve(state.historyPages.length > beforePages), 15_000, "next synthetic thread/read page", 10);
    await waitForTwoFrames(page);
  }
  assert.equal(state.historyRowsDelivered, expectedRows, "fixture pagination must load the exact history row count");
}

function latestLoadedHistoryTail(state) {
  const fixtureHistoryIds = [...state.historyMessageIds]
    .map((id) => ({ id, match: /^history-(\d+)$/.exec(id) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ id: entry.id, index: Number(entry.match[1]) }));
  assert.ok(fixtureHistoryIds.length > 0, "the fixture must have delivered a history row before checking its tail");
  const latest = fixtureHistoryIds.reduce((current, candidate) => candidate.index > current.index ? candidate : current);
  const marker = `HISTORY-${String(latest.index).padStart(4, "0")}-TAIL`;
  const firstPage = state.historyPages[0] ?? null;
  assert.ok(firstPage && firstPage.end - 1 === latest.index, "the initial thread/read page must identify the newest loaded fixture row");
  return {
    fixtureMessageId: latest.id,
    historyIndex: latest.index,
    marker,
    role: latest.index % 2 === 0 ? "user" : "assistant",
    initialPage: {
      start: firstPage.start,
      end: firstPage.end,
      count: firstPage.count,
      cursor: firstPage.cursor,
      requestId: firstPage.requestId,
    },
  };
}

async function verifyInitialEntryNaturalTailBeforeHistoryPreload(context, page, state, source, count, panelState, startPageTimeMs) {
  const evidence = {
    scenario: "initial-entry-before-manual-history-preload",
    source,
    requestedMessages: count,
    panelState,
    startPageTimeMs,
    deadlineMs: 10_000,
    historyRowsAtEntry: null,
    expectedLatestHistory: null,
    gate: null,
    status: "RUNNING",
  };
  try {
    const elapsedBeforeHistoryPageMs = await page.evaluate((start) => Number((performance.now() - start).toFixed(3)), startPageTimeMs);
    assert.ok(elapsedBeforeHistoryPageMs <= evidence.deadlineMs, "initial thread entry exceeded the existing 10-second natural-tail deadline before its first history page");
    await waitFor(
      () => Promise.resolve(state.historyPages.length > 0 && state.historyRowsDelivered > 0),
      Math.max(1, evidence.deadlineMs - elapsedBeforeHistoryPageMs),
      "initial thread/read page before manual history preload",
      10,
    );
    evidence.historyRowsAtEntry = state.historyRowsDelivered;
    evidence.expectedLatestHistory = latestLoadedHistoryTail(state);
    evidence.gate = await waitForProductTailMarkerWithoutAction(
      page,
      evidence.expectedLatestHistory.marker,
      startPageTimeMs,
      "initial-entry-natural-tail-before-manual-history-preload",
      { captureVisibilityDiagnostics: true },
    );
    assert.equal(evidence.gate.status, "PASS", "the initial loaded history page must naturally expose its newest row before manual preload");
    evidence.rpcLedger = snapshotInitialEntryRpcLedger(state);
    assert.equal(evidence.rpcLedger.overflow, false, "initial-entry RPC ledger overflow makes the routing diagnostic incomplete");
    evidence.status = "PASS";
    state.initialEntryTailEvidence = evidence;
    return evidence;
  } catch (error) {
    evidence.status = "FAIL";
    evidence.rpcLedger = snapshotInitialEntryRpcLedger(state);
    evidence.error = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    evidence.gate = error?.productTailGateEvidence ?? evidence.gate;
    state.initialEntryTailEvidence = evidence;
    await writeTailSetupFailureArtifact(context, page, state, source, count, panelState, "initial-entry-tail-before-preload", error, evidence);
    error.initialEntryTailEvidence = evidence;
    throw error;
  }
}

async function restoreFollowAfterManualHistoryPreload(context, page, state, source, count, panelState) {
  const evidence = {
    scenario: "manual-history-preload-follow-reset",
    source,
    requestedMessages: count,
    panelState,
    action: "if the already-visible history tail leaves Jump hidden, use at most eight trusted wheel inputs to move away from latest; then one trusted touch on the real Jump control and an unassisted natural-tail gate",
    status: "RUNNING",
    expectedLatestHistory: null,
    historyRowsAtReset: state.historyRowsDelivered,
    before: null,
    preTapNavigation: null,
    beforeTapViewport: null,
    actionStartedAtPageTimeMs: null,
    actionCompleted: false,
    gate: null,
  };
  try {
    assert.equal(state.historyRowsDelivered, count - 1, "manual history preload must finish before the follow reset");
    assert.equal(state.historyMessageIds.size, count - 1, "manual history preload must retain unique fixture IDs before the follow reset");
    evidence.expectedLatestHistory = latestLoadedHistoryTail(state);
    evidence.before = await readTranscriptViewport(page, evidence.expectedLatestHistory.marker, true, {
      captureMarkerVisibilityDiagnostics: true,
    });
    if (evidence.before.jumpToLatestVisible) {
      evidence.preTapNavigation = {
        status: "NOT_NEEDED_JUMP_ALREADY_VISIBLE",
        boundary: "no input was sent because the real Jump control was already visible",
        initialViewport: summarizeManualHistoryResetViewport(evidence.before),
        steps: [],
      };
    } else if (evidence.before.targetMarkerVisibleWithinMessageList) {
      evidence.preTapNavigation = await moveAwayFromLatestWithTrustedWheel(
        page,
        evidence.expectedLatestHistory.marker,
        evidence.before,
      );
    } else {
      evidence.preTapNavigation = {
        status: "NOT_RUN_TAIL_MARKER_NOT_VISIBLE",
        boundary: "no wheel or programmatic scroll was used because the actual latest history marker was not visible",
        initialViewport: summarizeManualHistoryResetViewport(evidence.before),
        steps: [],
      };
    }
    const jump = page.getByTestId("jump-to-latest");
    await jump.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await jump.isVisible(), true, "manual history paging must expose the real Jump-to-latest control before follow is reset");
    evidence.beforeTapViewport = await readTranscriptViewport(page, evidence.expectedLatestHistory.marker, true, {
      captureMarkerVisibilityDiagnostics: true,
    });
    assert.equal(evidence.beforeTapViewport.jumpToLatestVisible, true, "the viewport immediately before the trusted reset must show the real Jump-to-latest control");
    if (evidence.preTapNavigation.status === "TRUSTED_WHEEL_MOVED_AWAY_FROM_LATEST") {
      assert.ok(evidence.preTapNavigation.finalViewport.logicalDistanceFromLatestPx > 96, "trusted wheel setup must move the real transcript beyond its latest-follow threshold");
      assert.equal(evidence.preTapNavigation.finalViewport.jumpToLatestVisible, true, "trusted wheel setup must make the real Jump control visible before the reset touch");
    }
    evidence.actionStartedAtPageTimeMs = await page.evaluate(() => Number(performance.now().toFixed(3)));
    await jump.tap({ timeout: 5_000 });
    evidence.actionCompleted = true;
    evidence.gate = await waitForProductTailMarkerWithoutAction(
      page,
      evidence.expectedLatestHistory.marker,
      evidence.actionStartedAtPageTimeMs,
      "manual-history-preload-explicit-follow-reset",
      { captureVisibilityDiagnostics: true },
    );
    assert.equal(evidence.gate.status, "PASS", "the real Jump action must restore natural follow at the existing history tail before the seed turn");
    evidence.status = "PASS";
    state.manualHistoryFollowResetEvidence = evidence;
    return evidence;
  } catch (error) {
    evidence.status = "FAIL";
    evidence.preTapNavigation ??= error?.preTapNavigationEvidence ?? null;
    evidence.error = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    evidence.gate = error?.productTailGateEvidence ?? evidence.gate;
    if (evidence.beforeTapViewport === null && evidence.expectedLatestHistory) {
      try {
        evidence.beforeTapViewport = await readTranscriptViewport(page, evidence.expectedLatestHistory.marker, true, {
          captureMarkerVisibilityDiagnostics: true,
        });
      } catch (viewportError) {
        evidence.beforeTapViewport = { readError: safeSeedErrorMessage(viewportError) };
      }
    }
    state.manualHistoryFollowResetEvidence = evidence;
    await writeTailSetupFailureArtifact(context, page, state, source, count, panelState, "manual-history-follow-reset", error, evidence);
    error.manualHistoryFollowResetEvidence = evidence;
    throw error;
  }
}

function summarizeManualHistoryResetViewport(viewport) {
  const transformEvidence = resolveTranscriptScrollportTransform(viewport);
  return {
    sampledAtPageTimeMs: viewport?.sampledAtPageTimeMs ?? null,
    scrollTop: viewport?.scrollTop ?? null,
    scrollHeight: viewport?.scrollHeight ?? null,
    clientHeight: viewport?.clientHeight ?? null,
    rawBottomGapPx: viewport?.bottomGapPx ?? null,
    markerVisibleWithinMessageList: viewport?.targetMarkerVisibleWithinMessageList ?? null,
    markerLastCharacterRect: viewport?.targetMarkerLastCharacterRect ?? null,
    jumpToLatestVisible: viewport?.jumpToLatestVisible ?? null,
    scrollportTransform: transformEvidence.status === "captured" ? transformEvidence.transform : null,
    scrollportTransformEvidence: transformEvidence,
  };
}

function evidenceValue(value) {
  if (typeof value === "string") return value.slice(0, 160);
  if (value === undefined) return "<undefined>";
  if (value === null) return null;
  return `<${typeof value}>`;
}

function resolveTranscriptScrollportTransform(viewport) {
  const target = viewport && typeof viewport === "object" ? viewport : null;
  const diagnosticScrollport = target?.targetMarkerVisibilityDiagnostics?.scrollport;
  const topLevelValue = target?.scrollportTransform;
  const diagnosticValue = diagnosticScrollport?.transform;
  const topLevelCaptured = typeof topLevelValue === "string";
  const diagnosticCaptured = typeof diagnosticValue === "string";
  const details = {
    topLevel: evidenceValue(topLevelValue),
    diagnostic: evidenceValue(diagnosticValue),
  };

  if (topLevelValue !== undefined && topLevelValue !== null && !topLevelCaptured) {
    return { status: "invalid", transform: null, source: null, ...details };
  }
  if (diagnosticValue !== undefined && diagnosticValue !== null && !diagnosticCaptured) {
    return { status: "invalid", transform: null, source: null, ...details };
  }
  if (topLevelCaptured && diagnosticCaptured && topLevelValue !== diagnosticValue) {
    return { status: "conflict", transform: null, source: null, ...details };
  }
  if (!topLevelCaptured && !diagnosticCaptured) {
    return { status: "missing", transform: null, source: null, ...details };
  }
  if (topLevelCaptured && diagnosticCaptured) {
    return { status: "captured", transform: topLevelValue, source: "both", ...details };
  }
  return topLevelCaptured
    ? { status: "captured", transform: topLevelValue, source: "top-level", ...details }
    : { status: "captured", transform: diagnosticValue, source: "visibility-diagnostics", ...details };
}

function parseAxisAlignedVerticalScale(transform) {
  if (transform === "none") return 1;

  const matrix2d = /^matrix\(([^)]+)\)$/.exec(transform);
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(transform);
  const match = matrix2d ?? matrix3d;
  assert.ok(match, `unsupported transcript scrollport transform for logical distance: ${transform}`);
  const values = match[1].split(",").map((part) => Number(part.trim()));
  const expectedCount = matrix2d ? 6 : 16;
  assert.equal(values.length, expectedCount, `transcript scrollport transform must contain ${expectedCount} matrix values`);
  assert.ok(values.every(Number.isFinite), "transcript scrollport transform matrix values must be finite numbers");

  if (matrix2d) {
    const [scaleX, crossXToY, crossYToX, scaleY] = values;
    assert.ok(Math.abs(scaleX) > MATRIX_EPSILON && Math.abs(scaleY) > MATRIX_EPSILON,
      "transcript scrollport matrix must preserve both measured axes");
    assert.ok(Math.abs(crossXToY) <= MATRIX_EPSILON && Math.abs(crossYToX) <= MATRIX_EPSILON,
      "rotated or skewed transcript scrollport transforms are unsupported for logical distance");
    return scaleY;
  }

  const [scaleX, xToY, zToX, perspectiveX, yToX, scaleY, zToY, perspectiveY,
    xToZ, yToZ, scaleZ, perspectiveZ, , , , homogeneousScale] = values;
  assert.ok(Math.abs(scaleX) > MATRIX_EPSILON && Math.abs(scaleY) > MATRIX_EPSILON && Math.abs(scaleZ) > MATRIX_EPSILON,
    "transcript scrollport matrix3d must preserve all measured axes");
  assert.ok(Math.abs(homogeneousScale - 1) <= MATRIX_EPSILON,
    "perspective transcript scrollport transforms are unsupported for logical distance");
  assert.ok([
    xToY, zToX, perspectiveX, yToX, zToY, perspectiveY, xToZ, yToZ, perspectiveZ,
  ].every((value) => Math.abs(value) <= MATRIX_EPSILON),
  "rotated, tilted, skewed, or perspective transcript scrollport transforms are unsupported for logical distance");
  return scaleY;
}

function manualHistoryLogicalDistanceFromLatest(viewport) {
  const transformEvidence = resolveTranscriptScrollportTransform(viewport);
  assert.equal(transformEvidence.status, "captured",
    `transcript scrollport transform must be explicitly captured and unambiguous (status=${transformEvidence.status}, topLevel=${transformEvidence.topLevel}, diagnostic=${transformEvidence.diagnostic})`);
  const verticalScale = parseAxisAlignedVerticalScale(transformEvidence.transform);
  const inverted = verticalScale < 0;
  const scrollTop = viewport?.scrollTop;
  assert.equal(typeof scrollTop, "number", "transcript scrollTop must be a directly measured number");
  assert.ok(Number.isFinite(scrollTop), "transcript scrollTop must be finite");

  if (inverted) {
    return { transform: transformEvidence.transform, inverted, pixels: Math.abs(scrollTop) };
  }
  const bottomGapPx = viewport?.bottomGapPx;
  assert.equal(typeof bottomGapPx, "number", "normal transcript bottom gap must be a directly measured number");
  assert.ok(Number.isFinite(bottomGapPx), "normal transcript bottom gap must be finite");
  return { transform: transformEvidence.transform, inverted, pixels: Math.max(0, bottomGapPx) };
}


async function moveAwayFromLatestWithTrustedWheel(page, marker, initialViewport) {
  const evidence = {
    status: "RUNNING",
    boundary: "trusted Playwright mouse wheel over the actual message-list; no DOM scroll offsets or synthetic DOM events are written",
    maximumWheelSteps: 8,
    requestedDeltaYPerStep: -180,
    inputBudgetMs: 5_000,
    initialViewport: summarizeManualHistoryResetViewport(initialViewport),
    logicalDistance: null,
    hitTest: null,
    steps: [],
    trustedWheelEventCount: 0,
    trustedListScrollEventCount: 0,
    inputDurationMs: null,
    finalViewport: null,
    cleanupErrors: [],
  };
  let observerInstalled = false;
  let primaryError = null;
  try {
    evidence.logicalDistance = manualHistoryLogicalDistanceFromLatest(initialViewport);
    assert.equal(initialViewport.targetMarkerVisibleWithinMessageList, true, "trusted wheel setup is only allowed when the latest history marker is actually visible");
    assert.ok(evidence.logicalDistance.pixels <= 96, "Jump hidden with a visible latest marker is only a near-tail setup; refuse to wheel if measured logical distance already exceeds 96px");

    const inputObserver = await installTranscriptFollowGestureInputTrace(page);
    observerInstalled = true;
    assert.equal(inputObserver.installed, true, "bounded pre-reset wheel must observe trusted input and real list scroll events");
    const list = page.getByTestId("message-list");
    const bounds = await list.boundingBox();
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0, "trusted pre-reset wheel needs a visible message-list hitbox");
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height / 2);
    evidence.hitTest = await page.evaluate(({ pointX, pointY }) => {
      const listRoot = document.querySelector('[data-testid="message-list"]');
      const target = document.elementFromPoint(pointX, pointY);
      return {
        insideMessageList: Boolean(listRoot && target && listRoot.contains(target)),
        targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
      };
    }, { pointX: x, pointY: y });
    assert.equal(evidence.hitTest.insideMessageList, true, "trusted pre-reset wheel must target the actual message-list subtree");
    const initialOrdinal = (await readTranscriptFollowGestureInputTrace(page))?.latestOrdinal ?? 0;
    let latestOrdinal = initialOrdinal;
    let currentViewport = initialViewport;
    await page.mouse.move(x, y);
    const inputStartedAt = performance.now();
    let lastDispatchFinishedAt = inputStartedAt;

    for (let index = 0; index < evidence.maximumWheelSteps; index += 1) {
      if (performance.now() - inputStartedAt > evidence.inputBudgetMs) break;
      const before = currentViewport;
      const beforeDistance = manualHistoryLogicalDistanceFromLatest(before).pixels;
      await page.mouse.wheel(0, evidence.requestedDeltaYPerStep);
      lastDispatchFinishedAt = performance.now();
      await waitForTwoFrames(page);
      const after = await readTranscriptViewport(page, marker, true, {
        captureMarkerVisibilityDiagnostics: true,
      });
      assert.equal(after.listFound, true, "the actual message-list must remain mounted through the bounded wheel setup");
      const afterDistance = manualHistoryLogicalDistanceFromLatest(after).pixels;
      const trace = await readTranscriptFollowGestureInputTrace(page);
      const events = transcriptInputEventsSince(trace, latestOrdinal);
      latestOrdinal = trace?.latestOrdinal ?? latestOrdinal;
      const wheelEvents = events.filter((event) => event.type === "wheel");
      const scrollEvents = events.filter((event) => event.type === "scroll" && event.insideMessageList);
      evidence.steps.push({
        index: index + 1,
        requestedDeltaY: evidence.requestedDeltaYPerStep,
        before: summarizeManualHistoryResetViewport(before),
        after: summarizeManualHistoryResetViewport(after),
        logicalDistanceChangePx: Number((afterDistance - beforeDistance).toFixed(2)),
        trustedWheelEvents: wheelEvents,
        trustedListScrollEvents: scrollEvents,
      });
      evidence.trustedWheelEventCount += wheelEvents.filter((event) => event.isTrusted && event.insideMessageList).length;
      evidence.trustedListScrollEventCount += scrollEvents.filter((event) => event.isTrusted).length;
      currentViewport = after;
      if (afterDistance > 96 && after.jumpToLatestVisible) break;
    }

    evidence.inputDurationMs = Number((lastDispatchFinishedAt - inputStartedAt).toFixed(3));
    const finalDistance = manualHistoryLogicalDistanceFromLatest(currentViewport).pixels;
    evidence.finalViewport = summarizeManualHistoryResetViewport(currentViewport);
    evidence.finalViewport.logicalDistanceFromLatestPx = finalDistance;
    assert.ok(evidence.steps.length > 0, "bounded trusted wheel setup must issue at least one real wheel input");
    assert.ok(evidence.trustedWheelEventCount > 0, "the page must observe trusted wheel input inside the real message-list");
    assert.ok(evidence.trustedListScrollEventCount > 0, "trusted wheel setup must produce a real trusted message-list scroll event");
    assert.ok(evidence.inputDurationMs <= evidence.inputBudgetMs, "bounded pre-reset wheel dispatches must stay within the five-second input budget");
    assert.ok(finalDistance > 96, "trusted wheel setup must move the logical transcript distance beyond the existing 96px latest threshold");
    assert.equal(currentViewport.jumpToLatestVisible, true, "trusted wheel setup must make the real Jump-to-latest control visible");
    evidence.status = "TRUSTED_WHEEL_MOVED_AWAY_FROM_LATEST";
  } catch (error) {
    primaryError = error;
  } finally {
    if (observerInstalled) {
      try {
        await disposeTranscriptFollowGestureInputTrace(page);
      } catch (cleanupError) {
        evidence.cleanupErrors.push({
          name: cleanupError?.name ?? "Error",
          message: safeSeedErrorMessage(cleanupError),
          stack: safeSeedErrorStack(cleanupError),
        });
      }
    }
  }

  if (primaryError || evidence.cleanupErrors.length > 0) {
    evidence.status = "FAIL";
    if (primaryError) evidence.error = { name: primaryError?.name ?? "Error", message: safeSeedErrorMessage(primaryError), stack: safeSeedErrorStack(primaryError) };
    const cleanupErrorObjects = evidence.cleanupErrors.map((entry) => new Error(`${entry.name}: ${entry.message}`));
    const failure = primaryError && cleanupErrorObjects.length > 0
      ? new AggregateError([primaryError, ...cleanupErrorObjects], "pre-reset trusted wheel setup and observer cleanup failed", { cause: primaryError })
      : primaryError ?? new AggregateError(cleanupErrorObjects, "pre-reset trusted wheel observer cleanup failed", { cause: cleanupErrorObjects[0] });
    failure.preTapNavigationEvidence = evidence;
    throw failure;
  }
  return evidence;
}

async function writeTailSetupFailureArtifact(context, page, state, source, count, panelState, failureStage, error, phaseEvidence) {
  const prefix = `phone-render-profile-${failureStage}-${source}-${count}-${panelState}`;
  const screenshotArtifact = `${prefix}.png`;
  let screenshot = { status: "not-captured", artifact: null, error: null };
  try {
    await page.screenshot({ path: context.pathInArtifacts(screenshotArtifact), fullPage: false });
    screenshot = { status: "captured", artifact: screenshotArtifact, error: null };
  } catch (screenshotError) {
    screenshot = { status: "failed", artifact: null, error: safeSeedErrorMessage(screenshotError) };
  }
  const latestHistory = phaseEvidence?.expectedLatestHistory ?? null;
  let lastTranscriptViewport = null;
  try {
    lastTranscriptViewport = await readTranscriptViewport(page, latestHistory?.marker ?? null, Boolean(latestHistory), {
      captureMarkerVisibilityDiagnostics: true,
    });
  } catch (viewportError) {
    lastTranscriptViewport = { readError: safeSeedErrorMessage(viewportError) };
  }
  await context.writeArtifactJson(`${prefix}.json`, {
    schemaVersion: 1,
    failureStage,
    scenario: "manual-history-preload-with-explicit-follow-reset",
    source,
    requestedMessages: count,
    panelState,
    historyRowsDelivered: state.historyRowsDelivered,
    historyIds: state.historyMessageIds.size,
    historyPages: state.historyPages,
    rpcLedger: snapshotInitialEntryRpcLedger(state),
    expectedLatestHistory: latestHistory,
    phaseEvidence,
    productTailGate: error?.productTailGateEvidence ?? null,
    lastTranscriptViewport,
    screenshot,
    error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) },
  });
}

async function readProductHistoryAnchor(page, marker) {
  const viewport = await readProductHistoryViewport(page);
  return {
    viewport,
    anchor: viewport.visibleRows.find((row) => row.marker === marker) ?? null,
  };
}



async function readTranscriptFollowGestureInputTrace(page) {
  return page.evaluate(() => window.__phoneFollowGestureInputTrace?.snapshot() ?? null);
}

function transcriptInputEventsSince(trace, ordinal) {
  return Array.isArray(trace?.events) ? trace.events.filter((event) => event.ordinal > ordinal) : [];
}

async function captureBrowserMemory(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const [heap, dom] = await Promise.all([
      cdp.send("Runtime.getHeapUsage"),
      cdp.send("Memory.getDOMCounters"),
    ]);
    return {
      source: "Chromium CDP Runtime.getHeapUsage and Memory.getDOMCounters; snapshot only, no forced GC",
      usedHeapSizeBytes: heap.usedSize ?? null,
      totalHeapSizeBytes: heap.totalSize ?? null,
      embedderHeapUsedBytes: heap.embedderHeapUsedSize ?? null,
      backingStorageBytes: heap.backingStorageSize ?? null,
      documents: dom.documents ?? null,
      nodes: dom.nodes ?? null,
      eventListeners: dom.jsEventListeners ?? null,
    };
  } catch (error) {
    return { source: "Chromium CDP heap/DOM snapshot unavailable", error: String(error.message || error).slice(0, 240) };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function captureTranscriptEvidence(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="message-list"]');
    const rows = root?.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]') ?? [];
    const scrollHost = root instanceof HTMLElement
      ? [root, ...root.querySelectorAll("*")].filter((element) => element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16).sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0]
      : null;
    return {
      renderedMessageRows: rows.length,
      transcriptScrollHeight: scrollHost?.scrollHeight ?? null,
      transcriptClientHeight: scrollHost?.clientHeight ?? null,
      transcriptMaxScrollTop: scrollHost ? scrollHost.scrollHeight - scrollHost.clientHeight : null,
    };
  });
}

function makeHistoryPage(total, beforeCursor, requestedLimit, fixtureWorkspace, markLatestHistoryTailForVisibility = false) {
  let end = total;
  if (typeof beforeCursor === "string" && /^ux:\d+$/.test(beforeCursor)) end = Number(beforeCursor.slice(3));
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, fixturePageSize) : fixturePageSize;
  const start = Math.max(0, end - limit);
  const messages = Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    return makeHistoryMessage(index, fixtureWorkspace, markLatestHistoryTailForVisibility && index === total - 1);
  });
  return {
    messages,
    rangeStart: start,
    rangeEnd: end,
    hasMoreBefore: start > 0,
    beforeCursor: start > 0 ? `ux:${start}` : null,
  };
}

function makeHistoryMessage(index, fixtureWorkspace, markTranscriptTail = false) {
  const marker = `HISTORY-${String(index).padStart(4, "0")}`;
  const code = Array.from({ length: 18 }, (_, line) => `export function fixture_${index}_${line}(value: number) { return value + ${line}; }`).join("\n");
  const markdown = [
    `# ${marker}: mobile transcript fixture`,
    "",
    `This is a long Markdown history entry used only by the isolated Chromium render profile. It contains a paragraph with enough prose to exercise line wrapping, text layout, and memoized row rendering at a 390 CSS-pixel viewport. ${"A fixed deterministic sentence gives this message a stable text shape. ".repeat(8)}`,
    "",
    "| step | result | detail |",
    "| --- | --- | --- |",
    `| parse | complete | synthetic fixture row ${index} |`,
    "| render | measured | no model request |",
    "",
    "```typescript",
    code,
    "```",
    ...(markTranscriptTail ? [`HISTORY-${String(index).padStart(4, "0")}-TAIL`] : []),
  ].join("\n");
  const blocks = [];
  if (index % 3 === 1) {
    blocks.push({ type: "tool", id: `tool-${index}`, tool_name: "read_file", status: "done", tool_input: { path: `src/fixture-${index}.ts`, range: { start: 1, end: 80 } }, tool_output: `${"tool output line for a long source excerpt; deterministic mock only.\n".repeat(18)}${marker}-TOOL-END` });
  }
  if (index % 5 === 2) {
    blocks.push({ type: "file_changes", fileChanges: { artifactId: `history-artifact-${index}`, workspacePath: fixtureWorkspace, fileCount: 12, additions: 88, deletions: 16, files: Array.from({ length: 12 }, (_, fileIndex) => `${fixtureWorkspace}/history-${index}-${fileIndex}.ts`), status: "active", revertible: true } });
  }
  return {
    id: `history-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: markdown,
    blocks,
    timestampMs: 1_790_000_000_000 + index * 1000,
  };
}

function createPageState(source, count, panelState, fixtureWorkspace, options = {}) {
  const reserveOlderHistoryPage = options.reserveOlderHistoryPage === true;
  return {
    source,
    count,
    panelState,
    workspacePath: fixtureWorkspace,
    historyMessageCount: count - 1 + (reserveOlderHistoryPage ? fixturePageSize : 0),
    initialHistoryTarget: reserveOlderHistoryPage ? count - 1 : null,
    markLatestHistoryTailForVisibility: options.markLatestHistoryTailForVisibility === true,
    historyRowsDelivered: 0,
    historyMessageIds: new Set(),
    historyPages: [],
    initialEntryRpcLedger: {
      startedAtNodeMs: performance.now(),
      events: [],
      endpointCounts: new Map(),
      sockets: [],
      observedWebSocketCount: 0,
      routeInterceptCount: 0,
      seenEventCount: 0,
      recordedBytes: 0,
      droppedEventCount: 0,
      droppedConnectionCount: 0,
      pendingCorrelationOverflowCount: 0,
      unpairedResponseCount: 0,
      malformedResponseCount: 0,
      overflow: false,
    },
    initialEntryTailEvidence: null,
    manualHistoryFollowResetEvidence: null,
    rpcMethods: Object.create(null),
    failedRequests: Object.create(null),
    activeThreadReadRequestId: null,
    websocketConnections: [],
    websocketSocketRecords: [],
    notificationBatches: [],
    nextSequence: 1,
    changesPanelMounted: false,
    tabFocusTrace: [],
    fixtureShape: {
      textMessages: count - 1,
      reservedOlderHistoryRows: reserveOlderHistoryPage ? fixturePageSize : 0,
      toolOutputMessages: Math.floor(count / 3),
      fileChangeHistoryMessages: Math.floor((count + 1) / 5),
      markdownCodeMessageBytesApprox: Buffer.byteLength(makeHistoryMessage(0, fixtureWorkspace).content),
      pageSize: fixturePageSize,
    },
    readRequestStarted(frame) {
      const beforeCursor = frame.params?.beforeCursor;
      this.pendingReadRequests = (this.pendingReadRequests ?? 0) + 1;
      this.lastRequestedCursor = beforeCursor ?? null;
    },
  };
}

function areNotificationBatchesOrdered(batches) {
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  if (!Array.isArray(batches) || batches.length === 0) return false;
  let previousSequence = -1;
  return batches.every((batch) => {
    if (!batch.dispatchOrderValid || batch.methods.length !== expectedMethods.length || batch.sequences.length !== expectedMethods.length) return false;
    if (batch.methods.some((method, index) => method !== expectedMethods[index])) return false;
    if (batch.sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence <= previousSequence)) return false;
    previousSequence = batch.sequences.at(-1);
    return true;
  });
}

function summarizeObservations(observations, { suppressP95 = false } = {}) {
  const groups = new Map();
  for (const observation of observations) {
    const key = [observation.source, observation.scenario, observation.requestedMessages, observation.panelState ?? "none"].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [source, scenario, countText, panelState] = key.split("|");
    const values = entries.filter((entry) => entry.ok && Number.isFinite(entry.durationMs)).map((entry) => entry.durationMs).sort((left, right) => left - right);
    const automationValues = entries.filter((entry) => entry.ok && Number.isFinite(entry.automationElapsedMs)).map((entry) => entry.automationElapsedMs).sort((left, right) => left - right);
    const harnessValues = entries.filter((entry) => entry.ok && Number.isFinite(entry.fixtureHarnessElapsedToAgentRevisionMs)).map((entry) => entry.fixtureHarnessElapsedToAgentRevisionMs).sort((left, right) => left - right);
    const taskValues = entries.filter((entry) => Number.isFinite(entry.synchronousEventTaskMs)).map((entry) => entry.synchronousEventTaskMs).sort((left, right) => left - right);
    const websocketDispatchTaskValues = entries.flatMap((entry) => entry.websocketDispatchHandlerSyncMs ?? []).filter(Number.isFinite).sort((left, right) => left - right);
    return {
      source,
      scenario,
      requestedMessages: Number(countText),
      panelState: panelState === "none" ? null : panelState,
      sampleCount: entries.length,
      successCount: entries.filter((entry) => entry.ok).length,
      errorCount: entries.filter((entry) => !entry.ok).length,
      p95Reporting: suppressP95 ? "NOT_REPORTED_N1_STACK_DIAGNOSTIC" : "REPORTED",
      p50Ms: percentile(values, 0.5),
      p95Ms: suppressP95 ? null : percentile(values, 0.95),
      maxMs: values.length ? values.at(-1) : null,
      automationElapsedP50Ms: percentile(automationValues, 0.5),
      automationElapsedP95Ms: suppressP95 ? null : percentile(automationValues, 0.95),
      automationElapsedMaxMs: automationValues.length ? automationValues.at(-1) : null,
      fixtureHarnessElapsedP50Ms: percentile(harnessValues, 0.5),
      fixtureHarnessElapsedP95Ms: suppressP95 ? null : percentile(harnessValues, 0.95),
      fixtureHarnessElapsedMaxMs: harnessValues.length ? harnessValues.at(-1) : null,
      synchronousEventTaskP50Ms: percentile(taskValues, 0.5),
      synchronousEventTaskP95Ms: suppressP95 ? null : percentile(taskValues, 0.95),
      synchronousEventTaskMaxMs: taskValues.length ? taskValues.at(-1) : null,
      websocketDispatchHandlerSyncTaskCount: websocketDispatchTaskValues.length,
      websocketDispatchHandlerSyncTaskP50Ms: percentile(websocketDispatchTaskValues, 0.5),
      websocketDispatchHandlerSyncTaskP95Ms: suppressP95 ? null : percentile(websocketDispatchTaskValues, 0.95),
      websocketDispatchHandlerSyncTaskMaxMs: websocketDispatchTaskValues.length ? websocketDispatchTaskValues.at(-1) : null,
      longTaskCount: entries.reduce((total, entry) => total + (entry.longTasks?.length ?? 0), 0),
      longTaskMaxMs: Math.max(0, ...entries.flatMap((entry) => (entry.longTasks ?? []).map((task) => task.durationMs))),
    };
  }).sort((left, right) => left.source.localeCompare(right.source) || left.requestedMessages - right.requestedMessages || left.scenario.localeCompare(right.scenario) || String(left.panelState).localeCompare(String(right.panelState)));
}

function summarizeLongTasks(observations, { suppressP95 = false } = {}) {
  const tasks = observations.flatMap((entry) => entry.longTasks ?? []);
  const durations = tasks.map((task) => task.durationMs).sort((left, right) => left - right);
  return {
    source: "PerformanceObserver longtask API; entries are browser tasks over 50ms",
    count: tasks.length,
    p50Ms: percentile(durations, 0.5),
    p95Reporting: suppressP95 ? "NOT_REPORTED_N1_STACK_DIAGNOSTIC" : "REPORTED",
    p95Ms: suppressP95 ? null : percentile(durations, 0.95),
    maxMs: durations.length ? durations.at(-1) : null,
    entries: tasks.slice(0, 500),
  };
}

function summarizeLongAnimationFrames(observations) {
  const streamSamples = observations.filter((entry) => entry.scenario === "active-markdown-stream" && entry.longAnimationFrames);
  const frames = streamSamples.flatMap((entry) => (entry.longAnimationFrames.entries ?? []).map((frame) => ({
    source: entry.source,
    requestedMessages: entry.requestedMessages,
    panelState: entry.panelState,
    ...frame,
  })));
  const scripts = new Map();
  for (const frame of frames) {
    for (const script of frame.scripts ?? []) {
      const key = `${script.sourceFunctionName}|${script.sourceUrlPath}|${script.invokerType}|${script.invoker}`;
      const current = scripts.get(key) ?? {
        sourceFunctionName: script.sourceFunctionName,
        sourceUrlPath: script.sourceUrlPath,
        invokerType: script.invokerType,
        invoker: script.invoker,
        frameCount: 0,
        scriptDurationMs: 0,
        forcedStyleAndLayoutDurationMs: 0,
      };
      current.frameCount += 1;
      current.scriptDurationMs += script.durationMs;
      current.forcedStyleAndLayoutDurationMs += script.forcedStyleAndLayoutDurationMs;
      scripts.set(key, current);
    }
  }
  return {
    source: "PerformanceObserver long-animation-frame API; scripts identify browser-reported script entry points, not full JavaScript call stacks",
    supportedStreamSamples: streamSamples.filter((entry) => entry.longAnimationFrames.supported).length,
    unsupportedStreamSamples: streamSamples.filter((entry) => !entry.longAnimationFrames.supported).length,
    frameCount: frames.length,
    frames: frames.slice(0, 500),
    attributedScripts: [...scripts.values()].map((script) => ({
      ...script,
      scriptDurationMs: Number(script.scriptDurationMs.toFixed(3)),
      forcedStyleAndLayoutDurationMs: Number(script.forcedStyleAndLayoutDurationMs.toFixed(3)),
    })).sort((left, right) => right.scriptDurationMs - left.scriptDurationMs).slice(0, 80),
  };
}

function createCoverage(sourceNames, counts, samples, observations, fixtureEvidence, browserErrors, provenance, cpuProfiles) {
  const expectedSources = ["before", "after"];
  const core = [];
  for (const source of expectedSources) {
    for (const count of counts) {
      for (const panelState of ["unmounted", "mounted-hidden"]) {
        for (const scenario of ["input-feedback", "scroll-feedback", "active-markdown-stream", "active-markdown-final-flush", `hidden-changes-update-${panelState}`]) {
          const matches = observations.filter((entry) => entry.source === source && entry.requestedMessages === count && entry.panelState === panelState && entry.scenario === scenario && entry.ok).length;
          core.push({ source, requestedMessages: count, panelState, scenario, samples: matches, required: samples, status: matches >= samples ? "PASS" : "PARTIAL" });
        }
      }
    }
  }
  const deltaHandlerSubsamples = [];
  for (const source of expectedSources) {
    for (const count of counts) {
      for (const panelState of ["unmounted", "mounted-hidden"]) {
        const matches = observations.filter((entry) => entry.source === source && entry.requestedMessages === count && entry.panelState === panelState && entry.scenario === "active-markdown-delta-handler" && entry.ok).length;
        deltaHandlerSubsamples.push({ source, requestedMessages: count, panelState, samples: matches, required: samples * activeDeltaChunksPerStream, role: "within-stream handler subsamples; not independent stream samples", status: matches >= samples * activeDeltaChunksPerStream ? "PASS" : "PARTIAL" });
      }
    }
  }
  const everyFixture = sourceNames.length === expectedSources.length && expectedSources.every((source) => sourceNames.includes(source)) && fixtureEvidence.length === expectedSources.length * counts.length * 2 && fixtureEvidence.every((item) => item.historyRowsDelivered + 1 === item.requestedMessages);
  const noTurns = fixtureEvidence.every((item) => item.turnStartRpcCount === 0);
  const orderedNotifications = fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.notificationDispatchOrderValid);
  const activeStreamsOrdered = fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.activeMarkdownStream?.dispatchOrderValid === true && item.activeMarkdownStream?.burstCount === samples && item.activeMarkdownStream.bursts?.every((burst) => burst.dispatchOrderValid && burst.finalDeltaAndCompletionShareTask));
  const activeFinalFlushes = fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.activeMarkdownStream?.bursts?.length === samples && item.activeMarkdownStream.bursts.every((burst) => burst.finalFlushPendingAtCompletion === true && burst.finalAssistantRow?.finalMarkerPresent === true && burst.finalAssistantRow?.finalMarkerVisibleWithinMessageList === true && burst.finalAssistantRow?.finalMarkerVisibleAfterTwoFrames === true && burst.finalAssistantRow?.runtimeTerminalUi === true && burst.finalAssistantRow?.failureMarkerPresent === false && burst.finalAssistantRow?.unknownMarkerPresent === false));
  const memoryCaptured = fixtureEvidence.length > 0 && fixtureEvidence.every((item) => Number.isFinite(item.historyResponseBytes) && Number.isFinite(item.memoryBeforeMeasuredInteractions?.usedHeapSizeBytes) && Number.isFinite(item.memoryAfterActiveStream?.usedHeapSizeBytes));
  const expectedProfileCases = fixtureEvidence
    .filter((fixture) => fixture.activeMarkdownStackDiagnostic !== null)
    .map((fixture) => ({ source: fixture.source, requestedMessages: fixture.requestedMessages, panelState: fixture.panelState }));
  const cpuProfilesCaptured = expectedProfileCases.length > 0 && expectedProfileCases.every((expected) => cpuProfiles.some((profile) => profile.source === expected.source
    && profile.requestedMessages === expected.requestedMessages
    && profile.panelState === expected.panelState
    && profile.sampleCount > 0
    && profile.clockAlignment?.status === "ALIGNED_WITHIN_10MS"));
  const cpuProfileBoundaryStatus = expectedProfileCases.length === 0 ? "NOT_RUN_BY_DESIGN" : cpuProfilesCaptured ? "PASS" : "PARTIAL";
  const mainLongTaskCases = [...new Map(observations
    .filter((entry) => entry.scenario === "active-markdown-stream" && (entry.longTasks?.length ?? 0) > 0)
    .map((entry) => [`${entry.source}|${entry.requestedMessages}|${entry.panelState}`, {
      source: entry.source,
      requestedMessages: entry.requestedMessages,
      panelState: entry.panelState,
    }])).values()];
  const attributedLongTaskCases = mainLongTaskCases.filter((expected) => cpuProfiles.some((profile) => profile.source === expected.source
    && profile.requestedMessages === expected.requestedMessages
    && profile.panelState === expected.panelState
    && profile.longTaskStackAttribution?.some((task) => task.status === "PROFILE_SAMPLES_OVERLAP")));
  const longTaskStackAttributionComplete = attributedLongTaskCases.length === mainLongTaskCases.length;
  const mountedModalDismissed = fixtureEvidence.filter((item) => item.panelState === "mounted-hidden").length > 0
    && fixtureEvidence.filter((item) => item.panelState === "mounted-hidden").every((item) => item.tabModalDismiss?.dismissed === true);
  const allHistoryCounts = counts.length === 3 && [50, 500, 2000].every((count) => counts.includes(count));
  const status = samples >= 30 && allHistoryCounts && core.every((item) => item.status === "PASS") && everyFixture && noTurns && orderedNotifications && activeStreamsOrdered && activeFinalFlushes && mountedModalDismissed && memoryCaptured && cpuProfilesCaptured && longTaskStackAttributionComplete && browserErrors.length === 0 && provenance.length === 2 ? "PASS_WEB_ONLY" : "PARTIAL";
  return {
    overallStatus: status,
    note: "PASS_WEB_ONLY applies only to the listed isolated Chromium Mobile Web scenarios; Android/iOS native performance remains UNVERIFIED.",
    core,
    activeDeltaHandlerSubsamples: deltaHandlerSubsamples,
    boundaries: [
      { id: "50-500-2000-loaded-message-history", status: allHistoryCounts && everyFixture ? "PASS" : "PARTIAL", configuredCounts: counts, requiredCounts: [50, 500, 2000], fixtureCount: fixtureEvidence.length },
      { id: "hidden-changes-mounted-and-unmounted", status: fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.panelState === "unmounted" ? !item.changesPanelMounted : item.changesPanelMounted) ? "PASS" : "PARTIAL" },
      { id: "tab-modal-dismiss-before-mounted-input", status: mountedModalDismissed ? "PASS" : "PARTIAL", timingExcludedFromInputFeedback: true },
      { id: "no-model-or-active-user-session", status: noTurns ? "PASS" : "FAIL", turnStartRequests: 0, providerConfigured: false, syntheticNotificationsOnly: true },
      { id: "ordered-synthetic-runtime-notification-dispatch", status: orderedNotifications ? "PASS" : "PARTIAL", evidence: "test helper ledger confirms exact app-facing Mock dispatch order; Agent row mutation is checked separately", expectedOrder: ["turn/started", "item/started", "item/delta", "turn/completed"] },
      { id: "ordered-active-Markdown-delta-dispatch", status: activeStreamsOrdered ? "PASS" : "PARTIAL", evidence: "test helper ledger confirms dispatch order only; actual Agent row mutation and terminal composer UI are checked separately", independentBurstsPerFixture: samples, deltaFramesPerBurst: activeDeltaChunksPerStream, expectedOrder: ["turn/started", "item/started", "item/delta*", "turn/completed"] },
      { id: "active-Markdown-final-flush", status: activeFinalFlushes ? "PASS" : "PARTIAL", finalFlushSamples: fixtureEvidence.reduce((total, item) => total + (item.activeMarkdownStream?.bursts?.filter((burst) => burst.finalFlushPendingAtCompletion && burst.finalAssistantRow?.finalMarkerPresent && burst.finalAssistantRow?.finalMarkerVisibleWithinMessageList && burst.finalAssistantRow?.runtimeTerminalUi).length ?? 0), 0), requiredFlushes: fixtureEvidence.length * samples, finalDeltaAndCompletionShareBrowserTask: true, finalMarkerRequirement: "last-character DOM Range intersects message-list after stable tail viewport and two animation frames", checksComposerReturnedToNotRunningState: true },
      { id: "active-Markdown-handler-subsamples", status: deltaHandlerSubsamples.every((item) => item.status === "PASS") ? "PASS" : "PARTIAL", deltaFramesPerBurst: activeDeltaChunksPerStream, doesNotReplaceIndependentStreamSamples: true },
      { id: "active-assistant-message-growth", status: fixtureEvidence.length > 0 && fixtureEvidence.every((item) => item.activeAssistantTurnsCompleted === samples && item.expectedLogicalMessagesAfterActiveStreams === item.expectedLogicalMessagesBeforeActiveStreams + samples) ? "PASS" : "PARTIAL", assistantTurnsAddedPerFixture: samples, preservesIntermediateMessages: true },
      { id: "browser-heap-and-fixture-payload-bytes", status: memoryCaptured ? "PASS" : "PARTIAL", note: "CDP heap snapshots are approximate and were not forced through GC; fixture JSON response byte counts are recorded; durable transcript storage is not exercised" },
      { id: "active-Markdown-v8-cpu-profile", status: cpuProfileBoundaryStatus, profilerEnabledDuringCoreSamples: false, profiles: cpuProfiles.map((profile) => ({ source: profile.source, requestedMessages: profile.requestedMessages, panelState: profile.panelState, sampleCount: profile.sampleCount, totalSampledMs: profile.totalSampledMs, clockAlignment: profile.clockAlignment?.status, attributedLongTaskCount: profile.longTaskStackAttribution?.filter((task) => task.status === "PROFILE_SAMPLES_OVERLAP").length ?? 0 })), required: expectedProfileCases },
      { id: "cdp-v8-stack-attribution-for-longtask-cases", status: longTaskStackAttributionComplete ? "PASS" : "PARTIAL", coreLongTaskCases: mainLongTaskCases, attributedCases: attributedLongTaskCases, rule: "For each core active-stream case with a LongTask API entry, a separate same-source/count/panel CDP profile diagnostic must sample a LongTask interval; diagnostic samples are not included in core latency statistics" },
      { id: "before-after-source-and-complement-digests", status: provenance.length === 2 && provenance.every((item) => /^[a-f0-9]{64}$/.test(item.sourceTreeSha256) && /^[a-f0-9]{64}$/.test(item.sharedSourceInputSha256) && (item.sourceComplementSha256 === null || /^[a-f0-9]{64}$/.test(item.sourceComplementSha256)) && /^[a-f0-9]{64}$/.test(item.sourceFreezeEvidenceDigest)) && /^[a-f0-9]{64}$/.test(suiteSourceSha256) ? "PASS" : "PARTIAL", testSuiteSha256: suiteSourceSha256, measuredSources: provenance.map((item) => ({ source: item.source, sourceComplementSha256: item.sourceComplementSha256, sharedSourceInputSha256: item.sharedSourceInputSha256, sourceFreezeEvidenceDigest: item.sourceFreezeEvidenceDigest, sourceFreezeEvidenceKind: item.sourceFreezeEvidenceKind, frozenSourceEntryCount: item.frozenSourceEntryCount, sourceComplementMode: item.sourceComplementMode })) },
      { id: "30-samples-per-core-scenario", status: samples >= 30 && core.every((item) => item.status === "PASS") ? "PASS" : "PARTIAL", requestedSamples: samples, minimumRequired: 30 },
      { id: "android-ios-native-performance", status: "UNVERIFIED", reason: "system Chromium web emulation does not measure Hermes, native UI frames, operating-system keyboard, or native storage" },
    ],
  };
}

function percentile(values, quantile) {
  if (!values.length) return null;
  return values[Math.max(0, Math.ceil(values.length * quantile) - 1)];
}

async function sampleHostCpuWindow(phase) {
  const first = await readHostCpuSnapshot();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  const second = await readHostCpuSnapshot();
  const elapsedMs = Number((second.sampledAt - first.sampledAt).toFixed(1));
  const totalTicks = Math.max(0, second.systemCpu.totalTicks - first.systemCpu.totalTicks);
  const busyTicks = Math.max(0, second.systemCpu.busyTicks - first.systemCpu.busyTicks);
  const otherProcesses = [];
  for (const [pid, after] of second.processes) {
    const before = first.processes.get(pid);
    if (!before || pid === process.pid || before.startTimeTicks !== after.startTimeTicks) continue;
    const cpuTicks = Math.max(0, after.cpuTicks - before.cpuTicks);
    if (cpuTicks > 0) otherProcesses.push({ pid, name: after.name, cpuTicks, percentOfHostCpuCapacity: totalTicks > 0 ? Number((cpuTicks / totalTicks * 100).toFixed(2)) : null });
  }
  otherProcesses.sort((left, right) => right.cpuTicks - left.cpuTicks);
  return {
    phase,
    elapsedMs,
    systemCpuBusyPercent: totalTicks > 0 ? Number((busyTicks / totalTicks * 100).toFixed(2)) : null,
    loadAverage: second.loadAverage,
    nonSuiteProcessesWithCpu: otherProcesses.slice(0, 12),
    nonSuiteProcessCountWithCpu: otherProcesses.length,
    source: "/proc/stat and /proc/<pid>/stat; process command lines are not read; percentages are normalized to total host CPU capacity",
  };
}

async function readHostCpuSnapshot() {
  const sampledAt = performance.now();
  const [cpuStat, loadText, entries] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    readFile("/proc/loadavg", "utf8").catch(() => ""),
    readdir("/proc").catch(() => []),
  ]);
  const cpuLine = cpuStat.split(/\r?\n/).find((line) => /^cpu\s/.test(line)) ?? "";
  const cpuValues = cpuLine.trim().split(/\s+/).slice(1, 9).map(Number);
  const totalTicks = cpuValues.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const idleTicks = (cpuValues[3] ?? 0) + (cpuValues[4] ?? 0);
  const processes = new Map();
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const raw = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
    if (!raw) return;
    const open = raw.indexOf("(");
    const close = raw.lastIndexOf(")");
    if (open < 0 || close <= open) return;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const userTicks = Number(fields[11]);
    const systemTicks = Number(fields[12]);
    const startTimeTicks = Number(fields[19]);
    if (![userTicks, systemTicks, startTimeTicks].every(Number.isFinite)) return;
    processes.set(Number(entry), {
      name: raw.slice(open + 1, close).slice(0, 80),
      cpuTicks: userTicks + systemTicks,
      startTimeTicks,
    });
  }));
  return {
    sampledAt,
    systemCpu: { totalTicks, busyTicks: Math.max(0, totalTicks - idleTicks) },
    loadAverage: loadText.trim().split(/\s+/).slice(0, 3).map(Number).filter(Number.isFinite),
    processes,
  };
}

function optionValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function requiredOption(name) {
  const value = optionValue(name, "");
  assert.ok(value, `missing required option ${name}=...`);
  return value;
}

function requiredDigest(name) {
  const value = requiredOption(name);
  assert.match(value, /^[a-f0-9]{64}$/, `${name} must be a lowercase SHA-256 digest`);
  return value;
}

function parseFrame(raw) {
  try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { return null; }
}

function safePath(value) {
  try { return new URL(value).pathname; } catch { return ""; }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function collectLongTasks(page, result) {
  await waitForTwoFrames(page);
  return page.evaluate(({ startedAt, finishedAt }) => window.__phoneRenderLongTasksBetween(startedAt, finishedAt), result);
}

async function waitForTwoFrames(page) {
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}
