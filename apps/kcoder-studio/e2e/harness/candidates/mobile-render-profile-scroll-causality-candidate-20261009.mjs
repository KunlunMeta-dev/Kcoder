import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../../harness/chromium.mjs";
import { assertPathWithinApprovedRoots, readVerifiedMobileExportFile, verifyMobileExportManifestEnvelope } from "../../harness/mobile-web-export-input.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { measuredTranscriptLatestDistance } from "../../harness/transcript-logical-distance.mjs";
import { createPrivateScrollV1Helpers } from "../../harness/private-candidate-modules/scroll-v1/helpers.mjs";
import { createPrivateScrollV1SourceInputs } from "../../harness/private-candidate-modules/scroll-v1/source-inputs.mjs";
import { createPrivateScrollV1ViewLedger } from "../../harness/private-candidate-modules/scroll-v1/view-ledger.mjs";
import { createPrivateScrollV1FollowScenarios } from "../../harness/private-candidate-modules/scroll-v1/follow-scenarios.mjs";
import { createPrivateScrollV1Measurements } from "../../harness/private-candidate-modules/scroll-v1/measurements.mjs";
import { observeSeparatedSuiteSourceInputs } from "../../harness/separated-suite-source-inputs.mjs";


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
assert.ok(!(tailWindowProductRegression && tailWindowPaginationRegression), "core follow and older-page pagination diagnostics are separate selectors");
const tailWindowDiagnostic = tailWindowProductRegression || tailWindowPaginationRegression;
const sourceNames = optionValue("--sources", "before,after").split(",").map((value) => value.trim());
const messageCounts = optionValue("--messages", "50,500,2000")
  .split(",")
  .map((value) => Number(value.trim()));
const fixturePageSize = 50;
const serverId = "backend4a";
const threadId = "mock-active-session";
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
let transcriptVirtualizationTraceSequence = 0;
const allowedMessages = new Set([50, 500, 2000]);
const suiteSourceSha256 = sha256(await readFile(new URL(import.meta.url)));

assert.ok(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 100, "--samples must be between 1 and 100");
assert.ok(sourceNames.length > 0 && sourceNames.every((value) => value === "before" || value === "after") && new Set(sourceNames).size === sourceNames.length, "--sources must be a unique comma-separated subset of before,after");
assert.ok(messageCounts.length > 0 && new Set(messageCounts).size === messageCounts.length && messageCounts.every((value) => allowedMessages.has(value)), "--messages must be a unique subset of 50,500,2000");
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

const { resolveProvenanceReference, readFrozenGatewayRuntime, startFrozenGateway, assertSafeBundleRelativePath, assertNoSymlinkAncestors, verifyExactBundleTree, installPerformanceInstrumentation, configureRuntimeConsumerProbe, safeSeedErrorMessage, safeSeedErrorStack, beginSeedUiTraceInPage, endSeedUiTraceInPage, captureSeedFailureDom } = createPrivateScrollV1Helpers({
  assert,
  lstat,
  performance,
  randomBytes,
  readFile,
  readdir,
  relative,
  repoRoot,
  resolve,
  sep,
  sha256,
  sha256File,
  waitFor,
});

const { readSourceSpec, copyAndVerifyRetainedBuilderExport } = createPrivateScrollV1SourceInputs({
  assert,
  assertNoSymlinkAncestors,
  assertPathWithinApprovedRoots,
  assertSafeBundleRelativePath,
  basename,
  dirname,
  lstat,
  mkdir,
  optionValue,
  readFile,
  readVerifiedMobileExportFile,
  relative,
  repoRoot,
  requiredDigest,
  requiredOption,
  resolve,
  resolveProvenanceReference,
  rm,
  sep,
  sha256,
  verifyExactBundleTree,
  verifyMobileExportManifestEnvelope,
  writeFile,
});

const { installHistoryAndNotificationFixture, readFocusState, connectMobile, loadHistoryToCount, latestLoadedHistoryTail, readTranscriptViewport, captureBrowserMemory, captureTranscriptEvidence, makeHistoryPage, makeHistoryMessage, createPageState, areNotificationBatchesOrdered, summarizeObservations, summarizeLongTasks, summarizeLongAnimationFrames, createCoverage, percentile, sampleHostCpuWindow, readHostCpuSnapshot } = createPrivateScrollV1ViewLedger({
  activeDeltaChunksPerStream,
  assert,
  fixturePageSize,
  parseFrame,
  performance,
  readFile,
  readdir,
  serverId,
  suiteSourceSha256,
  threadId,
  transcriptVirtualizationTraceLimits,
  waitFor,
  waitForTwoFrames,
});

const { summarizeSeedDispatchEvidence, beginTranscriptVirtualizationScrollTrace, stopTranscriptVirtualizationScrollTrace, scrollTranscriptToLatestCore, waitForProductTailMarkerWithoutAction, assertProductHistoryAnchorPreserved, assertProductVisibleHistoryOrder, chooseVisibleProductCodeAnchor, makeLongTailWindowAppendDelta, expandProductHistoryCodeDisclosure, runTailWindowProductRegression, runTailWindowPaginationRegression, runTranscriptFollowGestureRegression, disposeTranscriptFollowGestureInputTrace, waitForProductAppendCommit, performTrustedTranscriptTouch, waitForTranscriptTouchSettled, waitForProgrammaticFollowScrollEvent, waitForFollowAppendLayout, assertNoFollowPull, readVisibleHistoryAnchor, readCompletedAssistantMarkerUi, trustedJumpClickEventsSince, summarizeFollowGestureNotification, emitSyntheticTaskSnapshot } = createPrivateScrollV1FollowScenarios({
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
  scrollTranscriptToLatest,
  serverId,
  threadId,
  transcriptInputEventsSince,
  transcriptVirtualizationTraceLimits,
  waitFor,
  waitForStableProductHistoryAnchor,
  waitForStableProductHistoryWindow,
  waitForTwoFrames,
});

const { measureInputFeedback, measureScrollFeedback, summarizeScrollCausalityViewport, summarizeScrollCausalityTailGate, summarizeScrollCausalityWheel, summarizeScrollCausalityTouchTrace, measureActiveMarkdownDelta, dispatchActiveFrame, dispatchActiveStreamFrames, makeLongMarkdownDelta, measureSnapshotUpdates, captureCdpClockAnchor, summarizeCpuProfile, sendSyntheticSnapshot, readRuntimeConsumerProbe, drainRuntimeConsumerProbe, buildRuntimeConsumerSeedDiagnostic, summarizeRuntimeConsumerSeedFailure, summarizeSeedTranscriptViewport } = createPrivateScrollV1Measurements({
  activeDeltaChunksPerStream,
  assert,
  beginSeedUiTraceInPage,
  captureSeedFailureDom,
  captureSeedUiDomTrace,
  collectLongTasks,
  configureRuntimeConsumerProbe,
  disposeTranscriptFollowGestureInputTrace,
  emitSyntheticTaskSnapshot,
  endSeedUiTraceInPage,
  installTranscriptFollowGestureInputTrace,
  manualHistoryLogicalDistanceFromLatest,
  moveAwayFromLatestWithTrustedWheel,
  performance,
  readTranscriptFollowGestureInputTrace,
  readTranscriptViewport,
  runtimeConsumerDiagnostic,
  safePath,
  safeSeedErrorMessage,
  safeSeedErrorStack,
  scrollTranscriptToLatest,
  serverId,
  summarizeManualHistoryResetViewport,
  summarizeSeedDispatchEvidence,
  threadId,
  transcriptInputEventsSince,
  transcriptVirtualizationTraceLimits,
  waitForTwoFrames,
});

await runE2E(import.meta.url, {
  testId: tailWindowDiagnostic
    ? "mobile-render-profile-tail-window-product-regression"
    : followGestureRegression ? "mobile-render-profile-follow-gesture-regression" : "mobile-render-profile-high-history",
  tier: "manual-live",
  modelPolicy: tailWindowProductRegression
    ? `isolated Mobile Web product UI diagnostic (${tailWindowProductStage} stage) in Chromium with heterogeneous 500-message synthetic history and ordered app-facing WebSocketMock notifications; stable-reader uses trusted input to normalize its same-ID anchor before code/append checks; race uses preplanned touch and touchstart-time geometry; no provider, model, Rust app-server turn, Runtime probe, native validation, or performance sample`
    : tailWindowPaginationRegression
      ? "isolated Mobile Web pagination UI diagnostic in Chromium with synthetic history and trusted wheel/click against the real fixture route; no provider, model, Rust app-server turn, Runtime probe, native validation, or performance sample"
    : followGestureRegression
    ? "isolated Mobile Web UI follow-state diagnostic in Chromium with synthetic history and ordered app-facing WebSocketMock notifications plus trusted browser touch input; no provider, model, Runtime probe, or Rust app-server turn; not a performance sample or native validation"
    : "real Mobile Web UI in isolated Chromium with synthetic history pages and synthetic completed-task notifications; no provider or model calls; optional one-seed runtime-consumer diagnostic uses a private bounded read-only TaskRuntime projection and is not a performance sample or real app-server turn",
  retainSuccessLogs: true,
}, async (context) => {
  await observeSeparatedSuiteSourceInputs(context, [
    import.meta.url,
    new URL("../../harness/private-candidate-modules/scroll-v1/helpers.mjs", import.meta.url),
    new URL("../../harness/private-candidate-modules/scroll-v1/source-inputs.mjs", import.meta.url),
    new URL("../../harness/private-candidate-modules/scroll-v1/view-ledger.mjs", import.meta.url),
    new URL("../../harness/private-candidate-modules/scroll-v1/follow-scenarios.mjs", import.meta.url),
    new URL("../../harness/private-candidate-modules/scroll-v1/measurements.mjs", import.meta.url),
  ]);
  const hostCpuBefore = await sampleHostCpuWindow("before-owned-browser-and-gateway-work");
  const chromium = await startChromium(context, {
    label: "mobile-render-profile-chromium",
    noSandbox: true,
  });
  const observations = [];
  const fixtureEvidence = [];
  const cpuProfiles = [];
  const phaseProvenance = [];
  const browserErrors = [];
  const sources = [];
  const runtimeConsumerDiagnosticCases = [];
  const followGestureRegressionCases = [];
  const tailWindowProductRegressionCases = [];
  const tailWindowPaginationRegressionCases = [];
  const gatewayRuntime = await readFrozenGatewayRuntime(
    requiredOption("--gateway-runtime-root"),
    requiredOption("--gateway-binary"),
    requiredDigest("--gateway-binary-sha256"),
    requiredDigest("--gateway-source-tree-sha256"),
    requiredDigest("--gateway-dependency-tree-sha256"),
    requiredDigest("--gateway-runtime-manifest-sha256"),
  );
  const browserInfo = {
    version: await chromium.browser.version(),
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    evidenceKind: "system Chromium Mobile Web viewport emulation; does not measure Android/iOS native JS, UI, keyboard, or storage",
  };

  for (const sourceName of sourceNames) {
    const source = await readSourceSpec(sourceName);
    sources.push(source);
    const mobileWeb = await copyAndVerifyRetainedBuilderExport(context, source);

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
      webRoot: mobileWeb.path,
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
      exportManifestSha256: mobileWeb.sourceManifestSha256,
      bundleSha256: mobileWeb.bundleSha256,
      indexHtmlSha256: mobileWeb.indexHtmlSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
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
        installHistoryAndNotificationFixture(page, pageState);
        await connectMobile(page, gateway);
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
          try {
            assert.equal(await page.getByTestId("changes-panel").count(), 0, "tail-window product diagnostic requires ChangesPanel to be actually unmounted");
            pageState.changesPanelMounted = false;
            if (tailWindowPaginationRegression) {
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
            const scenario = tailWindowPaginationRegression ? "pagination" : "core";
            const screenshotArtifact = `phone-render-tail-window-${scenario}-failure-after-${count}-unmounted.png`;
            let screenshot = { status: "not-captured", artifact: null, error: null };
            try {
              await page.screenshot({ path: context.pathInArtifacts(screenshotArtifact), fullPage: false });
              screenshot = { status: "captured", artifact: screenshotArtifact, error: null };
            } catch (screenshotError) {
              screenshot = { status: "failed", artifact: null, error: safeSeedErrorMessage(screenshotError) };
            }
            const failureEvidence = (tailWindowPaginationRegression ? error?.tailWindowPaginationEvidence : error?.tailWindowProductEvidence) ?? {
              schemaVersion: 1,
              status: "FAIL",
              scenario,
              source: source.name,
              requestedMessages: count,
              panelState,
              seedTranscriptViewport: seed.transcriptViewport ?? null,
              historyPages: pageState.historyPages,
              notificationBatches: pageState.notificationBatches,
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
              if (tailWindowPaginationRegression) combinedError.tailWindowPaginationEvidence = completeFailureEvidence;
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
          await page.getByTestId("workspace-tab-switcher").click();
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
          await page.getByTestId("workspace-tab-switcher").click();
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
        pageState.memoryBeforeMeasuredInteractions = await captureBrowserMemory(page);

        observations.push(...await measureInputFeedback(page, pageState, source.name, count, panelState, sampleCount));
        observations.push(...await measureScrollFeedback(page, pageState, source.name, count, panelState, sampleCount, context));

        const hiddenUpdates = await measureSnapshotUpdates(page, pageState, source.name, count, panelState, sampleCount, context);
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

        // Core latency samples run without V8 Profiler enabled. A separate diagnostic
        // burst below captures stacks so sampling overhead cannot inflate P50/P95.
        let activeStream;
        try {
          activeStream = await measureActiveMarkdownDelta(page, pageState, source.name, count, panelState, sampleCount, false);
        } catch (error) {
          await context.writeArtifactJson(`phone-render-profile-failure-${source.name}-${count}-${panelState}.json`, {
            schemaVersion: 1,
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
        pageState.memoryAfterActiveStream = await captureBrowserMemory(page);

        let activeMarkdownStackDiagnostic = null;
        if (captureStackDiagnostic) {
          const measuredStreamEvidence = pageState.activeStreamEvidence;
          const diagnostic = await measureActiveMarkdownDelta(page, pageState, source.name, count, panelState, 1, true, {
            diagnosticOnly: true,
            sampleOffset: sampleCount,
          });
          activeMarkdownStackDiagnostic = {
            classification: "separate one-burst CDP V8 diagnostic; excluded from core latency summaries and sample counts",
            source: source.name,
            requestedMessages: count,
            panelState,
            priorMeasuredActiveStreams: sampleCount,
            profile: diagnostic.cpuProfile,
            burst: diagnostic.evidence?.bursts?.[0] ?? null,
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

  const summaries = summarizeObservations(observations);
  const longTaskSummary = summarizeLongTasks(observations);
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
    evidence.status = "PASS";
    state.initialEntryTailEvidence = evidence;
    return evidence;
  } catch (error) {
    evidence.status = "FAIL";
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
  return {
    sampledAtPageTimeMs: viewport?.sampledAtPageTimeMs ?? null,
    scrollTop: viewport?.scrollTop ?? null,
    scrollHeight: viewport?.scrollHeight ?? null,
    clientHeight: viewport?.clientHeight ?? null,
    rawBottomGapPx: viewport?.bottomGapPx ?? null,
    markerVisibleWithinMessageList: viewport?.targetMarkerVisibleWithinMessageList ?? null,
    markerLastCharacterRect: viewport?.targetMarkerLastCharacterRect ?? null,
    jumpToLatestVisible: viewport?.jumpToLatestVisible ?? null,
    scrollportTransform: viewport?.targetMarkerVisibilityDiagnostics?.scrollport?.transform ?? null,
  };
}

function manualHistoryLogicalDistanceFromLatest(viewport) {
  const transform = viewport?.targetMarkerVisibilityDiagnostics?.scrollport?.transform ?? "none";
  let verticalScale = 1;
  if (transform !== "none") {
    const matrix2d = /^matrix\(([^)]+)\)$/.exec(transform);
    const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(transform);
    const values = (matrix2d?.[1] ?? matrix3d?.[1])?.split(",").map((part) => Number(part.trim()));
    assert.ok(values && values.every(Number.isFinite), `unsupported transcript scrollport transform for logical distance: ${transform}`);
    verticalScale = matrix2d ? values[3] : values[5];
    assert.ok(Number.isFinite(verticalScale) && Math.abs(verticalScale) > 0, "transcript scrollport vertical transform must be measurable");
  }
  const inverted = verticalScale < 0;
  return {
    transform,
    inverted,
    pixels: inverted ? Math.abs(viewport.scrollTop) : Math.max(0, viewport.bottomGapPx),
  };
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
    expectedLatestHistory: latestHistory,
    phaseEvidence,
    productTailGate: error?.productTailGateEvidence ?? null,
    lastTranscriptViewport,
    screenshot,
    error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) },
  });
}

async function scrollTranscriptToLatest(page, expectedTailMarker, options = {}) {
  if (options.captureVirtualizedGeometry !== true) {
    return scrollTranscriptToLatestCore(page, expectedTailMarker, options, null);
  }
  const traceKey = `transcript-layout-${transcriptVirtualizationTraceSequence++}`;
  let startEvidence;
  try {
    startEvidence = await beginTranscriptVirtualizationScrollTrace(page, traceKey);
  } catch (error) {
    startEvidence = { status: "START_FAILED", error: safeSeedErrorMessage(error) };
  }
  const trace = {
    key: traceKey,
    startEvidence,
    viewportSamplesCaptured: 0,
    viewportSamplesOmitted: 0,
    finished: false,
    summary: null,
  };
  try {
    const result = await scrollTranscriptToLatestCore(page, expectedTailMarker, options, trace);
    result.virtualizedGeometryTrace = await stopTranscriptVirtualizationScrollTrace(page, trace);
    return result;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const geometryTrace = await stopTranscriptVirtualizationScrollTrace(page, trace);
    if (failure.transcriptViewport && typeof failure.transcriptViewport === "object") {
      failure.transcriptViewport.virtualizedGeometryTrace = geometryTrace;
    } else {
      failure.transcriptViewport = { expectedTailMarker, virtualizedGeometryTrace: geometryTrace };
    }
    throw failure;
  }
}

async function readProductHistoryViewport(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { listFound: false, visibleRows: [] };
    const listRect = list.getBoundingClientRect();
    const hostCandidate = list.querySelector("[data-phone-ux-scroll-host]");
    const scrollableCandidates = [list, ...list.querySelectorAll("*")].filter((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    ).sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight),
    );
    const host = hostCandidate instanceof HTMLElement ? hostCandidate : scrollableCandidates[0] ?? list;
    const rectValue = (rect) => ({
      top: Number(rect.top.toFixed(3)),
      bottom: Number(rect.bottom.toFixed(3)),
      left: Number(rect.left.toFixed(3)),
      right: Number(rect.right.toFixed(3)),
      width: Number(rect.width.toFixed(3)),
      height: Number(rect.height.toFixed(3)),
    });
    const visibleRows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')]
      .map((row) => {
        const marker = /HISTORY-(\d{4})/.exec(row.textContent ?? "")?.[0] ?? null;
        if (!marker) return null;
        const historyIndex = Number(marker.slice("HISTORY-".length));
        const rect = row.getBoundingClientRect();
        const visibleWithinMessageList = rect.width > 0 && rect.height > 0
          && rect.right > listRect.left && rect.left < listRect.right
          && rect.bottom > listRect.top && rect.top < listRect.bottom;
        if (!visibleWithinMessageList) return null;
        const disclosures = [...row.querySelectorAll('[data-testid="code-disclosure"] [role="button"]')];
        const collapsedCodeDisclosureCount = disclosures.filter((button) => button.getAttribute("aria-expanded") === "false").length;
        const expandedCodeDisclosureCount = disclosures.filter((button) => button.getAttribute("aria-expanded") === "true").length;
        return {
          marker,
          historyIndex,
          fixtureMessageId: `history-${historyIndex}`,
          role: row.getAttribute("data-testid") === "message-assistant" ? "assistant" : "user",
          rect: rectValue(rect),
          viewportOffsetPx: Number((rect.top - listRect.top).toFixed(3)),
          collapsedCodeDisclosureCount,
          expandedCodeDisclosureCount,
          expandedCodeTokenVisible: (row.textContent ?? "").includes(`fixture_${historyIndex}_0`),
        };
      })
      .filter(Boolean)
      .slice(0, 32);
    const control = document.querySelector('[data-testid="load-older-messages"]');
    const controlRect = control instanceof HTMLElement ? control.getBoundingClientRect() : null;
    const jump = document.querySelector('[data-testid="jump-to-latest"]');
    const jumpRect = jump instanceof HTMLElement ? jump.getBoundingClientRect() : null;
    const jumpStyle = jump instanceof HTMLElement ? getComputedStyle(jump) : null;
    const visibleControl = Boolean(controlRect && controlRect.width > 0 && controlRect.height > 0
      && controlRect.right > listRect.left && controlRect.left < listRect.right
      && controlRect.bottom > listRect.top && controlRect.top < listRect.bottom);
    return {
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      listFound: true,
      listRect: rectValue(listRect),
      scrollHost: {
        testId: host.getAttribute("data-testid"),
        scrollTop: Number(host.scrollTop.toFixed(3)),
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        scrollTopIsRawWebGeometryOnly: true,
      },
      visibleRows,
      visibleHistoryIndexes: visibleRows.map((row) => row.historyIndex),
      visualHistoryIndexes: [...visibleRows].sort((left, right) => left.rect.top - right.rect.top).map((row) => row.historyIndex),
      minimumVisibleHistoryIndex: visibleRows.length ? Math.min(...visibleRows.map((row) => row.historyIndex)) : null,
      maximumVisibleHistoryIndex: visibleRows.length ? Math.max(...visibleRows.map((row) => row.historyIndex)) : null,
      olderHistoryControl: {
        present: Boolean(control),
        visibleWithinMessageList: visibleControl,
        disabled: control instanceof HTMLButtonElement ? control.disabled : control?.getAttribute("aria-disabled") === "true",
        rect: controlRect ? rectValue(controlRect) : null,
      },
      jumpToLatestVisible: Boolean(jumpRect && jumpRect.width > 0 && jumpRect.height > 0
        && jumpStyle?.display !== "none" && jumpStyle?.visibility !== "hidden"),
    };
  });
}

async function readProductHistoryAnchor(page, marker) {
  const viewport = await readProductHistoryViewport(page);
  return {
    viewport,
    anchor: viewport.visibleRows.find((row) => row.marker === marker) ?? null,
  };
}

async function waitForStableProductHistoryAnchor(page, marker, label, timeoutMs = 5_000) {
  const startedAt = performance.now();
  const samples = [];
  let previous = null;
  while (performance.now() - startedAt <= timeoutMs) {
    await waitForTwoFrames(page);
    const current = await readProductHistoryAnchor(page, marker);
    samples.push({
      pageTimeMs: current.viewport.sampledAtPageTimeMs,
      anchor: current.anchor,
      scrollHost: current.viewport.scrollHost,
    });
    assert.equal(current.viewport.listFound, true, `${label}: actual message-list must remain mounted`);
    assert.ok(current.anchor?.fixtureMessageId, `${label}: the same visible fixture history row must remain mounted`);
    if (previous?.anchor?.fixtureMessageId === current.anchor.fixtureMessageId
      && Math.abs(previous.anchor.viewportOffsetPx - current.anchor.viewportOffsetPx) <= 0.5
      && Math.abs(previous.viewport.scrollHost.scrollTop - current.viewport.scrollHost.scrollTop) <= 0.5
      && previous.viewport.scrollHost.scrollHeight === current.viewport.scrollHost.scrollHeight
      && previous.viewport.scrollHost.clientHeight === current.viewport.scrollHost.clientHeight) {
      return {
        ...current.anchor,
        listRect: current.viewport.listRect,
        sampledAtPageTimeMs: current.viewport.sampledAtPageTimeMs,
        stableAfterTwoFrames: true,
        stabilityPair: [previous, samples.at(-1)],
        observations: samples.slice(-8),
      };
    }
    previous = current;
    await page.waitForTimeout(25);
  }
  const error = new Error(`${label}: visible row geometry did not settle within ${timeoutMs}ms`);
  error.historyAnchorEvidence = { marker, observations: samples.slice(-12) };
  throw error;
}

async function installTranscriptFollowGestureInputTrace(page, maxEvents = 256) {
  assert.ok(Number.isSafeInteger(maxEvents) && maxEvents >= 256 && maxEvents <= 4096, "follow input trace bound must be between 256 and 4096 events");
  return page.evaluate((eventLimit) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) throw new Error("follow regression could not find the visible message-list");
    const candidates = [list, ...list.querySelectorAll("*")].filter((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    );
    const host = candidates.sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight),
    )[0] ?? list;
    const trace = { nextOrdinal: 1, dropped: 0, events: [], maxEvents: eventLimit, anchorMarker: null, tailMarker: null,
      jumpClickOrdinal: null, raceEvidence: null, readinessEvidence: null };
    const sampleRow = (row, marker, fixtureMessageId = null) => {
      if (!(row instanceof HTMLElement) || !row.isConnected) return { marker, found: false, visibleInClip: false };
      const rowRect = row.getBoundingClientRect(), listRect = list.getBoundingClientRect(), hostRect = host.getBoundingClientRect();
      const visual = window.visualViewport;
      const clip = {
        left: Math.max(visual?.offsetLeft ?? 0, listRect.left, hostRect.left + host.clientLeft),
        top: Math.max(visual?.offsetTop ?? 0, listRect.top, hostRect.top + host.clientTop),
        right: Math.min((visual?.offsetLeft ?? 0) + (visual?.width ?? innerWidth), listRect.right, hostRect.left + host.clientLeft + host.clientWidth),
        bottom: Math.min((visual?.offsetTop ?? 0) + (visual?.height ?? innerHeight), listRect.bottom, hostRect.top + host.clientTop + host.clientHeight),
      };
      const visibleInClip = rowRect.width > 0 && rowRect.height > 0
        && rowRect.right > clip.left && rowRect.left < clip.right
        && rowRect.bottom > clip.top && rowRect.top < clip.bottom;
      const rawTop = Number(host.scrollTop.toFixed(2));
      const maximumRawTop = Math.max(0, host.scrollHeight - host.clientHeight);
      return { marker, found: true, fixtureMessageId,
        rowTop: Number(rowRect.top.toFixed(2)), rowBottom: Number(rowRect.bottom.toFixed(2)),
        viewportOffsetPx: Number((rowRect.top - listRect.top).toFixed(2)), clip, visibleInClip,
        rawTop, logicalTop: Number((maximumRawTop - rawTop).toFixed(2)), maximumRawTop, pageTimeMs: Number(performance.now().toFixed(3)) };
    };
    const sampleAnchor = () => {
      if (!(trace.anchorElement instanceof HTMLElement) || !trace.anchorElement.isConnected
        || !(trace.anchorElement.textContent ?? "").includes(trace.anchorMarker ?? "")) {
        return { marker: trace.anchorMarker, fixtureMessageId: trace.anchorFixtureId, found: false, visibleInClip: false, recycledOrDetached: true };
      }
      return sampleRow(trace.anchorElement, trace.anchorMarker, trace.anchorFixtureId);
    };
    const sampleTail = () => {
      if (!(trace.tailElement instanceof HTMLElement) || !trace.tailElement.isConnected
        || !(trace.tailElement.textContent ?? "").includes(trace.tailMarker ?? "")) {
        return { marker: trace.tailMarker, found: false, visibleInClip: false, recycledOrDetached: true };
      }
      return sampleRow(trace.tailElement, trace.tailMarker);
    };
    const activeJumpState = (currentEvent = null) => {
      const clickOrdinal = trace.jumpClickOrdinal ?? Number.MAX_SAFE_INTEGER;
      const jumpScrolls = trace.events.filter((prior) => prior.type === "scroll" && prior.isTrusted
        && prior.insideMessageList && prior.ordinal > clickOrdinal && prior.anchorSample?.found).slice(-2);
      const [prior, latest] = jumpScrolls;
      const anchorNow = sampleAnchor();
      const tailNow = sampleTail();
      const nowMs = currentEvent?.pageTimeMs ?? Number(performance.now().toFixed(3));
      const currentScrollTop = currentEvent?.scrollTop ?? Number(host.scrollTop.toFixed(2));
      const conditions = {
        trustedJumpClick: trace.jumpClickOrdinal !== null,
        twoRecentJumpScrolls: jumpScrolls.length === 2,
        sameFixtureAnchor: Boolean(prior && latest && prior.anchorSample.fixtureMessageId === trace.anchorFixtureId
          && latest.anchorSample.fixtureMessageId === trace.anchorFixtureId && anchorNow.fixtureMessageId === trace.anchorFixtureId),
        recent: Boolean(latest && nowMs - latest.pageTimeMs <= 200),
        clippedAnchor: anchorNow.visibleInClip === true,
        tailOutsideClip: tailNow.visibleInClip === false && latest?.tailSample?.visibleInClip === false,
        rawAdvancingToLatest: Boolean(prior && latest && latest.scrollTop < prior.scrollTop - 0.5
          && currentScrollTop <= latest.scrollTop + 0.5),
        anchorAdvancingToLatest: Boolean(prior && latest
          && latest.anchorSample.viewportOffsetPx < prior.anchorSample.viewportOffsetPx - 0.5
          && anchorNow.viewportOffsetPx <= latest.anchorSample.viewportOffsetPx + 0.5),
      };
      return { conditions, recentJumpScrolls: jumpScrolls, anchorNow, tailNow, currentScrollTop,
        currentLogicalTop: anchorNow.logicalTop ?? null, sampledAtPageTimeMs: nowMs };
    };
    const waitForActiveJump = (timeoutMs) => new Promise((resolve) => {
      const boundedTimeoutMs = Math.min(3_000, Math.max(0, Number(timeoutMs) || 0));
      const startedAt = performance.now();
      const observations = [];
      const poll = () => {
        const state = activeJumpState();
        observations.push({ sampledAtPageTimeMs: state.sampledAtPageTimeMs, conditions: state.conditions,
          latestOrdinal: trace.events.at(-1)?.ordinal ?? 0, anchorNow: state.anchorNow, tailNow: state.tailNow,
          recentJumpScrolls: state.recentJumpScrolls });
        if (observations.length > 32) observations.shift();
        if (Object.values(state.conditions).every(Boolean)) {
          trace.readinessEvidence = { status: "READY_ACTIVE_JUMP", ...state,
            jumpClickOrdinal: trace.jumpClickOrdinal, latestOrdinal: trace.events.at(-1)?.ordinal ?? 0,
            observations: [...observations] };
          resolve(trace.readinessEvidence);
        } else if (performance.now() - startedAt >= boundedTimeoutMs) {
          trace.readinessEvidence = { status: "INVALID_TIMING", ...state,
            jumpClickOrdinal: trace.jumpClickOrdinal, latestOrdinal: trace.events.at(-1)?.ordinal ?? 0,
            observations: [...observations] };
          resolve(trace.readinessEvidence);
        } else {
          requestAnimationFrame(poll);
        }
      };
      poll();
    });
    const record = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const target = event.target instanceof Element ? event.target : null;
      const insideMessageList = path.includes(list) || Boolean(target && list.contains(target));
      const jumpButton = path.find((node) => node instanceof HTMLElement && node.getAttribute("data-testid") === "jump-to-latest")
        ?? target?.closest('[data-testid="jump-to-latest"]')
        ?? null;
      if (!insideMessageList && !jumpButton) return;
      if (trace.events.length >= trace.maxEvents) {
        trace.dropped += 1;
        return;
      }
      const entry = {
        ordinal: trace.nextOrdinal++,
        type: event.type,
        isTrusted: event.isTrusted === true,
        insideMessageList,
        insideJumpButton: Boolean(jumpButton),
        targetTag: target?.tagName ?? null,
        targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        pointerType: "pointerType" in event ? event.pointerType : null,
        deltaX: typeof event.deltaX === "number" ? Number(event.deltaX.toFixed(3)) : null,
        deltaY: typeof event.deltaY === "number" ? Number(event.deltaY.toFixed(3)) : null,
        pageTimeMs: Number(performance.now().toFixed(3)),
        scrollTop: Number(host.scrollTop.toFixed(2)),
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        bottomGapPx: Math.max(0, Number((host.scrollHeight - host.clientHeight - host.scrollTop).toFixed(2))),
      };
      if (event.type === "click" && jumpButton && entry.isTrusted) trace.jumpClickOrdinal = entry.ordinal;
      if (event.type === "scroll" && insideMessageList && trace.anchorMarker) {
        entry.anchorSample = sampleAnchor();
        entry.tailSample = sampleTail();
      }
      if (event.type === "touchstart" && insideMessageList && trace.anchorMarker) {
        const state = activeJumpState(entry);
        const conditions = { trustedTouchstart: entry.isTrusted, ...state.conditions };
        const activeMotion = Object.values(conditions).every(Boolean);
        trace.raceEvidence = {
          classification: activeMotion ? "VALID_ACTIVE_JUMP" : "INVALID_TIMING",
          conditions, jumpClickOrdinal: trace.jumpClickOrdinal, recentJumpScrolls: state.recentJumpScrolls,
          readinessEvidence: trace.readinessEvidence, anchorAtTouchStart: state.anchorNow, tailAtTouchStart: state.tailNow,
          currentRawTop: entry.scrollTop, currentLogicalTop: state.currentLogicalTop,
        };
        entry.anchorAtTouchStart = state.anchorNow;
        entry.tailAtTouchStart = state.tailNow;
        entry.raceClassification = trace.raceEvidence.classification;
        trace.anchorMarker = null;
        trace.anchorElement = null;
        trace.tailMarker = null;
        trace.tailElement = null;
      }
      trace.events.push(entry);
    };
    const inputTypes = ["touchstart", "touchmove", "touchend", "pointerdown", "pointermove", "pointerup", "wheel", "click"];
    for (const type of inputTypes) document.addEventListener(type, record, true);
    list.addEventListener("scroll", record, true);
    window.__phoneFollowGestureInputTrace = {
      armAnchor: (marker, fixtureMessageId, tailMarker) => {
        trace.anchorMarker = typeof marker === "string" ? marker : null;
        trace.anchorFixtureId = typeof fixtureMessageId === "string" ? fixtureMessageId : null;
        trace.tailMarker = typeof tailMarker === "string" ? tailMarker : null;
        const rows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
        trace.anchorElement = rows.find((element) => (element.textContent ?? "").includes(trace.anchorMarker)) ?? null;
        trace.tailElement = rows.find((element) => trace.tailMarker && (element.textContent ?? "").includes(trace.tailMarker)) ?? null;
        trace.jumpClickOrdinal = null;
        trace.raceEvidence = null;
        trace.readinessEvidence = null;
        return Boolean(trace.anchorMarker && trace.anchorFixtureId && trace.anchorElement && trace.tailMarker);
      },
      snapshot: () => ({
        schemaVersion: 1,
        maxEvents: trace.maxEvents,
        dropped: trace.dropped,
        latestOrdinal: trace.events.at(-1)?.ordinal ?? 0,
        raceEvidence: trace.raceEvidence,
        readinessEvidence: trace.readinessEvidence,
        events: [...trace.events],
      }),
      waitForActiveJump,
      dispose: () => {
        for (const type of inputTypes) document.removeEventListener(type, record, true);
        list.removeEventListener("scroll", record, true);
        delete window.__phoneFollowGestureInputTrace;
      },
    };
    const listRect = list.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      installed: true,
      source: "passive DOM event capture plus bounded read-only requestAnimationFrame readiness sampling; no DOM scroll writes, synthetic DOM events, React state, Runtime handler calls, or observers",
      listTestId: list.getAttribute("data-testid"),
      hostTag: host.tagName,
      hostTestId: host.getAttribute("data-testid"),
      hostOverflowY: getComputedStyle(host).overflowY,
      listRect: { top: listRect.top, bottom: listRect.bottom, left: listRect.left, right: listRect.right },
      hostRect: { top: hostRect.top, bottom: hostRect.bottom, left: hostRect.left, right: hostRect.right },
      initialScrollTop: Number(host.scrollTop.toFixed(2)),
      initialScrollHeight: host.scrollHeight,
      initialClientHeight: host.clientHeight,
    };
  }, maxEvents);
}

async function readTranscriptFollowGestureInputTrace(page) {
  return page.evaluate(() => window.__phoneFollowGestureInputTrace?.snapshot() ?? null);
}

async function waitForStableProductHistoryWindow(page, label, timeoutMs = 5_000) {
  const startedAt = performance.now();
  const observations = [];
  let previous = null;
  while (performance.now() - startedAt <= timeoutMs) {
    await waitForTwoFrames(page);
    const current = await readProductHistoryViewport(page);
    observations.push(current);
    assert.equal(current.listFound, true, `${label}: actual Mobile message-list must remain mounted`);
    const sameVisibleRows = previous !== null
      && previous.visibleRows.length === current.visibleRows.length
      && previous.visibleRows.every((row, index) => row.marker === current.visibleRows[index].marker
        && Math.abs(row.viewportOffsetPx - current.visibleRows[index].viewportOffsetPx) <= 0.5);
    const sameExtent = previous !== null
      && Math.abs(previous.scrollHost.scrollTop - current.scrollHost.scrollTop) <= 0.5
      && previous.scrollHost.scrollHeight === current.scrollHost.scrollHeight
      && previous.scrollHost.clientHeight === current.scrollHost.clientHeight;
    if (sameVisibleRows && sameExtent) {
      return {
        ...current,
        stableAfterTwoFrames: true,
        stabilityPair: [previous, current],
        observations: observations.slice(-8),
      };
    }
    previous = current;
    await page.waitForTimeout(25);
  }
  const error = new Error(`${label}: visible history window and actual scroll geometry did not settle within ${timeoutMs}ms`);
  error.productHistoryViewportEvidence = { observations: observations.slice(-12) };
  throw error;
}

async function prepareProductTouchStroke(page, label, options = {}) {
  const bounds = await page.getByTestId("message-list").boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `${label}: pre-jump message-list hitbox must be visible`);
  const x = Math.round(bounds.x + bounds.width * 0.55);
  const direction = options.direction === "toward-latest" ? "toward-latest" : "toward-older";
  const fromY = Math.round(bounds.y + bounds.height * (direction === "toward-latest" ? 0.78 : 0.24));
  const toY = Math.round(bounds.y + bounds.height * (direction === "toward-latest" ? 0.24 : 0.78));
  assert.ok(Math.abs(toY - fromY) >= 96, `${label}: prepared touch path must move at least 96 CSS px`);
  const [hitTest, trace] = await Promise.all([
    page.evaluate(({ x, y }) => {
      const list = document.querySelector('[data-testid="message-list"]');
      const target = document.elementFromPoint(x, y);
      return { insideMessageList: Boolean(list && target && list.contains(target)), targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null };
    }, { x, y: fromY }),
    readTranscriptFollowGestureInputTrace(page),
  ]);
  assert.equal(hitTest.insideMessageList, true, `${label}: prevalidated touch point must hit the actual message-list`);
  return { preparedBeforeAction: true, preparedBeforeJump: options.preparedBeforeJump === true,
    direction, start: { x, y: fromY }, end: { x, y: toY }, hitTest,
    latestOrdinal: trace?.latestOrdinal ?? 0, requestedPointCount: options.pointCount ?? 12 };
}

async function performProductTouchStroke(page, cdp, label, options = {}) {
  const evidence = {
    label,
    status: "RUNNING",
    inputBoundary: "Chromium CDP Input.dispatchTouchEvent; the page must observe trusted DOM touchstart/move/end and trusted list scroll events",
    intent: options.direction === "toward-latest"
      ? "finger moves toward the visual latest edge to normalize the same reader anchor; no programmatic scroll assignment or list API call"
      : "finger moves toward the visual older-history edge; no programmatic scroll assignment or list API call",
    requestedPointCount: options.pointCount ?? 12,
    interMoveDelayMs: options.interMoveDelayMs ?? 16,
    startedAtHostMonotonicMs: Number(performance.now().toFixed(3)),
    hitTest: null,
    start: null,
    end: null,
    eventStartOrdinal: null,
    beforeViewport: null,
    touchEndSent: false,
    touchEndPageTimeMs: null,
    afterTwoFramesViewport: null,
    events: [],
    trustedEventCounts: { touchstart: 0, touchmove: 0, touchend: 0, listScroll: 0 },
  };
  try {
    const plan = options.preparedPlan ?? await prepareProductTouchStroke(page, label, {
      pointCount: evidence.requestedPointCount, direction: options.direction,
    });
    assert.equal(plan.preparedBeforeAction, true, `${label}: touch coordinates and hit test must be prepared before the action under test`);
    const { x, y: fromY } = plan.start;
    const toY = plan.end.y;
    evidence.hitTest = plan.hitTest;
    const eventStartOrdinal = options.afterOrdinal ?? plan.latestOrdinal;
    evidence.preparedPlan = { preparedBeforeAction: true, preparedBeforeJump: plan.preparedBeforeJump, latestOrdinal: plan.latestOrdinal, dispatchedAfterOrdinal: eventStartOrdinal };
    evidence.start = { x, y: fromY };
    evidence.end = { x, y: toY };
    evidence.eventStartOrdinal = eventStartOrdinal;
    const pointCount = evidence.requestedPointCount;
    const interMoveDelayMs = evidence.interMoveDelayMs;
    const pointId = 71;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY, id: pointId }] });
    for (let index = 1; index <= pointCount; index += 1) {
      const y = fromY + ((toY - fromY) * index) / pointCount;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: pointId }] });
      if (interMoveDelayMs > 0) await page.waitForTimeout(interMoveDelayMs);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    evidence.touchEndSent = true;
    evidence.touchEndPageTimeMs = await page.evaluate(() => Number(performance.now().toFixed(3)));
    await waitForTwoFrames(page);
    evidence.afterTwoFramesViewport = await readProductHistoryViewport(page);
    const traceAfter = await readTranscriptFollowGestureInputTrace(page);
    evidence.touchStartRaceEvidence = traceAfter?.raceEvidence ?? null;
    evidence.events = transcriptInputEventsSince(traceAfter, eventStartOrdinal);
    const touchEvents = evidence.events.filter((event) => event.ordinal > (options.inputAfterOrdinal ?? eventStartOrdinal) && ["touchstart", "touchmove", "touchend"].includes(event.type));
    const trustedListScrolls = evidence.events.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList);
    evidence.trustedEventCounts = {
      touchstart: touchEvents.filter((event) => event.type === "touchstart" && event.isTrusted && event.insideMessageList).length,
      touchmove: touchEvents.filter((event) => event.type === "touchmove" && event.isTrusted && event.insideMessageList).length,
      touchend: touchEvents.filter((event) => event.type === "touchend" && event.isTrusted && event.insideMessageList).length,
      listScroll: trustedListScrolls.length,
    };
    evidence.status = "CAPTURED_TRUSTED_TOUCH_SEQUENCE";
    assert.ok(evidence.trustedEventCounts.touchstart > 0, `${label}: real browser trusted touchstart must reach the message-list`);
    assert.ok(evidence.trustedEventCounts.touchmove > 0, `${label}: real browser trusted touchmove must reach the message-list`);
    assert.ok(evidence.trustedEventCounts.touchend > 0, `${label}: real browser trusted touchend must reach the message-list`);
    assert.ok(touchEvents.every((event) => event.isTrusted && event.insideMessageList), `${label}: every captured touch event must be trusted and inside the message-list`);
    if (options.requireActiveJumpAtTouchStart && evidence.touchStartRaceEvidence?.classification !== "VALID_ACTIVE_JUMP") {
      evidence.status = "INVALID_TIMING";
      const timingError = new Error(`${label}: trusted touchstart did not coincide with a clipped anchor and recent active Jump motion`);
      timingError.code = "INVALID_TIMING";
      timingError.productTouchStrokeEvidence = evidence;
      throw timingError;
    }
    evidence.status = "PASS_TRUSTED_TOUCH_SEQUENCE";
    return {
      ...evidence,
      beforeViewport: evidence.beforeViewport,
      afterViewport: evidence.afterTwoFramesViewport,
      pointCount: evidence.requestedPointCount + 2,
    };
  } catch (error) {
    evidence.status = error?.code === "INVALID_TIMING" ? "INVALID_TIMING" : "FAIL";
    evidence.failure = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    try {
      const traceAfter = await readTranscriptFollowGestureInputTrace(page);
      evidence.events = transcriptInputEventsSince(traceAfter, evidence.eventStartOrdinal ?? 0);
      evidence.inputTraceDropped = traceAfter?.dropped ?? null;
      const touchEvents = evidence.events.filter((event) => event.ordinal > (options.inputAfterOrdinal ?? (evidence.eventStartOrdinal ?? 0)) && ["touchstart", "touchmove", "touchend"].includes(event.type));
      evidence.trustedEventCounts = {
        touchstart: touchEvents.filter((event) => event.type === "touchstart" && event.isTrusted && event.insideMessageList).length,
        touchmove: touchEvents.filter((event) => event.type === "touchmove" && event.isTrusted && event.insideMessageList).length,
        touchend: touchEvents.filter((event) => event.type === "touchend" && event.isTrusted && event.insideMessageList).length,
        listScroll: evidence.events.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList).length,
      };
      evidence.currentViewport = await readProductHistoryViewport(page);
    } catch (evidenceError) {
      evidence.evidenceReadError = { name: evidenceError?.name ?? "Error", message: safeSeedErrorMessage(evidenceError) };
    }
    error.productTouchStrokeEvidence = evidence;
    throw error;
  }
}

async function normalizeStableReaderAnchorWithTrustedInput(page, cdp, initialAnchor, label) {
  const evidence = {
    status: "RUNNING",
    fixtureMessageId: initialAnchor.fixtureMessageId,
    marker: initialAnchor.marker,
    before: initialAnchor,
    after: initialAnchor,
    exactAnchorTolerancePx: 2,
    direction: "toward-latest",
    inputBoundary: "trusted Chromium CDP touch strokes only; no DOM scroll writes, list API calls, or anchor substitution",
    inputBudgetMs: 5_000,
    settleBudgetMs: 5_000,
    maximumStrokeCount: 8,
    cumulativeInputMs: 0,
    cumulativeSettleMs: 0,
    strokes: [],
  };
  let anchor = initialAnchor;
  const startedAt = performance.now();
  try {
    assert.ok(anchor?.fixtureMessageId && anchor.marker, `${label}: normalization needs one mounted history row with its immutable ID`);
    while (anchor.viewportOffsetPx < -2) {
      assert.ok(evidence.strokes.length < evidence.maximumStrokeCount,
        `${label}: the same row did not reach the 2px top contract within eight trusted strokes`);
      const remainingInputMs = evidence.inputBudgetMs - evidence.cumulativeInputMs;
      const previousInputMs = evidence.strokes.at(-1)?.inputDurationMs ?? 0;
      const remainingSettleMs = evidence.settleBudgetMs - evidence.cumulativeSettleMs;
      const previousSettleMs = evidence.strokes.at(-1)?.settleDurationMs ?? 0;
      assert.ok(remainingInputMs > previousInputMs,
        `${label}: no next trusted stroke fits the original shared five-second input budget`);
      assert.ok(remainingSettleMs > previousSettleMs,
        `${label}: no next anchor-settle check fits the original shared five-second settle budget`);

      const strokeNumber = evidence.strokes.length + 1;
      const strokeBefore = anchor;
      const inputStartedAt = performance.now();
      let stroke;
      try {
        stroke = await performProductTouchStroke(page, cdp, `${label}-toward-latest-${strokeNumber}`, {
          direction: "toward-latest",
          pointCount: 26,
          interMoveDelayMs: 12,
        });
      } catch (error) {
        const partialStroke = error.productTouchStrokeEvidence ?? { status: "FAIL_WITHOUT_STROKE_EVIDENCE" };
        partialStroke.strokeNumber = strokeNumber;
        partialStroke.inputDurationMs = Number((performance.now() - inputStartedAt).toFixed(3));
        evidence.cumulativeInputMs += partialStroke.inputDurationMs;
        partialStroke.cumulativeInputMs = Number(evidence.cumulativeInputMs.toFixed(3));
        partialStroke.anchorBefore = strokeBefore;
        evidence.strokes.push(partialStroke);
        error.productStableReaderNormalizationEvidence = evidence;
        throw error;
      }
      stroke.strokeNumber = strokeNumber;
      stroke.inputDurationMs = Number((performance.now() - inputStartedAt).toFixed(3));
      evidence.cumulativeInputMs += stroke.inputDurationMs;
      stroke.cumulativeInputMs = Number(evidence.cumulativeInputMs.toFixed(3));
      stroke.anchorBefore = strokeBefore;
      evidence.strokes.push(stroke);
      assert.ok(stroke.trustedEventCounts?.touchstart > 0 && stroke.trustedEventCounts?.touchmove > 0
        && stroke.trustedEventCounts?.touchend > 0 && stroke.trustedEventCounts?.listScroll > 0,
      `${label}: each normalization step needs trusted touchstart/move/end and a real message-list scroll`);
      assert.ok(evidence.cumulativeInputMs <= evidence.inputBudgetMs,
        `${label}: trusted normalization exceeded the original five-second input budget`);

      const remainingSettleBudgetMs = evidence.settleBudgetMs - evidence.cumulativeSettleMs;
      assert.ok(remainingSettleBudgetMs > 0, `${label}: stable same-ID geometry exhausted the original five-second settle budget`);
      const settleStartedAt = performance.now();
      try {
        anchor = await waitForStableProductHistoryAnchor(page, strokeBefore.marker, `${label} settles after trusted stroke ${strokeNumber}`,
          Math.max(1, Math.ceil(remainingSettleBudgetMs)));
      } catch (error) {
        stroke.settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
        evidence.cumulativeSettleMs += stroke.settleDurationMs;
        stroke.cumulativeSettleMs = Number(evidence.cumulativeSettleMs.toFixed(3));
        stroke.anchorAfterFailure = error.historyAnchorEvidence ?? null;
        error.productStableReaderNormalizationEvidence = evidence;
        throw error;
      }
      stroke.settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
      evidence.cumulativeSettleMs += stroke.settleDurationMs;
      stroke.cumulativeSettleMs = Number(evidence.cumulativeSettleMs.toFixed(3));
      stroke.anchorAfter = anchor;
      stroke.sameFixtureMessageId = anchor.fixtureMessageId === evidence.fixtureMessageId;
      stroke.sameUniqueMarker = anchor.marker === evidence.marker;
      stroke.anchorTopProgressPx = Number((anchor.viewportOffsetPx - strokeBefore.viewportOffsetPx).toFixed(3));
      assert.equal(anchor.fixtureMessageId, evidence.fixtureMessageId, `${label}: trusted input must retain the original fixture message ID`);
      assert.equal(anchor.marker, evidence.marker, `${label}: trusted input must retain the original unique marker`);
      assert.ok(stroke.anchorTopProgressPx > 0.5,
        `${label}: trusted toward-latest stroke made no same-row top progress toward the unchanged 2px contract`);
      assert.ok(evidence.cumulativeSettleMs <= evidence.settleBudgetMs,
        `${label}: stable anchor checks exceeded the original five-second settle budget`);
    }
    assert.equal(anchor.fixtureMessageId, evidence.fixtureMessageId, `${label}: normalized row ID must be unchanged`);
    assert.equal(anchor.marker, evidence.marker, `${label}: normalized row marker must be unchanged`);
    assert.ok(anchor.viewportOffsetPx >= -2 && anchor.viewportOffsetPx <= anchor.listRect.height + 2,
      `${label}: same row must be clipped within the actual message-list viewport`);
    evidence.after = anchor;
    evidence.status = evidence.strokes.length ? "PASS_TRUSTED_INPUT_NORMALIZED" : "PASS_ALREADY_WITHIN_2PX";
    evidence.wallDurationMs = Number((performance.now() - startedAt).toFixed(3));
    return evidence;
  } catch (error) {
    evidence.status = "FAIL";
    evidence.after = anchor;
    evidence.wallDurationMs = Number((performance.now() - startedAt).toFixed(3));
    error.productStableReaderNormalizationEvidence = evidence;
    throw error;
  }
}

async function performProductTouchToOlderHistory(page, cdp) {
  const initial = await waitForStableProductHistoryWindow(page, "latest history window before trusted touch");
  assert.ok(Number.isSafeInteger(initial.minimumVisibleHistoryIndex), "latest viewport must show at least one actual visible HISTORY row");
  const targetIndex = Math.max(0, initial.minimumVisibleHistoryIndex - 1);
  assert.ok(targetIndex < initial.minimumVisibleHistoryIndex, "trusted touch target must be older than the currently visible window");
  const inputBudgetMs = 5_000;
  const settleBudgetMs = 5_000;
  const maximumStrokeCount = 8;
  const wallStartedAt = performance.now();
  let cumulativeInputMs = 0;
  let cumulativeSettleMs = 0;
  let settled = initial;
  let stopReason = "maximum-strokes-reached";
  const strokes = [];
  const strokeBudgetDecisions = [];
  const trustedTouchDurationMs = (stroke) => {
    const events = stroke.events ?? [];
    const touchStart = events.find((event) => event.type === "touchstart" && event.isTrusted && event.insideMessageList);
    const touchEnd = [...events].reverse().find((event) => event.type === "touchend" && event.isTrusted && event.insideMessageList);
    return Number.isFinite(touchStart?.pageTimeMs) && Number.isFinite(touchEnd?.pageTimeMs)
      ? Number(Math.max(0, touchEnd.pageTimeMs - touchStart.pageTimeMs).toFixed(3))
      : null;
  };
  const summarize = () => {
    const gestureEvents = strokes.flatMap((stroke) => stroke.events ?? []);
    const trustedTouchEvents = gestureEvents.filter((event) => ["touchstart", "touchmove", "touchend"].includes(event.type)
      && event.isTrusted && event.insideMessageList);
    const trustedScrolls = gestureEvents.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList);
    const gestureComplete = {
      touchEndSent: strokes.length > 0 && strokes.every((stroke) => stroke.touchEndSent === true),
      trustedTouchendObserved: strokes.length > 0 && strokes.every((stroke) => stroke.trustedEventCounts?.touchend > 0),
      trustedListScrollObserved: strokes.length > 0 && strokes.every((stroke) => stroke.trustedEventCounts?.listScroll > 0),
      stableHistoryWindowAfterTouchend: settled?.stableAfterTwoFrames === true,
      finalTwoFrameObservation: strokes.at(-1)?.afterTwoFramesViewport ?? null,
      settledHistoryObservation: settled,
      postGestureSettleMs: Number(cumulativeSettleMs.toFixed(3)),
    };
    return {
      initialViewport: initial,
      targetHistoryIndex: targetIndex,
      finalViewport: settled,
      inputDurationMs: Number(cumulativeInputMs.toFixed(3)),
      trustedTouchEventDurationMs: Number(strokes.reduce((total, stroke) => total + (stroke.trustedTouchDurationMs ?? 0), 0).toFixed(3)),
      inputDurationBoundary: "shared five-second budget charges host elapsed around each unchanged performProductTouchStroke call, including that helper's two-RAF observation; trusted touchstart-to-touchend event time is reported separately",
      inputBudgetMs,
      settleDurationMs: Number(cumulativeSettleMs.toFixed(3)),
      settleBudgetMs,
      wallDurationMs: Number((performance.now() - wallStartedAt).toFixed(3)),
      gestureCount: strokes.length,
      maximumStrokeCount,
      stopReason,
      strokeBudgetDecisions,
      gestureComplete,
      gestureEvidence: strokes,
      actualHistoryProgress: {
        initialMinimumVisibleHistoryIndex: initial.minimumVisibleHistoryIndex,
        finalMinimumVisibleHistoryIndex: settled?.minimumVisibleHistoryIndex ?? null,
        movedOlderByAtLeast: Number.isSafeInteger(settled?.minimumVisibleHistoryIndex)
          ? initial.minimumVisibleHistoryIndex - settled.minimumVisibleHistoryIndex
          : null,
        immediatelyOlderTargetHistoryIndex: targetIndex,
        immediatelyOlderTargetVisible: settled?.visibleHistoryIndexes?.includes(targetIndex) === true,
        trustedScrollEventCount: trustedScrolls.length,
        trustedTouchEventCount: trustedTouchEvents.length,
      },
    };
  };

  try {
    for (let strokeIndex = 0; strokeIndex < maximumStrokeCount; strokeIndex += 1) {
      if (settled.visibleHistoryIndexes.includes(targetIndex)) {
        stopReason = "immediately-older-row-visible-and-stable";
        break;
      }
      const remainingInputBudgetMs = inputBudgetMs - cumulativeInputMs;
      const estimatedNextStrokeMs = strokes.length === 0
        ? 0
        : Math.max(...strokes.map((stroke) => stroke.inputDurationMs ?? 0));
      const remainingSettleBudgetBeforeStrokeMs = settleBudgetMs - cumulativeSettleMs;
      const estimatedNextSettleMs = strokes.length === 0
        ? 0
        : Math.max(...strokes.map((stroke) => stroke.settleDurationMs ?? 0));
      const mayStartStroke = remainingInputBudgetMs > 0
        && remainingSettleBudgetBeforeStrokeMs > 0
        && (strokes.length === 0 || remainingInputBudgetMs > estimatedNextStrokeMs)
        && (strokes.length === 0 || remainingSettleBudgetBeforeStrokeMs > estimatedNextSettleMs);
      strokeBudgetDecisions.push({
        strokeNumber: strokeIndex + 1,
        remainingInputBudgetMs: Number(Math.max(0, remainingInputBudgetMs).toFixed(3)),
        estimatedNextStrokeMs: Number(estimatedNextStrokeMs.toFixed(3)),
        remainingSettleBudgetMs: Number(Math.max(0, remainingSettleBudgetBeforeStrokeMs).toFixed(3)),
        estimatedNextSettleMs: Number(estimatedNextSettleMs.toFixed(3)),
        mayStartStroke,
      });
      if (!mayStartStroke) {
        stopReason = remainingInputBudgetMs <= estimatedNextStrokeMs
          ? "input-budget-does-not-reserve-the-last-observed-stroke-duration"
          : "settle-budget-does-not-reserve-the-last-observed-settle-duration";
        break;
      }

      const strokeStartedAt = performance.now();
      let stroke;
      try {
        stroke = await performProductTouchStroke(page, cdp, `toward-old-history-touch-${strokeIndex + 1}`, {
          pointCount: 26,
          interMoveDelayMs: 12,
        });
      } catch (error) {
        stroke = error.productTouchStrokeEvidence ?? {
          label: `toward-old-history-touch-${strokeIndex + 1}`,
          status: "FAIL_WITHOUT_STROKE_EVIDENCE",
        };
        stroke.strokeNumber = strokeIndex + 1;
        stroke.inputDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
        stroke.wallDurationMs = stroke.inputDurationMs;
        stroke.trustedTouchDurationMs = trustedTouchDurationMs(stroke);
        cumulativeInputMs += stroke.inputDurationMs;
        stroke.cumulativeInputDurationMs = Number(cumulativeInputMs.toFixed(3));
        strokes.push(stroke);
        stopReason = "trusted-stroke-failed";
        error.productTouchEvidence = summarize();
        throw error;
      }
      stroke.strokeNumber = strokeIndex + 1;
      stroke.inputDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
      stroke.trustedTouchDurationMs = trustedTouchDurationMs(stroke);
      cumulativeInputMs += stroke.inputDurationMs;
      stroke.cumulativeInputDurationMs = Number(cumulativeInputMs.toFixed(3));
      stroke.previousSettledViewport = settled;

      const remainingSettleBudgetMs = settleBudgetMs - cumulativeSettleMs;
      if (remainingSettleBudgetMs <= 0) {
        stroke.wallDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
        strokes.push(stroke);
        stopReason = "post-gesture-settle-budget-exhausted";
        throw new Error("trusted touch sequence exhausted the shared five-second post-gesture settle budget");
      }
      const settleStartedAt = performance.now();
      try {
        settled = await waitForStableProductHistoryWindow(
          page,
          `trusted touch ${strokeIndex + 1} settles on older visible history`,
          Math.max(1, Math.ceil(remainingSettleBudgetMs)),
        );
      } catch (error) {
        stroke.settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
        cumulativeSettleMs += stroke.settleDurationMs;
        stroke.cumulativeSettleDurationMs = Number(cumulativeSettleMs.toFixed(3));
        stroke.wallDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
        stroke.settleFailure = error.productHistoryViewportEvidence ?? null;
        strokes.push(stroke);
        stopReason = "history-window-did-not-settle-within-shared-budget";
        error.productTouchEvidence = summarize();
        throw error;
      }
      stroke.settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
      cumulativeSettleMs += stroke.settleDurationMs;
      stroke.cumulativeSettleDurationMs = Number(cumulativeSettleMs.toFixed(3));
      stroke.wallDurationMs = Number((performance.now() - strokeStartedAt).toFixed(3));
      stroke.settledViewport = settled;
      const previousViewport = stroke.previousSettledViewport;
      const rawScrollTopDelta = settled.scrollHost.scrollTop - previousViewport.scrollHost.scrollTop;
      const olderIndexProgress = settled.minimumVisibleHistoryIndex < previousViewport.minimumVisibleHistoryIndex;
      stroke.progress = {
        rawScrollTopDelta: Number(rawScrollTopDelta.toFixed(3)),
        rawScrollTopIsGeometryOnly: true,
        visibleHistoryIndexBefore: previousViewport.minimumVisibleHistoryIndex,
        visibleHistoryIndexAfter: settled.minimumVisibleHistoryIndex,
        olderIndexProgress,
        progressedTowardOlderHistory: rawScrollTopDelta > 0.5 || olderIndexProgress,
      };
      strokes.push(stroke);

      assert.ok(cumulativeInputMs <= inputBudgetMs,
        "trusted touch strokes must stay within the original shared five-second input budget");
      assert.ok(cumulativeSettleMs <= settleBudgetMs,
        "trusted touch strokes must stay within the original shared five-second post-gesture settle budget");
      assert.ok(stroke.trustedEventCounts?.listScroll > 0,
        `trusted touch stroke ${strokeIndex + 1} must cause a real message-list scroll event`);
      assert.ok(stroke.progress.progressedTowardOlderHistory,
        `trusted touch stroke ${strokeIndex + 1} made no measurable progress toward older history`);
      if (settled.visibleHistoryIndexes.includes(targetIndex)) {
        stopReason = "immediately-older-row-visible-and-stable";
        break;
      }
    }
  } catch (error) {
    if (!error.productTouchEvidence) error.productTouchEvidence = summarize();
    throw error;
  }

  const evidence = summarize();
  try {
    assert.ok(evidence.inputDurationMs <= inputBudgetMs, "trusted touch input must stay within the existing shared five-second gesture budget");
    assert.ok(evidence.settleDurationMs <= settleBudgetMs, "trusted touch settling must stay within the existing shared five-second post-gesture budget");
    assert.ok(evidence.gestureCount > 0, "trusted touch must include at least one completed stroke");
    assert.ok(evidence.gestureComplete.touchEndSent && evidence.gestureComplete.trustedTouchendObserved && evidence.gestureComplete.stableHistoryWindowAfterTouchend,
      "trusted touch must deliver touchend and reach a stable history window afterward");
    assert.equal(evidence.gestureComplete.trustedListScrollObserved, true, "every settled trusted stroke must cause a real browser scroll event inside the message-list");
    assert.ok(evidence.finalViewport.minimumVisibleHistoryIndex <= targetIndex,
      `trusted touch must expose at least one older rendered history row; target<=${targetIndex}, actual=${evidence.finalViewport.minimumVisibleHistoryIndex}`);
    assert.ok(evidence.finalViewport.visibleHistoryIndexes.includes(targetIndex),
      `trusted touch must preserve the immediately older consecutive history row ${targetIndex} in the viewport; visible=${evidence.finalViewport.visibleHistoryIndexes.join(",")}`);
    assert.equal(evidence.finalViewport.jumpToLatestVisible, true, "moving away from latest must expose the real Jump-to-latest control");
    assert.ok(evidence.finalViewport.visibleRows.every((row) => Number.isSafeInteger(row.historyIndex)), "visible history rows must retain their fixture IDs and order markers");
  } catch (error) {
    error.productTouchEvidence = evidence;
    throw error;
  }
  return {
    ...evidence,
    beforeViewport: initial,
    afterViewport: evidence.finalViewport,
    pointCountPerStroke: 28,
    inputTraceDropped: (await readTranscriptFollowGestureInputTrace(page))?.dropped ?? null,
  };
}

async function performProductWheelToOlderHistoryControl(page) {
  const initial = await waitForStableProductHistoryWindow(page, "history window before trusted wheel");
  const bounds = await page.getByTestId("message-list").boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, "trusted wheel must target the visible message-list");
  const x = Math.round(bounds.x + Math.min(28, bounds.width / 4));
  const y = Math.round(bounds.y + bounds.height / 2);
  const hitTest = await page.evaluate(({ pointX, pointY }) => {
    const root = document.querySelector('[data-testid="message-list"]');
    const target = document.elementFromPoint(pointX, pointY);
    return { insideMessageList: Boolean(root && target && root.contains(target)), targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null };
  }, { pointX: x, pointY: y });
  assert.equal(hitTest.insideMessageList, true, "trusted wheel pointer must be over the actual message-list");
  const traceBefore = await readTranscriptFollowGestureInputTrace(page);
  const eventStartOrdinal = traceBefore?.latestOrdinal ?? 0;
  await page.mouse.move(x, y);
  const maximumWheelEvents = 32;
  const inputBudgetMs = 5_000;
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  assert.ok(Number.isFinite(devicePixelRatio) && devicePixelRatio >= 1, "trusted wheel calibration requires a real positive browser devicePixelRatio");
  assert.equal(initial.olderHistoryControl.present, true, "reserved older history must expose the actual Load Earlier Messages control in the DOM");
  assert.ok(initial.olderHistoryControl.rect, "the real older-page control must have measurable geometry before trusted wheel input");
  const controlDistanceToViewport = (viewport) => {
    const list = viewport.listRect;
    const controlRect = viewport.olderHistoryControl.rect;
    if (!list || !controlRect) return null;
    if (controlRect.bottom <= list.top) return Math.max(0, list.top - controlRect.bottom);
    if (controlRect.top >= list.bottom) return Math.max(0, controlRect.top - list.bottom);
    return 0;
  };
  const scrollRange = (viewport) => Math.max(0, viewport.scrollHost.scrollHeight - viewport.scrollHost.clientHeight);
  const initialControlGapPx = controlDistanceToViewport(initial);
  assert.ok(Number.isFinite(initialControlGapPx), "the real older-page control and list must provide finite target geometry");
  const initialScrollRangePx = scrollRange(initial);
  const initialTravelEstimateCssPx = Math.max(initialControlGapPx, initialScrollRangePx);
  let estimatedCssPixelsPerWheelDelta = 1 / devicePixelRatio;
  let wheelEventCount = 0;
  let currentViewport = initial;
  let control = currentViewport.olderHistoryControl;
  let batchRequestedMagnitude = 0;
  let batchInitialGapPx = initialControlGapPx;
  const requestedDeltaYs = [];
  const wheelCalibrationBatches = [];
  const inputStartedAt = performance.now();
  let lastDispatchFinishedAt = inputStartedAt;
  for (let index = 0; index < maximumWheelEvents && !control.visibleWithinMessageList
    && performance.now() - inputStartedAt <= inputBudgetMs; index += 1) {
    const remainingEventsIncludingThis = maximumWheelEvents - wheelEventCount;
    const measuredGapPx = controlDistanceToViewport(currentViewport);
    const remainingDistancePx = Number.isFinite(measuredGapPx) ? measuredGapPx : initialTravelEstimateCssPx;
    const useInitialScrollRangeEstimate = wheelEventCount === 0;
    const requestedMagnitude = Math.max(1, Math.ceil(
      ((useInitialScrollRangeEstimate ? initialTravelEstimateCssPx : remainingDistancePx) + 1)
      / Math.max(1, remainingEventsIncludingThis)
      / Math.max(0.0001, estimatedCssPixelsPerWheelDelta)
      * 1.12,
    ));
    await page.mouse.wheel(0, -requestedMagnitude);
    lastDispatchFinishedAt = performance.now();
    requestedDeltaYs.push(-requestedMagnitude);
    if (wheelEventCount === 0) batchInitialGapPx = remainingDistancePx;
    batchRequestedMagnitude += requestedMagnitude;
    wheelEventCount += 1;
    if (wheelEventCount % 4 === 0 || wheelEventCount === maximumWheelEvents) {
      await waitForTwoFrames(page);
      const previousViewport = currentViewport;
      currentViewport = await readProductHistoryViewport(page);
      control = currentViewport.olderHistoryControl;
      const beforeGapPx = controlDistanceToViewport(previousViewport);
      const afterGapPx = controlDistanceToViewport(currentViewport);
      const geometryProgressPx = Number.isFinite(beforeGapPx) && Number.isFinite(afterGapPx)
        ? beforeGapPx - afterGapPx
        : null;
      const rawScrollOffsetChangePx = Math.abs(currentViewport.scrollHost.scrollTop - previousViewport.scrollHost.scrollTop);
      const measuredProgressPx = geometryProgressPx !== null && geometryProgressPx > 0.5
        ? geometryProgressPx
        : rawScrollOffsetChangePx;
      const measuredCssPixelsPerWheelDelta = batchRequestedMagnitude > 0
        ? measuredProgressPx / batchRequestedMagnitude
        : null;
      wheelCalibrationBatches.push({
        eventCount: wheelEventCount,
        requestedMagnitude: batchRequestedMagnitude,
        beforeControlGapPx: batchInitialGapPx,
        afterControlGapPx: afterGapPx,
        geometryProgressTowardControlPx: geometryProgressPx,
        rawScrollOffsetChangePx,
        measuredProgressPx,
        measuredCssPixelsPerWheelDelta,
        scrollTopBefore: previousViewport.scrollHost.scrollTop,
        scrollTopAfter: currentViewport.scrollHost.scrollTop,
        scrollHeight: currentViewport.scrollHost.scrollHeight,
        clientHeight: currentViewport.scrollHost.clientHeight,
        controlVisible: control.visibleWithinMessageList,
      });
      if (measuredCssPixelsPerWheelDelta > 0) estimatedCssPixelsPerWheelDelta = measuredCssPixelsPerWheelDelta;
      batchRequestedMagnitude = 0;
      batchInitialGapPx = afterGapPx;
    }
  }
  const inputFinishedAt = lastDispatchFinishedAt;
  const inputDurationMs = Number((inputFinishedAt - inputStartedAt).toFixed(3));
  const postInputViewport = currentViewport;
  const settleStartedAt = inputFinishedAt;
  const settled = await waitForStableProductHistoryWindow(page, "trusted wheel settles at older-history page control", 5_000);
  const settleDurationMs = Number((performance.now() - settleStartedAt).toFixed(3));
  const traceAfter = await readTranscriptFollowGestureInputTrace(page);
  const events = transcriptInputEventsSince(traceAfter, eventStartOrdinal);
  const wheels = events.filter((event) => event.type === "wheel");
  const trustedOlderWheels = wheels.filter((event) => event.isTrusted && event.insideMessageList && event.deltaY < 0);
  const trustedScrolls = events.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList);
  const evidence = {
    initialViewport: initial,
    postInputViewport,
    finalViewport: settled,
    hitTest,
    devicePixelRatio,
    initialControlGapPx,
    initialScrollRangePx,
    initialTravelEstimateCssPx,
    requestedDeltaYs,
    observedTrustedDeltaY: trustedOlderWheels.map((event) => event.deltaY),
    wheelEventCount,
    inputBudgetMs,
    inputStartedAtMonotonicMs: Number(inputStartedAt.toFixed(3)),
    lastDispatchFinishedAtMonotonicMs: Number(inputFinishedAt.toFixed(3)),
    inputDurationMs,
    settleDurationMs,
    wheelCalibrationBatches,
    trustedWheelCount: trustedOlderWheels.length,
    trustedScrollEventCount: trustedScrolls.length,
    olderControl: settled.olderHistoryControl,
    inputTraceDropped: traceAfter?.dropped ?? null,
    noBottomGapGate: true,
  };
  try {
    assert.ok(wheelEventCount > 0 && trustedOlderWheels.length > 0, "older paging must be reached using real trusted negative-delta wheel events, not DOM/API scrolling");
    assert.ok(trustedScrolls.length > 0, "trusted wheel must produce actual browser scroll events inside the message-list");
    assert.ok(evidence.inputDurationMs <= inputBudgetMs, "trusted wheel sequence must stay within the existing bounded five-second input budget");
    assert.equal(settled.olderHistoryControl.visibleWithinMessageList, true, "the actual Load Earlier Messages control must intersect the message-list viewport after wheel navigation");
    assert.equal(settled.olderHistoryControl.disabled, false, "older history must still be available at the visible page boundary");
    assert.equal(settled.jumpToLatestVisible, true, "the reader must remain paused while navigating toward the older page");
  } catch (error) {
    error.productWheelEvidence = evidence;
    throw error;
  }
  return evidence;
}

function transcriptInputEventsSince(trace, ordinal) {
  return Array.isArray(trace?.events) ? trace.events.filter((event) => event.ordinal > ordinal) : [];
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
