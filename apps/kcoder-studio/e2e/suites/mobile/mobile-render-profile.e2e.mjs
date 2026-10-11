import { createMobileRenderProfileHelpers } from "../../harness/mobile-render-profile-helpers.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../../harness/chromium.mjs";
import { assertPathWithinApprovedRoots, readVerifiedMobileExportFile, verifyMobileExportManifestEnvelope } from "../../harness/mobile-web-export-input.mjs";
import { makeCoreAttributionRecord, mapGeneratedProfilePosition, recordScriptUrlIdentity, resolveScriptMapBinding, validateCoreAttributionMode, verifySourceMapBundleEvidence } from "../../harness/render-profile-attribution-contract.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { measuredTranscriptLatestDistance } from "../../harness/transcript-logical-distance.mjs";

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
const coreAttributionOnlyValue = optionValue("--core-attribution-only", "false");
assert.ok(coreAttributionOnlyValue === "true" || coreAttributionOnlyValue === "false", "--core-attribution-only must be true or false");
const coreAttributionOnly = coreAttributionOnlyValue === "true";
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

await runE2E(import.meta.url, {
  testId: tailWindowDiagnostic
    ? "mobile-render-profile-tail-window-product-regression"
    : coreAttributionOnly ? "mobile-render-profile-core-attribution-diagnostic"
      : followGestureRegression ? "mobile-render-profile-follow-gesture-regression" : "mobile-render-profile-high-history",
  tier: "manual-live",
  modelPolicy: coreAttributionOnly
    ? "isolated Mobile Web CDP V8 profile of the actual core active-Markdown burst with a source-map-enabled, full-bundle-pinned after/500 fixture; DIAGNOSTIC_ONLY, excluded from performance distributions, no provider/model/Rust turn, and native remains unverified"
    : tailWindowProductRegression
    ? `isolated Mobile Web product UI diagnostic (${tailWindowProductStage} stage) in Chromium with heterogeneous 500-message synthetic history and ordered app-facing WebSocketMock notifications; stable-reader uses trusted input to normalize its same-ID anchor before code/append checks; race uses preplanned touch and touchstart-time geometry; no provider, model, Rust app-server turn, Runtime probe, native validation, or performance sample`
    : tailWindowPaginationRegression
      ? "isolated Mobile Web pagination UI diagnostic in Chromium with synthetic history and trusted wheel/click against the real fixture route; no provider, model, Rust app-server turn, Runtime probe, native validation, or performance sample"
    : followGestureRegression
    ? "isolated Mobile Web UI follow-state diagnostic in Chromium with synthetic history and ordered app-facing WebSocketMock notifications plus trusted browser touch input; no provider, model, Runtime probe, or Rust app-server turn; not a performance sample or native validation"
    : "real Mobile Web UI in isolated Chromium with synthetic history pages and synthetic completed-task notifications; no provider or model calls; optional one-seed runtime-consumer diagnostic uses a private bounded read-only TaskRuntime projection and is not a performance sample or real app-server turn",
  retainSuccessLogs: true,
}, async (context) => {
  const prevalidatedSources = coreAttributionOnly
    ? await Promise.all(sourceNames.map((sourceName) => readSourceSpec(sourceName)))
    : null;
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
  const coreAttributionCases = [];
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
    const source = prevalidatedSources?.find((candidate) => candidate.name === sourceName)
      ?? await readSourceSpec(sourceName);
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

async function readSourceSpec(name) {
  const prefix = `--${name}-`;
  const manifestArgument = requiredOption(`${prefix}manifest`);
  const sourceProvenanceArgument = requiredOption(`${prefix}source-provenance`);
  const bundleRootArgument = requiredOption(`${prefix}bundle-root`);
  const manifestPath = resolve(manifestArgument);
  const sourceProvenancePath = resolve(sourceProvenanceArgument);
  const bundleRoot = resolve(bundleRootArgument);
  const expectedManifestSha256 = requiredDigest(`${prefix}export-manifest-sha256`);
  const expectedSourceProvenanceSha256 = requiredDigest(`${prefix}source-provenance-sha256`);
  const sourceTreeSha256 = requiredDigest(`${prefix}source-tree-sha256`);
  const sharedSourceInputSha256 = requiredDigest(`${prefix}shared-input-sha256`);
  const sourceComplementArgument = optionValue(`${prefix}source-complement-sha256`, "");
  if (sourceComplementArgument) assert.match(sourceComplementArgument, /^[a-f0-9]{64}$/, `${name} source-complement-sha256 must be a lowercase SHA-256 digest`);
  const sourceFreezeEvidenceDigest = requiredDigest(`${prefix}source-freeze-digest`);
  const dependencySourceTreeSha256 = requiredDigest(`${prefix}dependency-source-tree-sha256`);
  assert.equal(manifestPath, manifestArgument, `${name} manifest path must be normalized and absolute`);
  assert.equal(sourceProvenancePath, sourceProvenanceArgument, `${name} source provenance path must be normalized and absolute`);
  assert.equal(bundleRoot, bundleRootArgument, `${name} bundle path must be normalized and absolute`);
  const artifactBoundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
  const privateBoundary = resolve(repoRoot, "target/private-phone-ux-implementation");
  const artifactsDirectories = [];
  for (const candidatePath of [manifestPath, sourceProvenancePath]) {
    const candidateDirectory = dirname(candidatePath);
    const relativeToE2e = relative(artifactBoundary, candidateDirectory);
    const isRetainedE2ePath = relativeToE2e === "" || (relativeToE2e !== ".." && !relativeToE2e.startsWith(`..${sep}`));
    if (basename(candidateDirectory) === "artifacts" && isRetainedE2ePath) {
      await assertPathWithinApprovedRoots(candidateDirectory, [artifactBoundary], `${name} retained artifacts directory`);
      artifactsDirectories.push(candidateDirectory);
    }
  }
  const bundleArtifactsDirectory = dirname(bundleRoot);
  const relativeBundleArtifactsToE2e = relative(artifactBoundary, bundleArtifactsDirectory);
  const bundleIsInRetainedArtifacts = basename(bundleArtifactsDirectory) === "artifacts"
    && (relativeBundleArtifactsToE2e === "" || (relativeBundleArtifactsToE2e !== ".." && !relativeBundleArtifactsToE2e.startsWith(`..${sep}`)));
  if (bundleIsInRetainedArtifacts) {
    await assertPathWithinApprovedRoots(bundleArtifactsDirectory, [artifactBoundary], `${name} retained bundle artifacts directory`);
    artifactsDirectories.push(bundleArtifactsDirectory);
  }
  const approvedEvidenceRoots = [...new Set([privateBoundary, ...artifactsDirectories])];
  await assertPathWithinApprovedRoots(manifestPath, approvedEvidenceRoots, `${name} export manifest`);
  await assertPathWithinApprovedRoots(sourceProvenancePath, approvedEvidenceRoots, `${name} source provenance`);
  await assertPathWithinApprovedRoots(bundleRoot, approvedEvidenceRoots, `${name} public bundle`);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceProvenanceBytes = await readFile(sourceProvenancePath);
  const sourceProvenanceSha256 = sha256(sourceProvenanceBytes);
  assert.equal(sourceProvenanceSha256, expectedSourceProvenanceSha256, `${name} source provenance changed after its digest was pinned`);
  const sourceProvenance = JSON.parse(sourceProvenanceBytes.toString("utf8"));
  const relocationSidecarPath = resolve(dirname(sourceProvenancePath), "relocation-sidecar.json");
  const relocationSidecarArgument = optionValue(`${prefix}relocation-sidecar-sha256`, "");
  let relocationSidecarInfo;
  try {
    relocationSidecarInfo = await lstat(relocationSidecarPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let relocationSidecar = null;
  if (relocationSidecarArgument) {
    assert.match(relocationSidecarArgument, /^[a-f0-9]{64}$/, `${name} relocation sidecar digest must be a lowercase SHA-256 digest`);
    assert.ok(relocationSidecarInfo?.isFile() && !relocationSidecarInfo.isSymbolicLink(), `${name} pinned relocation sidecar must be a regular file`);
    await assertPathWithinApprovedRoots(relocationSidecarPath, approvedEvidenceRoots, `${name} relocation sidecar`);
    const relocationSidecarBytes = await readFile(relocationSidecarPath);
    const observedRelocationSidecarSha256 = sha256(relocationSidecarBytes);
    assert.equal(observedRelocationSidecarSha256, relocationSidecarArgument, `${name} relocation sidecar changed after its digest was pinned`);
    relocationSidecar = JSON.parse(relocationSidecarBytes.toString("utf8"));
    assert.equal(relocationSidecar.status, "complete", `${name} relocation sidecar must be complete`);
    assert.equal(relocationSidecar.kind, "retention-safe-relocation-of-before-render-export-inputs", `${name} relocation sidecar kind is unsupported`);
    assert.equal(relocationSidecar.pinnedSourceProvenancePath, sourceProvenancePath, `${name} relocation sidecar must pin the supplied provenance path`);
    assert.equal(relocationSidecar.originalSourceProvenanceSha256, sourceProvenanceSha256, `${name} relocated source provenance bytes differ from the original`);
    assert.equal(relocationSidecar.pinnedExportManifestPath, manifestPath, `${name} relocation sidecar must pin the supplied manifest path`);
    assert.equal(relocationSidecar.originalExportManifestSha256, expectedManifestSha256, `${name} relocated export manifest bytes differ from the original`);
    assert.equal(relocationSidecar.pinnedBundleRoot, bundleRoot, `${name} relocation sidecar must pin the supplied bundle path`);
    assert.equal(relocationSidecar.bundleSha256, manifest.bundleSha256, `${name} relocation bundle digest differs from the export manifest`);
    assert.equal(relocationSidecar.bundleFileCount, 37, `${name} relocation must cover all 37 exported files`);
    assert.equal(relocationSidecar.sourceTreeSha256, sourceProvenance.sourceTreeSha256, `${name} relocation source tree digest differs from provenance`);
    assert.equal(relocationSidecar.sourceFreezeEvidenceDigest, sourceProvenance.frozenSourceManifestSha256, `${name} relocation freeze digest differs from provenance`);
    assert.equal(relocationSidecar.dependencySourceTreeSha256, sourceProvenance.dependencySourceTreeSha256, `${name} relocation dependency digest differs from provenance`);
    assert.equal(relocationSidecar.resolvedOriginalManifestReference, relocationSidecar.originalExportManifestPath, `${name} relocation manifest reference mapping is inconsistent`);
    assert.equal(
      relocationSidecar.resolvedOriginalProvenanceBundle,
      resolve(dirname(dirname(relocationSidecar.originalSourceProvenancePath)), sourceProvenance.exportedWebArtifact),
      `${name} relocation bundle reference mapping is inconsistent`,
    );
    const preservationInventoryPath = resolve(relocationSidecar.preservationInventoryPath);
    assert.equal(preservationInventoryPath, relocationSidecar.preservationInventoryPath, `${name} preservation inventory path must be normalized and absolute`);
    await assertPathWithinApprovedRoots(preservationInventoryPath, [privateBoundary], `${name} preservation inventory`);
    const preservationInventoryBytes = await readFile(preservationInventoryPath);
    assert.equal(sha256(preservationInventoryBytes), relocationSidecar.preservationInventorySha256, `${name} preservation inventory changed after relocation`);
    const preservationInventory = JSON.parse(preservationInventoryBytes.toString("utf8"));
    for (const entry of manifest.bundleFiles) {
      assert.equal(preservationInventory[`artifacts/mobile-web-export/${entry.path}`], entry.sha256, `${name} preservation inventory does not pin ${entry.path}`);
    }
    relocationSidecar.sha256 = observedRelocationSidecarSha256;
  } else {
    assert.ok(!relocationSidecarInfo, `${name} relocation sidecar exists but no explicit digest pin was provided`);
  }
  const inputRoots = manifest.inputRoots ?? [];
  const mobileRoot = inputRoots.find((root) => root.name === "mobile");
  const complementRoot = inputRoots.find((root) => root.name === "studio-shared");
  const dependency = manifest.dependencyProvenance ?? {};
  const usesCandidateExportProvenance = Array.isArray(sourceProvenance.sourceRoots)
    && Number.isSafeInteger(sourceProvenance.candidateFiles)
    && typeof sourceProvenance.candidateDigest === "string";
  const sourceFreezeEvidenceKind = typeof sourceProvenance.frozenSourceManifestSha256 === "string"
    ? "frozen-source-manifest-sha256"
    : usesCandidateExportProvenance ? "candidate-source-manifest" : null;
  assert.ok(sourceFreezeEvidenceKind, `${name} source provenance must pin a recognized frozen-source digest`);
  const provenanceFreezeDigest = sourceFreezeEvidenceKind === "frozen-source-manifest-sha256"
    ? sourceProvenance.frozenSourceManifestSha256
    : sourceProvenance.candidateDigest;
  assert.equal(provenanceFreezeDigest, sourceFreezeEvidenceDigest, `${name} source freeze evidence digest differs from its pinned provenance`);
  const frozenSourceEntryCount = sourceFreezeEvidenceKind === "frozen-source-manifest-sha256"
    ? sourceProvenance.frozenSourceEntryCount
    : sourceProvenance.candidateFiles;
  const provenanceDependencyDigest = sourceProvenance.dependencySourceTreeSha256
    ?? sourceProvenance.dependencyInput?.sourceTreeSha256;
  assert.equal(provenanceDependencyDigest, dependencySourceTreeSha256, `${name} source provenance dependency digest differs from its pinned input`);
  const sourceComplementSha256 = sourceProvenance.sourceComplementSha256 ?? null;
  const sourceCompleteness = sourceProvenance.sourceCompleteness ?? (usesCandidateExportProvenance ? {
    manifestFileCount: sourceProvenance.candidateFiles,
    workspaceComplementCopied: false,
    candidateMobileManifestFiles: sourceProvenance.candidateMobileManifestFiles,
    candidateSharedManifestFiles: sourceProvenance.candidateSharedManifestFiles,
    sourceRootsIndividuallyPinned: true,
  } : {});
  const complementarySourceDescription = optionValue(`${prefix}complement-description`, "")
    || sourceProvenance.complementarySourceDescription
    || sourceCompleteness.complementSource
    || sourceProvenance.complementChangeConfirmation
    || (usesCandidateExportProvenance ? "Mobile and studio-shared source roots are independently SHA-256 pinned in the export manifest" : "");
  assert.ok(complementarySourceDescription, `${name} complementary source description is required`);

  assert.equal(manifest.status, "complete", `${name} retained Mobile Web export must be complete`);
  assert.equal(manifest.sourceTreeSha256, sourceTreeSha256, `${name} export must match the pinned frozen source-tree digest`);
  assert.equal(manifest.sourceUnchanged, true, `${name} export source must remain unchanged during build`);
  assert.equal(manifest.snapshotUnchangedDuringExport, true, `${name} frozen snapshot must remain unchanged during export`);
  assert.ok(mobileRoot?.sha256 && complementRoot?.sha256, `${name} export must include both Mobile and shared source roots`);
  assert.equal(complementRoot.sha256, sharedSourceInputSha256, `${name} shared source-root digest must match the pinned complement input`);
  assert.equal(dependency.sourceTreeSha256Before, dependencySourceTreeSha256, `${name} dependency source digest must match the pinned frozen dependency tree`);
  assert.equal(dependency.sourceTreeSha256After, dependencySourceTreeSha256, `${name} dependency tree must remain unchanged during export`);
  assert.equal(dependency.sourceUnchanged, true, `${name} dependency tree must remain unchanged during export`);
  verifyMobileExportManifestEnvelope(manifest, manifestBytes, expectedManifestSha256, name);
  if (coreAttributionOnly) verifySourceMapBundleEvidence(manifest.sourceMapEvidence, manifest);
  assert.equal(sourceProvenance.sourceTreeSha256, sourceTreeSha256, `${name} source provenance must match the frozen Mobile Web source tree`);
  if (sourceFreezeEvidenceKind === "frozen-source-manifest-sha256") {
    assert.equal(sourceProvenance.frozenSourceEntryCount, sourceProvenance.sourceCompleteness?.manifestFileCount, `${name} source provenance must report a freeze entry count consistent with its completeness ledger`);
  } else {
    assert.equal(sourceProvenance.status, "complete", `${name} candidate export provenance must be complete`);
    assert.equal(sourceProvenance.snapshotCopyMatchesSource, true, `${name} candidate export must record a byte-matching frozen copy`);
    assert.equal(sourceProvenance.snapshotUnchangedDuringExport, true, `${name} candidate snapshot must remain unchanged during export`);
  }
  const provenanceManifestReference = sourceProvenance.bundleManifest ?? sourceProvenance.exportManifestPath ?? sourceProvenance.manifestPath;
  if (typeof provenanceManifestReference === "string") {
    if (relocationSidecar) {
      const originalProvenanceBase = dirname(dirname(relocationSidecar.originalSourceProvenancePath));
      const originalReferencedManifestPath = resolveProvenanceReference(provenanceManifestReference, originalProvenanceBase);
      assert.equal(originalReferencedManifestPath, relocationSidecar.resolvedOriginalManifestReference, `${name} relocation must preserve the original manifest reference`);
      assert.equal(originalReferencedManifestPath, relocationSidecar.originalExportManifestPath, `${name} original manifest reference differs from relocation sidecar`);
      assert.equal(relocationSidecar.pinnedExportManifestPath, manifestPath, `${name} relocation must map to the explicitly pinned export manifest`);
    } else {
      const sourceProvenanceDirectory = dirname(sourceProvenancePath);
      const provenanceBase = basename(sourceProvenanceDirectory) === "artifacts" ? dirname(sourceProvenanceDirectory) : sourceProvenanceDirectory;
      const referencedManifestPath = resolveProvenanceReference(provenanceManifestReference, provenanceBase);
      assert.equal(referencedManifestPath, manifestPath, `${name} source provenance must name the exact builder manifest`);
    }
  }
  if (relocationSidecar && typeof sourceProvenance.exportedWebArtifact === "string") {
    const originalProvenanceBase = dirname(dirname(relocationSidecar.originalSourceProvenancePath));
    assert.equal(
      resolveProvenanceReference(sourceProvenance.exportedWebArtifact, originalProvenanceBase),
      relocationSidecar.resolvedOriginalProvenanceBundle,
      `${name} relocation must preserve the original provenance bundle reference`,
    );
    assert.equal(relocationSidecar.pinnedBundleRoot, bundleRoot, `${name} relocation must map to the explicitly pinned bundle root`);
  }
  for (const provenanceBundlePath of [sourceProvenance.bundlePath, sourceProvenance.bundleRoot]) {
    if (typeof provenanceBundlePath === "string") {
      const resolvedProvenanceBundlePath = provenanceBundlePath.startsWith("/") ? resolve(provenanceBundlePath) : resolve(repoRoot, provenanceBundlePath);
      assert.equal(resolvedProvenanceBundlePath, bundleRoot, `${name} source provenance bundle path must match the explicitly pinned bundle root`);
    }
  }
  assert.equal(sourceProvenance.bundleSha256, manifest.bundleSha256, `${name} source provenance bundle digest must match the builder manifest`);
  if (usesCandidateExportProvenance) {
    for (const root of sourceProvenance.sourceRoots) {
      const manifestRoot = inputRoots.find((item) => item.name === root.name);
      assert.ok(manifestRoot, `${name} candidate source root ${root.name} must appear in the export manifest`);
      assert.equal(root.sha256, manifestRoot.sha256, `${name} candidate source root ${root.name} digest must match the builder manifest`);
      assert.equal(root.fileCount, manifestRoot.fileCount, `${name} candidate source root ${root.name} file count must match the builder manifest`);
    }
    assert.ok(sourceProvenance.candidateManifestPath, `${name} candidate source manifest reference is required`);
    assert.ok(sourceProvenance.candidateFiles > 0, `${name} candidate source file count must be positive`);
  }
  if (sourceComplementArgument) {
    assert.equal(sourceComplementSha256, sourceComplementArgument, `${name} separate complement digest must match its retained source provenance`);
    assert.equal(sourceProvenance.sourceComplementStableDuringCopy, true, `${name} copied complement must remain stable while the frozen source is prepared`);
    assert.equal(sourceCompleteness.workspaceComplementCopied, true, `${name} source provenance must record its workspace complement copy`);
  } else {
    assert.equal(sourceComplementSha256, null, `${name} source provenance must not claim a separate workspace complement digest`);
    if (sourceFreezeEvidenceKind === "frozen-source-manifest-sha256") {
      assert.equal(sourceProvenance.sourceComplementStableDuringCopy, null, `${name} source provenance must not claim a separate workspace complement copy`);
      assert.equal(sourceCompleteness.workspaceComplementCopied, false, `${name} source provenance must record use of the exact frozen Mobile/shared snapshot`);
      assert.equal(sourceCompleteness.manifestFileCount, frozenSourceEntryCount, `${name} exact-frozen source must cover every entry listed by its freeze manifest`);
    } else {
      assert.equal(complementRoot.sha256, sharedSourceInputSha256, `${name} shared input must be pinned as an export root when there is no separate complement copy`);
    }
  }
  return {
    name,
    manifestPath,
    sourceProvenancePath,
    sourceProvenanceSha256: sha256(sourceProvenanceBytes),
    relocationSidecarSha256: relocationSidecar?.sha256 ?? null,
    bundleRoot,
    sourceTreeSha256,
    sourceComplementSha256,
    sharedSourceInputSha256,
    mobileExportInputFileCount: mobileRoot.fileCount,
    sharedExportInputFileCount: complementRoot.fileCount,
    frozenSourceEntryCount,
    sourceCompleteness,
    sourceFreezeEvidenceDigest,
    sourceFreezeEvidenceKind,
    dependencySourceTreeSha256,
    complementarySourceDescription,
    mobileSourceComponentSha256: mobileRoot?.sha256 ?? null,
    exportManifestSha256: sha256(manifestBytes),
    overlaySha256: sourceProvenance.frozenSourceOverlaySha256 ?? null,
    sourceComplementMode: sourceComplementArgument
      ? "separate-workspace-complement-copied-and-digest-pinned"
      : sourceFreezeEvidenceKind === "candidate-source-manifest"
        ? "mobile-and-shared-roots-individually-digest-pinned-by-the-export-manifest"
        : "mobile-and-shared-roots-covered-by-the-exact-frozen-source-manifest",
    builderManifest: manifest,
  };
}







async function copyAndVerifyRetainedBuilderExport(context, source) {
  const manifestBytesBefore = await readFile(source.manifestPath);
  const manifest = JSON.parse(manifestBytesBefore.toString("utf8"));
  verifyMobileExportManifestEnvelope(manifest, manifestBytesBefore, source.exportManifestSha256, source.name);
  assert.equal(manifest.bundleSha256, source.builderManifest.bundleSha256, `${source.name} bundle digest changed after provenance was read`);

  const sourceRootInfo = await lstat(source.bundleRoot);
  assert.ok(sourceRootInfo.isDirectory() && !sourceRootInfo.isSymbolicLink(), `${source.name} source bundle root must be a real directory`);
  const ownedRoot = context.pathInState(`render-profile-${source.name}-bundle`);
  await mkdir(ownedRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory(`copied retained Mobile Web export ${source.name}`, ownedRoot);
  let totalBytes = 0;
  const expectedFiles = new Map();
  try {
    for (const entry of manifest.bundleFiles) {
      assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `${source.name} bundle file descriptor must be an object`);
      assert.deepEqual(Object.keys(entry), ["path", "size", "sha256"], `${source.name} bundle descriptor must contain only path, size, and SHA-256`);
      const parts = assertSafeBundleRelativePath(entry.path, source.name);
      assert.ok(!expectedFiles.has(entry.path), `${source.name} bundle file list contains a duplicate path`);
      expectedFiles.set(entry.path, entry);
      totalBytes += entry.size;
      assert.ok(totalBytes <= 64 * 1024 * 1024, `${source.name} public bundle exceeds the 64 MiB fixture limit`);

      const sourcePath = resolve(source.bundleRoot, ...parts);
      const sourceRelative = relative(source.bundleRoot, sourcePath);
      assert.ok(sourceRelative && !sourceRelative.startsWith(`..${sep}`) && sourceRelative !== "..", `${source.name} source asset escaped the bundle root`);
      await assertNoSymlinkAncestors(source.bundleRoot, parts, source.name);
      const bytes = await readVerifiedMobileExportFile(source.bundleRoot, entry, source.name);

      const destinationPath = resolve(ownedRoot, ...parts);
      const destinationRelative = relative(ownedRoot, destinationPath);
      assert.ok(destinationRelative && !destinationRelative.startsWith(`..${sep}`) && destinationRelative !== "..", `${source.name} copied asset escaped its owned directory`);
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      await writeFile(destinationPath, bytes, { flag: "wx", mode: 0o600 });
    }
    const mapFileCount = manifest.bundleFiles.filter((entry) => entry.path.endsWith(".map")).length;
    const expectedMapFileCount = coreAttributionOnly ? manifest.sourceMapEvidence?.mapFileCount : 0;
    assert.equal(mapFileCount, expectedMapFileCount, `${source.name} bundle source-map count does not match the active diagnostic mode`);
    assert.equal(expectedFiles.size - mapFileCount, 37, `${source.name} bundle must preserve exactly 37 standard files in addition to any explicitly pinned diagnostic maps`);
    const indexEntry = expectedFiles.get("index.html");
    assert.ok(indexEntry, `${source.name} bundle must list root index.html`);
    assert.equal(indexEntry.sha256, manifest.indexHtmlSha256, `${source.name} index digest does not match its file entry`);
    await verifyExactBundleTree(ownedRoot, expectedFiles, source.name);

    const manifestBytesAfter = await readFile(source.manifestPath);
    assert.equal(sha256(manifestBytesAfter), source.exportManifestSha256, `${source.name} export manifest changed while the public bundle was copied`);
    await verifyExactBundleTree(source.bundleRoot, expectedFiles, source.name);
    const provenance = {
      schemaVersion: 1,
      status: "complete",
      kind: "locally-verified-copy-of-retained-builder-export-v2",
      exportPerformedInMeasurementRun: false,
      source: {
        name: source.name,
        manifestPath: relative(repoRoot, source.manifestPath).split(sep).join("/"),
        manifestSha256: source.exportManifestSha256,
        sourceProvenancePath: relative(repoRoot, source.sourceProvenancePath).split(sep).join("/"),
        sourceProvenanceSha256: source.sourceProvenanceSha256,
        sourceFreezeEvidenceDigest: source.sourceFreezeEvidenceDigest,
        sourceFreezeEvidenceKind: source.sourceFreezeEvidenceKind,
        frozenOverlaySha256: source.overlaySha256,
        sourceTreeSha256: source.sourceTreeSha256,
        mobileSourceComponentSha256: source.mobileSourceComponentSha256,
        sourceComplementSha256: source.sourceComplementSha256,
        sharedSourceInputSha256: source.sharedSourceInputSha256,
        frozenSourceEntryCount: source.frozenSourceEntryCount,
        sourceCompleteness: source.sourceCompleteness,
        dependencySourceTreeSha256: source.dependencySourceTreeSha256,
        bundleRoot: relative(repoRoot, source.bundleRoot).split(sep).join("/"),
        bundleSha256: manifest.bundleSha256,
        indexHtmlSha256: manifest.indexHtmlSha256,
        bundleFileCount: expectedFiles.size,
        sourceAndManifestUnchangedDuringCopy: true,
      },
      ownedCopy: {
        path: relative(context.runRoot, ownedRoot).split(sep).join("/"),
        bundleSha256: sha256(Buffer.from(JSON.stringify(manifest.bundleFiles))),
        bundleFileCount: expectedFiles.size,
        bytes: totalBytes,
        exactFileSetVerified: true,
        symlinks: 0,
      },
    };
    const provenancePath = await context.writeArtifactJson(`render-profile-${source.name}-bundle-provenance.json`, provenance);
    return {
      path: ownedRoot,
      sourceManifestPath: source.manifestPath,
      sourceManifestSha256: source.exportManifestSha256,
      sourceTreeSha256: source.sourceTreeSha256,
      bundleSha256: manifest.bundleSha256,
      bundleFileCount: expectedFiles.size,
      indexHtmlSha256: manifest.indexHtmlSha256,
      provenancePath,
      exportPerformed: false,
    };
  } catch (error) {
    await rm(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}









function installHistoryAndNotificationFixture(page, state) {
  page.routeWebSocket("**/rpc*", (socket) => {
    const socketUrl = new URL(socket.url());
    const routeOrdinal = state.websocketConnections.length;
    const routeWorkspace = socketUrl.searchParams.get("workspace");
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
        if (frame.id !== undefined) requests.set(String(frame.id), frame);
        if (frame.method === "thread/read" && frame.id !== undefined) {
          state.readRequestStarted(frame);
          if (frame.params?.threadId === threadId
            && routeInfo.server === serverId
            && routeInfo.channel === "runtime"
            && routeInfo.workspaceMatchesFixture) {
            state.activeSocketRoute = { ...routeInfo, threadReadRequestId: frame.id };
            state.activeThreadReadRequestId = frame.id;
          }
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage((raw) => {
      let outbound = raw;
      const frame = parseFrame(raw);
      const request = frame?.id === undefined ? null : requests.get(String(frame.id));
      if (frame && request?.method === "thread/read") {
        if (request.params?.limit === 1) {
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
        outbound = JSON.stringify(frame);
        state.historyResponseBytes = (state.historyResponseBytes ?? 0) + Buffer.byteLength(outbound);
      }
      if (frame?.id !== undefined) requests.delete(String(frame.id));
      socket.send(outbound);
    });
  });
}

async function readFocusState(page, step) {
  return page.evaluate((stepName) => {
    const describe = (element) => element instanceof Element ? {
      tag: element.tagName,
      testId: element.getAttribute("data-testid"),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaExpanded: element.getAttribute("aria-expanded"),
      ariaSelected: element.getAttribute("aria-selected"),
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.hasAttribute("inert"),
      className: element instanceof HTMLElement ? String(element.className).slice(0, 100) : null,
      text: String(element.textContent ?? "").trim().slice(0, 80),
    } : null;
    const active = document.activeElement;
    const ancestors = [];
    let current = active instanceof Element ? active : null;
    for (let index = 0; current && index < 6; index += 1, current = current.parentElement) {
      const style = getComputedStyle(current);
      ancestors.push({ ...describe(current), display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents });
    }
    const overlays = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"], [data-testid*="menu"], [data-testid*="dialog"]')]
      .filter((element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== "none")
      .slice(0, 12)
      .map(describe);
    const tabs = [...document.querySelectorAll('[role="tab"], [data-testid^="workspace-tab-"]')].slice(0, 12).map(describe);
    return {
      step: stepName,
      at: Number(performance.now().toFixed(3)),
      active: describe(active),
      ancestors,
      overlays,
      tabs,
      focusEvents: window.__phoneRenderFocusEvents?.() ?? [],
    };
  }, step);
}

async function connectMobile(page, gateway) {
  const login = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(login?.status(), 200, "isolated fixture Gateway must serve the selected Mobile Web bundle");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
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
    expectedLatestHistory: latestHistory,
    phaseEvidence,
    productTailGate: error?.productTailGateEvidence ?? null,
    lastTranscriptViewport,
    screenshot,
    error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) },
  });
}

async function measureInputFeedback(page, pageState, source, count, panelState, samples) {
  const input = page.getByTestId("message-input");
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await waitForTwoFrames(page);
  const output = [];
  for (let index = 0; index < samples; index += 1) {
    await input.click();
    await input.fill("");
    await input.evaluate((element) => element.focus());
    await waitForTwoFrames(page);
    let focusState = await input.evaluate((element) => ({
      focused: document.activeElement === element,
      tag: element.tagName,
      disabled: "disabled" in element ? element.disabled : null,
      readOnly: "readOnly" in element ? element.readOnly : null,
      connected: element.isConnected,
      display: getComputedStyle(element).display,
      visibility: getComputedStyle(element).visibility,
      pointerEvents: getComputedStyle(element).pointerEvents,
      html: element.outerHTML.slice(0, 350),
      activeTag: document.activeElement?.tagName ?? null,
      activeTestId: document.activeElement?.getAttribute?.("data-testid") ?? null,
    }));
    if (!focusState.focused) {
      await input.click();
      await waitForTwoFrames(page);
      focusState = await input.evaluate((element) => ({
        focused: document.activeElement === element,
        tag: element.tagName,
        disabled: "disabled" in element ? element.disabled : null,
        readOnly: "readOnly" in element ? element.readOnly : null,
        connected: element.isConnected,
        display: getComputedStyle(element).display,
        visibility: getComputedStyle(element).visibility,
        pointerEvents: getComputedStyle(element).pointerEvents,
        html: element.outerHTML.slice(0, 350),
        activeTag: document.activeElement?.tagName ?? null,
        activeTestId: document.activeElement?.getAttribute?.("data-testid") ?? null,
      }));
    }
    const id = `input-${source}-${count}-${index}`;
    const startedAt = performance.now();
    let error = focusState.focused ? null : new Error("input focus did not remain on the textarea after a two-frame wait and a retry click");
    if (!error) {
      await page.evaluate((value) => window.__phoneRenderArmInput(value), id);
      try {
        await input.press("x");
        await page.waitForFunction((value) => Boolean(window.__phoneRenderInputResult(value)), id, { timeout: 5_000 });
      } catch (caught) { error = caught; }
    }
    const automationElapsedMs = Number((performance.now() - startedAt).toFixed(3));
    const result = await page.evaluate((value) => window.__phoneRenderInputResult(value), id).catch(() => null);
    const longTasks = result ? await collectLongTasks(page, result) : [];
    const diagnostic = error ? await page.evaluate(() => {
      const inputElement = document.querySelector('[data-testid="message-input"]');
      const active = document.activeElement;
      return {
        activeElementTag: active?.tagName ?? null,
        activeElementTestId: active?.getAttribute?.("data-testid") ?? null,
        inputConnected: inputElement?.isConnected ?? false,
        inputValueLength: "value" in (inputElement ?? {}) ? String(inputElement.value ?? "").length : null,
        inputDisplay: inputElement instanceof HTMLElement ? getComputedStyle(inputElement).display : null,
        inputParentDisplay: inputElement?.parentElement instanceof HTMLElement ? getComputedStyle(inputElement.parentElement).display : null,
        inputDisabled: inputElement instanceof HTMLTextAreaElement || inputElement instanceof HTMLInputElement ? inputElement.disabled : null,
        inputReadOnly: inputElement instanceof HTMLTextAreaElement || inputElement instanceof HTMLInputElement ? inputElement.readOnly : null,
        inputOuterHtml: inputElement?.outerHTML.slice(0, 500) ?? null,
        focusState,
        focusEvents: window.__phoneRenderFocusEvents?.() ?? [],
        activeState: document.activeElement instanceof Element ? {
          role: document.activeElement.getAttribute("role"),
          ariaExpanded: document.activeElement.getAttribute("aria-expanded"),
          ariaModal: document.activeElement.getAttribute("aria-modal"),
          ancestors: (() => {
            const values = [];
            let current = document.activeElement;
            for (let index = 0; current instanceof HTMLElement && index < 5; index += 1, current = current.parentElement) values.push({ tag: current.tagName, testId: current.getAttribute("data-testid"), role: current.getAttribute("role"), ariaHidden: current.getAttribute("aria-hidden"), inert: current.hasAttribute("inert"), display: getComputedStyle(current).display, pointerEvents: getComputedStyle(current).pointerEvents });
            return values;
          })(),
        } : null,
        visibleOverlays: [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"], [data-testid*="menu"], [data-testid*="dialog"]')].filter((element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== "none").slice(0, 8).map((element) => ({ testId: element.getAttribute("data-testid"), role: element.getAttribute("role"), ariaModal: element.getAttribute("aria-modal"), text: element.textContent?.trim().slice(0, 80) })),
      };
    }) : null;
    output.push({
      source,
      requestedMessages: count,
      scenario: "input-feedback",
      panelState,
      sample: index + 1,
      durationMs: result?.durationMs ?? null,
      automationElapsedMs,
      synchronousEventTaskMs: result?.synchronousEventTaskMs ?? null,
      focusState,
      tabModalDismiss: pageState.tabModalDismiss ?? null,
      longTasks,
      ok: Boolean(result) && !error && (panelState !== "mounted-hidden" || pageState.tabModalDismiss?.dismissed === true),
      timingSource: "browser keydown event through next animation frame with controlled TextInput value updated",
      ...(diagnostic ? { diagnostic } : {}),
      ...(error ? { error: String(error.message || error).slice(0, 400) } : {}),
    });
  }
  return output;
}

async function measureScrollFeedback(page, state, source, count, panelState, samples, context) {
  const hostInfo = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="message-list"]');
    if (!(root instanceof HTMLElement)) return null;
    const candidates = [root, ...root.querySelectorAll("*")].filter((element) => element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16);
    const host = candidates.sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0];
    if (!host) return null;
    host.setAttribute("data-phone-ux-scroll-host", "true");
    return { top: host.getBoundingClientRect().top, left: host.getBoundingClientRect().left, width: host.clientWidth, height: host.clientHeight, scrollHeight: host.scrollHeight, maxScrollTop: host.scrollHeight - host.clientHeight };
  });
  const output = [];
  for (let index = 0; index < samples; index += 1) {
    const sample = index + 1;
    const marker = `seed-${source}-${count}-${panelState}`;
    const artifact = {
      schemaVersion: 1,
      scenario: "scroll-feedback-causal-setup",
      evidenceClass: "isolated Mobile Web Chromium with app-facing WebSocketMock history and synthetic fixture input; not a real app-server turn, native measurement, or matched performance result",
      source,
      requestedMessages: count,
      panelState,
      sample,
      marker,
      boundary: "positioning uses trusted wheel input and measured scroll geometry; touch timing begins only after setup; no scrollTop writes are used",
      hostInfo,
      stage: "precondition",
      setup: { tailRestoreDurationMs: null, wheelSetupDurationMs: null, tailRestore: null, trustedWheel: null, beforeTouch: null, touchHitTest: null },
      touch: { inputTrace: null, result: null, afterViewport: null, waitError: null },
      cleanup: { inputTrace: "not-installed", cdpSession: "not-created" },
      cleanupErrors: [],
      primaryError: null,
      status: "RUNNING",
    };
    let primaryError = null;
    let artifactWriteError = null;
    let cdp = null;
    let inputObserverInstalled = false;
    let inputTraceStartOrdinal = 0;
    let inputTraceStartDropped = null;
    let touchResult = null;
    let touchWaitError = null;
    let touchBefore = null;
    let touchAfter = null;
    let touchLongTasks = [];
    let automationElapsedMs = null;
    let touchStartedAt = null;

    try {
      assert.ok(hostInfo && hostInfo.height > 0 && hostInfo.maxScrollTop > 0,
        "scroll host was not found or the transcript did not overflow");
      artifact.stage = "restore-real-tail";
      const tailRestoreStartedAt = performance.now();
      const entryTail = await scrollTranscriptToLatest(page, marker, { requireMarkerVisible: true });
      artifact.setup.tailRestoreDurationMs = Number((performance.now() - tailRestoreStartedAt).toFixed(3));
      artifact.setup.tailRestore = summarizeScrollCausalityTailGate(entryTail);

      artifact.stage = "trusted-wheel-to-old-history";
      const wheelSetupStartedAt = performance.now();
      try {
        const wheelEvidence = await moveAwayFromLatestWithTrustedWheel(page, marker, entryTail.after);
        artifact.setup.trustedWheel = summarizeScrollCausalityWheel(wheelEvidence);
        assert.equal(wheelEvidence.status, "TRUSTED_WHEEL_MOVED_AWAY_FROM_LATEST",
          "scroll feedback setup must use bounded trusted wheel input to move away from the real latest tail");
      } catch (error) {
        const wheelEvidence = error?.preTapNavigationEvidence ?? error?.cause?.preTapNavigationEvidence;
        if (wheelEvidence) artifact.setup.trustedWheel = summarizeScrollCausalityWheel(wheelEvidence);
        throw error;
      } finally {
        artifact.setup.wheelSetupDurationMs = Number((performance.now() - wheelSetupStartedAt).toFixed(3));
      }

      artifact.stage = "verify-off-tail-touch-target";
      touchBefore = await readTranscriptViewport(page, marker, true, {
        captureMarkerVisibilityDiagnostics: true,
        captureScrollportTransform: true,
      });
      const logicalDistanceBeforeTouch = manualHistoryLogicalDistanceFromLatest(touchBefore);
      artifact.setup.beforeTouch = {
        ...summarizeScrollCausalityViewport(touchBefore),
        logicalDistanceFromLatestPx: logicalDistanceBeforeTouch.pixels,
        logicalDistanceOrientation: logicalDistanceBeforeTouch.inverted ? "inverted" : "normal",
      };
      assert.ok(logicalDistanceBeforeTouch.pixels > 96,
        "trusted wheel setup must leave the measured touch away from the latest threshold");
      assert.equal(touchBefore.jumpToLatestVisible, true,
        "trusted wheel setup must expose the real Jump-to-latest control before the measured touch");

      const listBounds = await page.getByTestId("message-list").boundingBox();
      assert.ok(listBounds && listBounds.width > 0 && listBounds.height > 0,
        "measured touch must target the actual visible message-list hitbox");
      const x = Math.round(listBounds.x + listBounds.width / 2);
      const y = Math.round(listBounds.y + listBounds.height / 2);
      artifact.setup.touchHitTest = await page.evaluate(({ pointX, pointY }) => {
        const list = document.querySelector('[data-testid="message-list"]');
        const target = document.elementFromPoint(pointX, pointY);
        return {
          insideMessageList: Boolean(list && target && list.contains(target)),
          targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
          sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
        };
      }, { pointX: x, pointY: y });
      assert.equal(artifact.setup.touchHitTest.insideMessageList, true,
        "measured CDP touch point must hit the real message-list subtree");

      artifact.stage = "arm-measured-touch";
      const inputObserver = await installTranscriptFollowGestureInputTrace(page, 256);
      inputObserverInstalled = true;
      assert.equal(inputObserver.installed, true, "measured touch needs a bounded passive input trace");
      const traceBaseline = await readTranscriptFollowGestureInputTrace(page);
      assert.ok(Number.isSafeInteger(traceBaseline?.latestOrdinal) && Number.isSafeInteger(traceBaseline?.dropped),
        "measured touch trace must expose ordinal and dropped-event counters before input starts");
      inputTraceStartOrdinal = traceBaseline.latestOrdinal;
      inputTraceStartDropped = traceBaseline.dropped;
      artifact.touch.traceInstallBaseline = { latestOrdinal: inputTraceStartOrdinal, dropped: inputTraceStartDropped };
      cdp = await page.context().newCDPSession(page);
      const id = `scroll-${source}-${count}-${panelState}-${index}`;
      await page.evaluate((value) => window.__phoneRenderArmScroll(value), id);
      const measurementTraceBaseline = await readTranscriptFollowGestureInputTrace(page);
      assert.ok(Number.isSafeInteger(measurementTraceBaseline?.latestOrdinal) && Number.isSafeInteger(measurementTraceBaseline?.dropped),
        "measured touch interval must have valid trace counters immediately before dispatch");
      inputTraceStartOrdinal = measurementTraceBaseline.latestOrdinal;
      inputTraceStartDropped = measurementTraceBaseline.dropped;
      artifact.touch.traceBaseline = { latestOrdinal: inputTraceStartOrdinal, dropped: inputTraceStartDropped };

      artifact.stage = "measured-trusted-touch";
      touchStartedAt = performance.now();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 41 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 64, id: 41 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 128, id: 41 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      try {
        await page.waitForFunction((value) => Boolean(window.__phoneRenderInputResult(value)), id, { timeout: 5_000 });
      } catch (error) {
        touchWaitError = error;
      }
      touchResult = await page.evaluate((value) => window.__phoneRenderInputResult(value), id).catch(() => null);
      automationElapsedMs = Number((performance.now() - touchStartedAt).toFixed(3));
      touchAfter = await readTranscriptViewport(page, marker, true, {
        captureMarkerVisibilityDiagnostics: true,
        captureScrollportTransform: true,
      });
      touchLongTasks = touchResult ? await collectLongTasks(page, touchResult) : [];

      const touchTrace = await readTranscriptFollowGestureInputTrace(page);
      const events = transcriptInputEventsSince(touchTrace, inputTraceStartOrdinal);
      artifact.touch.inputTrace = summarizeScrollCausalityTouchTrace(touchTrace, events, inputTraceStartDropped);
      const logicalDistanceAfterTouch = manualHistoryLogicalDistanceFromLatest(touchAfter);
      const touchVerification = evaluateScrollCausalityTouchEvidence({
        result: touchResult,
        waitError: touchWaitError,
        trace: artifact.touch.inputTrace,
      });
      artifact.touch.result = {
        durationMs: touchResult?.durationMs ?? null,
        automationElapsedMs,
        synchronousEventTaskMs: touchResult?.scrollEventTaskMs ?? null,
        touchStartHandlerMs: touchResult?.synchronousEventTaskMs ?? null,
        scrollDeltaPx: touchResult?.scrollDeltaPx ?? null,
        beforeRawScrollTop: touchBefore.scrollTop,
        afterRawScrollTop: touchAfter.scrollTop,
        logicalDistanceBeforePx: logicalDistanceBeforeTouch.pixels,
        logicalDistanceAfterPx: logicalDistanceAfterTouch.pixels,
        logicalOrientation: logicalDistanceAfterTouch.inverted ? "inverted" : "normal",
        trustedInputCounts: artifact.touch.inputTrace.trustedCounts,
        traceDroppedDuringMeasurement: artifact.touch.inputTrace.droppedDuringMeasurement,
        verification: touchVerification,
        longTaskCount: touchLongTasks.length,
        longTasks: touchLongTasks.slice(0, 8).map((task) => ({
          startTimeMs: task.startTimeMs,
          durationMs: task.durationMs,
          name: String(task.name ?? "unknown").slice(0, 80),
        })),
      };
      artifact.touch.afterViewport = summarizeScrollCausalityViewport(touchAfter);
      artifact.touch.waitError = touchWaitError
        ? { name: touchWaitError?.name ?? "Error", message: safeSeedErrorMessage(touchWaitError).slice(0, 400) }
        : null;

      const outputEntry = {
        source,
        requestedMessages: count,
        scenario: "scroll-feedback",
        panelState,
        sample,
        durationMs: touchResult?.durationMs ?? null,
        automationElapsedMs,
        setupDurationMs: artifact.setup.wheelSetupDurationMs,
        setupWheelSteps: artifact.setup.trustedWheel?.steps?.length ?? null,
        synchronousEventTaskMs: touchResult?.scrollEventTaskMs ?? null,
        touchStartHandlerMs: touchResult?.synchronousEventTaskMs ?? null,
        scrollDeltaPx: touchResult?.scrollDeltaPx ?? null,
        trustedInputCounts: artifact.touch.inputTrace.trustedCounts,
        traceDroppedDuringMeasurement: artifact.touch.inputTrace.droppedDuringMeasurement,
        evidenceStatus: touchVerification.status,
        longTasks: touchLongTasks,
        ok: touchVerification.status === "PASS",
        timingSource: "CDP trusted mobile touchstart through first transcript scroll event and next animation frame; trusted wheel setup and any real tail Jump restoration are reported separately",
        ...(touchWaitError ? { error: safeSeedErrorMessage(touchWaitError).slice(0, 400) } : {}),
      };
      artifact.result = outputEntry;
      output.push(outputEntry);
    } catch (error) {
      primaryError = error;
      artifact.primaryError = {
        name: error?.name ?? "Error",
        message: safeSeedErrorMessage(error).slice(0, 1200),
        stack: safeSeedErrorStack(error)?.slice(0, 4000) ?? null,
      };
      if (error?.transcriptViewport) artifact.tailGateFailure = summarizeScrollCausalityTailGate(error.transcriptViewport);
      const wheelEvidence = error?.preTapNavigationEvidence ?? error?.cause?.preTapNavigationEvidence;
      if (wheelEvidence && artifact.setup.trustedWheel === null) artifact.setup.trustedWheel = summarizeScrollCausalityWheel(wheelEvidence);
    } finally {
      if (touchAfter === null) {
        try {
          touchAfter = await readTranscriptViewport(page, marker, true, {
            captureMarkerVisibilityDiagnostics: true,
            captureScrollportTransform: true,
          });
          artifact.touch.afterViewport = summarizeScrollCausalityViewport(touchAfter);
        } catch (error) {
          artifact.touch.afterViewportReadError = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error).slice(0, 400) };
        }
      }
      if (inputObserverInstalled) {
        try {
          const trace = await readTranscriptFollowGestureInputTrace(page);
          if (artifact.touch.inputTrace === null) {
            artifact.touch.inputTrace = summarizeScrollCausalityTouchTrace(
              trace,
              transcriptInputEventsSince(trace, inputTraceStartOrdinal),
              inputTraceStartDropped,
            );
          }
        } catch (error) {
          artifact.cleanupErrors.push({ operation: "read-input-trace", name: error?.name ?? "Error", message: safeSeedErrorMessage(error).slice(0, 400) });
        }
        try {
          await disposeTranscriptFollowGestureInputTrace(page);
          artifact.cleanup.inputTrace = "disposed";
        } catch (error) {
          artifact.cleanup.inputTrace = "failed";
          artifact.cleanupErrors.push({ operation: "dispose-input-trace", name: error?.name ?? "Error", message: safeSeedErrorMessage(error).slice(0, 400) });
        }
      }
      if (cdp) {
        try {
          await cdp.detach();
          artifact.cleanup.cdpSession = "detached";
        } catch (error) {
          artifact.cleanup.cdpSession = "failed";
          artifact.cleanupErrors.push({ operation: "detach-cdp-session", name: error?.name ?? "Error", message: safeSeedErrorMessage(error).slice(0, 400) });
        }
      }
      artifact.touch.verification ??= evaluateScrollCausalityTouchEvidence({
        result: touchResult,
        waitError: touchWaitError,
        trace: artifact.touch.inputTrace,
      });
      artifact.status = primaryError || touchWaitError || artifact.cleanupErrors.some((entry) => entry.name)
        ? "FAIL"
        : artifact.touch.verification.status;
      try {
        await context.writeArtifactJson(
          `phone-render-profile-scroll-causality-${source}-${count}-${panelState}-${sample}.json`,
          artifact,
        );
      } catch (error) {
        artifactWriteError = error;
      }
    }

    if (primaryError || artifactWriteError || artifact.cleanupErrors.some((entry) => entry.name)) {
      const cleanupFailures = artifact.cleanupErrors.filter((entry) => entry.name)
        .map((entry) => new Error(`${entry.operation}: ${entry.message}`));
      const errors = [primaryError, ...cleanupFailures, artifactWriteError].filter(Boolean);
      const failure = errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "scroll feedback causal measurement failed; primary and cleanup/artifact errors are retained", { cause: primaryError ?? errors[0] });
      failure.scrollCausalityEvidence = artifact;
      throw failure;
    }
  }
  return output;
}

function summarizeScrollCausalityViewport(viewport) {
  if (!viewport || typeof viewport !== "object") return null;
  const transformEvidence = resolveTranscriptScrollportTransform(viewport);
  const transform = transformEvidence.status === "captured" ? transformEvidence.transform : null;
  let logicalDistance = null;
  try {
    const measured = manualHistoryLogicalDistanceFromLatest(viewport);
    logicalDistance = { pixels: measured.pixels, orientation: measured.inverted ? "inverted" : "normal" };
  } catch (error) {
    logicalDistance = { error: safeSeedErrorMessage(error).slice(0, 200) };
  }
  return {
    sampledAtPageTimeMs: viewport.sampledAtPageTimeMs ?? null,
    scrollHostTestId: viewport.scrollHostTestId ?? null,
    scrollTop: viewport.scrollTop ?? null,
    scrollHeight: viewport.scrollHeight ?? null,
    clientHeight: viewport.clientHeight ?? null,
    rawBottomGapPx: viewport.bottomGapPx ?? null,
    scrollportTransform: transform,
    scrollportTransformEvidence: transformEvidence,
    logicalDistanceFromLatest: logicalDistance,
    targetRowFound: viewport.targetRowFound ?? null,
    targetRowRect: viewport.targetRowRect ?? null,
    targetMarkerLastCharacterRect: viewport.targetMarkerLastCharacterRect ?? null,
    targetMarkerVisibleWithinMessageList: viewport.targetMarkerVisibleWithinMessageList ?? null,
    jumpToLatestVisible: viewport.jumpToLatestVisible ?? null,
  };
}

function summarizeScrollCausalityTailGate(gate) {
  if (!gate || typeof gate !== "object") return gate ?? null;
  const actions = Array.isArray(gate.actions) ? gate.actions.slice(0, 2).map((action) => ({
    action: action.action ?? null,
    atPoll: action.atPoll ?? null,
    outcome: action.outcome ?? null,
    timeoutMs: action.timeoutMs ?? null,
  })) : [];
  return {
    action: gate.action ?? null,
    expectedTailMarker: gate.expectedTailMarker ?? null,
    before: summarizeScrollCausalityViewport(gate.before),
    after: summarizeScrollCausalityViewport(gate.after ?? gate.afterTwoFrames ?? gate.last),
    afterTwoFrames: gate.afterTwoFrames === true,
    firstTargetVisiblePoll: gate.firstTargetVisiblePoll ?? null,
    stableSamples: gate.stableSamples ?? null,
    pollCount: gate.pollCount ?? null,
    actions,
    geometryStableAfterTwoFrames: gate.geometryStableAfterTwoFrames ?? null,
  };
}

function summarizeScrollCausalityWheel(wheel) {
  if (!wheel || typeof wheel !== "object") return null;
  const summarizeEvents = (events) => {
    if (!Array.isArray(events)) return { count: 0, trustedInsideListCount: 0, firstOrdinal: null, lastOrdinal: null };
    const accepted = events.filter((event) => event?.isTrusted === true && event?.insideMessageList === true);
    return {
      count: events.length,
      trustedInsideListCount: accepted.length,
      firstOrdinal: events[0]?.ordinal ?? null,
      lastOrdinal: events.at(-1)?.ordinal ?? null,
      firstPageTimeMs: events[0]?.pageTimeMs ?? null,
      lastPageTimeMs: events.at(-1)?.pageTimeMs ?? null,
    };
  };
  const steps = Array.isArray(wheel.steps) ? wheel.steps.slice(0, 8).map((step) => ({
    index: step.index ?? null,
    requestedDeltaY: step.requestedDeltaY ?? null,
    before: summarizeManualHistoryResetViewport(step.before),
    after: summarizeManualHistoryResetViewport(step.after),
    logicalDistanceChangePx: step.logicalDistanceChangePx ?? null,
    wheelEvents: summarizeEvents(step.trustedWheelEvents),
    listScrollEvents: summarizeEvents(step.trustedListScrollEvents),
  })) : [];
  return {
    status: wheel.status ?? null,
    maximumWheelSteps: wheel.maximumWheelSteps ?? null,
    requestedDeltaYPerStep: wheel.requestedDeltaYPerStep ?? null,
    inputBudgetMs: wheel.inputBudgetMs ?? null,
    inputDurationMs: wheel.inputDurationMs ?? null,
    initialViewport: wheel.initialViewport ?? null,
    logicalDistance: wheel.logicalDistance ?? null,
    hitTest: wheel.hitTest ?? null,
    steps,
    trustedWheelEventCount: wheel.trustedWheelEventCount ?? null,
    trustedListScrollEventCount: wheel.trustedListScrollEventCount ?? null,
    finalViewport: wheel.finalViewport ?? null,
    cleanupErrors: Array.isArray(wheel.cleanupErrors) ? wheel.cleanupErrors.slice(0, 4) : [],
    error: wheel.error ? { name: wheel.error.name ?? null, message: String(wheel.error.message ?? "").slice(0, 400) } : null,
  };
}

function summarizeScrollCausalityTouchTrace(trace, events, droppedBefore) {
  const allEvents = Array.isArray(events) ? events : [];
  const droppedAfter = Number.isSafeInteger(trace?.dropped) ? trace.dropped : null;
  const droppedDuringMeasurement = Number.isSafeInteger(droppedBefore) && Number.isSafeInteger(droppedAfter) && droppedAfter >= droppedBefore
    ? droppedAfter - droppedBefore
    : null;
  const boundedEvents = allEvents.slice(0, 32).map((event) => ({
    ordinal: event.ordinal ?? null,
    type: event.type ?? null,
    pageTimeMs: event.pageTimeMs ?? null,
    isTrusted: event.isTrusted === true,
    insideMessageList: event.insideMessageList === true,
    insideJumpButton: event.insideJumpButton === true,
    targetTestId: event.targetTestId ?? null,
    deltaX: event.deltaX ?? null,
    deltaY: event.deltaY ?? null,
    scrollTop: event.scrollTop ?? null,
    scrollHeight: event.scrollHeight ?? null,
    clientHeight: event.clientHeight ?? null,
  }));
  const count = (type) => allEvents.filter((event) => event.type === type && event.isTrusted === true && event.insideMessageList === true).length;
  return {
    schemaVersion: trace?.schemaVersion ?? null,
    latestOrdinal: trace?.latestOrdinal ?? null,
    droppedBeforeMeasurement: Number.isSafeInteger(droppedBefore) ? droppedBefore : null,
    droppedAfterMeasurement: droppedAfter,
    droppedDuringMeasurement,
    recordedEventCountAfterStartOrdinal: allEvents.length,
    recordedTouchEventCount: allEvents.filter((event) => ["touchstart", "touchmove", "touchend"].includes(event.type)).length,
    trustedCounts: {
      touchstart: count("touchstart"),
      touchmove: count("touchmove"),
      touchend: count("touchend"),
      listScroll: count("scroll"),
    },
    events: boundedEvents,
    eventsOmittedCount: Math.max(0, allEvents.length - boundedEvents.length),
  };
}

function evaluateScrollCausalityTouchEvidence({ result, waitError, trace }) {
  const counts = trace?.trustedCounts;
  const requiredCounts = ["touchstart", "touchmove", "touchend", "listScroll"];
  const countsAvailable = requiredCounts.every((name) => Number.isSafeInteger(counts?.[name]) && counts[name] >= 0);
  const dropCountAvailable = Number.isSafeInteger(trace?.droppedDuringMeasurement) && trace.droppedDuringMeasurement >= 0;
  const scrollDeltaAvailable = typeof result?.scrollDeltaPx === "number" && Number.isFinite(result.scrollDeltaPx);
  const gates = {
    touchResultAvailable: Boolean(result),
    touchWaitCompleted: !waitError,
    trustedTouchstartInsideList: countsAvailable ? counts.touchstart > 0 : null,
    trustedTouchmoveInsideList: countsAvailable ? counts.touchmove > 0 : null,
    trustedTouchendInsideList: countsAvailable ? counts.touchend > 0 : null,
    trustedListScrollObserved: countsAvailable ? counts.listScroll > 0 : null,
    scrollDeltaGreaterThanOnePx: scrollDeltaAvailable ? Math.abs(result.scrollDeltaPx) > 1 : null,
    noTraceEventsDropped: dropCountAvailable ? trace.droppedDuringMeasurement === 0 : null,
  };
  const evidenceComplete = countsAvailable && dropCountAvailable && scrollDeltaAvailable;
  const passed = evidenceComplete && Object.values(gates).every((value) => value === true);
  return {
    status: passed ? "PASS" : evidenceComplete ? "FAIL" : "UNVERIFIED",
    gates,
    trustedCounts: countsAvailable ? counts : null,
    droppedDuringMeasurement: dropCountAvailable ? trace.droppedDuringMeasurement : null,
    scrollDeltaPx: scrollDeltaAvailable ? result.scrollDeltaPx : null,
    evidenceBoundary: "sample passes only when the measured interval contains trusted in-list touchstart/move/end, a trusted in-list scroll, >1px observed movement, and zero dropped trace events",
  };
}

async function measureActiveMarkdownDelta(page, state, source, count, panelState, samples, captureProfile, options = {}) {
  const sampleOffset = Number.isInteger(options.sampleOffset) ? options.sampleOffset : 0;
  const diagnosticOnly = options.diagnosticOnly === true;
  const safeVariant = panelState === "mounted-hidden" ? "mounted" : "unmounted";
  const firstTailMarker = options.initialTailMarker ?? (sampleOffset === 0
    ? samples > 0
      ? `UX-${source}-${count}-${safeVariant}-${samples - 1}`
      : `seed-${source}-${count}-${panelState}`
    : `ACTIVE-MD-${source}-${count}-${safeVariant}-burst-${sampleOffset}-chunk-${activeDeltaChunksPerStream}`);
  let previousTailMarker = firstTailMarker;
  const observations = [];
  const bursts = [];
  let totalDeltaBytes = 0;
  let currentStreamSample = sampleOffset + 1;
  let currentExpectedTailMarker = previousTailMarker;
  let currentExpectedFinalMarker = null;
  let currentStreamPhase = "initial-tail-follow";
  let currentTranscriptViewportBeforeBurst = null;
  const attachActiveStreamFailureEvidence = (error, failureStage) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.activeStreamFailureEvidence = {
      schemaVersion: 1,
      failureStage,
      source,
      requestedMessages: count,
      panelState,
      sampleOffset,
      expectedStreamCount: samples,
      completedStreamCount: bursts.length,
      totalDeltaBytes,
      completedBursts: [...bursts],
      completedObservations: [...observations],
      currentStream: {
        sample: currentStreamSample,
        expectedTailMarker: currentExpectedTailMarker,
        expectedFinalMarker: currentExpectedFinalMarker,
        phase: currentStreamPhase,
        transcriptViewportBeforeBurst: currentTranscriptViewportBeforeBurst,
        nextSequence: state.nextSequence,
      },
      helperViewport: failure.transcriptViewport ?? failure.cause?.transcriptViewport ?? null,
      error: {
        name: failure.name,
        message: String(failure.message || failure).slice(0, 2000),
        stack: typeof failure.stack === "string" ? failure.stack.slice(0, 8000) : null,
      },
    };
    return failure;
  };
  let initialTranscriptViewport;
  try {
    initialTranscriptViewport = await scrollTranscriptToLatest(page, previousTailMarker);
    currentTranscriptViewportBeforeBurst = initialTranscriptViewport;
    currentStreamPhase = "ready-for-first-stream";
  } catch (error) {
    throw attachActiveStreamFailureEvidence(error, "initial-tail-follow");
  }
  let profileSession = null;
  let cpuProfile = null;
  let cpuProfileError = null;
  const approvedScriptBaseUrl = captureProfile ? page.url() : null;
  const profileStartedAt = captureProfile ? performance.now() : null;
  let profileStartClock = null;
  let profileEndClock = null;
  if (captureProfile) {
    try {
      profileSession = await page.context().newCDPSession(page);
      await profileSession.send("Performance.enable");
      await profileSession.send("Profiler.enable");
      await profileSession.send("Profiler.setSamplingInterval", { interval: 500 });
      await profileSession.send("Profiler.start");
      profileStartClock = await captureCdpClockAnchor(profileSession, page);
    } catch (error) {
      cpuProfileError = String(error.message || error).slice(0, 300);
      await profileSession?.detach().catch(() => {});
      profileSession = null;
    }
  }
  try {
    for (let streamIndex = 0; streamIndex < samples; streamIndex += 1) {
      const streamSample = sampleOffset + streamIndex + 1;
      currentStreamSample = streamSample;
      currentExpectedTailMarker = previousTailMarker;
      currentExpectedFinalMarker = `ACTIVE-MD-${source}-${count}-${safeVariant}-burst-${streamSample}-chunk-${activeDeltaChunksPerStream}`;
      currentStreamPhase = "tail-follow-before-stream";
      currentTranscriptViewportBeforeBurst = null;
      const transcriptViewportBeforeBurst = streamIndex === 0
        ? initialTranscriptViewport
        : await scrollTranscriptToLatest(page, previousTailMarker);
      currentTranscriptViewportBeforeBurst = transcriptViewportBeforeBurst;
      currentStreamPhase = "dispatching-stream-setup";
      const turnId = `ux-active-stream-turn-${source}-${count}-${safeVariant}-${streamSample}`;
      const attemptId = `ux-active-stream-attempt-${source}-${count}-${safeVariant}-${streamSample}`;
      const itemId = `ux-active-stream-item-${source}-${count}-${safeVariant}-${streamSample}`;
      const common = { serverId, threadId, turnId, attemptId };
      const setupFrames = [
        {
          jsonrpc: "2.0",
          method: "turn/started",
          params: { ...common, sequence: state.nextSequence++, turn: { id: turnId, attemptId, threadId, status: "running" } },
        },
        {
          jsonrpc: "2.0",
          method: "item/started",
          params: { ...common, sequence: state.nextSequence++, item: { id: itemId, type: "agentMessage" } },
        },
      ];
      const setupResults = [];
      for (const frame of setupFrames) {
        const delivery = await dispatchActiveFrame(page, state, frame);
        assert.equal(delivery.delivered, true, `active Markdown burst setup frame must reach the unique Mobile runtime socket: ${JSON.stringify(delivery)}`);
        setupResults.push({
          method: frame.method,
          sequence: frame.params.sequence,
          serverId,
          threadId,
          turnId,
          browserMockId: delivery.browserMockId,
          dispatchHandlerSyncMs: delivery.dispatchHandlerSyncMs,
        });
      }

      const finalMarker = currentExpectedFinalMarker;
      currentStreamPhase = "arming-stream-mutation-observer";
      const observerId = `active-md-${source}-${count}-${safeVariant}-burst-${streamSample}`;
      const armed = await page.evaluate(({ id, value }) => window.__phoneRenderArmMutation(id, value), { id: observerId, value: finalMarker });
      assert.equal(armed.observedRoot, true, "active Markdown stream observer must watch the Mobile transcript");

      const deltaFrames = [];
      const deltaMetadata = [];
      let burstDeltaBytes = 0;
      for (let chunkIndex = 0; chunkIndex < activeDeltaChunksPerStream; chunkIndex += 1) {
        const marker = `ACTIVE-MD-${source}-${count}-${safeVariant}-burst-${streamSample}-chunk-${chunkIndex + 1}`;
        const globalChunkIndex = (sampleOffset + streamIndex) * activeDeltaChunksPerStream + chunkIndex;
        const deltaText = makeLongMarkdownDelta(marker, globalChunkIndex);
        const deltaBytes = Buffer.byteLength(deltaText);
        burstDeltaBytes += deltaBytes;
        totalDeltaBytes += deltaBytes;
        deltaMetadata.push({ marker, deltaBytes, chunkIndex: chunkIndex + 1 });
        deltaFrames.push({
          jsonrpc: "2.0",
          method: "item/delta",
          params: {
            ...common,
            sequence: state.nextSequence++,
            itemId,
            delta: { text: deltaText },
          },
        });
      }
      const completionFrame = {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { ...common, sequence: state.nextSequence++, turn: { id: turnId, attemptId, threadId, status: "completed" } },
      };
      currentStreamPhase = "dispatching-stream-deltas-and-completion";
      const delivery = await dispatchActiveStreamFrames(page, state, [...deltaFrames, completionFrame], finalMarker);
      assert.equal(delivery.delivered, activeDeltaChunksPerStream + 1, `all active Markdown chunks and their completion must reach the unique Mobile runtime socket: ${JSON.stringify(delivery)}`);
      let error = null;
      currentStreamPhase = "waiting-for-agent-row-and-two-raf";
      try {
        await page.waitForFunction((id) => Boolean(window.__phoneRenderMutationResult(id)), observerId, { timeout: 5_000 });
      } catch (caught) { error = caught; }
      currentStreamPhase = "capturing-terminal-row";
      const result = await page.evaluate((id) => window.__phoneRenderMutationResult(id), observerId).catch(() => null);
      delivery.twoFrameOpportunityAt = result?.finishedAt ?? null;
      delivery.streamToTwoFrameOpportunityMs = result?.notificationDispatchToTwoFrameOpportunityMs ?? null;
      delivery.completionToTwoFrameOpportunityMs = Number.isFinite(result?.finishedAt)
        ? Number((result.finishedAt - delivery.completionDispatchAt).toFixed(3))
        : null;
      delivery.finalAssistantRow = await page.evaluate((marker) => {
        const rows = [...document.querySelectorAll('[data-testid="message-assistant"]')];
        const row = rows.find((element) => (element.textContent ?? "").includes(marker));
        const list = document.querySelector('[data-testid="message-list"]');
        return row ? {
          present: true,
          textLength: (row.textContent ?? "").length,
          finalMarkerPresent: (row.textContent ?? "").includes(marker),
          rowIntersectsMessageListAtAgentRevision: Boolean(list) && (() => {
            const rowRect = row.getBoundingClientRect();
            const listRect = list.getBoundingClientRect();
            return rowRect.width > 0 && rowRect.height > 0
              && rowRect.right > listRect.left && rowRect.left < listRect.right
              && rowRect.bottom > listRect.top && rowRect.top < listRect.bottom;
          })(),
          rowRect: (() => { const rect = row.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; })(),
          listRect: list ? (() => { const rect = list.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; })() : null,
          failureMarkerPresent: Boolean(row.querySelector('[data-testid="message-attempt-failure"]')),
          unknownMarkerPresent: Boolean(row.querySelector('[data-testid="message-attempt-unknown"]')),
          runtimeTerminalUi: !document.querySelector('[data-testid="stop-turn"]')
            && Boolean(document.querySelector('[data-testid="send-message"]'))
            && !Boolean(document.querySelector('[data-testid="queue-message"]')),
        } : { present: false, textLength: null, finalMarkerPresent: false };
      }, finalMarker).catch(() => ({ present: false, textLength: null, finalMarkerPresent: false }));
      currentStreamPhase = "tail-following-final-marker";
      const finalMarkerVisibility = await scrollTranscriptToLatest(page, finalMarker, { requireMarkerVisible: true });
      delivery.finalMarkerVisibilityEvidence = {
        classification: "exact last-character DOM Range visibility after observed app-side layout/scroll movement or one real jump-to-latest touch, stable viewport samples, and two requestAnimationFrame opportunities",
        markerAlreadyVisibleBeforeTailFollow: finalMarkerVisibility.before.targetMarkerVisibleWithinMessageList,
        firstVisiblePoll: finalMarkerVisibility.firstTargetVisiblePoll,
        action: finalMarkerVisibility.action,
        pollCount: finalMarkerVisibility.pollCount,
        stableSamples: finalMarkerVisibility.stableSamples,
        startedAtPageTimeMs: finalMarkerVisibility.before.sampledAtPageTimeMs,
        completedAtPageTimeMs: finalMarkerVisibility.afterPageTimeMs,
        elapsedPageTimeMs: Number((finalMarkerVisibility.afterPageTimeMs - finalMarkerVisibility.before.sampledAtPageTimeMs).toFixed(3)),
        before: finalMarkerVisibility.before,
        afterTwoFrames: finalMarkerVisibility.after,
      };
      delivery.completionToFinalMarkerVisibleTwoFramesMs = Number((finalMarkerVisibility.afterPageTimeMs - delivery.completionDispatchAt).toFixed(3));
      delivery.finalAssistantRow.rowIntersectsMessageListAfterTailFollow = finalMarkerVisibility.after.targetVisibleWithinMessageList;
      delivery.finalAssistantRow.rowRectAfterTailFollow = finalMarkerVisibility.after.targetRowRect;
      delivery.finalAssistantRow.listRectAfterTailFollow = finalMarkerVisibility.after.messageListRect;
      delivery.finalAssistantRow.finalMarkerLastCharacterRect = finalMarkerVisibility.after.targetMarkerLastCharacterRect;
      delivery.finalAssistantRow.finalMarkerVisibleWithinMessageList = finalMarkerVisibility.after.targetMarkerVisibleWithinMessageList;
      delivery.finalAssistantRow.finalMarkerVisibleAfterTwoFrames = finalMarkerVisibility.afterTwoFrames === true;
      delivery.finalAssistantRow.tailFollowAction = finalMarkerVisibility.action;
      const longTasks = await page.evaluate((bounds) => window.__phoneRenderLongTasksBetween(bounds.start, bounds.end), {
        start: delivery.firstDeltaDispatchAt,
        end: delivery.twoFrameOpportunityAt,
      });
      const longAnimationFrames = await page.evaluate((bounds) => ({
        supported: window.__phoneRenderLongAnimationFrameSupport?.() === true,
        entries: window.__phoneRenderLongAnimationFramesBetween?.(bounds.start, bounds.end) ?? [],
      }), {
        start: delivery.firstDeltaDispatchAt,
        end: delivery.twoFrameOpportunityAt,
      });
      delivery.longAnimationFrames = longAnimationFrames;
      const observedFrames = [...setupResults, ...delivery.frameResults];
      const methods = observedFrames.map((frame) => frame.method);
      const sequences = observedFrames.map((frame) => frame.sequence);
      const expectedFrameCount = activeDeltaChunksPerStream + 3;
      const logicalMessageCountBeforeStream = count + (state.hiddenUpdateTurnsCompleted ?? 0) + streamIndex;
      const logicalMessageCountAfterStream = logicalMessageCountBeforeStream
        + (delivery.finalAssistantRow?.finalMarkerPresent === true ? 1 : 0);
      const dispatchOrderValid = observedFrames.length === expectedFrameCount
        && methods[0] === "turn/started"
        && methods[1] === "item/started"
        && methods.slice(2, -1).every((method) => method === "item/delta")
        && methods.at(-1) === "turn/completed"
        && observedFrames.every((frame) => frame.serverId === serverId && frame.threadId === threadId && frame.turnId === turnId)
        && sequences.every((sequence, index) => Number.isSafeInteger(sequence) && (index === 0 || sequence > sequences[index - 1]));
      const activeSocketIds = [...new Set(observedFrames.map((frame) => frame.browserMockId))];
      const deltaResults = delivery.frameResults.filter((frame) => frame.method === "item/delta");
      const completionResult = delivery.frameResults.find((frame) => frame.method === "turn/completed");
      const maximumDeltaHandlerSyncMs = deltaResults.length ? Math.max(...deltaResults.map((frame) => frame.dispatchHandlerSyncMs)) : null;
      const totalDeltaHandlerSyncMs = Number(deltaResults.reduce((sum, frame) => sum + frame.dispatchHandlerSyncMs, 0).toFixed(3));
      const maximumBrowserTaskWallMs = delivery.taskResults.length ? Math.max(...delivery.taskResults.map((task) => task.wallMs)) : null;
      const finalDeltaAndCompletionShareTask = delivery.taskResults.at(-1)?.frameMethods.join(",") === "item/delta,turn/completed";
      const finalFlushTimerWindowMs = 80;
      const finalFlushPendingAtCompletion = delivery.deltaBurstDispatchMs < finalFlushTimerWindowMs;
      currentStreamPhase = "validating-stream-success-gate";
      const streamOk = Boolean(result)
        && !error
        && dispatchOrderValid
        && activeSocketIds.length === 1
        && setupResults.every((frame) => frame.browserMockId === activeSocketIds[0])
        && delivery.browserMockId === activeSocketIds[0]
        && deltaResults.length === activeDeltaChunksPerStream
        && completionResult
        && finalDeltaAndCompletionShareTask
        && finalFlushPendingAtCompletion
        && result?.agentRevision?.fixtureMarkerPresent === true
        && delivery.finalAssistantRow?.finalMarkerPresent === true
        && delivery.finalAssistantRow?.finalMarkerVisibleWithinMessageList === true
        && delivery.finalAssistantRow?.finalMarkerVisibleAfterTwoFrames === true
        && delivery.finalAssistantRow?.runtimeTerminalUi === true
        && delivery.finalAssistantRow?.failureMarkerPresent === false
        && delivery.finalAssistantRow?.unknownMarkerPresent === false;
      currentStreamPhase = "recording-completed-stream-evidence";

      if (!diagnosticOnly) for (let chunkIndex = 0; chunkIndex < deltaResults.length; chunkIndex += 1) {
        const frame = deltaResults[chunkIndex];
        const metadata = deltaMetadata[chunkIndex];
        observations.push({
          source,
          requestedMessages: count,
          scenario: "active-markdown-delta-handler",
          panelState,
          sample: streamIndex * activeDeltaChunksPerStream + chunkIndex + 1,
          streamSample,
          chunkIndex: metadata.chunkIndex,
          durationMs: frame.dispatchHandlerSyncMs,
          synchronousEventTaskMs: frame.dispatchHandlerSyncMs,
          websocketDispatchHandlerSyncMs: [frame.dispatchHandlerSyncMs],
          deltaBytes: metadata.deltaBytes,
          cumulativeActiveMarkdownBytes: totalDeltaBytes - burstDeltaBytes + deltaMetadata.slice(0, chunkIndex + 1).reduce((sum, item) => sum + item.deltaBytes, 0),
          longTasks: [],
          ok: streamOk && frame.sequence === deltaFrames[chunkIndex].params.sequence,
          timingSource: "one item/delta MessageEvent handler on a separate MessageChannel browser task during a 30-delta active burst; handler sync time is a subsample and not a separate stream sample",
        });
      }

      if (!diagnosticOnly) observations.push({
        source,
        requestedMessages: count,
        scenario: "active-markdown-stream",
        panelState,
        sample: streamSample,
        deltaFrames: deltaResults.length,
        deltaBytes: burstDeltaBytes,
        totalActiveStreamBytes: totalDeltaBytes,
        deltaBurstDispatchMs: delivery.deltaBurstDispatchMs,
        finalFlushTimerWindowMs,
        finalFlushPendingAtCompletion,
        durationMs: result?.notificationDispatchToTwoFrameOpportunityMs ?? delivery.streamToTwoFrameOpportunityMs,
        notificationDispatchToAgentRevisionMs: result?.notificationDispatchToAgentRevisionMs ?? null,
        notificationDispatchToTwoFrameOpportunityMs: result?.notificationDispatchToTwoFrameOpportunityMs ?? null,
        websocketDispatchHandlerSyncMs: deltaResults.map((frame) => frame.dispatchHandlerSyncMs),
        totalDeltaHandlerSyncMs,
        maximumDeltaHandlerSyncMs,
        completionHandlerSyncMs: completionResult?.dispatchHandlerSyncMs ?? null,
        maximumBrowserTaskWallMs,
        agentRevision: result?.agentRevision ?? null,
        finalAssistantRow: delivery.finalAssistantRow,
        logicalMessageCountBeforeStream,
        logicalMessageCountAfterStream,
        transcriptViewportBeforeBurst,
        longTasks,
        longAnimationFrames,
        ok: streamOk,
        finalMarkerVisibilityEvidence: delivery.finalMarkerVisibilityEvidence,
        completionToFinalMarkerVisibleTwoFramesMs: delivery.completionToFinalMarkerVisibleTwoFramesMs,
        completionToAgentRevisionTwoFrameOpportunityMs: delivery.completionToTwoFrameOpportunityMs,
        timingSource: "one independent active turn with 30 long Markdown/table/code deltas on MessageChannel browser tasks; stream latency ends at Agent-row revision plus two requestAnimationFrame opportunities; exact final-marker last-character visibility after actual tail-follow is recorded separately, without Gateway transport or compositor timestamp",
        ...(error ? { error: String(error.message || error).slice(0, 300) } : {}),
      });
      const finalFlushDurationMs = delivery.completionToFinalMarkerVisibleTwoFramesMs;
      if (!diagnosticOnly) observations.push({
      source,
      requestedMessages: count,
      scenario: "active-markdown-final-flush",
      panelState,
      sample: streamSample,
      durationMs: finalFlushDurationMs,
      completionToFinalMarkerVisibleTwoFramesMs: finalFlushDurationMs,
      completionToAgentRevisionTwoFrameOpportunityMs: delivery.completionToTwoFrameOpportunityMs,
      websocketDispatchHandlerSyncMs: completionResult ? [completionResult.dispatchHandlerSyncMs] : [],
      synchronousEventTaskMs: completionResult?.dispatchHandlerSyncMs ?? null,
      finalAssistantRow: delivery.finalAssistantRow,
      finalMarkerVisibilityEvidence: delivery.finalMarkerVisibilityEvidence,
      finalMarker,
      finalFlushPendingAtCompletion,
      deltaBurstDispatchMs: delivery.deltaBurstDispatchMs,
      finalFlushTimerWindowMs,
      longTasks: [],
      ok: streamOk,
      timingSource: "terminal turn/completed synchronous handler after the final long delta in the same browser task; duration continues separately until the final marker's last-character DOM Range intersects the message-list viewport after actual tail-follow, stable viewport samples, and two requestAnimationFrame opportunities",
      });

      state.syntheticNotificationFramesSent = (state.syntheticNotificationFramesSent ?? 0) + setupFrames.length + delivery.delivered;
      bursts.push({
        streamSample,
        turnId,
        attemptId,
        itemId,
        deltaChunkCount: deltaResults.length,
        totalDeltaBytes: burstDeltaBytes,
        methods,
        sequences,
        serverId,
        threadId,
        browserMockIds: activeSocketIds,
        threadReadRequestId: state.activeThreadReadRequestId,
        setupFrames: setupResults,
        dispatchOrderValid,
        finalDeltaAndCompletionShareTask,
        deltaBurstDispatchMs: delivery.deltaBurstDispatchMs,
        finalFlushPendingAtCompletion,
        finalMarker,
        finalAssistantRow: delivery.finalAssistantRow,
        finalMarkerVisibilityEvidence: delivery.finalMarkerVisibilityEvidence,
        logicalMessageCountBeforeStream,
        logicalMessageCountAfterStream,
        transcriptViewportBeforeBurst,
        agentRevision: result?.agentRevision ?? null,
        streamToTwoFrameOpportunityMs: result?.notificationDispatchToTwoFrameOpportunityMs ?? delivery.streamToTwoFrameOpportunityMs,
        notificationDispatchToAgentRevisionMs: result?.notificationDispatchToAgentRevisionMs ?? null,
        completionToTwoFrameOpportunityMs: delivery.completionToTwoFrameOpportunityMs,
        completionToFinalMarkerVisibleTwoFramesMs: finalFlushDurationMs,
        completionToAgentRevisionTwoFrameOpportunityMs: delivery.completionToTwoFrameOpportunityMs,
        deltaHandlerSyncMs: deltaResults.map((frame) => frame.dispatchHandlerSyncMs),
        totalDeltaHandlerSyncMs,
        maximumDeltaHandlerSyncMs,
        completionHandlerSyncMs: completionResult?.dispatchHandlerSyncMs ?? null,
        maximumBrowserTaskWallMs,
        longTasks,
        longAnimationFrames,
        ok: streamOk,
      });
      if (streamOk) previousTailMarker = finalMarker;
      currentExpectedTailMarker = previousTailMarker;
      currentTranscriptViewportBeforeBurst = delivery.finalMarkerVisibilityEvidence?.afterTwoFrames ?? transcriptViewportBeforeBurst;
      currentStreamPhase = streamOk ? "completed-stream-gate-passed" : "completed-stream-gate-failed";
    }
    const allBurstsValid = bursts.length === samples && bursts.every((burst) => burst.ok && burst.dispatchOrderValid && burst.finalAssistantRow?.finalMarkerPresent === true && burst.finalAssistantRow?.finalMarkerVisibleWithinMessageList === true && burst.finalAssistantRow?.finalMarkerVisibleAfterTwoFrames === true && burst.finalAssistantRow?.runtimeTerminalUi === true && burst.finalAssistantRow?.failureMarkerPresent === false && burst.finalAssistantRow?.unknownMarkerPresent === false);
    state.activeStreamEvidence = {
      burstCount: bursts.length,
      deltaChunksPerBurst: activeDeltaChunksPerStream,
      deltaFrameCount: bursts.reduce((sum, burst) => sum + burst.deltaChunkCount, 0),
      totalDeltaBytes,
      activeAssistantTurnsAdded: bursts.filter((burst) => burst.ok).length,
      logicalMessageCountBeforeStreams: count + (state.hiddenUpdateTurnsCompleted ?? 0),
      expectedLogicalMessageCountAfterStreams: count + (state.hiddenUpdateTurnsCompleted ?? 0) + bursts.filter((burst) => burst.ok).length,
      bursts,
      serverId,
      threadId,
      threadReadRequestId: state.activeThreadReadRequestId,
      dispatchOrderValid: allBurstsValid,
      finalAssistantRow: bursts.at(-1)?.finalAssistantRow ?? null,
      finalFlushDurationMs: bursts.at(-1)?.completionToTwoFrameOpportunityMs ?? null,
      deltaSamplesSucceeded: diagnosticOnly
        ? bursts.reduce((total, burst) => total + (burst.ok ? burst.deltaChunkCount : 0), 0)
        : observations.filter((entry) => entry.scenario === "active-markdown-delta-handler" && entry.ok).length,
      deltaHandlerSampleCount: diagnosticOnly
        ? bursts.reduce((total, burst) => total + burst.deltaChunkCount, 0)
        : observations.filter((entry) => entry.scenario === "active-markdown-delta-handler").length,
      streamSampleCount: bursts.length,
    };
  } catch (error) {
    throw attachActiveStreamFailureEvidence(error, currentStreamPhase);
  } finally {
    if (profileSession) {
      try {
      const { profile } = await profileSession.send("Profiler.stop");
      profileEndClock = await captureCdpClockAnchor(profileSession, page);
      cpuProfile = summarizeCpuProfile(profile, {
        source,
        requestedMessages: count,
        panelState,
        profileKind: options.profileKind ?? "separate diagnostic burst, excluded from core latency samples",
        diagnosticActiveMarkdownBursts: samples,
          deltaChunksPerStream: activeDeltaChunksPerStream,
          profilerSamplingIntervalUs: 500,
          profileWallTimeMs: Number((performance.now() - profileStartedAt).toFixed(3)),
        }, { start: profileStartClock, end: profileEndClock }, bursts.flatMap((burst) => burst.longTasks ?? []), approvedScriptBaseUrl);
      } catch (error) {
        cpuProfileError = String(error.message || error).slice(0, 300);
      }
      await profileSession.send("Profiler.disable").catch(() => {});
      await profileSession.detach().catch(() => {});
    }
  }
  if (cpuProfileError) state.activeStreamEvidence = { ...state.activeStreamEvidence, cpuProfileError };
  return { observations, cpuProfile, evidence: state.activeStreamEvidence };
}

async function dispatchActiveFrame(page, state, frame, options = {}) {
  const result = await page.evaluate((payload) => window.__phoneRenderDispatchFrameInTask(payload), {
    frame,
    server: serverId,
    channel: "runtime",
    workspace: state.workspacePath,
    threadId,
    threadReadId: state.activeThreadReadRequestId,
    ...options,
  });
  return result;
}

async function dispatchActiveStreamFrames(page, state, frames, finalMarker) {
  return page.evaluate((payload) => window.__phoneRenderDispatchActiveStreamInTasks(payload), {
    frames,
    finalMarker,
    server: serverId,
    channel: "runtime",
    workspace: state.workspacePath,
    threadId,
    threadReadId: state.activeThreadReadRequestId,
  });
}

function makeLongMarkdownDelta(marker, index) {
  const paragraph = "The active transcript streams deterministic Markdown text while the Mobile UI parses and lays out a changing assistant message. ".repeat(4);
  const code = Array.from({ length: 12 }, (_, line) => `export const stream_${index}_${line} = (value: number) => value + ${line};`).join("\n");
  return [
    `\n\n### Live Markdown chunk ${index + 1}\n`,
    paragraph,
    `\n\n| chunk | state | notes |\n| --- | --- | --- |\n| ${index + 1} | streaming | ${marker} |\n`,
    "\n```typescript\n",
    code,
    "\n```\n\n",
    `${marker}\n`,
  ].join("");
}

async function measureSnapshotUpdates(page, state, source, count, panelState, samples, context) {
  const output = [];
  let currentSample = null;
  let currentMarker = null;
  let currentExpectedTailMarker = null;
  let currentViewportBeforeUpdate = null;
  try {
    for (let index = 0; index < samples; index += 1) {
      currentSample = index + 1;
      currentMarker = null;
      currentExpectedTailMarker = null;
      currentViewportBeforeUpdate = null;
      const variant = panelState === "mounted-hidden" ? "mounted" : "unmounted";
      const expectedTailMarker = index === 0
        ? `seed-${source}-${count}-${panelState}`
        : `UX-${source}-${count}-${variant}-${index - 1}`;
      currentExpectedTailMarker = expectedTailMarker;
      currentViewportBeforeUpdate = await scrollTranscriptToLatest(page, expectedTailMarker);
      const transcriptViewportBeforeUpdate = currentViewportBeforeUpdate;
      const marker = `UX-${source}-${count}-${variant}-${index}`;
      currentMarker = marker;
      const id = `changes-${source}-${count}-${variant}-${index}`;
      const mutationObserverArmed = await page.evaluate(({ value, markerValue }) => window.__phoneRenderArmMutation(value, markerValue), { value: id, markerValue: marker });
      assert.equal(mutationObserverArmed.observedRoot, true, `${panelState} Agent content revision observer must be attached`);
      assert.equal(mutationObserverArmed.primaryBoundary, "changed assistant-row text under Mobile message-list followed by two requestAnimationFrame callbacks");
      const startedAt = performance.now();
      let error = null;
      let delivery = null;
      try {
        assert.ok(state.activeSocketRoute, "isolated Mobile runtime route must have completed the fixture thread/read before snapshot injection");
        delivery = await emitSyntheticTaskSnapshot(page, state, marker, {
          artifactId: id,
          workspacePath: state.workspacePath,
          fileCount: 16,
          additions: 160 + index,
          deletions: 24 + index,
          files: [`${state.workspacePath}/src/${marker}-fixture.ts`, ...Array.from({ length: 15 }, (_, fileIndex) => `${state.workspacePath}/src/fixture-${index}-${fileIndex}.ts`)],
          status: "active",
          revertible: true,
        });
        await page.waitForFunction((value) => Boolean(window.__phoneRenderMutationResult(value)), id, { timeout: 5_000 });
      } catch (caught) { error = caught; }
      const result = await page.evaluate((value) => window.__phoneRenderMutationResult(value), id).catch(() => null);
      const longTasks = result ? await collectLongTasks(page, result) : [];
      output.push({
        source,
        requestedMessages: count,
        scenario: `hidden-changes-update-${panelState}`,
        panelState,
        sample: index + 1,
        marker,
        transcriptViewportBeforeUpdate,
        durationMs: result?.durationMs ?? null,
        fixtureHarnessElapsedToAgentRevisionMs: result ? Number((performance.now() - startedAt).toFixed(3)) : null,
        armToNotificationDispatchMs: result?.armToNotificationDispatchMs ?? null,
        notificationDispatchToAgentRevisionMs: result?.notificationDispatchToAgentRevisionMs ?? null,
        notificationDispatchToTwoFrameOpportunityMs: result?.notificationDispatchToTwoFrameOpportunityMs ?? null,
        agentRevision: result?.agentRevision ?? null,
        changesFilenameMarkerObserved: result?.changesFilenameMarkerObserved ?? false,
        changesFilenameMarkerAt: result?.changesFilenameMarkerAt ?? null,
        mutationObserverCallbackMs: result?.mutationObserverCallbackMs ?? null,
        synchronousEventTaskMs: result?.synchronousEventTaskMs ?? null,
        websocketDispatchMethods: delivery?.dispatchMethods ?? [],
        websocketDispatchHandlerSyncMs: delivery?.dispatchTaskDurationsMs ?? [],
        websocketDispatchHandlerSyncMaxMs: delivery?.maximumDispatchTaskMs ?? null,
        syntheticNotificationFramesDispatchedToAppMock: delivery?.delivered ?? 0,
        longTasks,
        ok: Boolean(result) && !error,
        timingSource: "test-side synthetic Mobile runtime WebSocket notifications through changed Agent assistant-row content to two requestAnimationFrame presentation opportunities; the mounted-hidden Changes filename is a supplemental observation only; excludes Gateway network transport",
        ...(error ? { error: String(error.message || error).slice(0, 400) } : {}),
      });
      currentSample = null;
      currentMarker = null;
      currentExpectedTailMarker = null;
      currentViewportBeforeUpdate = null;
    }
  } catch (error) {
    await context.writeArtifactJson(`phone-render-profile-failure-${source}-${count}-${panelState}.json`, {
      schemaVersion: 1,
      failureStage: "hidden-update-loop",
      source,
      requestedMessages: count,
      panelState,
      expectedUpdateCount: samples,
      completedUpdateResultCount: output.length,
      currentSample,
      currentMarker,
      currentExpectedTailMarker,
      currentViewportBeforeUpdate,
      helperViewport: error?.transcriptViewport ?? error?.cause?.transcriptViewport ?? null,
      hiddenUpdateResults: output,
      error: {
        name: error?.name ?? "Error",
        message: String(error?.message || error).slice(0, 2000),
        stack: typeof error?.stack === "string" ? error.stack.slice(0, 8000) : null,
      },
    });
    throw error;
  }
  return output;
}

async function captureCdpClockAnchor(session, page) {
  const pageBeforeMs = await page.evaluate(() => performance.now());
  const metrics = await session.send("Performance.getMetrics");
  const pageAfterMs = await page.evaluate(() => performance.now());
  const timestampSeconds = metrics.metrics?.find((metric) => metric.name === "Timestamp")?.value;
  const pageMidpointMs = (pageBeforeMs + pageAfterMs) / 2;
  const cdpTimestampMs = Number.isFinite(timestampSeconds) ? timestampSeconds * 1000 : null;
  return {
    pageBeforeMs: Number(pageBeforeMs.toFixed(3)),
    pageAfterMs: Number(pageAfterMs.toFixed(3)),
    pageMidpointMs: Number(pageMidpointMs.toFixed(3)),
    bracketWidthMs: Number((pageAfterMs - pageBeforeMs).toFixed(3)),
    cdpTimestampMs: Number.isFinite(cdpTimestampMs) ? Number(cdpTimestampMs.toFixed(3)) : null,
    cdpMinusPageMidpointMs: Number.isFinite(cdpTimestampMs) ? Number((cdpTimestampMs - pageMidpointMs).toFixed(3)) : null,
  };
}

function summarizeCpuProfile(profile, metadata, clockAnchors, longTasks, approvedScriptBaseUrl = null) {
  const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node]));
  const parentById = new Map();
  for (const node of nodes.values()) {
    for (const childId of node.children ?? []) {
      if (!parentById.has(childId)) parentById.set(childId, node.id);
    }
  }
  const durations = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let sampledMicros = 0;
  const sampleRecords = [];
  const stackFor = (nodeId) => {
    const stack = [];
    const seen = new Set();
    let currentId = nodeId;
    while (currentId !== undefined && !seen.has(currentId) && stack.length < 24) {
      seen.add(currentId);
      const node = nodes.get(currentId);
      if (!node) break;
      const frame = node.callFrame ?? {};
      const scriptUrlIdentity = recordScriptUrlIdentity(frame.url, approvedScriptBaseUrl);
      stack.push({
        functionName: frame.functionName || "(anonymous)",
        scriptPath: safePath(frame.url),
        scriptUrlIdentity,
        lineNumber: frame.lineNumber ?? null,
        columnNumber: frame.columnNumber ?? null,
      });
      currentId = parentById.get(currentId);
    }
    return stack;
  };
  let elapsedMicros = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const micros = Number(deltas[index] ?? 0);
    sampledMicros += micros;
    elapsedMicros += micros;
    const node = nodes.get(samples[index]);
    if (!node) continue;
    const frame = node.callFrame ?? {};
    const scriptUrlIdentity = recordScriptUrlIdentity(frame.url, approvedScriptBaseUrl);
    const key = `${frame.functionName || "(anonymous)"}|${JSON.stringify(scriptUrlIdentity)}|${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0}`;
    const current = durations.get(key) ?? {
      functionName: frame.functionName || "(anonymous)",
      scriptPath: safePath(frame.url),
      scriptUrlIdentity,
      lineNumber: frame.lineNumber ?? null,
      columnNumber: frame.columnNumber ?? null,
      selfSampledMs: 0,
      samples: 0,
    };
    current.selfSampledMs += micros / 1000;
    current.samples += 1;
    durations.set(key, current);
    sampleRecords.push({
      profileTimeUs: profile.startTime + elapsedMicros,
      pageTimeMs: null,
      sampleWeightMs: micros / 1000,
      stack: stackFor(samples[index]),
    });
  }
  const startAnchor = clockAnchors?.start;
  const endAnchor = clockAnchors?.end;
  const offsetMs = Number.isFinite(startAnchor?.cdpMinusPageMidpointMs) && Number.isFinite(endAnchor?.cdpMinusPageMidpointMs)
    ? (startAnchor.cdpMinusPageMidpointMs + endAnchor.cdpMinusPageMidpointMs) / 2
    : null;
  const clockDriftMs = Number.isFinite(offsetMs)
    ? Number((endAnchor.cdpMinusPageMidpointMs - startAnchor.cdpMinusPageMidpointMs).toFixed(3))
    : null;
  const clockAlignmentValid = Number.isFinite(offsetMs)
    && Number.isFinite(clockDriftMs)
    && Math.abs(clockDriftMs) <= 10
    && (startAnchor.bracketWidthMs ?? Infinity) <= 10
    && (endAnchor.bracketWidthMs ?? Infinity) <= 10;
  // The CDP Profile uses monotonic microseconds; page long-task timestamps use
  // performance.now(). Only correlate them when the bracketing clock checks agree.
  if (clockAlignmentValid) {
    for (const sample of sampleRecords) sample.pageTimeMs = Number((sample.profileTimeUs / 1000 - offsetMs).toFixed(3));
  }
  const longTaskStackAttribution = (longTasks ?? []).map((task) => {
    if (!clockAlignmentValid) return { longTask: task, status: "UNVERIFIED_CLOCK_ALIGNMENT", sampleCount: 0, sampledMs: 0, topStacks: [] };
    const taskEndMs = task.startTimeMs + task.durationMs;
    const taskSamples = sampleRecords.filter((sample) => sample.pageTimeMs >= task.startTimeMs && sample.pageTimeMs <= taskEndMs);
    const stacks = new Map();
    for (const sample of taskSamples) {
      const key = JSON.stringify(sample.stack);
      const current = stacks.get(key) ?? { stack: sample.stack, sampleCount: 0, sampledMs: 0 };
      current.sampleCount += 1;
      current.sampledMs += sample.sampleWeightMs;
      stacks.set(key, current);
    }
    return {
      longTask: task,
      status: taskSamples.length > 0 ? "PROFILE_SAMPLES_OVERLAP" : "NO_PROFILE_SAMPLES_IN_INTERVAL",
      sampleCount: taskSamples.length,
      sampledMs: Number(taskSamples.reduce((sum, sample) => sum + sample.sampleWeightMs, 0).toFixed(3)),
      topStacks: [...stacks.values()].map((item) => ({ ...item, sampledMs: Number(item.sampledMs.toFixed(3)) })).sort((left, right) => right.sampledMs - left.sampledMs).slice(0, 12),
    };
  });
  return {
    ...metadata,
    profilerSamplingIntervalUs: 500,
    sampleCount: samples.length,
    totalSampledMs: Number((sampledMicros / 1000).toFixed(3)),
    topFunctions: [...durations.values()].map((item) => ({ ...item, selfSampledMs: Number(item.selfSampledMs.toFixed(3)) })).sort((left, right) => right.selfSampledMs - left.selfSampledMs).slice(0, 40),
    profileWindow: { startTimeUs: profile.startTime, endTimeUs: profile.endTime },
    clockAlignment: {
      method: "CDP Performance.getMetrics Timestamp bracketing page performance.now, compared at profile start and stop",
      timeOffsetMs: Number.isFinite(offsetMs) ? Number(offsetMs.toFixed(3)) : null,
      driftMs: clockDriftMs,
      startAnchor,
      endAnchor,
      status: clockAlignmentValid ? "ALIGNED_WITHIN_10MS" : "UNVERIFIED",
      profileWindowPageTimeMs: clockAlignmentValid ? {
        start: Number((profile.startTime / 1000 - offsetMs).toFixed(3)),
        end: Number((profile.endTime / 1000 - offsetMs).toFixed(3)),
      } : null,
    },
    longTaskStackAttribution,
  };
}

async function mapCpuProfileWithSourceMaps(profile, bundleRoot, sourceMapEvidence, expectedBundleSha256) {
  assert.ok(sourceMapEvidence?.enabled === true, "core attribution requires enabled source-map evidence");
  assert.equal(sourceMapEvidence.bundleSha256, expectedBundleSha256, "source maps must bind to the exact profile input bundle");
  const mobileRequire = createRequire(resolve(repoRoot, "apps/kcoder-studio/mobile/package.json"));
  const traceMapping = mobileRequire("@jridgewell/trace-mapping");
  const traceMaps = new Map();
  const getMapForFrame = async (frame) => {
    const binding = resolveScriptMapBinding(frame?.scriptUrlIdentity, sourceMapEvidence.mapFiles.map((entry) => entry.path));
    if (binding.status !== "EXACT_BUNDLE_PATH_MATCH") return { binding, selectedMap: null };
    const { mapPath, generatedPath } = binding;
    if (!traceMaps.has(mapPath)) {
      const mapEntry = sourceMapEvidence.mapFiles.find((entry) => entry.path === mapPath);
      const mapBytes = await readVerifiedMobileExportFile(bundleRoot, mapEntry, "core attribution source map");
      const mapJson = JSON.parse(mapBytes.toString("utf8"));
      assert.equal(mapJson.version, 3, `source map ${mapPath} must use version 3`);
      traceMaps.set(mapPath, {
        generatedPath,
        traceMap: new traceMapping.TraceMap(mapJson, mapPath),
      });
    }
    return { binding, selectedMap: traceMaps.get(mapPath) };
  };
  const mapFrame = async (frame) => {
    const { binding, selectedMap } = await getMapForFrame(frame);
    const generatedPosition = {
      scriptPath: frame?.scriptPath ?? null,
      scriptUrlIdentity: frame?.scriptUrlIdentity ?? null,
      lineNumber: frame?.lineNumber ?? null,
      columnNumber: frame?.columnNumber ?? null,
    };
    if (!selectedMap) return { ...generatedPosition, sourceMapStatus: binding.status, originalPosition: null };
    return {
      ...generatedPosition,
      sourceMapPath: [...traceMaps.entries()].find(([, value]) => value === selectedMap)?.[0] ?? null,
      sourceMapStatus: binding.status,
      originalPosition: mapGeneratedProfilePosition(selectedMap.traceMap, frame, traceMapping),
    };
  };

  const mappedTopFunctions = [];
  for (const frame of profile.topFunctions ?? []) {
    mappedTopFunctions.push({ ...frame, originalPosition: await mapFrame(frame) });
  }
  const mappedLongTaskAttribution = [];
  for (const task of profile.longTaskStackAttribution ?? []) {
    const topStacks = [];
    for (const stack of task.topStacks ?? []) {
      const frames = [];
      for (const frame of stack.stack ?? []) frames.push({ ...frame, originalPosition: await mapFrame(frame) });
      topStacks.push({ ...stack, stack: frames });
    }
    mappedLongTaskAttribution.push({ ...task, topStacks });
  }
  const mappedFrameCount = mappedTopFunctions.reduce((count, frame) =>
    count + (frame.originalPosition.originalPosition?.status === "MAPPED" ? 1 : 0), 0)
    + mappedLongTaskAttribution.flatMap((task) => task.topStacks).flatMap((stack) => stack.stack)
      .filter((frame) => frame.originalPosition.originalPosition?.status === "MAPPED").length;
  return {
    bundleSha256: sourceMapEvidence.bundleSha256,
    sourceMapEvidenceDigest: sha256(Buffer.from(JSON.stringify(sourceMapEvidence))),
    mapFiles: sourceMapEvidence.mapFiles,
    mappedFrameCount,
    unmappedFrameCount: mappedTopFunctions.length
      + mappedLongTaskAttribution.flatMap((task) => task.topStacks).reduce((count, stack) => count + stack.stack.length, 0)
      - mappedFrameCount,
    mappedTopFunctions,
    mappedLongTaskAttribution,
  };
}

async function sendSyntheticSnapshot(page, state, marker, sequence, measure, options = {}) {
  const id = `seed-${marker}`;
  const runtimeProbe = runtimeConsumerDiagnostic && !measure
    ? { configuration: null, reads: [] }
    : null;
  if (measure) await page.evaluate(({ value, markerValue }) => window.__phoneRenderArmMutation(value, markerValue), { value: id, markerValue: marker });
  assert.ok(state.activeSocketRoute, "isolated Mobile runtime route must have completed the fixture thread/read before fixture seed");
  let traceActive = false;
  if (!measure && captureSeedUiDomTrace) {
    await page.evaluate(beginSeedUiTraceInPage, { marker });
    state.seedUiTraceActive = true;
    traceActive = true;
  }
  if (!measure) state.seedDispatchCaptureActive = true;
  let delivery = null;
  if (!measure) {
    let failurePhase = "seed-notification-dispatch";
    try {
      if (runtimeProbe) {
        runtimeProbe.configuration = await configureRuntimeConsumerProbe(page, marker);
      }
      delivery = await emitSyntheticTaskSnapshot(page, state, marker, { artifactId: id, workspacePath: state.workspacePath, fileCount: 16, additions: 160, deletions: 24, files: Array.from({ length: 16 }, (_, index) => `${state.workspacePath}/seed-${index}.ts`), status: "active", revertible: true });
      if (runtimeProbe) runtimeProbe.reads.push(await readRuntimeConsumerProbe(page, runtimeProbe, "after-four-frame-app-mock-dispatch"));
      const seedDispatch = state.lastSeedDispatchEvidence ?? summarizeSeedDispatchEvidence(state, marker, delivery);
      failurePhase = "seed-visible-tail-settlement";
      const transcriptViewport = options.deferTailGate === true
        ? null
        : await scrollTranscriptToLatest(page, marker, {
            requireMarkerVisible: true,
            captureVirtualizedGeometry: runtimeConsumerDiagnostic,
          });
      if (runtimeProbe) runtimeProbe.reads.push(await readRuntimeConsumerProbe(page, runtimeProbe, "after-existing-seed-marker-visibility-and-geometry-gate"));
      const seedUiTrace = traceActive ? await page.evaluate(endSeedUiTraceInPage) : null;
      state.seedUiTraceActive = false;
      traceActive = false;
      state.seedDispatchCaptureActive = false;
      return { ok: true, measured: false, transcriptViewport, seedDispatch, seedUiTrace, runtimeProbe };
    } catch (cause) {
      if (runtimeProbe?.configuration?.status === "CONFIGURED" && runtimeProbe.reads.length < 2) {
        runtimeProbe.reads.push(await readRuntimeConsumerProbe(page, runtimeProbe, "after-seed-gate-failure-without-extra-wait"));
      }
      const diagnosticDom = await captureSeedFailureDom(page, state, marker).catch((diagnosticError) => ({
        captureError: safeSeedErrorMessage(diagnosticError),
      }));
      const seedUiTrace = traceActive ? await page.evaluate(endSeedUiTraceInPage).catch((traceError) => ({
        captureError: safeSeedErrorMessage(traceError),
      })) : null;
      state.seedUiTraceActive = false;
      traceActive = false;
      state.seedDispatchCaptureActive = false;
      const error = new Error(`seed delivery or visible-tail gate failed for ${state.source}/${state.count}/${state.panelState}`);
      error.seedFailureEvidence = {
        failurePhase,
        seedDispatch: state.lastSeedDispatchEvidence ?? summarizeSeedDispatchEvidence(state, marker, delivery),
        transcriptViewport: summarizeSeedTranscriptViewport(cause?.transcriptViewport ?? null),
        diagnosticDom,
        seedUiTrace,
        runtimeProbe,
        error: {
          name: cause?.name ?? "Error",
          message: safeSeedErrorMessage(cause),
          stack: safeSeedErrorStack(cause),
        },
      };
      throw error;
    } finally {
      state.seedDispatchCaptureActive = false;
      if (traceActive) {
        await page.evaluate(endSeedUiTraceInPage).catch(() => null);
        state.seedUiTraceActive = false;
      }
    }
  }
  delivery = await emitSyntheticTaskSnapshot(page, state, marker, { artifactId: id, workspacePath: state.workspacePath, fileCount: 16, additions: 160, deletions: 24, files: Array.from({ length: 16 }, (_, index) => `${state.workspacePath}/seed-${index}.ts`), status: "active", revertible: true });
  await page.waitForFunction((value) => Boolean(window.__phoneRenderMutationResult(value)), id, { timeout: 5_000 });
  return { ok: true, measured: true, delivery };
}



async function readRuntimeConsumerProbe(page, runtimeProbe, stage) {
  if (runtimeProbe?.configuration?.status !== "CONFIGURED") {
    return {
      stage: String(stage).slice(0, 64),
      status: "NOT_RUN_CONFIGURATION_UNAVAILABLE",
      configurationStatus: String(runtimeProbe?.configuration?.status ?? "PROBE_NOT_CONFIGURED").slice(0, 48),
      records: [],
    };
  }
  return drainRuntimeConsumerProbe(page, stage);
}

async function drainRuntimeConsumerProbe(page, stage) {
  try {
    return await page.evaluate((stageName) => {
    const probe = window.__phoneRuntimeProbe;
    if (!probe || typeof probe.drain !== "function") {
      return { stage: stageName, status: "PROBE_GLOBAL_UNAVAILABLE", records: [] };
    }
    let value;
    try { value = probe.drain(); }
    catch { return { stage: stageName, status: "PROBE_DRAIN_FAILED", records: [] }; }
    const asInt = (input) => Number.isSafeInteger(input) && input >= 0 ? input : null;
    const asText = (input, max = 48) => typeof input === "string" ? input.slice(0, max) : null;
    const asBoolean = (input) => typeof input === "boolean" ? input : null;
    const normalizeProjection = (input) => {
      if (!input || typeof input !== "object") return null;
      return {
        messageCount: asInt(input.messageCount),
        assistantMatchCount: asInt(input.assistantMatchCount),
        lastAssistantMessageIdFingerprint: asText(input.lastAssistantMessageIdFingerprint, 16),
        lastAssistantAttemptFingerprint: asText(input.lastAssistantAttemptFingerprint, 16),
        lastAssistantStatus: asText(input.lastAssistantStatus, 32),
        contentMarkerPresent: asBoolean(input.contentMarkerPresent),
        orderedTextMarkerPresent: asBoolean(input.orderedTextMarkerPresent),
        renderedTextMarkerPresent: asBoolean(input.renderedTextMarkerPresent),
        orderedTextBlockCount: asInt(input.orderedTextBlockCount),
        contentLength: asInt(input.contentLength),
        orderedTextLength: asInt(input.orderedTextLength),
        running: asBoolean(input.running),
        connected: asBoolean(input.connected),
        disposed: asBoolean(input.disposed),
      };
    };
    const normalizeLegacySnapshot = (input) => {
      if (!input || typeof input !== "object") return null;
      return {
        messageCount: asInt(input.messageCount),
        assistantMatchCount: asInt(input.assistantMatchCount),
        contentLength: asInt(input.contentLength),
        markerPresent: asBoolean(input.markerPresent),
        status: asText(input.status, 32),
        running: asBoolean(input.running),
        connected: asBoolean(input.connected),
        disposed: asBoolean(input.disposed),
      };
    };
    const sourceRecords = Array.isArray(value?.records) ? value.records : [];
    const records = sourceRecords.slice(0, 64).map((row) => {
      const legacySnapshot = normalizeLegacySnapshot(row?.snapshot);
      return {
        ordinal: asInt(row?.ordinal),
        kind: asText(row?.kind, 32),
        runtimeInstanceOrdinal: asInt(row?.runtimeInstanceOrdinal),
        threadFingerprint: asText(row?.threadFingerprint, 16),
        turnFingerprint: asText(row?.turnFingerprint, 16),
        itemFingerprint: asText(row?.itemFingerprint, 16),
        rpcMethod: asText(row?.rpcMethod, 40),
        arrivalOrdinal: asInt(row?.arrivalOrdinal),
        projection: normalizeProjection(row?.projection),
        runtimeProjectionAtEffect: normalizeProjection(row?.runtimeProjectionAtEffect),
        panelSnapshotSameAsRuntimeAtEffect: asBoolean(row?.panelSnapshotSameAsRuntimeAtEffect),
        legacySnapshot,
        snapshot: legacySnapshot,
      };
    });
    return {
      stage: stageName,
      status: value?.schemaVersion === 1 && value?.limit === 64 && Array.isArray(value?.records) ? "CAPTURED" : "INVALID_PROBE_ENVELOPE",
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      schemaVersion: value?.schemaVersion === 1 ? 1 : null,
      limit: value?.limit === 64 ? 64 : null,
      dropped: asInt(value?.dropped),
      sourceRecordCount: sourceRecords.length,
      harnessTruncated: sourceRecords.length > 64,
      records,
    };
    }, String(stage).slice(0, 64));
  } catch (error) {
    return {
      stage: String(stage).slice(0, 64),
      status: "PROBE_PAGE_READ_FAILED",
      sampledAtPageTimeMs: null,
      schemaVersion: null,
      limit: null,
      dropped: null,
      sourceRecordCount: null,
      harnessTruncated: false,
      records: [],
      readError: safeSeedErrorMessage(error),
    };
  }
}

function buildRuntimeConsumerSeedDiagnostic(source, state, seed, mobileWeb) {
  const probe = seed.runtimeProbe ?? { configuration: null, reads: [] };
  const reads = Array.isArray(probe.reads) ? probe.reads.slice(0, 2) : [];
  const records = reads.flatMap((read) => Array.isArray(read.records) ? read.records : []).slice(0, 128);
  const identity = probe.configuration?.identity ?? {};
  const fingerprint = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  const legacyRpcEnterMethods = records.filter((record) => record.kind === "rpc-enter").map((record) => record.rpcMethod);
  const legacyAcceptedMethods = records.filter((record) => record.kind === "protocol-accepted").map((record) => record.rpcMethod);
  const legacyRpcReturnMethods = records.filter((record) => record.kind === "rpc-return").map((record) => record.rpcMethod);
  const legacySnapshots = records.filter((record) => record.kind === "snapshot" && record.legacySnapshot);
  const runtimeSnapshots = records.filter((record) => record.kind === "runtime-snapshot");
  const runtimeRegistrations = records.filter((record) => record.kind === "runtime-registered");
  const panelCommits = records.filter((record) => record.kind === "panel-projection-commit");
  const projectionRecords = [...runtimeSnapshots, ...runtimeRegistrations, ...panelCommits];
  const markerValue = (projection, fields) => {
    const values = fields.map((field) => projection?.[field]).filter((value) => typeof value === "boolean");
    if (values.some((value) => value === true)) return true;
    if (values.length === fields.length) return false;
    return null;
  };
  const combineBoolean = (values) => {
    const known = values.filter((value) => typeof value === "boolean");
    if (known.some((value) => value === true)) return true;
    if (known.length === values.length && known.length > 0) return false;
    return null;
  };
  const completedValue = (projection) => typeof projection?.lastAssistantStatus === "string"
    ? projection.lastAssistantStatus === "completed"
    : null;
  const aggregateProjection = (entries, projectionFor) => {
    const projections = entries.map(projectionFor).filter((projection) => projection && typeof projection === "object");
    const latest = projections.at(-1) ?? null;
    const fields = ["contentMarkerPresent", "orderedTextMarkerPresent", "renderedTextMarkerPresent"];
    return {
      recordCount: entries.length,
      projectionCount: projections.length,
      runtimeInstanceOrdinals: [...new Set(entries.map((entry) => entry.runtimeInstanceOrdinal).filter(Number.isSafeInteger))],
      messageCount: latest?.messageCount ?? null,
      assistantMatchCount: latest?.assistantMatchCount ?? null,
      orderedTextBlockCount: latest?.orderedTextBlockCount ?? null,
      contentLength: latest?.contentLength ?? null,
      orderedTextLength: latest?.orderedTextLength ?? null,
      lastAssistantStatus: latest?.lastAssistantStatus ?? null,
      contentMarkerPresent: combineBoolean(projections.map((projection) => projection.contentMarkerPresent)),
      orderedTextMarkerPresent: combineBoolean(projections.map((projection) => projection.orderedTextMarkerPresent)),
      renderedTextMarkerPresent: combineBoolean(projections.map((projection) => projection.renderedTextMarkerPresent)),
      markerPresent: combineBoolean(projections.map((projection) => markerValue(projection, fields))),
      completedStatusObserved: combineBoolean(projections.map(completedValue)),
      fieldsCaptured: projections.length > 0 && projections.every((projection) => fields.every((field) => typeof projection[field] === "boolean")),
      projections,
    };
  };
  const probeConfigured = probe.configuration?.status === "CONFIGURED";
  const fingerprintRecords = records.filter((record) => record.threadFingerprint !== null || record.turnFingerprint !== null || record.itemFingerprint !== null);
  const completeFingerprints = fingerprintRecords.every((record) => record.threadFingerprint !== null && record.turnFingerprint !== null && record.itemFingerprint !== null);
  const identityFingerprintsMatch = !probeConfigured || fingerprintRecords.length === 0 || !completeFingerprints
    ? null
    : fingerprintRecords.every((record) => record.threadFingerprint === fingerprint(threadId)
      && record.turnFingerprint === fingerprint(identity.turnId ?? "")
      && record.itemFingerprint === fingerprint(identity.itemId ?? ""));
  const readFailureStatuses = reads
    .filter((read) => ["PROBE_DRAIN_FAILED", "PROBE_PAGE_READ_FAILED", "INVALID_PROBE_ENVELOPE"].includes(read.status))
    .map((read) => read.status);
  const runtimeProjection = aggregateProjection([...runtimeRegistrations, ...runtimeSnapshots], (record) => record.projection);
  const runtimeInstanceRecords = [...runtimeRegistrations, ...runtimeSnapshots];
  const panelProjection = aggregateProjection(panelCommits, (record) => record.projection);
  const panelRuntimeAtEffect = aggregateProjection(panelCommits, (record) => record.runtimeProjectionAtEffect);
  const panelIdentity = panelCommits.at(-1) ?? null;
  const panelAndRuntimeInstanceOrdinalMatch = panelIdentity?.runtimeInstanceOrdinal != null
    && runtimeInstanceRecords.some((record) => record.runtimeInstanceOrdinal === panelIdentity.runtimeInstanceOrdinal)
    ? true
    : panelIdentity?.runtimeInstanceOrdinal != null && runtimeInstanceRecords.some((record) => Number.isSafeInteger(record.runtimeInstanceOrdinal))
      ? false
      : null;
  const panelSnapshotSameAsRuntimeAtEffect = combineBoolean(panelCommits.map((record) => record.panelSnapshotSameAsRuntimeAtEffect));
  const legacyMarker = combineBoolean(legacySnapshots.map((record) => record.legacySnapshot.markerPresent));
  const legacyCompleted = combineBoolean(legacySnapshots.map((record) => typeof record.legacySnapshot.status === "string"
    ? record.legacySnapshot.status === "completed"
    : null));
  let projectionStatus = "NO_RUNTIME_PROJECTION_RECORDS";
  if (!probeConfigured) projectionStatus = "NOT_RUN";
  else if (readFailureStatuses.length > 0) projectionStatus = "OBSERVATION_READ_FAILED";
  else if (projectionRecords.length > 0 && projectionRecords.every((record) => !record.projection && !record.runtimeProjectionAtEffect)) projectionStatus = "CAPTURED_PROJECTION_FIELDS_MISSING";
  else if (runtimeProjection.projectionCount === 0 && panelProjection.projectionCount === 0 && legacySnapshots.length > 0) {
    projectionStatus = legacyMarker === true && legacyCompleted === true
      ? "LEGACY_RUNTIME_MARKER_TERMINAL_SNAPSHOT_OBSERVED"
      : legacySnapshots.some((record) => record.legacySnapshot.markerPresent === null || record.legacySnapshot.status === null)
        ? "LEGACY_SNAPSHOT_FIELDS_MISSING"
        : "LEGACY_RUNTIME_SNAPSHOT_WITHOUT_MARKER_TERMINAL";
  } else if (runtimeProjection.projectionCount === 0 && panelProjection.projectionCount === 0 && records.length > 0) {
    projectionStatus = "RUNTIME_REGISTERED_WITHOUT_PROJECTION";
  } else if (runtimeProjection.markerPresent === true && runtimeProjection.completedStatusObserved === true
    && panelProjection.markerPresent === true && panelProjection.completedStatusObserved === true
    && panelSnapshotSameAsRuntimeAtEffect === true && panelAndRuntimeInstanceOrdinalMatch === true) {
    projectionStatus = "RUNTIME_AND_PANEL_MARKER_TERMINAL_PROJECTED";
  } else if (runtimeProjection.markerPresent === true && runtimeProjection.completedStatusObserved === true) {
    projectionStatus = "RUNTIME_MARKER_TERMINAL_PANEL_PROJECTION_INCOMPLETE";
  } else if (runtimeProjection.markerPresent === null && panelProjection.markerPresent === null && records.length > 0) {
    projectionStatus = "CAPTURED_PROJECTION_FIELDS_MISSING";
  } else if (runtimeProjection.markerPresent === true || panelProjection.markerPresent === true) {
    projectionStatus = "MARKER_PROJECTED_WITHOUT_COMPLETED_RUNTIME_AND_PANEL_MATCH";
  } else {
    projectionStatus = "RUNTIME_PROJECTION_OBSERVED_WITHOUT_MARKER";
  }
  const legacyEveryMethodEntered = expectedMethods.every((method) => legacyRpcEnterMethods.includes(method));
  const legacyEveryMethodAccepted = expectedMethods.every((method) => legacyAcceptedMethods.includes(method));
  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    performanceSample: false,
    evidenceClass: "isolated Mobile Web app-facing Playwright WebSocketMock dispatch plus private passive TaskRuntime projection; KCODER_STUDIO_MOCK Gateway, no Provider, no real app-server turn",
    source: {
      name: source.name,
      sourceTreeSha256: source.sourceTreeSha256,
      sourceFreezeEvidenceDigest: source.sourceFreezeEvidenceDigest,
      exportManifestSha256: source.exportManifestSha256,
      bundleSha256: mobileWeb.bundleSha256,
    },
    fixture: {
      requestedMessages: state.count,
      historyRowsDelivered: state.historyRowsDelivered,
      totalLoadedMessagesAfterSeed: state.historyRowsDelivered + 1,
      panelState: state.panelState,
      marker: identity.marker ?? null,
      turnId: identity.turnId ?? null,
      itemId: identity.itemId ?? null,
      threadId: threadId,
      activeRouteOrdinal: state.activeSocketRoute?.routeOrdinal ?? null,
      activeThreadReadRequestId: state.activeThreadReadRequestId,
    },
    mockDispatch: seed.seedDispatch ?? null,
    consumerProjection: {
      status: projectionStatus,
      configurationStatus: probe.configuration?.status ?? "PROBE_NOT_CONFIGURED",
      observationReadFailureCount: readFailureStatuses.length,
      observationReadFailureStatuses: readFailureStatuses,
      configure: probe.configuration,
      ringCapacityPerRead: 64,
      maximumStoredRecords: 128,
      readouts: reads,
      recordCount: records.length,
      runtimeRegistered: records.some((record) => record.kind === "runtime-registered" || record.kind === "registered"),
      runtimeInstanceOrdinals: [...new Set(records.map((record) => record.runtimeInstanceOrdinal).filter(Number.isSafeInteger))],
      runtimeProjection,
      panelProjection,
      panelRuntimeAtEffect,
      panelSnapshotSameAsRuntimeAtEffect,
      panelAndRuntimeInstanceOrdinalMatch,
      configuredIdentityFingerprintsMatch: identityFingerprintsMatch,
      identityFingerprintStatus: identityFingerprintsMatch === true ? "MATCH"
        : identityFingerprintsMatch === false ? "MISMATCH"
          : probeConfigured && fingerprintRecords.length === 0 ? "NOT_CAPTURED" : "INCOMPLETE",
      markerPresentInRuntimeSnapshot: runtimeProjection.markerPresent,
      completedStatusObservedInRuntimeSnapshot: runtimeProjection.completedStatusObserved,
      markerPresentInPanelProjection: panelProjection.markerPresent,
      completedStatusObservedInPanelProjection: panelProjection.completedStatusObserved,
      legacySnapshotRecordCount: legacySnapshots.length,
      legacySnapshotMarkerPresent: legacyMarker,
      legacySnapshotCompletedStatusObserved: legacyCompleted,
      legacyIngressEvidence: {
        evidenceClass: "legacy diagnostic record kinds only; current projection records do not establish RPC ingress or protocol acceptance",
        rpcEnterMethods: legacyRpcEnterMethods,
        protocolAcceptedMethods: legacyAcceptedMethods,
        rpcReturnMethods: legacyRpcReturnMethods,
        handlerThrowCount: records.filter((record) => record.kind === "rpc-threw").length,
        allFourMethodsEntered: legacyRpcEnterMethods.length > 0 ? legacyEveryMethodEntered : null,
        allFourMethodsProtocolAccepted: legacyAcceptedMethods.length > 0 ? legacyEveryMethodAccepted : null,
      },
    },
    domBoundary: {
      passedSeedVisibleTailGate: seed.ok === true,
      transcriptViewport: seed.transcriptViewport ?? null,
      changesPanelMounted: state.changesPanelMounted === true,
      changesPanelVisibilityEvidence: state.hiddenPanelEvidence ?? null,
      note: "Seed settlement requires the exact marker last-character Range to intersect the message-list viewport, stable tail geometry, and two animation-frame opportunities; probe reads do not alter or extend that gate.",
    },
    restrictions: {
      runtimeHandlerCalledDirectly: false,
      notificationFramesSentThrough: "the same identified app-facing Playwright 1.62 WebSocketMock selected by the existing active thread/read route guard",
      projectionReads: "one immediate drain after the four Mock frames and one drain after the existing DOM visibility/geometry gate; each drain is capped at 64 records",
      nativeStatus: "UNVERIFIED: Mobile Web Chromium only",
    },
  };
}

function summarizeRuntimeConsumerSeedFailure(source, state, error, mobileWeb) {
  const evidence = error?.seedFailureEvidence ?? {};
  const summary = buildRuntimeConsumerSeedDiagnostic(source, state, {
    ok: false,
    seedDispatch: evidence.seedDispatch ?? null,
    transcriptViewport: evidence.transcriptViewport ?? null,
    runtimeProbe: evidence.runtimeProbe ?? null,
  }, mobileWeb);
  return {
    ...summary,
    seedFailure: {
      failurePhase: evidence.failurePhase ?? null,
      diagnosticDom: evidence.diagnosticDom ?? null,
      error: evidence.error ?? null,
    },
  };
}

function summarizeSeedDispatchEvidence(state, marker, result, frames = []) {
  const frameResults = Array.isArray(result?.frameResults) ? result.frameResults : [];
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  const observedMethods = frameResults.map((frame) => frame.method);
  const sequences = frameResults.map((frame) => frame.sequence);
  const expectedFrames = frames.map((frame) => ({
    method: frame.method,
    sequence: frame.params?.sequence ?? null,
    serverId: frame.params?.serverId ?? null,
    threadId: frame.params?.threadId ?? null,
    turnId: frame.params?.turnId ?? null,
  }));
  const browserMockIds = [...new Set(frameResults.map((frame) => frame.browserMockId).filter(Boolean))];
  const turnId = expectedFrames[0]?.turnId ?? null;
  const dispatchOrderValid = frameResults.length === expectedMethods.length
    && frames.length === expectedMethods.length
    && result?.delivered === expectedMethods.length
    && observedMethods.every((method, index) => method === expectedMethods[index])
    && frameResults.every((frame, index) => frame.serverId === expectedFrames[index]?.serverId
      && frame.threadId === expectedFrames[index]?.threadId
      && frame.turnId === expectedFrames[index]?.turnId)
    && browserMockIds.length === 1
    && frameResults.every((frame) => frame.browserMockId === result?.browserMockId)
    && sequences.every((value, index) => Number.isSafeInteger(value)
      && value === expectedFrames[index]?.sequence
      && (index === 0 || value > sequences[index - 1]));
  const route = state.activeSocketRoute;
  const durations = frameResults.map((frame) => frame.dispatchHandlerSyncMs).filter(Number.isFinite);
  return {
    marker,
    turnId,
    attemptId: expectedFrames[0] ? frames[0].params?.attemptId ?? null : null,
    itemId: expectedFrames[1] ? frames[1].params?.item?.id ?? null : null,
    serverId,
    channel: "runtime",
    workspaceLabel: `run-owned/workspace-${state.source}`,
    threadId,
    threadReadRequestId: state.activeThreadReadRequestId,
    route: route ? {
      routeOrdinal: route.routeOrdinal,
      server: route.server,
      channel: route.channel,
      workspaceMatchesFixture: route.workspaceMatchesFixture,
      threadReadRequestId: route.threadReadRequestId,
    } : null,
    deliveryReturned: result?.delivered ?? 0,
    dispatchStartedAtPageTimeMs: Number.isFinite(result?.dispatchStartedAt) ? result.dispatchStartedAt : null,
    expectedFrameCount: frames.length,
    eligibleSocketCount: result?.eligibleSocketCount ?? (frameResults.length ? 1 : 0),
    socketCopies: result?.socketCopies ?? null,
    browserMockId: result?.browserMockId ?? browserMockIds[0] ?? null,
    expectedFrames,
    observedMethods,
    observedSequences: sequences,
    dispatchOrderValid,
    dispatchTaskDurationsMs: result?.dispatchTaskDurationsMs ?? frameResults.map((frame) => frame.dispatchHandlerSyncMs),
    maximumDispatchHandlerSyncMs: durations.length ? Math.max(...durations) : null,
    frameResults: frameResults.map((frame) => ({
      method: frame.method,
      sequence: frame.sequence,
      serverId: frame.serverId,
      threadId: frame.threadId,
      turnId: frame.turnId,
      browserMockId: frame.browserMockId,
      dispatchHandlerSyncMs: frame.dispatchHandlerSyncMs,
      pageDispatchStartedAtMs: frame.pageDispatchStartedAtMs ?? null,
      pageDispatchCompletedAtMs: frame.pageDispatchCompletedAtMs ?? null,
      domRowCountBefore: frame.domRowCountBefore ?? null,
      domRowCountAfter: frame.domRowCountAfter ?? null,
    })),
    terminalNotificationStatus: frames.find((frame) => frame.method === "turn/completed")?.params?.turn?.status ?? null,
    fileChangesStatus: frames.find((frame) => frame.method === "turn/completed")?.params?.fileChanges?.status ?? null,
    evidenceBoundary: "test-side app-facing Playwright WebSocketMock dispatch and handler synchrony; does not alone prove reducer state, rendered row, queue state, or task submission",
  };
}

function summarizeSeedTranscriptViewport(viewport) {
  if (!viewport) return null;
  const compactSample = (sample) => sample ? ({
    observationSource: sample.observationSource ?? null,
    poll: sample.poll ?? null,
    sampledAtPageTimeMs: sample.sampledAtPageTimeMs ?? null,
    scrollTop: sample.scrollTop ?? null,
    scrollHeight: sample.scrollHeight ?? null,
    clientHeight: sample.clientHeight ?? null,
    bottomGapPx: sample.bottomGapPx ?? null,
    renderedMessageRowCount: sample.renderedMessageRowCount ?? null,
    targetRowFound: sample.targetRowFound ?? false,
    targetVisibleWithinMessageList: sample.targetVisibleWithinMessageList ?? false,
    targetRowRect: sample.targetRowRect ?? null,
    targetMarkerGeometryIncluded: sample.targetMarkerGeometryIncluded ?? false,
    targetMarkerOccurrenceCount: sample.targetMarkerOccurrenceCount ?? null,
    targetMarkerSelectedOccurrenceIndex: sample.targetMarkerSelectedOccurrenceIndex ?? null,
    targetMarkerLastCharacterRect: sample.targetMarkerLastCharacterRect ?? null,
    targetMarkerVisibleWithinMessageList: sample.targetMarkerVisibleWithinMessageList ?? null,
    jumpToLatestVisible: sample.jumpToLatestVisible ?? false,
    virtualizedGeometry: sample.virtualizedGeometry ?? null,
  }) : null;
  const samples = Array.isArray(viewport.pollSamples)
    ? viewport.pollSamples.slice(0, transcriptVirtualizationTraceLimits.maxViewportSamples)
    : [];
  return {
    expectedTailMarker: viewport.expectedTailMarker ?? null,
    before: compactSample(viewport.before),
    last: compactSample(viewport.last),
    afterTwoFrames: compactSample(viewport.afterTwoFrames),
    actions: (viewport.actions ?? []).map((action) => ({
      action: action.action,
      attemptNumber: action.attemptNumber ?? null,
      atPoll: action.atPoll ?? null,
      startedAtPageTimeMs: action.startedAtPageTimeMs ?? null,
      completedAtPageTimeMs: action.completedAtPageTimeMs ?? null,
      timeoutMs: action.timeoutMs ?? null,
      outcome: action.outcome ?? null,
      errorKind: action.errorKind ?? null,
      viewport: compactSample(action.viewport),
      recheck: action.recheck ? {
        locatorVisible: action.recheck.locatorVisible,
        buttonGone: action.recheck.buttonGone,
        viewport: compactSample(action.recheck.viewport),
      } : null,
    })),
    pollSamples: samples.map(compactSample),
    stableSamples: viewport.stableSamples ?? 0,
    pollCount: viewport.pollCount ?? samples.length,
    geometryStableAfterTwoFrames: viewport.geometryStableAfterTwoFrames ?? null,
    virtualizedGeometryTrace: viewport.virtualizedGeometryTrace ?? null,
  };
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

async function beginTranscriptVirtualizationScrollTrace(page, traceKey) {
  return page.evaluate(({ key, maxEvents, limits }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { status: "NO_MESSAGE_LIST" };
    const observedHost = list.querySelector("[data-phone-ux-scroll-host]");
    let host = observedHost instanceof HTMLElement ? observedHost : null;
    let largestOverflow = host ? host.scrollHeight - host.clientHeight : -1;
    let visitedNodes = 0;
    const queue = [{ element: list, depth: 0 }];
    const rowSelector = '[data-testid="message-user"], [data-testid="message-assistant"]';
    while (!host && queue.length > 0 && visitedNodes < limits.maxWalkNodesPerSample) {
      const current = queue.shift();
      const element = current?.element;
      if (!(element instanceof HTMLElement) || element.matches(rowSelector)) continue;
      visitedNodes += 1;
      const overflow = element.scrollHeight - element.clientHeight;
      if (overflow > 16 && overflow > largestOverflow) {
        host = element;
        largestOverflow = overflow;
      }
      if (current.depth >= limits.maxDepth) continue;
      const children = element.children;
      for (let index = 0; index < Math.min(children.length, limits.maxChildrenPerNode); index += 1) {
        const child = children[index];
        if (!child.matches(rowSelector)) queue.push({ element: child, depth: current.depth + 1 });
      }
    }
    if (!host) host = list;
    if (!(host instanceof HTMLElement)) return { status: "NO_SCROLL_HOST" };
    const state = { events: [], nextOrdinal: 1, recordedCount: 0, droppedCount: 0 };
    const listener = (event) => {
      const ordinal = state.nextOrdinal++;
      if (state.recordedCount >= maxEvents) {
        state.droppedCount += 1;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      state.events.push({
        ordinal,
        pageTimeMs: Number(performance.now().toFixed(3)),
        isTrusted: event.isTrusted === true,
        targetTag: target?.tagName?.slice(0, 16) ?? null,
        targetTestId: target?.getAttribute("data-testid")?.slice(0, limits.maxTestIdLength) ?? null,
        scrollTop: Number(host.scrollTop.toFixed(2)),
      });
      state.recordedCount += 1;
    };
    const traces = window.__phoneRenderTranscriptVirtualizationTraces instanceof Map
      ? window.__phoneRenderTranscriptVirtualizationTraces
      : new Map();
    window.__phoneRenderTranscriptVirtualizationTraces = traces;
    traces.set(key, { host, listener, state });
    host.addEventListener("scroll", listener, { capture: true, passive: true });
    return {
      status: "ATTACHED",
      hostTestId: host.getAttribute("data-testid")?.slice(0, limits.maxTestIdLength) ?? null,
      startedAtPageTimeMs: Number(performance.now().toFixed(3)),
      initialScrollTop: Number(host.scrollTop.toFixed(2)),
      initialScrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      hostSearchVisitedNodes: visitedNodes,
    };
  }, { key: traceKey, maxEvents: transcriptVirtualizationTraceLimits.maxScrollEvents, limits: transcriptVirtualizationTraceLimits });
}

async function stopTranscriptVirtualizationScrollTrace(page, trace) {
  if (trace.finished) return trace.summary;
  trace.finished = true;
  let stopped;
  try {
    stopped = await page.evaluate(({ key, maxEvents }) => {
      const traces = window.__phoneRenderTranscriptVirtualizationTraces;
      const entry = traces instanceof Map ? traces.get(key) : null;
      if (!entry) return { status: "TRACE_NOT_FOUND", pendingScrollEvents: [] };
      entry.host.removeEventListener("scroll", entry.listener, true);
      traces.delete(key);
      if (traces.size === 0) delete window.__phoneRenderTranscriptVirtualizationTraces;
      return {
        status: "DETACHED",
        totalEventsSeen: entry.state.nextOrdinal - 1,
        totalEventsRecorded: entry.state.recordedCount,
        totalEventsDropped: entry.state.droppedCount,
        pendingScrollEvents: entry.state.events.splice(0, maxEvents),
      };
    }, { key: trace.key, maxEvents: transcriptVirtualizationTraceLimits.maxScrollEvents });
  } catch (error) {
    stopped = { status: "STOP_FAILED", error: safeSeedErrorMessage(error), pendingScrollEvents: [] };
  }
  trace.summary = {
    schemaVersion: 1,
    status: stopped.status === "DETACHED" ? "CAPTURED" : "PARTIAL",
    evidenceBoundary: "bounded test-side DOM geometry and trusted scroll-event timing; no React internals or message body capture",
    limits: transcriptVirtualizationTraceLimits,
    start: trace.startEvidence,
    viewportSamplesCaptured: trace.viewportSamplesCaptured,
    viewportSamplesOmitted: trace.viewportSamplesOmitted,
    totalScrollEventsSeen: stopped.totalEventsSeen ?? null,
    totalScrollEventsRecorded: stopped.totalEventsRecorded ?? null,
    totalScrollEventsDropped: stopped.totalEventsDropped ?? null,
    trailingScrollEvents: stopped.pendingScrollEvents ?? [],
    stopStatus: stopped.status,
    stopError: stopped.error ?? null,
  };
  return trace.summary;
}

async function scrollTranscriptToLatestCore(page, expectedTailMarker, options = {}, geometryTrace = null) {
  const requireMarkerVisible = options.requireMarkerVisible === true;
  const readViewport = async () => {
    const captureGeometry = geometryTrace !== null
      && geometryTrace.viewportSamplesCaptured < transcriptVirtualizationTraceLimits.maxViewportSamples;
    if (captureGeometry) geometryTrace.viewportSamplesCaptured += 1;
    else if (geometryTrace !== null) geometryTrace.viewportSamplesOmitted += 1;
    const viewport = await readTranscriptViewport(page, expectedTailMarker, requireMarkerVisible, {
      captureVirtualizedGeometry: captureGeometry,
      captureScrollportTransform: true,
      scrollTraceKey: geometryTrace?.key ?? null,
    });
    return {
      ...viewport,
      logicalLatestDistance: viewport.listFound ? measuredTranscriptLatestDistance(viewport) : null,
    };
  };
  const before = await readViewport();
  const jumpToLatest = page.getByTestId("jump-to-latest");
  const actions = [];
  const pollSamples = [before];
  const pollDeadline = Date.now() + 10_000;
  let previous = null;
  let stableSamples = 0;
  let pollCount = 0;
  let last = before;
  try {
    await waitFor(async () => {
      if (Date.now() >= pollDeadline) return null;
      pollCount += 1;
      const current = await readViewport();
      pollSamples.push({ ...current, observationSource: "bounded-poll", poll: pollCount });
      const currentLogicalDistancePx = current.logicalLatestDistance?.pixels ?? null;
      const previousLogicalDistance = previous?.logicalLatestDistance ?? null;
      const jumpButtonVisible = await jumpToLatest.isVisible().catch(() => false);
      const requiredTargetVisible = requireMarkerVisible
        ? current.targetMarkerVisibleWithinMessageList
        : current.targetVisibleWithinMessageList;
      const alreadyAttempted = actions.some((entry) => entry.action === "jump-to-latest-touch-attempt");
      const alreadyTouched = actions.some((entry) => entry.action === "actual-touch-on-jump-to-latest");
      const tapBudgetMs = pollDeadline - Date.now();
      if (jumpButtonVisible && !requiredTargetVisible && !alreadyAttempted && !alreadyTouched && tapBudgetMs > 0) {
        const attempt = {
          action: "jump-to-latest-touch-attempt",
          attemptNumber: 1,
          atPoll: pollCount,
          startedAtPageTimeMs: current.sampledAtPageTimeMs ?? null,
          timeoutMs: Math.max(1, Math.min(750, tapBudgetMs)),
          outcome: "pending",
          viewport: current,
        };
        actions.push(attempt);
        try {
          await jumpToLatest.tap({ timeout: attempt.timeoutMs });
          if (geometryTrace) {
            try { attempt.completedAtPageTimeMs = await page.evaluate(() => Number(performance.now().toFixed(3))); }
            catch { attempt.completedAtPageTimeMs = null; }
          }
          attempt.outcome = "completed";
          actions.push({
            action: "actual-touch-on-jump-to-latest",
            atPoll: pollCount,
            viewport: current,
          });
          previous = null;
          stableSamples = 0;
          last = current;
          return null;
        } catch (error) {
          if (geometryTrace) {
            try { attempt.completedAtPageTimeMs = await page.evaluate(() => Number(performance.now().toFixed(3))); }
            catch { attempt.completedAtPageTimeMs = null; }
          }
          const message = String(error?.message || error);
          const detachedOrHiddenActionabilityFailure = /(?:element|node) was detached from (?:the )?DOM|not attached to (?:the )?DOM|not visible|hidden from layout/i.test(message);
          const afterFailedAttempt = await readViewport();
          const locatorVisibleAfterFailedAttempt = await jumpToLatest.isVisible().catch(() => false);
          const buttonGoneAfterFailedAttempt = !locatorVisibleAfterFailedAttempt && !afterFailedAttempt.jumpToLatestVisible;
          const recheckObservation = {
            ...afterFailedAttempt,
            observationSource: "jump-to-latest-attempt-recheck",
            poll: pollCount,
          };
          pollSamples.push(recheckObservation);
          if (detachedOrHiddenActionabilityFailure && buttonGoneAfterFailedAttempt) {
            attempt.outcome = "abandoned-after-detached-or-hidden-rerender";
            attempt.errorKind = /detached|not attached/i.test(message) ? "detached-during-actionability" : "hidden-during-actionability";
            attempt.recheck = {
              viewport: recheckObservation,
              locatorVisible: locatorVisibleAfterFailedAttempt,
              buttonGone: buttonGoneAfterFailedAttempt,
            };
            previous = null;
            stableSamples = 0;
            last = recheckObservation;
            return null;
          }
          attempt.outcome = "failed";
          attempt.errorKind = detachedOrHiddenActionabilityFailure
            ? "button-still-visible-after-detach-or-hidden-error"
            : "unexpected-tap-error";
          attempt.errorMessage = message.slice(0, 1200);
          attempt.recheck = {
            viewport: recheckObservation,
            locatorVisible: locatorVisibleAfterFailedAttempt,
            buttonGone: buttonGoneAfterFailedAttempt,
          };
          throw error;
        }
      }
      if (
        requiredTargetVisible
        && currentLogicalDistancePx !== null
        && currentLogicalDistancePx <= 64
        && !current.jumpToLatestVisible
        && previous
        && previousLogicalDistance?.orientation === current.logicalLatestDistance?.orientation
        && Math.abs(current.scrollTop - previous.scrollTop) <= 1
        && current.scrollHeight === previous.scrollHeight
        && current.clientHeight === previous.clientHeight
      ) {
        stableSamples += 1;
      } else {
        stableSamples = 0;
      }
      previous = current;
      last = current;
      return stableSamples >= 2 ? current : null;
    }, 10_000, `latest transcript row ${expectedTailMarker} to become visible and settle`, 50);
  } catch (error) {
    error.transcriptViewport = { expectedTailMarker, before, last, actions, pollSamples, stableSamples, pollCount };
    throw error;
  }
  await waitForTwoFrames(page);
  const afterTwoFrames = await readViewport();
  const geometryStableAfterTwoFrames = Math.abs(afterTwoFrames.scrollTop - last.scrollTop) <= 1
    && afterTwoFrames.scrollHeight === last.scrollHeight
    && afterTwoFrames.clientHeight === last.clientHeight
    && afterTwoFrames.logicalLatestDistance?.orientation === last.logicalLatestDistance?.orientation;
  const requiredTargetVisibleAfterTwoFrames = requireMarkerVisible
    ? afterTwoFrames.targetMarkerVisibleWithinMessageList
    : afterTwoFrames.targetVisibleWithinMessageList;
  if (
    !requiredTargetVisibleAfterTwoFrames
    || afterTwoFrames.logicalLatestDistance?.pixels == null
    || afterTwoFrames.logicalLatestDistance.pixels > 64
    || afterTwoFrames.jumpToLatestVisible
    || !geometryStableAfterTwoFrames
  ) {
    const error = new Error(`latest transcript target ${expectedTailMarker} lost visibility or stable tail geometry after two animation frames`);
    error.transcriptViewport = { expectedTailMarker, before, last, afterTwoFrames, actions, pollSamples, stableSamples, pollCount, geometryStableAfterTwoFrames };
    throw error;
  }
  const firstTargetVisiblePollIndex = pollSamples.findIndex((sample) => requireMarkerVisible
    ? sample.targetMarkerVisibleWithinMessageList === true
    : sample.targetVisibleWithinMessageList === true);
  const firstTargetVisiblePoll = firstTargetVisiblePollIndex < 0 ? null : {
    source: pollSamples[firstTargetVisiblePollIndex].observationSource
      ?? (firstTargetVisiblePollIndex === 0 ? "before-bounded-poll" : "bounded-poll"),
    poll: pollSamples[firstTargetVisiblePollIndex].poll ?? (firstTargetVisiblePollIndex === 0 ? null : firstTargetVisiblePollIndex),
    sampledAtPageTimeMs: pollSamples[firstTargetVisiblePollIndex].sampledAtPageTimeMs,
    markerVisibleWithinMessageList: pollSamples[firstTargetVisiblePollIndex].targetMarkerVisibleWithinMessageList ?? null,
    rowVisibleWithinMessageList: pollSamples[firstTargetVisiblePollIndex].targetVisibleWithinMessageList ?? false,
  };
  const targetVisibleBeforePoll = requireMarkerVisible
    ? before.targetMarkerVisibleWithinMessageList === true
    : before.targetVisibleWithinMessageList === true;
  const actualTouch = actions.find((entry) => entry.action === "actual-touch-on-jump-to-latest") ?? null;
  return {
    action: actualTouch?.action ?? (targetVisibleBeforePoll
      ? "tail-already-visible"
      : "became-visible-without-manual-jump"),
    expectedTailMarker,
    before,
    after: afterTwoFrames,
    afterTwoFrames: true,
    afterPageTimeMs: afterTwoFrames.sampledAtPageTimeMs,
    firstTargetVisiblePoll,
    actions,
    pollSamples,
    stableSamples,
    pollCount,
    boundary: requireMarkerVisible
      ? "exact final marker's last-character DOM Range intersects the message-list; real jump-to-latest touch when needed; measured scrollport transform selects normal bottom-gap or inverted raw-top distance-to-latest; stable metrics across bounded samples and two RAF opportunities"
      : "target message row geometry inside message-list; real jump-to-latest touch when needed; measured scrollport transform selects normal bottom-gap or inverted raw-top distance-to-latest; stable metrics across bounded samples and two RAF opportunities",
  };
}

async function waitForProductTailMarkerWithoutAction(page, marker, startPageTimeMs, phase, options = {}) {
  const evidence = {
    phase,
    marker,
    action: "none-inside-tail-gate",
    startPageTimeMs: Number.isFinite(startPageTimeMs) ? startPageTimeMs : null,
    deadlineMs: 10_000,
    observations: [],
    lastVisibilityChecks: null,
    lastVisibilityDiagnostics: null,
    status: "WAITING",
  };
  let previous = null;
  try {
    assert.ok(Number.isFinite(startPageTimeMs), `${phase}: tail settlement needs the actual page-clock start of the notification or Jump action`);
    for (let poll = 0; poll < 220; poll += 1) {
      const current = await readTranscriptViewport(page, marker, true, {
        captureMarkerVisibilityDiagnostics: options.captureVisibilityDiagnostics === true,
      });
      evidence.lastVisibilityChecks = current.targetMarkerVisibilityChecks ?? null;
      evidence.lastVisibilityDiagnostics = current.targetMarkerVisibilityDiagnostics ?? null;
      evidence.observations.push({
        sampledAtPageTimeMs: current.sampledAtPageTimeMs ?? null,
        scrollTop: current.scrollTop ?? null,
        scrollHeight: current.scrollHeight ?? null,
        clientHeight: current.clientHeight ?? null,
        rowFound: current.targetRowFound ?? false,
        markerRangeCount: current.targetMarkerLastCharacterRangeCount ?? null,
        markerVisible: current.targetMarkerVisibleWithinMessageList ?? null,
        markerVisibilityChecks: current.targetMarkerVisibilityChecks ?? null,
        jumpVisible: current.jumpToLatestVisible ?? null,
      });
      const elapsedMs = Number.isFinite(current.sampledAtPageTimeMs)
        ? current.sampledAtPageTimeMs - startPageTimeMs
        : Infinity;
      assert.ok(elapsedMs <= evidence.deadlineMs, `${phase}: natural tail marker settlement exceeded the existing 10-second visible-tail deadline`);
      const visible = current.targetMarkerVisibleWithinMessageList === true
        && Number(current.targetMarkerLastCharacterRangeCount) > 0
        && current.targetMarkerLastCharacterRect?.width > 0
        && current.targetMarkerLastCharacterRect?.height > 0
        && current.jumpToLatestVisible === false;
      const stableWithPrevious = visible && previous !== null
        && Math.abs(current.scrollTop - previous.scrollTop) <= 0.5
        && current.scrollHeight === previous.scrollHeight
        && current.clientHeight === previous.clientHeight
        && Math.abs(current.targetMarkerLastCharacterRect.top - previous.targetMarkerLastCharacterRect.top) <= 0.5
        && Math.abs(current.targetMarkerLastCharacterRect.left - previous.targetMarkerLastCharacterRect.left) <= 0.5;
      if (stableWithPrevious) {
        const beforeTwoFrames = previous;
        await waitForTwoFrames(page);
        const afterTwoFrames = await readTranscriptViewport(page, marker, true, {
          captureMarkerVisibilityDiagnostics: options.captureVisibilityDiagnostics === true,
        });
        evidence.lastVisibilityChecks = afterTwoFrames.targetMarkerVisibilityChecks ?? null;
        evidence.lastVisibilityDiagnostics = afterTwoFrames.targetMarkerVisibilityDiagnostics ?? null;
        evidence.observations.push({
          sampledAtPageTimeMs: afterTwoFrames.sampledAtPageTimeMs ?? null,
          scrollTop: afterTwoFrames.scrollTop ?? null,
          scrollHeight: afterTwoFrames.scrollHeight ?? null,
          clientHeight: afterTwoFrames.clientHeight ?? null,
          rowFound: afterTwoFrames.targetRowFound ?? false,
          markerRangeCount: afterTwoFrames.targetMarkerLastCharacterRangeCount ?? null,
          markerVisible: afterTwoFrames.targetMarkerVisibleWithinMessageList ?? null,
          markerVisibilityChecks: afterTwoFrames.targetMarkerVisibilityChecks ?? null,
          jumpVisible: afterTwoFrames.jumpToLatestVisible ?? null,
          sampleBoundary: "after-two-requestAnimationFrame-opportunities",
        });
        const afterElapsedMs = Number.isFinite(afterTwoFrames.sampledAtPageTimeMs)
          ? afterTwoFrames.sampledAtPageTimeMs - startPageTimeMs
          : Infinity;
        const stillVisible = afterTwoFrames.targetMarkerVisibleWithinMessageList === true
          && Number(afterTwoFrames.targetMarkerLastCharacterRangeCount) > 0
          && afterTwoFrames.targetMarkerLastCharacterRect?.width > 0
          && afterTwoFrames.targetMarkerLastCharacterRect?.height > 0
          && afterTwoFrames.jumpToLatestVisible === false;
        const stillStable = Math.abs(afterTwoFrames.scrollTop - current.scrollTop) <= 0.5
          && afterTwoFrames.scrollHeight === current.scrollHeight
          && afterTwoFrames.clientHeight === current.clientHeight
          && Math.abs(afterTwoFrames.targetMarkerLastCharacterRect.top - current.targetMarkerLastCharacterRect.top) <= 0.5
          && Math.abs(afterTwoFrames.targetMarkerLastCharacterRect.left - current.targetMarkerLastCharacterRect.left) <= 0.5;
        assert.ok(afterElapsedMs <= evidence.deadlineMs, `${phase}: natural tail marker settlement exceeded the existing 10-second visible-tail deadline`);
        if (stillVisible && stillStable) {
          evidence.status = "PASS";
          evidence.elapsedFromStartMs = Number(afterElapsedMs.toFixed(3));
          evidence.before = beforeTwoFrames;
          evidence.after = current;
          evidence.afterTwoFrames = afterTwoFrames;
          evidence.tailBoundary = "actual last-character Range intersects the scrollport client clip, message-list, and visual viewport; its center hit-tests to the target row without Jump/composer coverage, then remains stable after two RAF opportunities; raw bottom-gap is not used for this inverted Web candidate";
          return evidence;
        }
      }
      previous = current;
      await page.waitForTimeout(50);
    }
    throw new Error(`${phase}: no stable visible last-character Range was observed before the bounded poll completed`);
  } catch (error) {
    evidence.status = "FAIL";
    evidence.error = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    error.productTailGateEvidence = evidence;
    throw error;
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

function assertProductHistoryAnchorPreserved(before, after, state, label) {
  assert.ok(before?.fixtureMessageId && after?.fixtureMessageId, `${label}: both anchor observations need a real visible fixture message`);
  assert.ok(state.historyMessageIds.has(before.fixtureMessageId), `${label}: anchor ID must belong to an actual history message returned by the fixture route`);
  assert.ok(state.historyMessageIds.has(after.fixtureMessageId), `${label}: retained anchor ID must still belong to loaded history`);
  assert.equal(after.fixtureMessageId, before.fixtureMessageId, `${label}: preserve the exact same visible history message ID`);
  assert.equal(after.marker, before.marker, `${label}: preserve the unique body marker mapped to the same history ID`);
  const rowRect = after.rect;
  const listRect = after.listRect;
  const intersectsMessageList = rowRect.left < listRect.right
    && rowRect.right > listRect.left
    && rowRect.top < listRect.bottom
    && rowRect.bottom > listRect.top;
  assert.ok(intersectsMessageList, `${label}: retained row rectangle must intersect the message-list viewport`);
  const displacementPx = Math.abs(after.viewportOffsetPx - before.viewportOffsetPx);
  assert.ok(displacementPx <= 2, `${label}: the same row top must remain within 2 CSS px of its pre-update viewport offset; actual=${displacementPx.toFixed(3)}px`);
  return { messageId: before.fixtureMessageId, marker: before.marker, beforeOffsetPx: before.viewportOffsetPx, afterOffsetPx: after.viewportOffsetPx, displacementPx };
}

function assertProductVisibleHistoryOrder(viewport, label) {
  const visualIndexes = viewport?.visualHistoryIndexes ?? [];
  assert.ok(visualIndexes.length > 0, `${label}: visible history rows must be backed by unique fixture markers`);
  for (let index = 1; index < visualIndexes.length; index += 1) {
    assert.ok(visualIndexes[index] >= visualIndexes[index - 1],
      `${label}: top-to-bottom MessageBubble order must remain chronological; visible=${visualIndexes.join(",")}`);
  }
  return { visualHistoryIndexes: visualIndexes, chronologicalTopToBottom: true };
}

function chooseVisibleProductCodeAnchor(viewport) {
  const visibleAssistantsWithCollapsedCode = (viewport?.visibleRows ?? [])
    .filter((row) => row.role === "assistant" && row.collapsedCodeDisclosureCount > 0)
    .sort((left, right) => {
      const center = viewport.listRect.top + viewport.listRect.height / 2;
      const leftCenter = (left.rect.top + left.rect.bottom) / 2;
      const rightCenter = (right.rect.top + right.rect.bottom) / 2;
      return Math.abs(leftCenter - center) - Math.abs(rightCenter - center);
    });
  return visibleAssistantsWithCollapsedCode[0] ?? null;
}

function makeLongTailWindowAppendDelta(marker) {
  const prose = "The retained Mobile history reader must stay on the same message while a completed Assistant turn grows the inverted transcript. ".repeat(5);
  const code = Array.from({ length: 20 }, (_, index) => `export const tail_window_stream_${index} = (value: number) => value + ${index};`).join("\n");
  return [
    `\n\n## ${marker} live Markdown update\n\n`,
    prose,
    "\n\n| phase | state | detail |\n| --- | --- | --- |\n| stream | complete | deterministic WebSocketMock fixture |\n\n",
    "```typescript\n",
    code,
    "\n```\n\n",
    `${marker}\n`,
  ].join("");
}

async function expandProductHistoryCodeDisclosure(page, anchor, state) {
  assert.ok(state.historyMessageIds.has(anchor.fixtureMessageId), "code expansion anchor must be a message returned by the fixture history route");
  const rowTestId = anchor.role === "assistant" ? "message-assistant" : "message-user";
  const row = page.getByTestId(rowTestId).filter({ hasText: anchor.marker });
  assert.equal(await row.count(), 1, "unique visible HISTORY marker must resolve to exactly one real MessageBubble row");
  const disclosure = row.getByTestId("code-disclosure").locator('[role="button"][aria-expanded="false"]').first();
  assert.ok(await disclosure.count() > 0, `history row ${anchor.fixtureMessageId} must contain a real collapsed CodeDisclosure`);
  await disclosure.waitFor({ state: "visible", timeout: 5_000 });
  const traceBefore = await readTranscriptFollowGestureInputTrace(page);
  await disclosure.click({ timeout: 5_000 });
  await page.waitForFunction(({ marker, rowTestId, token }) => {
    const message = [...document.querySelectorAll(`[data-testid="${rowTestId}"]`)]
      .find((element) => (element.textContent ?? "").includes(marker));
    const toggle = message?.querySelector('[data-testid="code-disclosure"] [role="button"]');
    return toggle?.getAttribute("aria-expanded") === "true" && (message?.textContent ?? "").includes(token);
  }, { marker: anchor.marker, rowTestId, token: `fixture_${anchor.historyIndex}_0` }, { timeout: 5_000 });
  await waitForTwoFrames(page);
  const traceAfter = await readTranscriptFollowGestureInputTrace(page);
  const inputEvents = transcriptInputEventsSince(traceAfter, traceBefore?.latestOrdinal ?? 0);
  const trustedDisclosureClick = inputEvents.find((event) => event.type === "click"
    && event.isTrusted && event.insideMessageList && event.targetTestId === "code-disclosure") ?? null;
  assert.ok(trustedDisclosureClick, "the existing CodeDisclosure must expand through a trusted browser click inside the real message list");
  return {
    messageId: anchor.fixtureMessageId,
    marker: anchor.marker,
    codeToken: `fixture_${anchor.historyIndex}_0`,
    trustedClick: trustedDisclosureClick,
    ariaExpanded: true,
    expandedCodeTokenVisible: true,
  };
}

async function runTailWindowProductRegression(page, state, source, count, seed, stage = "combined") {
  const evidence = {
    schemaVersion: 1,
    status: "RUNNING",
    diagnosticOnly: true,
    performanceSample: false,
    source,
    requestedMessages: count,
    panelState: "unmounted",
    evidenceClass: "isolated Mobile Web TaskTranscript and production MessageBubble UI with deterministic history pages, ordered app-facing Playwright WebSocketMock notifications, and trusted Chromium input; not a Rust app-server/model turn and not Android/iOS Native validation",
    notificationInjectionBoundary: "the existing active Mobile runtime WebSocketMock._apiSendToPage fixture path; initial history is loaded by the isolated fixture route and synthetic Assistant notification frames are test-side only; older-page UI pagination is a separate diagnostic selector",
    scenario: stage === "stable-reader"
      ? "manual-history-preload-500-explicit-follow-reset-stable-reader-code-append-return"
      : "manual-history-preload-500-explicit-follow-reset-core-follow-code-append-interruption-return",
    stage,
    interruptionStatus: stage === "stable-reader" ? "NOT_RUN_SEPARATE_CASE" : "PENDING",
    pagingStatus: "NOT_RUN_SEPARATE_SCENARIO",
    nativeValidation: "NOT_RUN",
    rawBottomGapUsedAsAcceptance: false,
    rowAnchorContract: "same fixture history message ID, mapped from its unique visible HISTORY body marker, and same MessageBubble row top relative to message-list within 2 CSS px after stable two-RAF observations",
    tailContract: "initial first-page newest history marker must naturally tail before manual preload; after manual preload one real Jump action explicitly restores follow; then seed and final tail must pass the existing 10-second gate without helper scrolling/clicking, with the last-character Range clipped to scrollport/list/visual viewport and center-hit-tested to its row across two RAF opportunities",
    historyRowsAtSeed: state.historyRowsDelivered,
    reservedOlderRows: state.fixtureShape.reservedOlderHistoryRows,
    historySetup: {
      boundary: "500 total messages are reached by manually loading 499 heterogeneous fixture history rows, after separately verifying initial-page entry tail and explicitly restoring follow with the visible Jump control; this is not direct 500-row entry behavior",
      initialEntryNaturalTail: state.initialEntryTailEvidence ?? null,
      manualHistoryPreloadFollowReset: state.manualHistoryFollowResetEvidence ?? null,
    },
    phases: [],
  };
  let failureStage = "validating-natural-seed-tail";
  let cdp = null;
  let inputTraceInstalled = false;
  let primaryError = null;
  try {
    assert.equal(count, 500, "product tail/window regression is pinned to the existing heterogeneous 500-message fixture");
    assert.equal(state.historyRowsDelivered, 499, "the initial history page sequence must deliver exactly 499 rows before the completed seed turn");
    assert.equal(state.historyMessageIds.size, 499, "initial history message IDs must be unique before the seed turn");
    assert.equal(state.initialEntryTailEvidence?.status, "PASS", "the actual initial history page must pass the natural-tail gate before any manual history preload");
    assert.equal(state.manualHistoryFollowResetEvidence?.status, "PASS", "the 499-row manual history preload must restore follow through the real Jump control before the seed turn");
    assert.equal(state.manualHistoryFollowResetEvidence?.actionCompleted, true, "the real Jump control action must complete before the seed turn");
    assert.equal(state.manualHistoryFollowResetEvidence?.gate?.status, "PASS", "the same history tail must settle after the explicit follow reset");
    assert.equal(seed?.ok, true, "product tail/window regression requires the actual four-frame seed delivery to complete");
    assert.equal(seed?.seedDispatch?.dispatchOrderValid, true, "seed must pass the real active WebSocketMock four-frame/sequence gate");
    assert.equal(seed?.transcriptViewport?.status, "PASS", "seed must pass the natural final-character Range/two-RAF tail gate without helper scrolling");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames?.targetMarkerVisibleWithinMessageList, true, "seed's last-character Range must intersect the message-list after two RAF opportunities");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames?.jumpToLatestVisible, false, "seed must naturally settle at latest with Jump hidden");
    evidence.seedTailGate = seed.transcriptViewport;
    evidence.seedNotification = seed.seedDispatch;
    assert.equal(state.activeSocketRoute?.server, serverId, "the seed must have a real active fixture runtime route for the expected server");
    assert.equal(state.activeSocketRoute?.channel, "runtime", "the seed must use the Runtime WebSocketMock route, not a directory socket");
    assert.equal(state.activeSocketRoute?.workspaceMatchesFixture, true, "the active thread/read route must match this RunContext-owned workspace");
    evidence.activeFixtureRoute = {
      routeOrdinal: state.activeSocketRoute.routeOrdinal,
      server: state.activeSocketRoute.server,
      channel: state.activeSocketRoute.channel,
      workspaceMatchesFixture: state.activeSocketRoute.workspaceMatchesFixture,
      threadReadRequestId: state.activeThreadReadRequestId,
    };

    failureStage = "installing-trusted-input-observer";
    evidence.inputObserver = await installTranscriptFollowGestureInputTrace(page, 4096);
    inputTraceInstalled = true;
    assert.equal(evidence.inputObserver.installed, true, "passive trusted-input observation must be installed on the actual message-list");
    cdp = await page.context().newCDPSession(page);

    failureStage = "trusted-touch-reaches-older-history-window";
    const touchToHistory = await performProductTouchToOlderHistory(page, cdp);
    evidence.touchToHistory = touchToHistory;
    const touchOrder = assertProductVisibleHistoryOrder(touchToHistory.finalViewport, "trusted touch older-history window");
    touchToHistory.chronologicalOrder = touchOrder;
    evidence.phases.push({ id: "trusted-touch-to-older-history", ...touchToHistory });

    failureStage = "selecting-history-row-and-starting-real-jump";
    const historyViewportAfterTouch = await waitForStableProductHistoryWindow(page, "history window after trusted touch");
    assert.ok(historyViewportAfterTouch.visibleRows.length > 0, "trusted touch must leave actual history MessageBubble rows in the viewport");
    const anchorCandidate = chooseVisibleProductCodeAnchor(historyViewportAfterTouch);
    assert.ok(anchorCandidate, "the trusted-touch history viewport must expose an actual Assistant MessageBubble with a collapsed CodeDisclosure");
    assert.ok(state.historyMessageIds.has(anchorCandidate.fixtureMessageId), "visible body marker must map to an immutable history ID returned by the fixture route");
    let readerAnchor;
    if (stage === "stable-reader") {
      failureStage = "normalizing-stable-reader-anchor-with-trusted-input";
      const beforeNormalize = await waitForStableProductHistoryAnchor(page, anchorCandidate.marker, "stable-reader anchor before normalization");
      try {
        evidence.stableReaderNormalization = await normalizeStableReaderAnchorWithTrustedInput(
          page, cdp, beforeNormalize, "stable-reader same-ID anchor normalization",
        );
      } catch (error) {
        evidence.stableReaderNormalization = error.productStableReaderNormalizationEvidence ?? {
          status: "FAIL_WITHOUT_NORMALIZATION_EVIDENCE", before: beforeNormalize, exactAnchorTolerancePx: 2,
        };
        throw error;
      }
      readerAnchor = evidence.stableReaderNormalization.after;
      assert.equal(readerAnchor.fixtureMessageId, beforeNormalize.fixtureMessageId, "normalization must retain the same immutable message ID");
      assert.equal(readerAnchor.marker, beforeNormalize.marker, "normalization must retain the same unique body marker");
      assert.ok(readerAnchor.viewportOffsetPx >= -2 && readerAnchor.viewportOffsetPx <= readerAnchor.listRect.height + 2,
        "stable-reader anchor top must be in the actual viewport within the unchanged 2px anchor contract");
      assert.ok(["PASS_TRUSTED_INPUT_NORMALIZED", "PASS_ALREADY_WITHIN_2PX"].includes(evidence.stableReaderNormalization.status),
        "stable-reader normalization can pass only after the same clipped row reaches the existing 2px top contract");
      evidence.interruptionStatus = "NOT_RUN_SEPARATE_CASE";
      evidence.phases.push({ id: "stable-reader-anchor-normalization", ...evidence.stableReaderNormalization });
    } else {
    const jumpAnchor = await waitForStableProductHistoryAnchor(page, anchorCandidate.marker, "pre-jump message anchor");
    assert.equal(jumpAnchor.fixtureMessageId, anchorCandidate.fixtureMessageId, "stable anchor must retain the same fixture message ID");
    const tailMarker = `seed-${source}-${count}-unmounted`;
    const armedRaceAnchor = await page.evaluate(({ marker, fixtureMessageId, tailMarker }) =>
      window.__phoneFollowGestureInputTrace?.armAnchor(marker, fixtureMessageId, tailMarker) ?? false,
      { marker: jumpAnchor.marker, fixtureMessageId: jumpAnchor.fixtureMessageId, tailMarker });
    assert.equal(armedRaceAnchor, true, "race timing trace must arm the exact fixture message before Jump starts");
    const preparedTouchPlan = await prepareProductTouchStroke(page, "interrupt-in-flight-jump-toward-older-history", { pointCount: 8, preparedBeforeJump: true });
    const jumpButton = page.getByTestId("jump-to-latest");
    assert.equal(await jumpButton.isVisible(), true, "manual reader must have the actual Jump-to-latest control before the follow-interruption race");
    await jumpButton.tap({ timeout: 5_000 });
    failureStage = "waiting-in-page-for-active-jump-before-touch";
    const jumpMotionReadiness = await page.evaluate((timeoutMs) =>
      window.__phoneFollowGestureInputTrace?.waitForActiveJump(timeoutMs) ?? { status: "OBSERVER_UNAVAILABLE" }, 3_000);
    evidence.jumpMotionReadiness = jumpMotionReadiness;
    if (jumpMotionReadiness?.status !== "READY_ACTIVE_JUMP") {
      const timingError = new Error("trusted interrupt plan did not reach the bounded page-side active-Jump readiness gate");
      timingError.code = "INVALID_TIMING";
      timingError.productFollowMotionEvidence = jumpMotionReadiness;
      throw timingError;
    }
    failureStage = "trusted-touch-interrupts-in-flight-jump";
    const touchInterrupt = await performProductTouchStroke(page, cdp, "interrupt-in-flight-jump-toward-older-history", {
      pointCount: 8,
      interMoveDelayMs: 8,
      preparedPlan: preparedTouchPlan,
      afterOrdinal: preparedTouchPlan.latestOrdinal,
      inputAfterOrdinal: jumpMotionReadiness.latestOrdinal,
      requireActiveJumpAtTouchStart: true,
    });
    const jumpClicks = touchInterrupt.events.filter((event) => event.type === "click" && event.isTrusted && event.insideJumpButton);
    assert.equal(jumpClicks.length, 1, "the race variant must begin with exactly one real trusted Jump button click");
    const lastMotionSample = touchInterrupt.touchStartRaceEvidence?.recentJumpScrolls?.at(-1)?.anchorSample;
    assert.ok(lastMotionSample, "touchstart timing evidence must include the same real history row during active Jump motion");
    const programmaticMotion = { anchor: lastMotionSample, latestOrdinal: touchInterrupt.eventStartOrdinal, sampledAtTouchStart: true };
    evidence.phases.push({ id: "animated-jump-motion-at-touchstart", jumpClick: jumpClicks[0],
      activeMotionReadiness: jumpMotionReadiness, visibleHistoryAnchorBeforeJump: jumpAnchor, firstObservedFollowMotion: programmaticMotion });
    evidence.activeTouchInterruptInput = touchInterrupt;
    const interruptedAnchor = await waitForStableProductHistoryAnchor(page, jumpAnchor.marker, "history anchor after follow interruption");
    evidence.activeTouchInterruptSettledAnchor = interruptedAnchor;
    const interruptTrace = await readTranscriptFollowGestureInputTrace(page);
    const interruptEvents = transcriptInputEventsSince(interruptTrace, touchInterrupt.eventStartOrdinal);
    const interruptTouchStart = interruptEvents.find((event) => event.type === "touchstart" && event.insideMessageList && event.isTrusted);
    const interruptTouchMove = interruptEvents.find((event) => event.type === "touchmove" && event.insideMessageList && event.isTrusted);
    const interruptTouchEnd = interruptEvents.find((event) => event.type === "touchend" && event.insideMessageList && event.isTrusted);
    const interruptListScroll = interruptEvents.find((event) => event.type === "scroll" && event.insideMessageList && event.isTrusted);
    touchInterrupt.events = interruptEvents;
    touchInterrupt.inputTraceDropped = interruptTrace?.dropped ?? null;
    touchInterrupt.trustedEventCounts.listScroll = interruptEvents.filter((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList).length;
    touchInterrupt.gestureComplete = {
      touchEndSent: touchInterrupt.touchEndSent,
      trustedTouchstartObserved: Boolean(interruptTouchStart),
      trustedTouchmoveObserved: Boolean(interruptTouchMove),
      trustedTouchendObserved: Boolean(interruptTouchEnd),
      trustedListScrollObserved: Boolean(interruptListScroll),
      stableHistoryAnchorAfterTouchend: interruptedAnchor.stableAfterTwoFrames === true,
      settledHistoryAnchor: interruptedAnchor,
    };
    assert.ok(interruptTouchStart && interruptTouchMove && interruptTouchEnd, "trusted list touch must complete start/move/end before follow-interruption assertions");
    assert.ok(interruptListScroll, "trusted interrupt gesture must produce actual browser scroll inside message-list before stable-state assertions");
    const interruptedTail = await readTranscriptViewport(page, `seed-${source}-${count}-unmounted`, true);
    assert.equal(interruptedAnchor.fixtureMessageId, jumpAnchor.fixtureMessageId, "interrupted follow must keep the same history MessageBubble visible");
    assert.ok(interruptedAnchor.viewportOffsetPx > programmaticMotion.anchor.viewportOffsetPx + 1,
      "the trusted toward-old touch must reverse visible row motion after the active follow has started");
    assert.equal(interruptedTail.targetMarkerVisibleWithinMessageList, false, "the interrupted tail must remain outside the actual viewport");
    assert.equal(interruptedTail.jumpToLatestVisible, true, "canceled follow must expose Jump again after the user takes over");
    evidence.phases.push({
      id: "trusted-touch-interrupts-in-flight-jump",
      input: touchInterrupt,
      touchStartAfterMotion: interruptTouchStart,
      touchMoveAfterMotion: interruptTouchMove,
      touchEndAfterStable: interruptTouchEnd,
      trustedListScrollAfterStable: interruptListScroll,
      historyAnchorAtMotion: programmaticMotion.anchor,
      historyAnchorAfterInterrupt: interruptedAnchor,
      tailMarkerAfterInterrupt: interruptedTail,
      inputTrace: interruptEvents,
    });
    readerAnchor = interruptedAnchor;
    evidence.interruptionStatus = touchInterrupt.touchStartRaceEvidence?.classification ?? "UNVERIFIED";
    }

    failureStage = "expanding-real-history-code-disclosure-with-stable-anchor";
    const codeAnchorBefore = await waitForStableProductHistoryAnchor(page, readerAnchor.marker, "history anchor before code disclosure expansion");
    const codeDisclosure = await expandProductHistoryCodeDisclosure(page, codeAnchorBefore, state);
    await page.waitForTimeout(120);
    const codeAnchorAfter = await waitForStableProductHistoryAnchor(page, codeAnchorBefore.marker, "history anchor after code disclosure and delayed layout");
    const codeAnchorDelta = assertProductHistoryAnchorPreserved(codeAnchorBefore, codeAnchorAfter, state, "CodeDisclosure expansion");
    assert.equal(codeAnchorAfter.expandedCodeDisclosureCount > 0, true, "the same visible MessageBubble must show its expanded real CodeDisclosure");
    assert.equal(codeAnchorAfter.expandedCodeTokenVisible, true, "expanded code from the existing history fixture must be present in that row");
    evidence.phases.push({ id: "code-disclosure-layout", disclosure: codeDisclosure, anchorBefore: codeAnchorBefore, anchorAfter: codeAnchorAfter, anchor: codeAnchorDelta, postLayoutWaitMs: 120 });

    failureStage = "app-facing-stream-growth-does-not-pull-reader";
    const appendedMarker = `tail-window-${source}-${count}-completed-assistant`;
    const beforeAppend = await waitForStableProductHistoryAnchor(page, codeAnchorAfter.marker, "history anchor before appended Assistant turn");
    const beforeAppendViewport = await readTranscriptViewport(page, appendedMarker, true);
    assert.equal(beforeAppendViewport.targetRowFound, false, "the new Assistant marker must not exist before its actual fixture notification batch");
    assert.equal(beforeAppendViewport.jumpToLatestVisible, true, "manual reading state must expose Jump before the appended turn");
    const appendDelivery = await emitSyntheticTaskSnapshot(page, state, appendedMarker, {
      artifactId: "tail-window-append-artifact",
      workspacePath: state.workspacePath,
      fileCount: 4,
      additions: 23,
      deletions: 2,
      files: Array.from({ length: 4 }, (_, index) => `${state.workspacePath}/src/tail-window-append-${index}.ts`),
      status: "active",
      revertible: true,
    }, { deltaText: makeLongTailWindowAppendDelta(appendedMarker) });
    assert.equal(appendDelivery.dispatchOrderValid, true, "the appended turn must dispatch one ordered four-frame batch on the active fixture runtime socket");
    assert.equal(appendDelivery.observedFrames.length, 4, "the appended completed turn must use exactly the real WebSocketMock four-frame fixture sequence");
    assert.deepEqual(appendDelivery.observedFrames.map((frame) => frame.method), ["turn/started", "item/started", "item/delta", "turn/completed"]);
    const appendCommit = await waitForProductAppendCommit(page, appendedMarker, beforeAppendViewport);
    await page.waitForTimeout(120);
    const afterAppend = await waitForStableProductHistoryAnchor(page, beforeAppend.marker, "history anchor after long Markdown/code append and delayed layout");
    const appendAnchorDelta = assertProductHistoryAnchorPreserved(beforeAppend, afterAppend, state, "completed Assistant stream append");
    const appendTailViewport = await readTranscriptViewport(page, appendedMarker, true);
    assert.equal(appendTailViewport.targetMarkerVisibleWithinMessageList, false, "completed append must not pull the user away from the retained old-history row");
    assert.equal(appendTailViewport.jumpToLatestVisible, true, "Jump must remain visible after the completed append while the reader is paused");
    evidence.phases.push({
      id: "completed-markdown-code-append-without-reader-pull",
      notification: summarizeFollowGestureNotification(appendDelivery),
      deltaByteLength: Buffer.byteLength(makeLongTailWindowAppendDelta(appendedMarker)),
      layoutCommit: appendCommit,
      viewportBefore: beforeAppendViewport,
      anchorBefore: beforeAppend,
      anchorAfter: afterAppend,
      anchor: appendAnchorDelta,
      tailViewportAfterAppend: appendTailViewport,
      postLayoutWaitMs: 120,
    });

    failureStage = "explicit-jump-to-completed-tail-marker";
    const finalJumpTraceBefore = await readTranscriptFollowGestureInputTrace(page);
    const finalJumpStartPageTimeMs = await page.evaluate(() => performance.now());
    await page.getByTestId("jump-to-latest").tap({ timeout: 5_000 });
    const finalJumpTraceAfterTap = await readTranscriptFollowGestureInputTrace(page);
    const finalJumpClicks = trustedJumpClickEventsSince(finalJumpTraceBefore, finalJumpTraceAfterTap);
    assert.equal(finalJumpClicks.length, 1, "final return to the appended tail must use exactly one actual trusted Jump click");
    const finalTailGate = await waitForProductTailMarkerWithoutAction(page, appendedMarker, finalJumpStartPageTimeMs, "final-explicit-jump", { captureVisibilityDiagnostics: true });
    const completedUi = await readCompletedAssistantMarkerUi(page, appendedMarker);
    assert.equal(completedUi.rowFound, true, "the final completed Assistant message must be mounted in the real MessageBubble list");
    assert.equal(completedUi.markerPresent, true, "the final long-delta marker must remain in its completed Assistant row");
    assert.equal(completedUi.runtimeTerminalUi, true, "the visible message must correspond to a terminal UI state after turn/completed");
    assert.equal(areNotificationBatchesOrdered(state.notificationBatches), true, "seed and appended turn batches must retain globally increasing ordered sequence numbers");
    assert.equal(state.notificationBatches.length, 2, "this UI diagnostic must send one seed and one completed appended Assistant turn");
    assert.deepEqual(state.notificationBatches.map((batch) => batch.marker), [`seed-${source}-${count}-unmounted`, appendedMarker]);
    assert.equal(state.syntheticNotificationFramesSent, 8, "the seed and append each send exactly one four-frame batch");
    assert.equal(state.historyRowsDelivered + state.notificationBatches.length, count + 1, "loaded history, seed and the appended turn must account for exact logical message growth without a paging action in this scenario");
    const finalInputTrace = await readTranscriptFollowGestureInputTrace(page);
    assert.equal(finalInputTrace?.dropped, 0, "trusted input event evidence must remain complete rather than exceeding its explicit trace bound");
    evidence.finalInputTraceEventCount = finalInputTrace?.events?.length ?? 0;
    evidence.phases.push({
      id: "explicit-jump-to-latest-after-interrupted-follow-append",
      trustedJumpClick: finalJumpClicks[0],
      finalTailGate,
      completedAssistantUi: completedUi,
    });
    evidence.historyPages = state.historyPages;
    evidence.notificationBatches = state.notificationBatches.map((batch) => ({
      marker: batch.marker,
      turnId: batch.turnId,
      attemptId: batch.attemptId,
      itemId: batch.itemId,
      methods: batch.methods,
      sequences: batch.sequences,
      threadId: batch.threadId,
      serverId: batch.serverId,
      browserMockId: batch.browserMockId,
      threadReadRequestId: batch.threadReadRequestId,
      routeOrdinal: batch.routeOrdinal,
      dispatchOrderValid: batch.dispatchOrderValid,
      maximumDispatchTaskMs: batch.maximumDispatchTaskMs,
    }));
    evidence.finalUniqueHistoryRows = state.historyRowsDelivered;
    evidence.finalLogicalMessageCount = state.historyRowsDelivered + state.notificationBatches.length;
    evidence.pagingStatus = "NOT_RUN_SEPARATE_SCENARIO";
    evidence.evidenceLimit = "one isolated Mobile Web core UI functional run using test-only app-facing WebSocketMock notifications; pagination has a separate diagnostic selector; no Android/iOS Native, physical-phone, Rust Engine, or Provider execution claim";
    evidence.status = "PASS_WEB_DIAGNOSTIC";
  } catch (error) {
    primaryError = error;
    evidence.status = "FAIL";
    evidence.failureStage = failureStage;
    evidence.error = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    evidence.historyPages = state.historyPages;
    if (evidence.interruptionStatus === "PENDING" && error?.productTouchStrokeEvidence) {
      evidence.interruptionStatus = error.productTouchStrokeEvidence.touchStartRaceEvidence?.classification ?? error.productTouchStrokeEvidence.status ?? "UNVERIFIED";
    }
    evidence.notificationBatches = state.notificationBatches.map((batch) => ({
      marker: batch.marker,
      turnId: batch.turnId,
      itemId: batch.itemId,
      methods: batch.methods,
      sequences: batch.sequences,
      threadId: batch.threadId,
      browserMockId: batch.browserMockId,
      threadReadRequestId: batch.threadReadRequestId,
      routeOrdinal: batch.routeOrdinal,
      dispatchOrderValid: batch.dispatchOrderValid,
    }));
    if (error?.appendCommitEvidence) evidence.appendCommitFailure = error.appendCommitEvidence;
    if (error?.historyAnchorEvidence) evidence.historyAnchorFailure = error.historyAnchorEvidence;
    if (error?.productHistoryViewportEvidence) evidence.historyViewportFailure = error.productHistoryViewportEvidence;
    if (error?.productTouchStrokeEvidence) evidence.touchStrokeFailure = error.productTouchStrokeEvidence;
    if (error?.productTouchEvidence) evidence.touchToHistoryFailure = error.productTouchEvidence;
    if (error?.productWheelEvidence) evidence.wheelToOlderControlFailure = error.productWheelEvidence;
    if (error?.productFollowMotionEvidence) evidence.followMotionFailure = error.productFollowMotionEvidence;
    evidence.lastHistoryViewport = await readProductHistoryViewport(page).catch((viewportError) => ({ readError: safeSeedErrorMessage(viewportError) }));
    evidence.lastTranscriptViewport = await readTranscriptViewport(page, null, false).catch((viewportError) => ({ readError: safeSeedErrorMessage(viewportError) }));
    evidence.inputTrace = inputTraceInstalled
      ? await readTranscriptFollowGestureInputTrace(page).catch((traceError) => ({ readError: safeSeedErrorMessage(traceError) }))
      : null;
    error.tailWindowProductEvidence = evidence;
  }

  const cleanupErrors = [];
  evidence.cleanup = {
    inputObserver: { status: inputTraceInstalled ? "pending" : "not-installed" },
    cdpSession: { status: cdp ? "pending" : "not-created" },
  };
  if (inputTraceInstalled) {
    try {
      await disposeTranscriptFollowGestureInputTrace(page);
      evidence.cleanup.inputObserver = { status: "disposed" };
    } catch (error) {
      evidence.cleanup.inputObserver = { status: "failed", error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) } };
      cleanupErrors.push({ operation: "dispose-input-observer", error });
    }
  }
  if (cdp) {
    try {
      await cdp.detach();
      evidence.cleanup.cdpSession = { status: "detached" };
    } catch (error) {
      evidence.cleanup.cdpSession = { status: "failed", error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) } };
      cleanupErrors.push({ operation: "detach-cdp-session", error });
    }
  }
  if (cleanupErrors.length > 0) {
    evidence.status = "FAIL";
    evidence.cleanup.status = "failed";
    if (primaryError) {
      const combinedError = new AggregateError([primaryError, ...cleanupErrors.map((entry) => entry.error)], "tail-window product diagnostic failed and cleanup also failed", { cause: primaryError });
      combinedError.tailWindowProductEvidence = evidence;
      throw combinedError;
    }
    const cleanupError = new AggregateError(cleanupErrors.map((entry) => entry.error), "tail-window product diagnostic cleanup failed", { cause: cleanupErrors[0].error });
    cleanupError.tailWindowProductEvidence = evidence;
    throw cleanupError;
  }
  evidence.cleanup.status = "completed";
  if (primaryError) throw primaryError;
  return evidence;
}

async function runTailWindowPaginationRegression(page, state, source, count, seed) {
  const evidence = {
    schemaVersion: 1,
    status: "RUNNING",
    diagnosticOnly: true,
    performanceSample: false,
    scenario: "trusted-wheel-older-page-prepend-anchor",
    coreStatus: "NOT_RUN_SEPARATE_SCENARIO",
    source,
    requestedMessages: count,
    panelState: "unmounted",
    evidenceClass: "isolated Mobile Web TaskTranscript/MessageBubble with a deterministic paged history fixture and trusted Chromium wheel/click; no Rust app-server/model turn and no Android/iOS Native validation",
    notificationInjectionBoundary: "seed uses the app-facing WebSocketMock._apiSendToPage fixture path; thread/read pagination is requested by the real load-older UI control and answered by the isolated Gateway fixture route",
    pagingContract: "one trusted negative-delta wheel sequence must expose the real older-page control; one real click must cause exactly one thread/read prepend; preserve the same immutable visible history message ID and MessageBubble row top within 2 CSS px after stable two-RAF observations",
    touchStatus: "NOT_RUN_SEPARATE_CORE_SCENARIO",
    seedTailGate: seed?.transcriptViewport ?? null,
    phases: [],
  };
  let failureStage = "validating-natural-seed-tail";
  let cdp = null;
  let inputTraceInstalled = false;
  let primaryError = null;
  try {
    assert.equal(count, 500, "pagination diagnostic is pinned to the existing heterogeneous 500-message fixture");
    assert.equal(state.fixtureShape.reservedOlderHistoryRows, fixturePageSize, "pagination diagnostic must reserve exactly one 50-row older page");
    assert.equal(state.historyRowsDelivered, 499, "initial paged history must deliver exactly 499 rows before the seed notification");
    assert.equal(state.historyMessageIds.size, 499, "initial history message IDs must be unique before the paging interaction");
    assert.equal(seed?.ok, true, "pagination diagnostic requires the real four-frame seed delivery to complete");
    assert.equal(seed?.seedDispatch?.dispatchOrderValid, true, "seed must pass the app-facing WebSocketMock four-frame/sequence gate");
    assert.equal(seed?.transcriptViewport?.status, "PASS", "seed must pass the natural final-character Range/two-RAF tail gate before paging");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames?.targetMarkerVisibleWithinMessageList, true, "seed's last-character Range must intersect the message-list after two RAF opportunities");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames?.jumpToLatestVisible, false, "seed must naturally settle at latest with Jump hidden before paging");
    assert.equal(state.notificationBatches.length, 1, "pagination scenario starts with exactly one completed seed turn and no appended stream");
    assert.equal(state.activeSocketRoute?.server, serverId, "paging must use the expected active fixture runtime route");
    assert.equal(state.activeSocketRoute?.channel, "runtime", "paging fixture must use the Runtime WebSocketMock route");
    assert.equal(state.activeSocketRoute?.workspaceMatchesFixture, true, "paging route must match this RunContext-owned workspace");
    evidence.activeFixtureRoute = {
      routeOrdinal: state.activeSocketRoute.routeOrdinal,
      server: state.activeSocketRoute.server,
      channel: state.activeSocketRoute.channel,
      workspaceMatchesFixture: state.activeSocketRoute.workspaceMatchesFixture,
      threadReadRequestId: state.activeThreadReadRequestId,
    };
    evidence.seedNotification = seed.seedDispatch;

    failureStage = "installing-passive-trusted-input-observer";
    evidence.inputObserver = await installTranscriptFollowGestureInputTrace(page, 4096);
    inputTraceInstalled = true;
    assert.equal(evidence.inputObserver.installed, true, "passive trusted-input observation must attach to the actual message-list");
    cdp = await page.context().newCDPSession(page);

    failureStage = "trusted-wheel-reaches-real-older-page-control";
    const wheelToOlderControl = await performProductWheelToOlderHistoryControl(page);
    evidence.wheelToOlderControl = wheelToOlderControl;
    wheelToOlderControl.chronologicalOrder = assertProductVisibleHistoryOrder(
      wheelToOlderControl.finalViewport,
      "trusted wheel older-history page boundary",
    );
    evidence.phases.push({ id: "trusted-wheel-to-real-older-page-control", ...wheelToOlderControl });
    assert.equal(wheelToOlderControl.finalViewport.olderHistoryControl.visibleWithinMessageList, true, "the real older-page control must be visible before paging");
    assert.equal(wheelToOlderControl.finalViewport.olderHistoryControl.disabled, false, "the visible older-page control must be enabled before paging");

    failureStage = "capturing-stable-visible-history-anchor-before-prepend";
    const beforeViewport = await waitForStableProductHistoryWindow(page, "older-page viewport before prepend");
    const anchorCandidate = [...beforeViewport.visibleRows].sort((left, right) => left.rect.top - right.rect.top)[0];
    assert.ok(anchorCandidate, "the actual viewport at the older-page boundary must contain a mounted history MessageBubble");
    assert.ok(state.historyMessageIds.has(anchorCandidate.fixtureMessageId), "the visible row must map to an immutable ID returned by the real thread/read fixture route");
    const beforeAnchor = await waitForStableProductHistoryAnchor(page, anchorCandidate.marker, "history anchor before older-page prepend");
    assert.equal(beforeAnchor.fixtureMessageId, anchorCandidate.fixtureMessageId, "the stable row anchor must keep the same fixture message ID");
    const controlBefore = await readProductHistoryViewport(page);
    assert.equal(controlBefore.olderHistoryControl.visibleWithinMessageList, true, "the real Load Earlier Messages control must remain visible at the anchored boundary");
    assert.equal(controlBefore.olderHistoryControl.disabled, false, "the older page must be available before the trusted control click");

    failureStage = "real-load-older-click-and-thread-read-prepend";
    const previousPageCount = state.historyPages.length;
    const previousUniqueRows = state.historyRowsDelivered;
    const clickTraceBefore = await readTranscriptFollowGestureInputTrace(page);
    await page.getByTestId("load-older-messages").click({ timeout: 5_000 });
    await waitFor(() => Promise.resolve(state.historyPages.length > previousPageCount), 10_000, "real Mobile load-older thread/read response", 20);
    await waitForTwoFrames(page);
    await page.waitForTimeout(120);
    const pageResponse = state.historyPages.at(-1);
    assert.equal(state.historyPages.length, previousPageCount + 1, "one real older-page click must cause exactly one additional thread/read request");
    assert.equal(pageResponse.cursor, "ux:51", "the control must request the next cursor behind the initially loaded 499 rows");
    assert.equal(pageResponse.start, 1, "the route must return the immediately older fixture range");
    assert.equal(pageResponse.end, 51, "the returned older page must end at the previous beginning cursor");
    assert.equal(pageResponse.count, fixturePageSize, "the route must return exactly one bounded 50-row history page");
    assert.equal(state.historyRowsDelivered, previousUniqueRows + fixturePageSize, "the prepend must add 50 unique history messages without duplicate IDs");
    const clickTraceAfter = await readTranscriptFollowGestureInputTrace(page);
    const trustedPageClicks = transcriptInputEventsSince(clickTraceAfter, clickTraceBefore?.latestOrdinal ?? 0)
      .filter((event) => event.type === "click" && event.isTrusted && event.insideMessageList && event.targetTestId === "load-older-messages");
    assert.equal(trustedPageClicks.length, 1, "the page request must come from exactly one real trusted click on the visible control");

    failureStage = "verifying-prepend-keeps-the-same-visible-row-anchor";
    const afterAnchor = await waitForStableProductHistoryAnchor(page, beforeAnchor.marker, "history anchor after older-page prepend");
    const anchorDelta = assertProductHistoryAnchorPreserved(beforeAnchor, afterAnchor, state, "older-page prepend");
    const afterViewport = await readProductHistoryViewport(page);
    const chronologicalOrder = assertProductVisibleHistoryOrder(afterViewport, "older-page-prepended MessageBubble order");
    assert.equal(afterViewport.jumpToLatestVisible, true, "older-page prepend must preserve paused reading and keep Jump visible");
    assert.equal(afterViewport.olderHistoryControl.disabled, false, "the next older page must remain available after the prepend");
    assert.equal(state.historyRowsDelivered + state.notificationBatches.length, count + fixturePageSize, "initial history, seed, and one older prepend must account for the fixture's exact logical message count");
    const finalTrace = await readTranscriptFollowGestureInputTrace(page);
    assert.equal(finalTrace?.dropped, 0, "trusted input evidence must stay within the explicit observer bound");
    evidence.inputTraceDropped = finalTrace?.dropped ?? null;
    evidence.inputTraceEventCount = finalTrace?.events?.length ?? 0;
    evidence.phases.push({
      id: "actual-older-page-prepend-with-stable-anchor",
      trustedControlClick: trustedPageClicks[0],
      pageResponse,
      previousPageCount,
      pageCountAfter: state.historyPages.length,
      uniqueRowsBefore: previousUniqueRows,
      uniqueRowsAfter: state.historyRowsDelivered,
      anchorBefore: beforeAnchor,
      anchorAfter: afterAnchor,
      anchor: anchorDelta,
      viewportBefore: beforeViewport,
      viewportAfter: afterViewport,
      chronologicalOrder,
      postLayoutWaitMs: 120,
    });
    evidence.historyPages = state.historyPages;
    evidence.notificationBatches = state.notificationBatches.map((batch) => ({
      marker: batch.marker,
      turnId: batch.turnId,
      attemptId: batch.attemptId,
      itemId: batch.itemId,
      methods: batch.methods,
      sequences: batch.sequences,
      threadId: batch.threadId,
      serverId: batch.serverId,
      browserMockId: batch.browserMockId,
      threadReadRequestId: batch.threadReadRequestId,
      routeOrdinal: batch.routeOrdinal,
      dispatchOrderValid: batch.dispatchOrderValid,
      maximumDispatchTaskMs: batch.maximumDispatchTaskMs,
    }));
    evidence.finalUniqueHistoryRows = state.historyRowsDelivered;
    evidence.finalLogicalMessageCount = state.historyRowsDelivered + state.notificationBatches.length;
    evidence.status = "PASS_WEB_DIAGNOSTIC";
  } catch (error) {
    primaryError = error;
    evidence.status = "FAIL";
    evidence.failureStage = failureStage;
    evidence.error = { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) };
    evidence.historyPages = state.historyPages;
    evidence.notificationBatches = state.notificationBatches.map(summarizeFollowGestureNotification);
    if (error?.productWheelEvidence) evidence.wheelToOlderControlFailure = error.productWheelEvidence;
    if (error?.productHistoryViewportEvidence) evidence.historyViewportFailure = error.productHistoryViewportEvidence;
    evidence.lastHistoryViewport = await readProductHistoryViewport(page).catch((viewportError) => ({ readError: safeSeedErrorMessage(viewportError) }));
    evidence.inputTrace = inputTraceInstalled
      ? await readTranscriptFollowGestureInputTrace(page).catch((traceError) => ({ readError: safeSeedErrorMessage(traceError) }))
      : null;
    error.tailWindowPaginationEvidence = evidence;
  }

  const cleanupErrors = [];
  evidence.cleanup = {
    inputObserver: { status: inputTraceInstalled ? "pending" : "not-installed" },
    cdpSession: { status: cdp ? "pending" : "not-created" },
  };
  if (inputTraceInstalled) {
    try {
      await disposeTranscriptFollowGestureInputTrace(page);
      evidence.cleanup.inputObserver = { status: "disposed" };
    } catch (error) {
      evidence.cleanup.inputObserver = { status: "failed", error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) } };
      cleanupErrors.push({ operation: "dispose-input-observer", error });
    }
  }
  if (cdp) {
    try {
      await cdp.detach();
      evidence.cleanup.cdpSession = { status: "detached" };
    } catch (error) {
      evidence.cleanup.cdpSession = { status: "failed", error: { name: error?.name ?? "Error", message: safeSeedErrorMessage(error), stack: safeSeedErrorStack(error) } };
      cleanupErrors.push({ operation: "detach-cdp-session", error });
    }
  }
  evidence.cleanup.status = cleanupErrors.length === 0 ? "completed" : "failed";
  if (cleanupErrors.length > 0) {
    evidence.status = "FAIL";
    const cleanupErrorObjects = cleanupErrors.map((entry) => entry.error);
    const combined = primaryError
      ? new AggregateError([primaryError, ...cleanupErrorObjects], "pagination diagnostic failed and cleanup also failed", { cause: primaryError })
      : new AggregateError(cleanupErrorObjects, "pagination diagnostic cleanup failed", { cause: cleanupErrorObjects[0] });
    combined.tailWindowPaginationEvidence = evidence;
    throw combined;
  }
  if (primaryError) throw primaryError;
  return evidence;
}

async function runTranscriptFollowGestureRegression(page, state, source, count, seed) {
  const seedMarker = `seed-${source}-${count}-unmounted`;
  const settledAppendMarker = `follow-${source}-${count}-settled-append`;
  const interruptedAppendMarker = `follow-${source}-${count}-interrupted-append`;
  const evidence = {
    schemaVersion: 1,
    status: "RUNNING",
    diagnosticOnly: true,
    performanceSample: false,
    source,
    requestedMessages: count,
    panelState: "unmounted",
    evidenceClass: "isolated Mobile Web UI follow-state regression using a synthetic history and ordered app-facing WebSocketMock notifications; no Provider, model turn, Rust app-server turn, or native measurement",
    notificationInjectionBoundary: "test-only Playwright app-facing WebSocketMock._apiSendToPage fixture dispatch on the exact active socket; not a network RPC, Runtime handler call, or Rust app-server receipt",
    historyAnchorTolerancePx: 48,
    historyAnchorGateMeaning: "the selected visible HISTORY row must remain within 48px vertical displacement after append; this detects a tail pull and does not assert zero scroll movement",
    seedTailGate: seed.transcriptViewport ?? null,
    startingHistoryRows: state.historyRowsDelivered,
    startingLogicalMessageCount: state.historyRowsDelivered + 1,
    phases: [],
  };
  let failureStage = "installing-passive-trusted-input-observer";
  let cdp = null;
  let primaryError = null;
  try {
    assert.equal(state.historyRowsDelivered + 1, count, "follow regression must start from the exact requested history count plus its completed seed Agent message");
    assert.equal(seed?.ok, true, "follow regression requires the normal seed delivery gate to pass");
    assert.equal(seed?.transcriptViewport?.after?.targetMarkerVisibleWithinMessageList, true, "initial exact last-character marker must intersect the actual Mobile message-list viewport");
    assert.equal(seed?.transcriptViewport?.afterTwoFrames, true, "initial seed marker must remain visible after two requestAnimationFrame opportunities");
    const observerSetup = await installTranscriptFollowGestureInputTrace(page);
    evidence.inputObserver = observerSetup;
    cdp = await page.context().newCDPSession(page);

    failureStage = "trusted-touch-to-older-history-after-seed-tail-gate";
    const firstOlder = await performTrustedTranscriptTouch(page, cdp, "older", "settled-follow-scroll-to-history");
    const firstAnchor = await readVisibleHistoryAnchor(page);
    assert.ok(firstAnchor?.marker, "trusted scroll must expose a concrete earlier HISTORY row as the retained viewport anchor");
    assert.ok(firstOlder.after.scrollTop < firstOlder.before.scrollTop - 96, "trusted touch must move the real message-list scroll position toward older history");
    assert.ok(firstOlder.after.bottomGapPx > 96 && firstOlder.after.jumpToLatestVisible, "scrolling away from latest must leave the real list away from its 96px follow threshold and show jump-to-latest");
    evidence.phases.push({
      id: "settled-follow-user-scroll",
      input: firstOlder,
      visibleHistoryAnchorBeforeAppend: firstAnchor,
    });

    failureStage = "settled-follow-append-does-not-pull-user-viewport-to-tail";
    const settledAppendBefore = firstOlder.after;
    const settledDelivery = await emitSyntheticTaskSnapshot(page, state, settledAppendMarker, {
      artifactId: settledAppendMarker,
      workspacePath: state.workspacePath,
      fileCount: 1,
      additions: 1,
      deletions: 0,
      files: [`${state.workspacePath}/src/${settledAppendMarker}.ts`],
      status: "active",
      revertible: true,
    });
    const settledAppend = await waitForFollowAppendLayout(page, settledAppendBefore, settledAppendMarker, "settled-scroll appended Assistant message to affect the real transcript");
    const settledAnchorAfter = await readVisibleHistoryAnchor(page, firstAnchor.marker);
    assertNoFollowPull(settledAppendBefore, settledAppend, firstAnchor, settledAnchorAfter, "settled-scroll append");
    evidence.phases.push({
      id: "settled-follow-append-without-pull",
      notification: summarizeFollowGestureNotification(settledDelivery),
      viewportBefore: settledAppendBefore,
      viewportAfter: settledAppend,
      visibleHistoryAnchorBefore: firstAnchor,
      visibleHistoryAnchorAfter: settledAnchorAfter,
      newMarkerVisibleBeforeExplicitJump: settledAppend.targetMarkerVisibleWithinMessageList,
      logicalMessageCountAfterAppend: count + 1,
    });

    failureStage = "explicit-jump-after-settled-user-scroll";
    const firstJumpTraceStart = await readTranscriptFollowGestureInputTrace(page);
    const settledTailGate = await scrollTranscriptToLatest(page, settledAppendMarker, { requireMarkerVisible: true });
    const firstJumpTraceEnd = await readTranscriptFollowGestureInputTrace(page);
    const firstJumpTouchEvents = trustedJumpClickEventsSince(firstJumpTraceStart, firstJumpTraceEnd);
    assert.equal(settledTailGate.before.targetMarkerVisibleWithinMessageList, false, "new appended marker must be outside the old viewport before the explicit return-to-latest action");
    assert.equal(settledTailGate.before.jumpToLatestVisible, true, "the real jump-to-latest control must be visible before the first return action");
    assert.equal(settledTailGate.actions.filter((entry) => entry.action === "actual-touch-on-jump-to-latest").length, 1, "the first return must use exactly one real jump-to-latest touch");
    assert.equal(firstJumpTouchEvents.length, 1, "the page must record exactly one trusted click on jump-to-latest for the first return");
    assert.equal(settledTailGate.after.targetMarkerVisibleWithinMessageList, true, "the first explicit jump must expose the appended marker's final character in the real list viewport");
    assert.ok(settledTailGate.after.targetMarkerLastCharacterRangeCount > 0, "the first appended marker must have measurable last-character Range geometry");
    assert.equal(settledTailGate.afterTwoFrames, true, "the first appended marker must remain visible after two animation-frame opportunities");
    const settledTerminalUi = await readCompletedAssistantMarkerUi(page, settledAppendMarker);
    assert.equal(settledTerminalUi.rowFound, true, "the first completed Assistant marker must exist in the rendered transcript");
    assert.equal(settledTerminalUi.markerPresent, true, "the first completed Assistant row must retain its unique fixture marker");
    assert.equal(settledTerminalUi.runtimeTerminalUi, true, "the first appended Assistant turn must be terminal before the regression continues");
    evidence.phases.push({
      id: "settled-follow-explicit-jump",
      userInput: firstJumpTouchEvents,
      tailGate: settledTailGate,
      completedAssistantUi: settledTerminalUi,
    });

    failureStage = "trusted-touch-to-older-history-before-interrupt-race";
    const secondOlder = await performTrustedTranscriptTouch(page, cdp, "older", "prepare-programmatic-follow-interruption");
    const secondAnchor = await readVisibleHistoryAnchor(page);
    assert.ok(secondAnchor?.marker, "interruption variant must first return to a real visible HISTORY row");
    assert.ok(secondOlder.after.scrollTop < secondOlder.before.scrollTop - 96, "interruption variant must leave the actual list away from latest before pressing jump");
    assert.ok(secondOlder.after.bottomGapPx > 96 && secondOlder.after.jumpToLatestVisible, "interruption variant requires a visible jump control before starting animated follow");

    failureStage = "interrupting-observed-programmatic-follow-with-trusted-touch";
    const beforeInterruptJump = await readTranscriptViewport(page, settledAppendMarker, true);
    const interruptJumpTraceStart = await readTranscriptFollowGestureInputTrace(page);
    await page.getByTestId("jump-to-latest").tap({ timeout: 5_000 });
    const interruptJumpTraceAfterTap = await readTranscriptFollowGestureInputTrace(page);
    const interruptJumpClick = trustedJumpClickEventsSince(interruptJumpTraceStart, interruptJumpTraceAfterTap);
    assert.equal(interruptJumpClick.length, 1, "the interrupt variant must begin with one trusted jump button click");
    const firstMovingScroll = await waitForProgrammaticFollowScrollEvent(
      page,
      interruptJumpTraceStart.latestOrdinal,
      beforeInterruptJump.scrollTop,
    );
    assert.ok(firstMovingScroll.scrollTop > beforeInterruptJump.scrollTop + 1, "jump-to-latest must begin moving the actual list toward the tail before the interrupt gesture");
    assert.ok(firstMovingScroll.bottomGapPx > 96, "the interrupt must occur while the scroll is still in flight, before the latest threshold is reached");
    const interruptedOlder = await performTrustedTranscriptTouch(page, cdp, "older", "interrupt-active-programmatic-follow");
    const interruptTrace = await readTranscriptFollowGestureInputTrace(page);
    const interruptEvents = transcriptInputEventsSince(interruptTrace, interruptedOlder.eventStartOrdinal);
    const interruptTouchStart = interruptEvents.find((event) => event.type === "touchstart" && event.insideMessageList);
    const programmaticMotionBeforeTouch = interruptTrace.events.find((event) =>
      event.ordinal > interruptJumpTraceStart.latestOrdinal
      && event.type === "scroll"
      && event.insideMessageList
      && event.scrollTop > beforeInterruptJump.scrollTop + 1
      && event.bottomGapPx > 96
      && event.ordinal < (interruptTouchStart?.ordinal ?? Infinity),
    );
    assert.ok(programmaticMotionBeforeTouch, "recorded scroll geometry must prove that the trusted user touch began after animated latest-follow motion started and before it settled");
    assert.ok(interruptTouchStart?.isTrusted, "the mid-flight list touchstart must be a trusted browser event");
    assert.ok(interruptTouchStart.bottomGapPx > 96, "the active-follow interrupt must begin before the real message-list reaches the latest threshold");
    assert.ok(interruptTouchStart.scrollTop > beforeInterruptJump.scrollTop + 1, "the active-follow interrupt must begin after the programmatic scroll has advanced toward latest");
    assert.ok(interruptedOlder.after.scrollTop < interruptedOlder.before.scrollTop - 96, "the trusted interrupt must move the real list back toward older history");
    assert.ok(interruptedOlder.after.bottomGapPx > 96 && interruptedOlder.after.jumpToLatestVisible, "the interrupted list must settle away from latest with jump-to-latest visible");
    const interruptAnchorAfter = await readVisibleHistoryAnchor(page, secondAnchor.marker);
    assert.ok(interruptAnchorAfter?.visibleWithinMessageList, "the interruption gesture must leave its prior visible history anchor in the list");
    evidence.phases.push({
      id: "interrupt-programmatic-follow",
      visibleHistoryAnchorBeforeJump: secondAnchor,
      viewportBeforeJump: beforeInterruptJump,
      jumpButtonClick: interruptJumpClick[0],
      firstProgrammaticScrollEvent: firstMovingScroll,
      touchAfterMotionStarted: interruptTouchStart,
      programmaticMotionBeforeTouch,
      input: interruptedOlder,
      visibleHistoryAnchorAfterInterrupt: interruptAnchorAfter,
    });

    failureStage = "append-during-interrupted-follow-does-not-pull-user-viewport-to-tail";
    const interruptAppendBefore = interruptedOlder.after;
    const interruptDelivery = await emitSyntheticTaskSnapshot(page, state, interruptedAppendMarker, {
      artifactId: interruptedAppendMarker,
      workspacePath: state.workspacePath,
      fileCount: 1,
      additions: 2,
      deletions: 0,
      files: [`${state.workspacePath}/src/${interruptedAppendMarker}.ts`],
      status: "active",
      revertible: true,
    });
    const interruptAppend = await waitForFollowAppendLayout(page, interruptAppendBefore, interruptedAppendMarker, "interrupted-follow appended Assistant message to affect the real transcript");
    const interruptAnchorAfterAppend = await readVisibleHistoryAnchor(page, secondAnchor.marker);
    assertNoFollowPull(interruptAppendBefore, interruptAppend, secondAnchor, interruptAnchorAfterAppend, "interrupted-follow append");
    evidence.phases.push({
      id: "interrupted-follow-append-without-pull",
      notification: summarizeFollowGestureNotification(interruptDelivery),
      viewportBefore: interruptAppendBefore,
      viewportAfter: interruptAppend,
      visibleHistoryAnchorBefore: secondAnchor,
      visibleHistoryAnchorAfter: interruptAnchorAfterAppend,
      newMarkerVisibleBeforeExplicitJump: interruptAppend.targetMarkerVisibleWithinMessageList,
      logicalMessageCountAfterAppends: count + 2,
    });

    failureStage = "explicit-jump-after-interrupted-follow";
    const finalJumpTraceStart = await readTranscriptFollowGestureInputTrace(page);
    const interruptedTailGate = await scrollTranscriptToLatest(page, interruptedAppendMarker, { requireMarkerVisible: true });
    const finalJumpTraceEnd = await readTranscriptFollowGestureInputTrace(page);
    const finalJumpTouchEvents = trustedJumpClickEventsSince(finalJumpTraceStart, finalJumpTraceEnd);
    assert.equal(interruptedTailGate.before.targetMarkerVisibleWithinMessageList, false, "the second appended marker must be outside the retained old-history viewport before its explicit jump");
    assert.equal(interruptedTailGate.before.jumpToLatestVisible, true, "the jump control must remain available after the interrupted-follow append");
    assert.equal(interruptedTailGate.actions.filter((entry) => entry.action === "actual-touch-on-jump-to-latest").length, 1, "the final return must use exactly one real jump-to-latest touch");
    assert.equal(finalJumpTouchEvents.length, 1, "the page must record exactly one trusted click on jump-to-latest for the final return");
    assert.equal(interruptedTailGate.after.targetMarkerVisibleWithinMessageList, true, "the final explicit jump must expose the newest marker's last character in the actual list viewport");
    assert.ok(interruptedTailGate.after.targetMarkerLastCharacterRangeCount > 0, "the newest marker must have measurable last-character Range geometry");
    assert.equal(interruptedTailGate.afterTwoFrames, true, "the newest marker must remain visible after two animation-frame opportunities");
    const interruptedTerminalUi = await readCompletedAssistantMarkerUi(page, interruptedAppendMarker);
    assert.equal(interruptedTerminalUi.rowFound, true, "the newest completed Assistant marker must exist in the rendered transcript");
    assert.equal(interruptedTerminalUi.markerPresent, true, "the newest completed Assistant row must retain its unique fixture marker");
    assert.equal(interruptedTerminalUi.runtimeTerminalUi, true, "the newest appended Assistant turn must be terminal in the visible UI");
    assert.equal(areNotificationBatchesOrdered(state.notificationBatches), true, "seed and appended synthetic notification batches must keep one ordered sequence on the same active thread fixture");
    assert.equal(state.notificationBatches.length, 3, "the seed and both append phases must each use one complete notification batch");
    assert.deepEqual(state.notificationBatches.map((batch) => batch.marker), [seedMarker, settledAppendMarker, interruptedAppendMarker], "all three completed turns must have unique expected markers in order");
    assert.equal(state.syntheticNotificationFramesSent, 12, "the seed and two append phases must each dispatch the four ordered task frames exactly once");
    assert.equal(state.historyRowsDelivered + state.notificationBatches.length, count + 2, "fixture history plus seed and two appended Assistant turns must preserve the reported logical message growth");
    evidence.phases.push({
      id: "interrupted-follow-explicit-jump",
      userInput: finalJumpTouchEvents,
      tailGate: interruptedTailGate,
      completedAssistantUi: interruptedTerminalUi,
    });
    evidence.notificationBatches = state.notificationBatches.map(summarizeFollowGestureNotification);
    evidence.finalLogicalMessageCount = count + 2;
    evidence.status = "PASS_WEB_DIAGNOSTIC";
    evidence.inputTrace = await readTranscriptFollowGestureInputTrace(page);
    return evidence;
  } catch (error) {
    primaryError = error;
    evidence.status = "FAIL";
    evidence.failureStage = failureStage;
    evidence.notificationBatches = state.notificationBatches.map(summarizeFollowGestureNotification);
    evidence.error = {
      name: error?.name ?? "Error",
      message: safeSeedErrorMessage(error),
      stack: safeSeedErrorStack(error),
    };
    evidence.inputTrace = await readTranscriptFollowGestureInputTrace(page).catch((traceError) => ({
      readError: safeSeedErrorMessage(traceError),
    }));
    evidence.lastViewport = await readTranscriptViewport(page, interruptedAppendMarker, true).catch((viewportError) => ({
      readError: safeSeedErrorMessage(viewportError),
    }));
    error.followGestureEvidence = evidence;
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = {
      observerDispose: { status: "pending" },
      cdpDetach: { status: cdp ? "pending" : "not-created" },
    };
    try {
      await disposeTranscriptFollowGestureInputTrace(page);
      cleanup.observerDispose = { status: "completed" };
    } catch (error) {
      cleanup.observerDispose = {
        status: "failed",
        error: {
          name: error?.name ?? "Error",
          message: safeSeedErrorMessage(error),
          stack: safeSeedErrorStack(error),
        },
      };
      cleanupErrors.push({ operation: "observer-dispose", error });
    }
    if (cdp) {
      try {
        await cdp.detach();
        cleanup.cdpDetach = { status: "completed" };
      } catch (error) {
        cleanup.cdpDetach = {
          status: "failed",
          error: {
            name: error?.name ?? "Error",
            message: safeSeedErrorMessage(error),
            stack: safeSeedErrorStack(error),
          },
        };
        cleanupErrors.push({ operation: "cdp-detach", error });
      }
    }
    evidence.cleanup = {
      status: cleanupErrors.length === 0 ? "completed" : "failed",
      ...cleanup,
    };
    if (cleanupErrors.length > 0) {
      evidence.status = "FAIL";
      evidence.failureStage = primaryError ? failureStage : "gesture-diagnostic-cleanup";
      if (!primaryError) {
        evidence.error = {
          name: "FollowGestureCleanupError",
          message: "follow-gesture diagnostic cleanup failed",
          cleanupErrors: cleanupErrors.map(({ operation, error }) => ({
            operation,
            name: error?.name ?? "Error",
            message: safeSeedErrorMessage(error),
            stack: safeSeedErrorStack(error),
          })),
        };
      }
      const cleanupErrorObjects = cleanupErrors.map(({ error }) => error);
      const aggregateError = primaryError
        ? new AggregateError([primaryError, ...cleanupErrorObjects], "follow-gesture diagnostic failed and cleanup also failed", { cause: primaryError })
        : new AggregateError(cleanupErrorObjects, "follow-gesture diagnostic cleanup failed", { cause: cleanupErrorObjects[0] });
      aggregateError.followGestureEvidence = evidence;
      throw aggregateError;
    }
  }
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

async function disposeTranscriptFollowGestureInputTrace(page) {
  await page.evaluate(() => window.__phoneFollowGestureInputTrace?.dispose());
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

async function waitForProductAppendCommit(page, marker, beforeViewport) {
  const observations = [];
  const startedAt = performance.now();
  while (performance.now() - startedAt <= 5_000) {
    const viewport = await readTranscriptViewport(page, marker, true);
    const history = await readProductHistoryViewport(page);
    const assistant = await readCompletedAssistantMarkerUi(page, marker);
    const signal = viewport.targetRowFound
      ? "new-assistant-messagebubble-row-mounted"
      : viewport.scrollHeight !== beforeViewport.scrollHeight
        ? "message-list-scroll-height-changed-after-notification"
        : null;
    observations.push({
      pageTimeMs: viewport.sampledAtPageTimeMs,
      signal,
      targetRowFound: viewport.targetRowFound,
      targetMarkerVisible: viewport.targetMarkerVisibleWithinMessageList,
      scrollHeight: viewport.scrollHeight,
      visibleHistoryIndexes: history.visibleHistoryIndexes,
      runtimeTerminalUi: assistant.runtimeTerminalUi,
    });
    if (signal) {
      await waitForTwoFrames(page);
      const afterTwoFrames = await readTranscriptViewport(page, marker, true);
      return {
        signal,
        observations: observations.slice(-12),
        afterTwoFrames,
        terminalUiAtCommit: await readCompletedAssistantMarkerUi(page, marker),
      };
    }
    await page.waitForTimeout(50);
  }
  const error = new Error(`completed Assistant notification did not produce a visible-row or list-extent commit for ${marker}`);
  error.appendCommitEvidence = { marker, beforeViewport, observations: observations.slice(-20) };
  throw error;
}

async function performTrustedTranscriptTouch(page, cdp, direction, label) {
  assert.ok(direction === "older" || direction === "latest", "transcript touch direction must be older or latest");
  const list = page.getByTestId("message-list");
  const bounds = await list.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, "trusted touch must begin inside a visible message-list hitbox");
  const x = Math.round(bounds.x + bounds.width / 2);
  const fromY = direction === "older"
    ? Math.round(bounds.y + Math.min(88, bounds.height * 0.2))
    : Math.round(bounds.y + bounds.height - Math.min(72, bounds.height * 0.15));
  const toY = direction === "older"
    ? Math.round(bounds.y + bounds.height - 24)
    : Math.round(bounds.y + 24);
  assert.ok(Math.abs(toY - fromY) >= 96, "trusted touch path must be long enough to leave the 96px latest-follow threshold");
  const hitTest = await page.evaluate(({ pointX, pointY }) => {
    const listRoot = document.querySelector('[data-testid="message-list"]');
    const target = document.elementFromPoint(pointX, pointY);
    return {
      hit: Boolean(target),
      insideMessageList: Boolean(listRoot && target && listRoot.contains(target)),
      targetTag: target?.tagName ?? null,
      targetTestId: target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
    };
  }, { pointX: x, pointY: fromY });
  assert.equal(hitTest.insideMessageList, true, "real touch start point must hit inside the actual message-list DOM subtree");
  const before = await readTranscriptViewport(page, null, false);
  const traceBefore = await readTranscriptFollowGestureInputTrace(page);
  const eventStartOrdinal = traceBefore?.latestOrdinal ?? 0;
  const pointCount = 12;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: fromY, id: 71 }],
  });
  for (let index = 1; index <= pointCount; index += 1) {
    const y = fromY + ((toY - fromY) * index) / pointCount;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: 71 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const settled = await waitForTranscriptTouchSettled(page, before, direction, eventStartOrdinal, label);
  const afterTwoFrames = await readTranscriptViewport(page, null, false);
  const traceAfter = await readTranscriptFollowGestureInputTrace(page);
  const events = transcriptInputEventsSince(traceAfter, eventStartOrdinal);
  const touchEvents = events.filter((event) => ["touchstart", "touchmove", "touchend"].includes(event.type));
  assert.ok(touchEvents.some((event) => event.type === "touchstart"), `${label}: a touchstart must reach the Mobile message-list`);
  assert.ok(touchEvents.some((event) => event.type === "touchmove"), `${label}: a touchmove must reach the Mobile message-list`);
  assert.ok(touchEvents.some((event) => event.type === "touchend"), `${label}: a touchend must reach the Mobile message-list`);
  assert.ok(touchEvents.every((event) => event.isTrusted && event.insideMessageList), `${label}: all captured touch events must be trusted and inside message-list`);
  assert.ok(events.some((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList), `${label}: a trusted browser scroll event must follow the touch within message-list`);
  assert.equal(afterTwoFrames.bottomGapPx > 96, true, `${label}: viewport must remain away from the latest-follow threshold after two frames`);
  assert.equal(afterTwoFrames.jumpToLatestVisible, true, `${label}: jump-to-latest must be visible after scrolling to older history`);
  return {
    label,
    direction,
    boundary: "Chromium CDP touch input; actual hit-test and trusted DOM touch/scroll events are required",
    hitTest,
    start: { x, y: fromY },
    end: { x, y: toY },
    pointCount: pointCount + 2,
    eventStartOrdinal,
    before,
    after: settled.viewport,
    afterTwoFrames,
    stableViewportPollCount: settled.pollCount,
    events,
  };
}

async function waitForTranscriptTouchSettled(page, before, direction, eventStartOrdinal, label) {
  let previous = null;
  let stableSamples = 0;
  let pollCount = 0;
  let last = before;
  const settled = await waitFor(async () => {
    pollCount += 1;
    const viewport = await readTranscriptViewport(page, null, false);
    const trace = await readTranscriptFollowGestureInputTrace(page);
    const events = transcriptInputEventsSince(trace, eventStartOrdinal);
    const trustedScrollObserved = events.some((event) => event.type === "scroll" && event.isTrusted && event.insideMessageList);
    const movedAsRequested = direction === "older"
      ? viewport.scrollTop < before.scrollTop - 96
      : viewport.scrollTop > before.scrollTop + 96;
    const remainedAwayFromLatest = viewport.bottomGapPx > 96 && viewport.jumpToLatestVisible;
    const stable = previous !== null
      && Math.abs(viewport.scrollTop - previous.scrollTop) <= 1
      && viewport.scrollHeight === previous.scrollHeight
      && viewport.clientHeight === previous.clientHeight;
    if (trustedScrollObserved && movedAsRequested && remainedAwayFromLatest && stable) stableSamples += 1;
    else stableSamples = 0;
    previous = viewport;
    last = viewport;
    return stableSamples >= 2 ? viewport : null;
  }, 10_000, `${label}: trusted transcript scroll to settle away from latest`, 50);
  await waitForTwoFrames(page);
  const afterTwoFrames = await readTranscriptViewport(page, null, false);
  assert.ok(Math.abs(afterTwoFrames.scrollTop - settled.scrollTop) <= 1 && afterTwoFrames.scrollHeight === settled.scrollHeight, `${label}: list geometry must remain stable after two additional animation frames`);
  return { viewport: afterTwoFrames, last, stableSamples, pollCount, settled };
}

async function waitForProgrammaticFollowScrollEvent(page, afterOrdinal, startingScrollTop) {
  const handle = await page.waitForFunction(({ ordinal, startTop }) => {
    const trace = window.__phoneFollowGestureInputTrace?.snapshot();
    return trace?.events.find((event) => event.ordinal > ordinal
      && event.type === "scroll"
      && event.insideMessageList
      && event.scrollTop > startTop + 1
      && event.bottomGapPx > 96) ?? null;
  }, { ordinal: afterOrdinal, startTop: startingScrollTop }, { timeout: 10_000, polling: "raf" });
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}

async function waitForFollowAppendLayout(page, before, marker, label) {
  const commit = await waitFor(async () => {
    const viewport = await readTranscriptViewport(page, marker, true);
    const layoutSignal = viewport.scrollHeight > before.scrollHeight
      ? "message-list-scroll-height-increased"
      : viewport.targetRowFound ? "new-assistant-marker-row-mounted" : null;
    return layoutSignal ? { viewport, layoutSignal } : null;
  }, 10_000, label, 50);
  await waitForTwoFrames(page);
  return {
    ...await readTranscriptViewport(page, marker, true),
    layoutSignal: commit.layoutSignal,
    commitViewport: commit.viewport,
    afterTwoFrames: true,
  };
}

function assertNoFollowPull(before, after, anchorBefore, anchorAfter, label) {
  assert.ok(after.scrollHeight > before.scrollHeight || after.layoutSignal === "new-assistant-marker-row-mounted", `${label}: UI must expose the appended message through list extent or its rendered Agent row`);
  assert.ok(after.bottomGapPx > 96, `${label}: content arrival must not return the user to the latest-follow threshold`);
  assert.equal(after.jumpToLatestVisible, true, `${label}: jump-to-latest must remain visible after content arrival`);
  assert.ok(anchorAfter?.visibleWithinMessageList, `${label}: the previously visible old-history anchor must remain in the message-list viewport`);
  assert.equal(anchorAfter.marker, anchorBefore.marker, `${label}: content arrival must preserve the same visible old-history anchor`);
  assert.ok(Math.abs(anchorAfter.rect.top - anchorBefore.rect.top) <= 48, `${label}: old-history anchor must not be displaced by an automatic tail pull`);
}

async function readVisibleHistoryAnchor(page, requiredMarker = null) {
  return page.evaluate((marker) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return null;
    const listRect = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
    const candidates = rows.map((row) => {
      const rect = row.getBoundingClientRect();
      const historyMarker = (row.textContent ?? "").match(/HISTORY-\d{4}/)?.[0] ?? null;
      return {
        marker: historyMarker,
        rowTestId: row.getAttribute("data-testid"),
        rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
        visibleWithinMessageList: Boolean(historyMarker)
          && rect.width > 0 && rect.height > 0
          && rect.right > listRect.left && rect.left < listRect.right
          && rect.bottom > listRect.top && rect.top < listRect.bottom,
      };
    }).filter((row) => row.visibleWithinMessageList && (!marker || row.marker === marker));
    return candidates[0] ?? null;
  }, requiredMarker);
}

async function readCompletedAssistantMarkerUi(page, marker) {
  return page.evaluate((expectedMarker) => {
    const row = [...document.querySelectorAll('[data-testid="message-assistant"]')]
      .find((element) => (element.textContent ?? "").includes(expectedMarker)) ?? null;
    return {
      rowFound: Boolean(row),
      markerPresent: Boolean(row && (row.textContent ?? "").includes(expectedMarker)),
      failureMarkerPresent: Boolean(row?.querySelector('[data-testid="message-attempt-failure"]')),
      unknownMarkerPresent: Boolean(row?.querySelector('[data-testid="message-attempt-unknown"]')),
      runtimeTerminalUi: !document.querySelector('[data-testid="stop-turn"]')
        && Boolean(document.querySelector('[data-testid="send-message"]'))
        && !Boolean(document.querySelector('[data-testid="queue-message"]')),
    };
  }, marker);
}

function transcriptInputEventsSince(trace, ordinal) {
  return Array.isArray(trace?.events) ? trace.events.filter((event) => event.ordinal > ordinal) : [];
}

function trustedJumpClickEventsSince(beforeTrace, afterTrace) {
  return transcriptInputEventsSince(afterTrace, beforeTrace?.latestOrdinal ?? 0)
    .filter((event) => event.type === "click" && event.insideJumpButton && event.isTrusted);
}

function summarizeFollowGestureNotification(delivery) {
  if (!delivery) return null;
  return {
    delivered: delivery.delivered,
    dispatchOrderValid: delivery.dispatchOrderValid,
    methods: delivery.observedFrames?.map((frame) => frame.method) ?? [],
    sequences: delivery.observedFrames?.map((frame) => frame.sequence) ?? [],
    threadId: delivery.observedFrames?.[0]?.threadId ?? null,
    turnId: delivery.observedFrames?.[0]?.turnId ?? null,
    itemId: delivery.itemId ?? null,
    browserMockId: delivery.browserMockId ?? null,
    routeOrdinal: delivery.observedFrames?.[0]?.routeOrdinal ?? null,
  };
}

async function readTranscriptViewport(page, expectedTailMarker, includeMarkerGeometry = false, options = {}) {
  return page.evaluate(({ marker, includeMarkerGeometry, captureVirtualizedGeometry, captureMarkerVisibilityDiagnostics, captureScrollportTransform, scrollTraceKey, limits }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { listFound: false, expectedTailMarker: marker };
    const rootRect = list.getBoundingClientRect();
    const scrollables = [list, ...list.querySelectorAll("*")].filter((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    ).sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight),
    );
    const observedHost = list.querySelector("[data-phone-ux-scroll-host]");
    const host = observedHost instanceof HTMLElement ? observedHost : scrollables[0] ?? list;
    const scrollportTransform = captureScrollportTransform ? getComputedStyle(host).transform : null;
    const rows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
    const target = typeof marker === "string"
      ? rows.find((row) => (row.textContent ?? "").includes(marker)) ?? null
      : rows.at(-1) ?? null;
    const rowRect = target?.getBoundingClientRect() ?? null;
    let targetMarkerGeometry = null;
    if (includeMarkerGeometry && target && typeof marker === "string" && marker.length > 0) {
      const textNodes = [];
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      let joinedText = "";
      while (textNode) {
        const text = textNode.nodeValue ?? "";
        textNodes.push({ node: textNode, startOffset: joinedText.length, endOffset: joinedText.length + text.length });
        joinedText += text;
        textNode = walker.nextNode();
      }
      const occurrenceOffsets = [];
      for (let offset = joinedText.indexOf(marker); offset >= 0; offset = joinedText.indexOf(marker, offset + 1)) occurrenceOffsets.push(offset);
      const selectedLastOccurrenceOffset = occurrenceOffsets.at(-1) ?? -1;
      const locateTextPosition = (offset) => {
        const textNodeIndex = textNodes.findIndex((entry) => offset >= entry.startOffset && offset < entry.endOffset);
        const segment = textNodes[textNodeIndex];
        return segment ? { node: segment.node, offset: offset - segment.startOffset, textNodeIndex } : null;
      };
      const firstCharacter = selectedLastOccurrenceOffset >= 0 ? locateTextPosition(selectedLastOccurrenceOffset) : null;
      const lastCharacterOffset = selectedLastOccurrenceOffset >= 0 ? selectedLastOccurrenceOffset + marker.length - 1 : -1;
      const lastCharacter = lastCharacterOffset >= 0 ? locateTextPosition(lastCharacterOffset) : null;
      if (firstCharacter && lastCharacter) {
        const fullMarkerRange = document.createRange();
        fullMarkerRange.setStart(firstCharacter.node, firstCharacter.offset);
        fullMarkerRange.setEnd(lastCharacter.node, lastCharacter.offset + 1);
        const markerRangeRects = [...fullMarkerRange.getClientRects()];
        const lastCharacterRange = document.createRange();
        lastCharacterRange.setStart(lastCharacter.node, lastCharacter.offset);
        lastCharacterRange.setEnd(lastCharacter.node, lastCharacter.offset + 1);
        const lastCharacterRangeRects = [...lastCharacterRange.getClientRects()];
        const lastCharacterRect = lastCharacterRange.getBoundingClientRect();
        const rect = {
          top: lastCharacterRect.top,
          bottom: lastCharacterRect.bottom,
          left: lastCharacterRect.left,
          right: lastCharacterRect.right,
          width: lastCharacterRect.width,
          height: lastCharacterRect.height,
        };
        const targetStyle = getComputedStyle(target);
        const listStyle = getComputedStyle(list);
        targetMarkerGeometry = {
          found: true,
          occurrenceCount: occurrenceOffsets.length,
          selectedOccurrenceIndex: occurrenceOffsets.length - 1,
          selectedLastOccurrenceOffset,
          lastCharacterOffset,
          textNodeCount: textNodes.length,
          firstCharacterTextNodeIndex: firstCharacter.textNodeIndex,
          firstCharacterTextNodeOffset: firstCharacter.offset,
          lastCharacterTextNodeIndex: lastCharacter.textNodeIndex,
          lastCharacterTextNodeOffset: lastCharacter.offset,
          rangeCount: markerRangeRects.length,
          lastCharacterRangeCount: lastCharacterRangeRects.length,
          lastCharacterRect: rect,
          visible: rect.width > 0 && rect.height > 0
            && targetStyle.display !== "none" && targetStyle.visibility !== "hidden"
            && listStyle.display !== "none" && listStyle.visibility !== "hidden",
        };
      } else {
        targetMarkerGeometry = {
          found: false,
          occurrenceCount: occurrenceOffsets.length,
          selectedOccurrenceIndex: occurrenceOffsets.length - 1,
          selectedLastOccurrenceOffset,
          lastCharacterOffset,
          textNodeCount: textNodes.length,
          firstCharacterTextNodeIndex: null,
          firstCharacterTextNodeOffset: null,
          lastCharacterTextNodeIndex: null,
          lastCharacterTextNodeOffset: null,
          rangeCount: 0,
          lastCharacterRangeCount: 0,
          lastCharacterRect: null,
          visible: false,
        };
      }
    }
    const targetVisibleWithinMessageList = Boolean(rowRect)
      && rowRect.width > 0 && rowRect.height > 0
      && rowRect.right > rootRect.left && rowRect.left < rootRect.right
      && rowRect.bottom > rootRect.top && rowRect.top < rootRect.bottom;
    const jump = document.querySelector('[data-testid="jump-to-latest"]');
    const jumpRect = jump?.getBoundingClientRect() ?? null;
    const jumpStyle = jump instanceof HTMLElement ? getComputedStyle(jump) : null;
    const jumpOpacity = jumpStyle ? Number.parseFloat(jumpStyle.opacity) : 1;
    const jumpToLatestVisible = Boolean(jumpRect)
      && jumpRect.width > 0 && jumpRect.height > 0
      && jumpStyle?.display !== "none" && jumpStyle?.visibility !== "hidden"
      && Number.isFinite(jumpOpacity) && jumpOpacity > 0.01;
    const composer = document.querySelector('[data-testid="message-input-root"]');
    const composerRect = composer?.getBoundingClientRect() ?? null;
    const composerStyle = composer instanceof HTMLElement ? getComputedStyle(composer) : null;
    const composerOpacity = composerStyle ? Number.parseFloat(composerStyle.opacity) : 1;
    const rectSnapshot = (rect) => rect ? {
      top: Number(rect.top.toFixed(2)),
      bottom: Number(rect.bottom.toFixed(2)),
      left: Number(rect.left.toFixed(2)),
      right: Number(rect.right.toFixed(2)),
      width: Number((rect.width ?? rect.right - rect.left).toFixed(2)),
      height: Number((rect.height ?? rect.bottom - rect.top).toFixed(2)),
    } : null;
    const rectIntersects = (left, right) => Boolean(left && right)
      && left.right > right.left && left.left < right.right
      && left.bottom > right.top && left.top < right.bottom;
    const rectIntersection = (left, right) => {
      if (!left || !right) return null;
      const intersection = {
        left: Math.max(left.left, right.left),
        top: Math.max(left.top, right.top),
        right: Math.min(left.right, right.right),
        bottom: Math.min(left.bottom, right.bottom),
      };
      if (intersection.right <= intersection.left || intersection.bottom <= intersection.top) return null;
      return { ...intersection, width: intersection.right - intersection.left, height: intersection.bottom - intersection.top };
    };
    const hostRect = host.getBoundingClientRect();
    const hostScaleX = host.offsetWidth > 0 ? Math.abs(hostRect.width / host.offsetWidth) : 1;
    const hostScaleY = host.offsetHeight > 0 ? Math.abs(hostRect.height / host.offsetHeight) : 1;
    const scrollportClientRect = {
      left: hostRect.left + host.clientLeft * hostScaleX,
      top: hostRect.top + host.clientTop * hostScaleY,
      right: hostRect.left + (host.clientLeft + host.clientWidth) * hostScaleX,
      bottom: hostRect.top + (host.clientTop + host.clientHeight) * hostScaleY,
    };
    const visualViewportObject = window.visualViewport;
    const visualViewportRect = {
      left: visualViewportObject?.offsetLeft ?? 0,
      top: visualViewportObject?.offsetTop ?? 0,
      right: (visualViewportObject?.offsetLeft ?? 0) + (visualViewportObject?.width ?? window.innerWidth),
      bottom: (visualViewportObject?.offsetTop ?? 0) + (visualViewportObject?.height ?? window.innerHeight),
    };
    const markerRect = targetMarkerGeometry?.lastCharacterRect ?? null;
    const markerCenter = markerRect ? {
      x: (markerRect.left + markerRect.right) / 2,
      y: (markerRect.top + markerRect.bottom) / 2,
    } : null;
    const visibleIntersection = rectIntersection(
      rectIntersection(scrollportClientRect, rootRect),
      visualViewportRect,
    );
    const markerCenterInsideRect = Boolean(markerCenter && visibleIntersection)
      && markerCenter.x >= visibleIntersection.left && markerCenter.x <= visibleIntersection.right
      && markerCenter.y >= visibleIntersection.top && markerCenter.y <= visibleIntersection.bottom;
    const hitElements = markerCenterInsideRect
      ? document.elementsFromPoint(markerCenter.x, markerCenter.y).slice(0, 6)
      : [];
    const topHit = hitElements[0] ?? null;
    const markerCenterHitTargetRow = Boolean(target && topHit && target.contains(topHit));
    const pointInside = (rect, point) => Boolean(rect && point)
      && point.x >= rect.left && point.x <= rect.right
      && point.y >= rect.top && point.y <= rect.bottom;
    const markerCenterCoveredByJump = jumpToLatestVisible && pointInside(jumpRect, markerCenter);
    const composerVisible = Boolean(composerRect && composerRect.width > 0 && composerRect.height > 0)
      && composerStyle?.display !== "none" && composerStyle?.visibility !== "hidden"
      && Number.isFinite(composerOpacity) && composerOpacity > 0.01;
    const markerCenterCoveredByComposer = composerVisible && pointInside(composerRect, markerCenter);
    let visibleStyleAncestors = true;
    let visibleStyleAncestorCount = 0;
    let visibleStyleChainReachedList = false;
    for (let element = target; element instanceof HTMLElement && visibleStyleAncestorCount < 16; element = element.parentElement) {
      const style = getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity);
      visibleStyleAncestorCount += 1;
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
        || (Number.isFinite(opacity) && opacity <= 0.01) || style.contentVisibility === "hidden") {
        visibleStyleAncestors = false;
      }
      if (element === list) {
        visibleStyleChainReachedList = true;
        break;
      }
    }
    visibleStyleAncestors = visibleStyleAncestors && visibleStyleChainReachedList;
    const targetMarkerVisibilityChecks = {
      markerRangePresent: Boolean(targetMarkerGeometry?.lastCharacterRangeCount > 0),
      markerIntersectsMessageList: rectIntersects(markerRect, rootRect),
      markerIntersectsScrollportClientClip: rectIntersects(markerRect, scrollportClientRect),
      markerIntersectsVisualViewport: rectIntersects(markerRect, visualViewportRect),
      markerCenterInsideCombinedClip: markerCenterInsideRect,
      markerCenterHitTargetRow,
      visibleStyleAncestors,
      visibleStyleAncestorCount,
      visibleStyleChainReachedList,
      markerCenterCoveredByJump,
      markerCenterCoveredByComposer,
    };
    const targetMarkerVisibleWithinMessageList = Boolean(targetMarkerGeometry?.visible)
      && targetMarkerVisibilityChecks.markerRangePresent
      && targetMarkerVisibilityChecks.markerIntersectsMessageList
      && targetMarkerVisibilityChecks.markerIntersectsScrollportClientClip
      && targetMarkerVisibilityChecks.markerIntersectsVisualViewport
      && targetMarkerVisibilityChecks.markerCenterInsideCombinedClip
      && targetMarkerVisibilityChecks.markerCenterHitTargetRow
      && targetMarkerVisibilityChecks.visibleStyleAncestors
      && !targetMarkerVisibilityChecks.markerCenterCoveredByJump
      && !targetMarkerVisibilityChecks.markerCenterCoveredByComposer;
    let targetMarkerVisibilityDiagnostics = null;
    if (captureMarkerVisibilityDiagnostics) {
      const clipAncestors = [];
      let clipAncestorReachedList = false;
      for (let element = target; element instanceof HTMLElement && clipAncestors.length < 12; element = element.parentElement) {
        const style = getComputedStyle(element);
        clipAncestors.push({
          tagName: element.tagName,
          testId: element.getAttribute("data-testid")?.slice(0, 48) ?? null,
          role: element.getAttribute("role")?.slice(0, 32) ?? null,
          rect: rectSnapshot(element.getBoundingClientRect()),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          clip: style.clip?.slice(0, 120) ?? null,
          clipPath: style.clipPath?.slice(0, 120) ?? null,
          contain: style.contain?.slice(0, 80) ?? null,
          transform: style.transform?.slice(0, 120) ?? null,
          opacity: style.opacity,
          display: style.display,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
        });
        if (element === list) {
          clipAncestorReachedList = true;
          break;
        }
      }
      const describeHit = (element) => element instanceof Element ? {
        tagName: element.tagName,
        testId: element.getAttribute("data-testid")?.slice(0, 48) ?? null,
        role: element.getAttribute("role")?.slice(0, 32) ?? null,
        classTokens: typeof element.className === "string" ? element.className.split(/\s+/).filter(Boolean).slice(0, 4) : [],
        rect: rectSnapshot(element.getBoundingClientRect()),
      } : null;
      targetMarkerVisibilityDiagnostics = {
        sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
        expectedMarker: marker,
        targetRowTestId: target?.getAttribute("data-testid") ?? null,
        targetRowRect: rectSnapshot(rowRect),
        lastCharacterRect: rectSnapshot(markerRect),
        messageListRect: rectSnapshot(rootRect),
        scrollport: {
          tagName: host.tagName,
          testId: host.getAttribute("data-testid")?.slice(0, 48) ?? null,
          borderRect: rectSnapshot(hostRect),
          clientClipRect: rectSnapshot(scrollportClientRect),
          clientLeft: host.clientLeft,
          clientTop: host.clientTop,
          clientWidth: host.clientWidth,
          clientHeight: host.clientHeight,
          offsetWidth: host.offsetWidth,
          offsetHeight: host.offsetHeight,
          scaleX: Number(hostScaleX.toFixed(4)),
          scaleY: Number(hostScaleY.toFixed(4)),
          overflowX: getComputedStyle(host).overflowX,
          overflowY: getComputedStyle(host).overflowY,
          transform: getComputedStyle(host).transform?.slice(0, 120) ?? null,
        },
        visualViewport: {
          rect: rectSnapshot(visualViewportRect),
          scale: visualViewportObject?.scale ?? null,
          windowInnerWidth: window.innerWidth,
          windowInnerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
        combinedVisibleClip: rectSnapshot(visibleIntersection),
        composer: {
          visible: composerVisible,
          rect: rectSnapshot(composerRect),
          display: composerStyle?.display ?? null,
          visibility: composerStyle?.visibility ?? null,
          pointerEvents: composerStyle?.pointerEvents ?? null,
        },
        jump: {
          visible: jumpToLatestVisible,
          rect: rectSnapshot(jumpRect),
          display: jumpStyle?.display ?? null,
          visibility: jumpStyle?.visibility ?? null,
          pointerEvents: jumpStyle?.pointerEvents ?? null,
        },
        markerCenter,
        checks: targetMarkerVisibilityChecks,
        hitTestTopToBottom: hitElements.map(describeHit),
        hitTestTopIsTargetRow: markerCenterHitTargetRow,
        clipAncestors,
        clipAncestorTraversalTruncated: !clipAncestorReachedList && clipAncestors.length === 12,
      };
    }
    let virtualizedGeometry = null;
    if (captureVirtualizedGeometry) {
      const rectOf = (element) => {
        if (!(element instanceof Element)) return null;
        const rect = element.getBoundingClientRect();
        return {
          top: Number(rect.top.toFixed(2)),
          bottom: Number(rect.bottom.toFixed(2)),
          left: Number(rect.left.toFixed(2)),
          right: Number(rect.right.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        };
      };
      const rowSelector = '[data-testid="message-user"], [data-testid="message-assistant"]';
      const mountedHistoryRows = rows.slice(0, limits.maxMountedHistoryRowsPerSample)
        .map((row, mountedDomIndex) => {
          const historyIndex = /HISTORY-(\d{4})/.exec(row.textContent ?? "")?.[1];
          if (historyIndex === undefined) return null;
          return {
            mountedDomIndex,
            role: row.getAttribute("data-testid") === "message-user" ? "user" : "assistant",
            historyIndex: Number(historyIndex),
            rect: rectOf(row),
          };
        }).filter(Boolean);
      const contentContainer = host.firstElementChild instanceof HTMLElement ? host.firstElementChild : null;
      const innerContent = contentContainer ? {
        tagName: contentContainer.tagName,
        testId: contentContainer.getAttribute("data-testid")?.slice(0, limits.maxTestIdLength) ?? null,
        childCount: contentContainer.children.length,
        rect: rectOf(contentContainer),
        scrollHeight: contentContainer.scrollHeight,
        clientHeight: contentContainer.clientHeight,
      } : null;
      const emptyLayoutCandidates = [];
      let visitedNodeCount = 0;
      let nodesOmitted = 0;
      let candidatesOmitted = 0;
      let traversalTruncated = false;
      const queue = contentContainer ? [{ element: contentContainer, depth: 0, path: "content" }] : [];
      while (queue.length > 0 && visitedNodeCount < limits.maxWalkNodesPerSample) {
        const current = queue.shift();
        const element = current?.element;
        if (!(element instanceof HTMLElement) || element.matches(rowSelector)) continue;
        visitedNodeCount += 1;
        const rect = rectOf(element);
        let hasDirectText = false;
        let inspectedChildNodes = 0;
        for (let node = element.firstChild; node && inspectedChildNodes < limits.maxChildrenPerNode; node = node.nextSibling) {
          inspectedChildNodes += 1;
          if (node.nodeType === Node.TEXT_NODE && /\S/.test(node.nodeValue ?? "")) hasDirectText = true;
        }
        const childNodesTruncated = inspectedChildNodes === limits.maxChildrenPerNode
          && element.childNodes.length > inspectedChildNodes;
        const children = element.children;
        const childCount = children.length;
        if (childNodesTruncated) traversalTruncated = true;
        if (current.depth > 0 && !hasDirectText && rect && rect.height > 0) {
          if (emptyLayoutCandidates.length < limits.maxEmptyLayoutCandidatesPerSample) {
            emptyLayoutCandidates.push({
              path: current.path.slice(0, limits.maxDomPathLength),
              depth: current.depth,
              kind: childCount === 0 ? "empty-leaf" : "empty-container",
              tagName: element.tagName,
              testId: element.getAttribute("data-testid")?.slice(0, limits.maxTestIdLength) ?? null,
              dataIndex: element.getAttribute("data-index")?.slice(0, 32) ?? null,
              childCount,
              rect,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            });
          } else {
            candidatesOmitted += 1;
          }
        }
        if (children.length > limits.maxChildrenPerNode) {
          nodesOmitted += children.length - limits.maxChildrenPerNode;
          traversalTruncated = true;
        }
        if (current.depth >= limits.maxDepth) {
          nodesOmitted += Math.min(children.length, limits.maxChildrenPerNode);
          traversalTruncated ||= children.length > 0;
          continue;
        }
        for (let index = 0; index < Math.min(children.length, limits.maxChildrenPerNode); index += 1) {
          const child = children[index];
          if (child.matches(rowSelector)) continue;
          queue.push({
            element: child,
            depth: current.depth + 1,
            path: `${current.path}.${index}`.slice(0, limits.maxDomPathLength),
          });
        }
      }
      if (queue.length > 0) {
        nodesOmitted += queue.length;
        traversalTruncated = true;
      }
      const traceMap = window.__phoneRenderTranscriptVirtualizationTraces;
      const traceEntry = scrollTraceKey && traceMap instanceof Map ? traceMap.get(scrollTraceKey) : null;
      const scrollEventsSincePreviousSample = traceEntry
        ? traceEntry.state.events.splice(0, limits.maxScrollEventsPerSample)
        : [];
      virtualizedGeometry = {
        sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
        innerContent,
        mountedHistoryRows,
        mountedHistoryRowsOmitted: Math.max(0, rows.length - limits.maxMountedHistoryRowsPerSample),
        emptyLayoutCandidates,
        emptyLayoutCandidatesOmitted: candidatesOmitted,
        visitedNodeCount,
        nodesOmitted,
        traversalTruncated,
        scrollTraceStatus: traceEntry ? "ATTACHED" : "UNAVAILABLE",
        scrollEventsSincePreviousSample,
        scrollEventsDroppedTotal: traceEntry?.state.droppedCount ?? null,
      };
    }
    return {
      listFound: true,
      expectedTailMarker: marker ?? null,
      scrollHostTag: host.tagName,
      scrollHostTestId: host.getAttribute("data-testid"),
      scrollportTransform,
      scrollTop: Number(host.scrollTop.toFixed(2)),
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      bottomGapPx: Math.max(0, Number((host.scrollHeight - host.clientHeight - host.scrollTop).toFixed(2))),
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      messageListRect: { top: rootRect.top, bottom: rootRect.bottom, height: rootRect.height },
      renderedMessageRowCount: rows.length,
      targetRowFound: Boolean(target),
      targetRowTestId: target?.getAttribute("data-testid") ?? null,
      targetRowTextLength: target?.textContent?.length ?? null,
      targetRowRect: rowRect ? { top: rowRect.top, bottom: rowRect.bottom, height: rowRect.height } : null,
      targetVisibleWithinMessageList,
      targetMarkerGeometryIncluded: includeMarkerGeometry,
      targetMarkerOccurrenceCount: targetMarkerGeometry?.occurrenceCount ?? null,
      targetMarkerSelectedOccurrenceIndex: targetMarkerGeometry?.selectedOccurrenceIndex ?? null,
      targetMarkerSelectedLastOccurrenceOffset: targetMarkerGeometry?.selectedLastOccurrenceOffset ?? null,
      targetMarkerTextNodeCount: targetMarkerGeometry?.textNodeCount ?? null,
      targetMarkerFirstCharacterTextNodeIndex: targetMarkerGeometry?.firstCharacterTextNodeIndex ?? null,
      targetMarkerFirstCharacterTextNodeOffset: targetMarkerGeometry?.firstCharacterTextNodeOffset ?? null,
      targetMarkerLastCharacterTextNodeIndex: targetMarkerGeometry?.lastCharacterTextNodeIndex ?? null,
      targetMarkerLastCharacterTextNodeOffset: targetMarkerGeometry?.lastCharacterTextNodeOffset ?? null,
      targetMarkerRangeCount: targetMarkerGeometry?.rangeCount ?? null,
      targetMarkerLastCharacterRangeCount: targetMarkerGeometry?.lastCharacterRangeCount ?? null,
      targetMarkerLastCharacterRect: targetMarkerGeometry?.lastCharacterRect ?? null,
      targetMarkerVisibilityChecks: includeMarkerGeometry ? targetMarkerVisibilityChecks : null,
      targetMarkerVisibilityDiagnostics,
      targetMarkerVisibleWithinMessageList: includeMarkerGeometry ? targetMarkerVisibleWithinMessageList : null,
      jumpToLatestVisible,
      ...(virtualizedGeometry ? { virtualizedGeometry } : {}),
    };
  }, {
    marker: expectedTailMarker,
    includeMarkerGeometry,
    captureVirtualizedGeometry: options.captureVirtualizedGeometry === true,
    captureMarkerVisibilityDiagnostics: options.captureMarkerVisibilityDiagnostics === true,
    captureScrollportTransform: options.captureScrollportTransform === true,
    scrollTraceKey: options.scrollTraceKey ?? null,
    limits: transcriptVirtualizationTraceLimits,
  });
}

async function emitSyntheticTaskSnapshot(page, state, marker, fileChanges, options = {}) {
  const safeMarker = marker.replace(/[^A-Za-z0-9_-]/g, "_");
  const turnId = `ux-profile-turn-${safeMarker}`;
  const attemptId = `ux-profile-attempt-${safeMarker}`;
  const itemId = `ux-profile-item-${safeMarker}`;
  const common = { serverId, threadId, turnId, attemptId };
  const frames = [
    { jsonrpc: "2.0", method: "turn/started", params: { ...common, sequence: state.nextSequence++, turn: { id: turnId, attemptId, threadId, status: "running" } } },
    { jsonrpc: "2.0", method: "item/started", params: { ...common, sequence: state.nextSequence++, item: { id: itemId, type: "agentMessage" } } },
    { jsonrpc: "2.0", method: "item/delta", params: { ...common, sequence: state.nextSequence++, itemId, delta: { text: options.deltaText ?? `\n\n${marker} synchronous task fixture update.` } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { ...common, sequence: state.nextSequence++, turn: { id: turnId, attemptId, threadId, status: "completed" }, fileChanges } },
  ];
  assert.ok(state.activeSocketRoute, "synthetic runtime notifications require the active fixture thread/read connection");
  const result = await page.evaluate((payload) => window.__phoneRenderDeliverFrames(payload.frames, payload.server, payload.channel, payload.workspace, payload.threadId, payload.threadReadId, payload.captureDispatchDetails), {
    frames,
    server: serverId,
    channel: "runtime",
    workspace: state.workspacePath,
    threadId,
    threadReadId: state.activeThreadReadRequestId,
    captureDispatchDetails: state.seedDispatchCaptureActive === true,
  });
  const seedDispatchEvidence = state.seedDispatchCaptureActive === true ? summarizeSeedDispatchEvidence(state, marker, result, frames) : null;
  if (seedDispatchEvidence) state.lastSeedDispatchEvidence = seedDispatchEvidence;
  assert.equal(result.delivered, frames.length, `exactly one open Mobile runtime socket must have sent thread/read for the fixture thread/workspace before synthetic notifications; routeEvidence=${JSON.stringify(state.activeSocketRoute)}, delivery=${JSON.stringify(result)}`);
  const observedFrames = result.frameResults;
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  const observedMethods = observedFrames.map((frame) => frame.method);
  const sequences = observedFrames.map((frame) => frame.sequence);
  const dispatchOrderValid = observedFrames.length === frames.length
    && observedMethods.every((method, index) => method === expectedMethods[index])
    && observedFrames.every((frame) => frame.serverId === serverId && frame.threadId === threadId && frame.turnId === turnId)
    && observedFrames.every((frame) => frame.browserMockId === result.browserMockId)
    && sequences.every((sequence, index) => Number.isSafeInteger(sequence) && (index === 0 || sequence > sequences[index - 1]));
  assert.equal(dispatchOrderValid, true, `synthetic notification dispatch must preserve its ordered thread/turn sequence: ${JSON.stringify({ observedMethods, sequences })}`);
  state.notificationBatches.push({
    marker,
    turnId,
    attemptId,
    itemId,
    methods: observedMethods,
    sequences,
    serverId,
    threadId,
    browserMockId: result.browserMockId,
    threadReadRequestId: state.activeThreadReadRequestId,
    routeOrdinal: state.activeSocketRoute.routeOrdinal,
    dispatchOrderValid,
  });
  state.syntheticNotificationFramesSent = (state.syntheticNotificationFramesSent ?? 0) + frames.length;
  state.syntheticNotificationCopiesSent = (state.syntheticNotificationCopiesSent ?? 0) + frames.length * result.socketCopies;
  const observedTaskMockIds = [...new Set(observedFrames.map((frame) => frame.browserMockId))];
  state.notificationBatches.at(-1).dispatchTaskDurationsMs = result.dispatchTaskDurationsMs;
  state.notificationBatches.at(-1).maximumDispatchTaskMs = Math.max(...result.dispatchTaskDurationsMs);
  return {
    ...result,
    observedFrames,
    turnId,
    attemptId,
    itemId,
    dispatchOrderValid,
    observedTaskMockIds,
    maximumDispatchTaskMs: Math.max(...result.dispatchTaskDurationsMs),
    ...(seedDispatchEvidence ? { seedDispatchEvidence } : {}),
  };
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

function summarizeObservations(observations) {
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
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      maxMs: values.length ? values.at(-1) : null,
      automationElapsedP50Ms: percentile(automationValues, 0.5),
      automationElapsedP95Ms: percentile(automationValues, 0.95),
      automationElapsedMaxMs: automationValues.length ? automationValues.at(-1) : null,
      fixtureHarnessElapsedP50Ms: percentile(harnessValues, 0.5),
      fixtureHarnessElapsedP95Ms: percentile(harnessValues, 0.95),
      fixtureHarnessElapsedMaxMs: harnessValues.length ? harnessValues.at(-1) : null,
      synchronousEventTaskP50Ms: percentile(taskValues, 0.5),
      synchronousEventTaskP95Ms: percentile(taskValues, 0.95),
      synchronousEventTaskMaxMs: taskValues.length ? taskValues.at(-1) : null,
      websocketDispatchHandlerSyncTaskCount: websocketDispatchTaskValues.length,
      websocketDispatchHandlerSyncTaskP50Ms: percentile(websocketDispatchTaskValues, 0.5),
      websocketDispatchHandlerSyncTaskP95Ms: percentile(websocketDispatchTaskValues, 0.95),
      websocketDispatchHandlerSyncTaskMaxMs: websocketDispatchTaskValues.length ? websocketDispatchTaskValues.at(-1) : null,
      longTaskCount: entries.reduce((total, entry) => total + (entry.longTasks?.length ?? 0), 0),
      longTaskMaxMs: Math.max(0, ...entries.flatMap((entry) => (entry.longTasks ?? []).map((task) => task.durationMs))),
    };
  }).sort((left, right) => left.source.localeCompare(right.source) || left.requestedMessages - right.requestedMessages || left.scenario.localeCompare(right.scenario) || String(left.panelState).localeCompare(String(right.panelState)));
}

function summarizeLongTasks(observations) {
  const tasks = observations.flatMap((entry) => entry.longTasks ?? []);
  const durations = tasks.map((task) => task.durationMs).sort((left, right) => left - right);
  return {
    source: "PerformanceObserver longtask API; entries are browser tasks over 50ms",
    count: tasks.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
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
