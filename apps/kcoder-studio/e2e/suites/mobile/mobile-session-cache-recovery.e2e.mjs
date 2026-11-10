import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { materializeArchivedMobileWebDeployment } from "../../harness/mobile-archived-deployment.mjs";
import {
  recordCacheTimingRpcRequest,
  recordCacheTimingRpcResponse,
} from "../../harness/mobile-cache-timing-telemetry.mjs";
import {
  projectResumeAssistantPageEvidence,
  resolveLatestCompletedAssistantIdentity,
} from "../../harness/mobile-cache-timing-latest-assistant.mjs";
import {
  assertCachedAuthorityIdentitySnapshot,
  assertCachedSessionComposerReadOnly,
  createAndPersistUnsentMultilineDraft,
  verifyCachedReadOnlyMultilineDraft,
} from "../../harness/mobile-session-cache-readonly.mjs";
import {
  assertMobileTimingLaneServiceWorker,
  createDirectMobileTimingLaneDescriptor,
  createMobileTimingLaneRouteAudit,
  installMobileTimingLaneHttpGuard,
  normalizeRelayMobileTimingLaneV1,
  prepareRelayTimingLatestAnchorV1,
  runTrustedUserAnchorWheelSequenceV1,
  runMobileCacheTimingSamplesV1,
} from "../../harness/mobile-cache-timing-runner.mjs";
import {
  buildColdProcessAnchorPrompt,
  prepareUserReadingAnchorViewport,
  resolveUniqueTurnUserAnchorIdentity,
  turnStartIncludesPromptMarker,
} from "../../harness/mobile-session-cache-user-anchor.mjs";
import {
  assessPersistedAnchorReadiness,
  assertAnchorScrollReachability,
  observeAnchorScrollResponse,
} from "../../harness/mobile-session-cache-cold-diagnostics.mjs";
import {
  armTrustedTranscriptWheelObservationWithViewport as armTrustedWheelObservationWithViewport,
  readTrustedTranscriptWheelObservation as readTrustedWheelObservation,
  readTrustedTranscriptWheelTargetAtPoint as readTrustedWheelTargetAtPoint,
  readTranscriptViewport,
} from "../../harness/mobile-session-cache-transcript-scroll-host.mjs";
import {
  projectClientMessageIdEvidence,
  projectMessageIdentityTuples,
  projectProtocolRpcRequests,
} from "../../harness/mobile-session-cache-identity-evidence.mjs";
import {
  archiveMobileWebExport,
  inspectMobileWebExportSourceIdentity,
  restoreMobileWebExportArchive,
  verifyMobileWebExportUnchanged,
} from "../../harness/mobile-web-export-archive.mjs";
import { hashExecutableFile, findOwnedExecutableProcesses } from "../../harness/owned-executable-provenance.mjs";
import { observeAndForwardMobileRpcRouteCloses } from "../../harness/mobile-page-rpc-lifecycle.mjs";
import {
  observeMobilePageRpcSockets,
  openMobileTimingCacheObserverPage,
  projectRelayBootstrapFailureEvidence,
  releaseMobileTimingPageAndChromium,
  releaseMobileTimingChromium,
} from "../../harness/mobile-cache-timing-page-ownership.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { parseMobileSessionCacheRecoveryMode } from "./mobile-session-cache-recovery-mode.mjs";
import { runColdProcessSmoke } from "./mobile-session-cache-cold-process.mjs";
import { runConfirmedAbsenceSmoke } from "./mobile-session-cache-confirmed-absence.mjs";
import { runCacheStorageCorruptionSmoke } from "./mobile-session-cache-storage-corruption.mjs";
import { runCacheTransactionAbortSmoke } from "./mobile-session-cache-transaction-abort.mjs";
import { runCacheQuotaSmoke } from "./mobile-session-cache-quota.mjs";
import { runCacheMultitabWritersSmoke } from "./mobile-session-cache-multitab-writers.mjs";
import { runAgentListCausalSmoke } from "./mobile-session-cache-agent-list-causal.mjs";
import { mobileBrowserRpcCredentials } from "./mobile-session-cache-rpc-credentials.mjs";
import { runOwnerHandoffRollbackSmoke } from "./mobile-session-cache-owner-handoff-rollback.mjs";
import { openAdvancedNewTaskForm } from "../../harness/mobile-session-cache-recovery-setup.mjs";
import { runCachedSessionUiVisualMatrix } from "../../harness/mobile-session-cache-visual-matrix.mjs";

const rustBinary = resolve(repoRoot, process.env.KCODER_E2E_KCODER_BIN || "target/debug/kcoder");
const promptMarker = `SESSION_CACHE_PROMPT_${randomBytes(6).toString("hex").toUpperCase()}`;
const replacementMarker = `SESSION_CACHE_AUTHORITY_${randomBytes(6).toString("hex").toUpperCase()}`;
const tailMarker = "tui-lab-final-sentinel";
const unpairedRpcTelemetrySequence = Number.MAX_SAFE_INTEGER;
const exportProgressPhases = new Set([
  "resolve-inputs", "dependency-symlink-check", "dependency-hash-before", "source-hash-before",
  "prepare-owned-state", "copy-source", "snapshot-hash-after-copy", "copy-dependencies",
  "owned-dependency-hash", "prepare-terminal-build", "terminal-build", "terminal-build-verification",
  "snapshot-hash-before-export", "expo-export", "source-hash-after", "snapshot-hash-after-export",
  "dependency-hash-after", "bundle-hash",
]);
const recoveryMode = parseMobileSessionCacheRecoveryMode(process.argv.slice(2));
const { cacheTimingSmoke, cacheTimingMatrix, cacheTimingDirectRelay, setupSmoke, cacheUiVisualSmoke, productionMobileMount,
  confirmedAbsenceSmoke, coldProcessSmoke, trustedAnchorSetupSmoke, cacheCorruptionKind, agentListCausalSmoke, transactionAbortSmoke, quotaSmoke, multitabWritersSmoke,
  ownerHandoffRollbackSmoke } = recoveryMode;
const initialPromptText = coldProcessSmoke || trustedAnchorSetupSmoke || transactionAbortSmoke || quotaSmoke || multitabWritersSmoke ? buildColdProcessAnchorPrompt(promptMarker) : promptMarker;
const setupReadinessTestIds = [
  "welcome-direct-connection", "gateway-token", "gateway-connect", "stored-profile-hydration-error",
  "retry-stored-profiles", "server-status-error", "new-workspace-projects-loading", "workspace-path",
  "new-workspace", "server-option-local", "model-selector", "new-workspace-prompt", "create-workspace",
  "new-workspace-error", "retry-new-workspace-catalogs",
  "new-workspace-preference-read-error", "retry-new-workspace-preference-read",
  "new-workspace-preference-error", "retry-new-workspace-preference", "workspace-task-handoff-error",
  "retry-task-handoff-lookup",
];
const setupErrorTestIds = new Set([
  "stored-profile-hydration-error", "server-status-error", "new-workspace-error",
  "new-workspace-preference-read-error", "new-workspace-preference-error", "workspace-task-handoff-error",
]);
const cacheTimingDelays = cacheTimingSmoke ? [300] : cacheTimingMatrix ? interleavedCacheTimingDelays() : null;
const productionMobileMountInputs = productionMobileMount
  ? await validateProductionMobileMountInputs(process.env)
  : null;
const modelPolicy = recoveryMode.modelPolicy;
assert.ok(modelPolicy.startsWith("model-independent"), "recovery modes must remain model-independent");

await runE2E(import.meta.url, {
  testId: recoveryMode.testId,
  tier: "full-integration",
  modelPolicy: modelPolicy,
  retainSuccessLogs: true,
}, async context => {
  const reportStartupPhase = phase => {
    if (productionMobileMount) process.stdout.write(`${JSON.stringify({ phase })}\n`);
  };
  const selectedMobileRoot = resolve(process.env.KCODER_E2E_MOBILE_SOURCE_ROOT || resolve(repoRoot, "apps/kcoder-studio/mobile"));
  const selectedSourceRoots = [
    { name: "mobile", path: selectedMobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(selectedMobileRoot, "../shared"), destination: "apps/kcoder-studio/shared" },
  ];
  const sourceManifestPath = process.env.KCODER_E2E_MOBILE_SOURCE_MANIFEST;
  const sourceManifestSha256 = process.env.KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256;
  assert.equal(Boolean(sourceManifestPath), Boolean(sourceManifestSha256),
    "source snapshot reuse requires both KCODER_E2E_MOBILE_SOURCE_MANIFEST and its SHA-256 pin");
  const sourceSnapshotOptions = sourceManifestPath
    ? { snapshotManifestPath: resolve(sourceManifestPath), expectedSnapshotManifestSha256: sourceManifestSha256 }
    : {};
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({
    sourceRoots: selectedSourceRoots,
    ...sourceSnapshotOptions,
  });
  const assistantRowConstruction = await inspectAssistantRowConstruction(selectedMobileRoot);
  const archivePath = process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE;
  const archiveSha256 = process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256;
  assert.equal(Boolean(archivePath), Boolean(archiveSha256),
    "archive reuse requires both KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE and its SHA-256 pin");
  if (productionMobileMount) {
    assert.ok(archivePath, "--production-mobile-mount requires a pre-existing deployMount:true archive; export is disabled in this mode");
  }
  let mobileWeb;
  let archiveEvidence;
  if (archivePath) {
    mobileWeb = await restoreMobileWebExportArchive(context, {
      archivePath,
      expectedArchiveSha256: archiveSha256,
      sourceIdentity,
      outputName: "mobile-web-export-archive-restored",
    });
    archiveEvidence = {
      mode: "reuse-verified-data-only-archive",
      path: mobileWeb.archivePath,
      sha256: mobileWeb.archiveSha256,
      ...sourceIdentityEvidence(sourceIdentity),
      originalManifestSha256: mobileWeb.originalManifestSha256,
      bundleSha256: mobileWeb.bundleSha256,
      sourceRoots: mobileWeb.sourceRoots,
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      dependencyProvenanceIsHistorical: true,
      originalRunRoot: mobileWeb.origin.originalRunRoot,
      dependencySourceTreeSha256: mobileWeb.origin.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: mobileWeb.origin.dependencyOwnedTreeSha256,
    };
  } else {
    mobileWeb = await exportMobileWeb(context, {
      label: "session-cache-mobile-web-export",
      outputName: "mobile-web-export",
      mobileRoot: selectedMobileRoot,
      dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
      timeoutMs: 10 * 60_000,
      onProgress: progress => {
        if (!exportProgressPhases.has(progress?.phase)) return;
        const elapsedMs = Number.isFinite(progress.elapsedMs) ? Math.max(0, Math.round(progress.elapsedMs)) : null;
        process.stdout.write(`${JSON.stringify({ phase: progress.phase, elapsedMs })}\n`);
      },
    });
    assert.equal(mobileWeb.sourceTreeSha256, sourceIdentity.sourceTreeSha256,
      "completed Mobile Web export differs from the pre-export caller-pinned source identity");
    const createdArchive = await archiveMobileWebExport(context, { exportResult: mobileWeb, sourceIdentity });
    archiveEvidence = {
      mode: "newly-exported-and-sealed-data-only-archive",
      path: createdArchive.path,
      sha256: createdArchive.sha256,
      ...sourceIdentityEvidence(sourceIdentity),
      originalManifestSha256: createdArchive.originalManifestSha256,
      bundleSha256: createdArchive.bundleSha256,
      sourceRoots: createdArchive.sourceIdentity.sourceRoots,
      sourceTreeSha256: createdArchive.sourceIdentity.sourceTreeSha256,
      dependencyProvenanceIsHistorical: true,
      originalRunRoot: createdArchive.originalRunRoot,
      dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
    };
    mobileWeb.archivePath = createdArchive.path;
    mobileWeb.archiveSha256 = createdArchive.sha256;
  }
  await context.writeArtifactJson("mobile-web-export-archive-provenance.json", archiveEvidence);
  context.addCleanup("verify Mobile Web bundle and archive remain unchanged", async () => {
    try {
      const postflight = await verifyMobileWebExportUnchanged(mobileWeb);
      await context.writeArtifactJsonInternal("mobile-web-export-archive-postflight.json", postflight);
    } catch (error) {
      await context.writeArtifactJsonInternal("mobile-web-export-archive-postflight.json", {
        unchanged: false,
        error: context.redactText(error?.message || String(error)),
      }).catch(() => {});
      throw error;
    }
  });
  let mobileDeployment = null;
  if (productionMobileMount) {
    mobileDeployment = await materializeArchivedMobileWebDeployment(context, {
      mobileWeb,
      sourcePins: {
        archivePath: productionMobileMountInputs.archivePath,
        archiveSha256: productionMobileMountInputs.archiveSha256,
        originalManifestSha256: productionMobileMountInputs.originalManifestSha256,
        sourceRoot: productionMobileMountInputs.sourceRoot,
        sourceManifestPath: productionMobileMountInputs.sourceManifestPath,
        sourceManifestSha256: productionMobileMountInputs.sourceManifestSha256,
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        sourceSnapshotProof: sourceIdentity.snapshotProof,
      },
    });
    await context.writeArtifactJson("mobile-web-derived-deployment-provenance.json", mobileDeployment);
  }
  const configuredRustBefore = await hashExecutableFile(rustBinary);
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const timingRelayAdapter = cacheTimingDirectRelay
    ? await import("../../harness/mobile-local-relay-timing-adapter.mjs")
      .then(({ startMobileLocalRelayTimingAdapter }) => startMobileLocalRelayTimingAdapter(context))
    : null;
  reportStartupPhase("start-gateway");
  const gateway = await startGateway(context, {
    auth: true,
    label: "session-cache-gateway",
    workspace,
    kcoderBin: rustBinary,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      ...(timingRelayAdapter ? timingRelayAdapter.gatewayEnvironment : {}),
      ...(productionMobileMount
        ? { KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDeployment.path }
        : { KCODER_STUDIO_WEB_ROOT: mobileWeb.path }),
    },
  });
  const timingRelayRegistration = timingRelayAdapter
    ? await timingRelayAdapter.connectGateway(gateway)
    : null;
  const timingRelayLane = timingRelayRegistration
    ? await timingRelayRegistration.readMobileEntry()
    : null;
  const mobileEntryUrl = productionMobileMount ? new URL("/mobile/", gateway.baseUrl).href : gateway.baseUrl;
  const gatewayBaseUrl = new URL(gateway.baseUrl);
  const gatewayRpcPath = `${gatewayBaseUrl.pathname.replace(/\/+$/, "")}/rpc`;
  reportStartupPhase("start-chromium");
  const chromiumProfileName = "mobile-cache";
  let chromiumLabel = "session-cache-chromium";
  let chromiumRestartSequence = 0;
  let chromium = await startChromium(context, {
    label: chromiumLabel,
    profileName: chromiumProfileName,
    portLabel: "session-cache-chromium-cdp",
    startTimeoutMs: 60_000,
  });
  const releaseTimingChromium = async (reason, { restart = true, ...pageRelease } = {}) => {
    const nextLabel = restart
      ? `session-cache-browser-${String(++chromiumRestartSequence).padStart(2, "0")}`
      : undefined;
    const released = await releaseMobileTimingPageAndChromium({
      ...pageRelease, waitFor, restart,
      releaseChromium: allowRestart => releaseMobileTimingChromium({
        context,
        chromium,
        currentLabel: chromiumLabel,
        nextLabel,
        profileName: chromiumProfileName,
        startChromium,
        restart: allowRestart,
        reason,
        startTimeoutMs: 60_000,
      }),
    });
    if (restart) {
      chromium = released.chromium;
      chromiumLabel = nextLabel;
    }
    return released.evidence;
  };
  reportStartupPhase("create-page");
  const persistentProfilePage = coldProcessSmoke || trustedAnchorSetupSmoke || cacheTimingDelays || cacheCorruptionKind || agentListCausalSmoke || transactionAbortSmoke || quotaSmoke || multitabWritersSmoke || ownerHandoffRollbackSmoke;
  const page = persistentProfilePage
    ? await chromium.newPersistentPage()
    : await chromium.newPage({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
    });
  if (persistentProfilePage) await page.setViewportSize({ width: 390, height: 844 });
  const protocol = createProtocolState();
  const clientMessageIdHashKey = randomBytes(32);
  const setupDiagnostics = {
    startedAtMs: performance.now(),
    phase: "browser-open",
    locatorChecks: [],
  };
  const serverRequests = [];
  const serverStatusRequests = [];
  const serverInventoryResponses = [];
  const mobileRpcSocketCredentialsByRecord = new WeakMap();
  let capturedMobileSessionBootstrap = null;
  const serverStatusByRequest = new WeakMap();
  let serverStatusRequestCount = 0;
  let serverStatusResponseCount = 0;
  let activeServerHold = null;
  let failNextServerRequest = false;
  let controlledApiFailure = null;
  let seededCacheReadiness = null;
  let savedAnchorReadiness = null;
  let firstRestoreCacheReadiness = null;
  let shortenedCacheReadiness = null;
  let recoveredCacheReadiness = null;
  let anchorAuthorityRead = null;
  let anchorDisplayIdentity = null;
  let timingLatestAssistantIdentity = null;
  const viewportEvidence = {};
  const browserErrors = [];
  page.on("close", () => { protocol.pageClosedAtMs = performance.now(); });
  observeMobilePageRpcSockets(page, protocol, context, gatewayBaseUrl, gatewayRpcPath,
    mobileRpcSocketCredentialsByRecord);
  page.on("pageerror", error => browserErrors.push(context.redactText(error.message)));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const locationUrl = message.location()?.url ?? "";
    if (controlledApiFailure?.request && controlledApiFailure.consoleErrorCount === 0 &&
      locationUrl === controlledApiFailure.url) {
      controlledApiFailure.consoleErrorCount += 1;
      return;
    }
    browserErrors.push(context.redactText(message.text()));
  });
  page.on("requestfailed", request => {
    const failureCode = safeNetworkFailureCode(request.failure()?.errorText);
    const serverRequest = serverRequests.find(item => item.request === request);
    if (serverRequest) {
      serverRequest.failureCode = failureCode;
      serverRequest.durationMs = Math.max(0, performance.now() - serverRequest.startedAtMs);
    }
    const statusRequest = serverStatusByRequest.get(request);
    if (statusRequest) {
      statusRequest.failureCode = failureCode;
      statusRequest.durationMs = Math.max(0, performance.now() - statusRequest.startedAtMs);
    }
    const expected = controlledApiFailure;
    if (expected?.request === request && request.method() === "GET" && request.url() === expected.url &&
      expected.requestFailedCount === 0) {
      expected.requestFailedCount += 1;
      expected.requestFailureText = failureCode;
    }
  });
  page.on("request", request => {
    if (safePath(request.url()) !== "/api/servers/status") return;
    serverStatusRequestCount += 1;
    const record = {
      method: request.method(),
      path: "/api/servers/status",
      startedAtMs: performance.now(),
      responseStatus: null,
      durationMs: null,
      failureCode: null,
    };
    serverStatusByRequest.set(request, record);
    serverStatusRequests.push(record);
    if (serverStatusRequests.length > 32) serverStatusRequests.shift();
  });
  page.on("response", response => {
    const request = response.request();
    const record = serverRequests.find(item => item.request === request);
    if (record) {
      record.responseStatus = response.status();
      record.durationMs = Math.max(0, performance.now() - record.startedAtMs);
    }
    const statusRecord = serverStatusByRequest.get(request);
    if (statusRecord) {
      serverStatusResponseCount += 1;
      statusRecord.responseStatus = response.status();
      statusRecord.durationMs ??= Math.max(0, performance.now() - statusRecord.startedAtMs);
    }
    const requestUrl = new URL(request.url());
    const ownedGatewayOrigin = requestUrl.origin === gatewayBaseUrl.origin;
    const isServerInventoryResponse = productionMobileMount && ownedGatewayOrigin &&
      request.method() === "GET" && requestUrl.pathname === "/api/servers";
    let mainFrameRequest = false;
    if (productionMobileMount && ownedGatewayOrigin && request.method() === "POST" &&
      requestUrl.pathname === "/api/mobile/session") {
      try { mainFrameRequest = request.frame() === page.mainFrame(); } catch {}
    }
    const isSessionBootstrapResponse = productionMobileMount && ownedGatewayOrigin && mainFrameRequest &&
      request.method() === "POST" && requestUrl.pathname === "/api/mobile/session";
    if (isServerInventoryResponse || isSessionBootstrapResponse) {
      const observed = {
        source: isServerInventoryResponse ? "GET /api/servers" : "POST /api/mobile/session initialServers",
        responseStatus: response.status(),
        atMs: performance.now(),
        ownedGatewayOrigin,
        mainFrameRequest: isSessionBootstrapResponse ? mainFrameRequest : null,
        descriptors: null,
        bodyReadComplete: false,
      };
      serverInventoryResponses.push(observed);
      if (serverInventoryResponses.length > 16) serverInventoryResponses.shift();
      observed.bodyRead = response.json().then(payload => {
        const descriptors = isServerInventoryResponse ? payload?.servers : payload?.initialServers?.servers;
        observed.descriptors = Array.isArray(descriptors)
          ? descriptors.slice(0, 32).map(safePublicServerScopeDescriptor).filter(Boolean)
          : null;
        if (isSessionBootstrapResponse && response.status() === 200 &&
          payload?.capabilities?.mobileInitialServersV1 === true && !capturedMobileSessionBootstrap) {
          const accessToken = payload?.accessToken;
          const rpcToken = payload?.rpcToken;
          if (typeof accessToken === "string" && accessToken.length > 0 &&
            typeof rpcToken === "string" && rpcToken.length > 0) {
            context.registerSecret(accessToken);
            context.registerSecret(rpcToken);
            capturedMobileSessionBootstrap = { response: observed, accessToken, rpcToken };
          }
        }
        observed.bodyReadComplete = true;
      }).catch(() => {
        observed.bodyReadComplete = true;
        observed.descriptors = null;
      });
    }
  });
  await installResumeBridge(page, protocol, promptMarker, replacementMarker, context, clientMessageIdHashKey);

  await page.route(url => new URL(url).pathname === "/api/servers", async route => {
    const request = route.request();
    const hold = activeServerHold;
    const failed = failNextServerRequest;
    if (failed) failNextServerRequest = false;
    const record = {
      request,
      method: request.method(),
      path: "/api/servers",
      held: Boolean(hold),
      failed,
      at: performance.now(),
      startedAtMs: performance.now(),
      responseStatus: null,
      durationMs: null,
      failureCode: null,
    };
    serverRequests.push(record);
    if (failed) {
      assert.ok(controlledApiFailure && controlledApiFailure.request === null,
        "only the one armed API-failure request may be aborted");
      controlledApiFailure.request = request;
      controlledApiFailure.url = request.url();
      await route.abort("failed").catch(() => {});
      return;
    }
    if (hold) {
      hold.pending += 1;
      await hold.release.promise;
    }
    await route.continue().catch(() => {});
  });

  function armServerHold() {
    let release;
    const releasePromise = new Promise(resolveRelease => { release = resolveRelease; });
    activeServerHold = {
      pending: 0,
      release: { promise: releasePromise, resolve: release },
    };
    return activeServerHold;
  }

  function armServerFailure() {
    assert.equal(failNextServerRequest, false, "only one controlled /api/servers failure may be armed at once");
    assert.equal(controlledApiFailure, null, "only one controlled API failure may be exercised in this Browser context");
    controlledApiFailure = {
      armedAt: performance.now(),
      request: null,
      url: null,
      requestFailedCount: 0,
      requestFailureText: null,
      consoleErrorCount: 0,
    };
    failNextServerRequest = true;
  }

  function releaseServerHold() {
    const hold = activeServerHold;
    activeServerHold = null;
    hold?.release.resolve();
  }

  try {
    setupDiagnostics.phase = "connect-mobile";
    reportStartupPhase("enter-mobile");
    await connectMobile(page, gateway, setupDiagnostics, { productionMobileMount, mobileEntryUrl });
    setupDiagnostics.phase = "create-task";
    await createTask(page, initialPromptText, promptMarker, setupDiagnostics);
    const threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1));
    assert.match(threadId, /^[A-Za-z0-9._:-]+$/, "created task route must identify one real thread");
    protocol.targetThreadId = threadId;
    const setupScopeExpectation = productionMobileMount
      ? await captureProductionMobileScopeExpectation({
        page,
        gateway,
        serverInventoryResponses,
        mobileMountPath: "/mobile",
      })
      : null;
    setupDiagnostics.phase = "full-turn-completion";
    await waitFor(() => protocol.turnCompletions.some(event => event.threadId === threadId && event.status === "completed"),
      60_000, "real app-server turn/completed for the created task");
    assert.equal(protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length,
      1, "the UI task creation must start exactly one real turn");
    const taskStartRequest = protocol.requests.find(request => request.method === "turn/start" && request.threadId === threadId);
    assert.ok(Number.isSafeInteger(taskStartRequest?.socketOrdinal), "the created task must belong to one observed RPC socket");
    protocol.activeTaskSocketOrdinal = taskStartRequest.socketOrdinal;

    const taskPath = safePath(page.url());
    assert.equal(await page.getByTestId("message-list").count(), 1,
      "the active task must expose one message-list viewport for geometry and trusted scrolling");
    setupDiagnostics.phase = "cache-persistence-readback";
    seededCacheReadiness = await waitForReadOnlyTranscriptCache(page, {
      threadId,
      gatewayOrigin: new URL(gateway.baseUrl).origin,
      marker: promptMarker,
      ...(setupScopeExpectation ? { expectedScope: setupScopeExpectation } : {}),
    }, 30_000);
    assert.ok(seededCacheReadiness.ready, "the cached transcript and last-route marker for this thread and Gateway origin must be committed before the first root reload");
    setupDiagnostics.phase = "cache-persistence-verified";
    if (ownerHandoffRollbackSmoke) {
      assert.ok(setupScopeExpectation);
      const rpcCredentials = mobileBrowserRpcCredentials({ gateway, scopeExpectation: setupScopeExpectation,
        serverInventoryResponses, mobileBootstrap: capturedMobileSessionBootstrap, protocol,
        pageSocketCredentials: mobileRpcSocketCredentialsByRecord });
      capturedMobileSessionBootstrap = null;
      const evidence = await runOwnerHandoffRollbackSmoke({ context, seedPage: page, chromium, gateway, protocol,
        threadId, taskUrl: page.url(), turn1Marker: promptMarker, mobileEntryUrl,
        expectedScope: setupScopeExpectation, rpcCredentials, pageSocketCredentials: mobileRpcSocketCredentialsByRecord,
        gatewayBaseUrl, gatewayRpcPath, readLiveMessageIdentityRows, waitFor,
        bridge: async (subject, gate) => {
          subject.on("pageerror", error => browserErrors.push(context.redactText(error.message)));
          await installResumeBridge(subject, protocol, promptMarker, replacementMarker, context,
            clientMessageIdHashKey, null, null, null, gate);
        } });
      evidence.rustAppServer = await verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore);
      evidence.mobileWebArchive = archiveEvidence;
      assert.equal(browserErrors.length, 0, "owner-handoff subject Page reported a Browser error");
      assert.equal(protocol.errors.length, 0, "owner-handoff WebSocket bridge reported an error");
      await context.writeArtifactJson("mobile-session-cache-owner-handoff-rollback-smoke.json", evidence);
      return evidence;
    }
    if (agentListCausalSmoke) {
      const evidence = await runAgentListCausalSmoke({
        context, page, protocol, threadId, taskUrl: page.url(), promptMarker, tailMarker,
        gateway, mobileEntryUrl, seededCacheReadiness, expectedScope: setupScopeExpectation,
        getChromium: () => chromium, releaseChromium: releaseTimingChromium,
        createRestorePage: async (restoredPage, gate, lane) => {
          observeMobilePageRpcSockets(restoredPage, protocol, context, gatewayBaseUrl, gatewayRpcPath);
          restoredPage.on("pageerror", error => browserErrors.push(context.redactText(error.message)));
          await installResumeBridge(restoredPage, protocol, promptMarker, replacementMarker, context,
            clientMessageIdHashKey, null, url => lane.assertRouteUrl(url, "rpc"), null, gate);
        },
        waitFor, releaseHeldAuthority,
      });
      evidence.rustAppServer = await verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore);
      evidence.mobileWebArchive = archiveEvidence;
      assert.equal(browserErrors.length, 0, `Browser page errors: ${browserErrors.join(" | ")}`);
      assert.equal(protocol.errors.length, 0, `test bridge errors: ${protocol.errors.join(" | ")}`);
      await context.writeArtifactJson("mobile-session-cache-agent-list-causal-smoke.json", evidence);
      return evidence;
    }
    if (cacheCorruptionKind || transactionAbortSmoke || quotaSmoke || multitabWritersSmoke) {
      assert.ok(setupScopeExpectation, "cache corruption requires the observed production Mobile route scope");
      const evidence = await (multitabWritersSmoke ? runCacheMultitabWritersSmoke : quotaSmoke ? runCacheQuotaSmoke : transactionAbortSmoke ? runCacheTransactionAbortSmoke : runCacheStorageCorruptionSmoke)({
        context, page, protocol, kind: cacheCorruptionKind, expectedScope: setupScopeExpectation,
        threadId, taskUrl: page.url(), promptMarker, tailMarker, gateway, mobileEntryUrl,
        getChromium: () => chromium, releaseChromium: releaseTimingChromium, createProtocolState,
        createPeerTask: marker => createTask(page, multitabWritersSmoke ? buildColdProcessAnchorPrompt(marker) : marker, marker, setupDiagnostics),
        createRestorePage: async (subjectProtocol = protocol, subjectMarker = promptMarker) => {
          const restoredPage = await chromium.newPersistentPage();
          await restoredPage.setViewportSize({ width: 390, height: 844 });
          observeMobilePageRpcSockets(restoredPage, subjectProtocol, context, gatewayBaseUrl, gatewayRpcPath);
          restoredPage.on("pageerror", error => browserErrors.push(context.redactText(error.message)));
          await installResumeBridge(restoredPage, subjectProtocol, subjectMarker, replacementMarker, context, clientMessageIdHashKey);
          return restoredPage;
        },
        waitFor, waitForReadOnlyTranscriptCache, releaseHeldAuthority,
      });
      evidence.rustAppServer = await verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore);
      evidence.mobileWebArchive = archiveEvidence;
      assert.equal(browserErrors.length, 0, `Browser page errors during storage fallback: ${browserErrors.join(" | ")}`);
      assert.equal(protocol.errors.length, 0, `test bridge errors during storage fallback: ${protocol.errors.join(" | ")}`);
      await context.writeArtifactJson(multitabWritersSmoke ? "mobile-session-cache-multitab-writers-smoke.json" : quotaSmoke ? "mobile-session-cache-quota-smoke.json" : transactionAbortSmoke ? "mobile-session-cache-transaction-abort-smoke.json" : "mobile-session-cache-storage-corruption-smoke.json", evidence);
      return evidence;
    }
    if (confirmedAbsenceSmoke) {
      assert.ok(setupScopeExpectation, "confirmed absence smoke requires the observed production Mobile route scope");
      const rustAppServer = await verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore);
      const rpcCredentials = mobileBrowserRpcCredentials({
        gateway,
        scopeExpectation: setupScopeExpectation,
        serverInventoryResponses,
        mobileBootstrap: capturedMobileSessionBootstrap,
        protocol,
        pageSocketCredentials: mobileRpcSocketCredentialsByRecord,
      });
      capturedMobileSessionBootstrap = null;
      const evidence = await runConfirmedAbsenceSmoke({
        context,
        page,
        gateway,
        ownedWorkspacePath: workspace,
        protocol,
        threadId,
        taskPath,
        promptMarker,
        mobileEntryUrl,
        mobileMountPath: "/mobile",
        scopeExpectation: setupScopeExpectation,
        seededCacheReadiness,
        rpcCredentials,
        armServerHold,
        releaseServerHold,
        waitFor,
        waitForReadOnlyTranscriptCache,
      });
      evidence.browser = {
        ...await browserIdentityEvidence(chromium, context),
        viewport: { width: 390, height: 844 },
        platform: "Web only; not native or a physical phone",
      };
      evidence.clientMessageIdHashPolicy = "per-run HMAC-SHA-256; plaintext IDs and hash key are not persisted";
      evidence.rpcRequests = projectProtocolRpcRequests(protocol.requests);
      evidence.indexedHistoryReads = protocol.indexedHistoryReads;
      evidence.rustAppServer = rustAppServer;
      assert.equal(browserErrors.length, 0, `Browser page errors during confirmed absence smoke: ${browserErrors.join(" | ")}`);
      assert.equal(protocol.errors.length, 0, `test WebSocket bridge errors during confirmed absence smoke: ${protocol.errors.join(" | ")}`);
      await context.writeArtifactJson("mobile-session-cache-confirmed-absence-smoke.json", evidence);
      return evidence;
    }
    if (setupSmoke) {
      let productionReloadEvidence = null;
      if (productionMobileMount) {
        const serverHold = armServerHold();
        const restoreSocket = protocol.nextSocketOrdinal + 1;
        protocol.rootRestore = { minSocketOrdinal: restoreSocket, threadId, holdMode: "forward" };
        setupDiagnostics.phase = "production-mobile-cache-reload-held";
        await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded" });
        await waitFor(() => serverHold.pending > 0, 30_000,
          "owned /api/servers held during the production-mobile-mount setup reload");
        await page.waitForURL(url => url.pathname === taskPath, { timeout: 30_000 });
        const cachedView = page.getByTestId("session-cache-view");
        await cachedView.waitFor({ state: "visible", timeout: 30_000 });
        assert.equal(await cachedView.count(), 1, "the production mobile mount reload must expose one cached transcript view");
        const cachedPrompt = cachedView.getByTestId("message-user").filter({ hasText: promptMarker });
        await cachedPrompt.waitFor({ state: "visible", timeout: 30_000 });
        assert.equal(await cachedPrompt.count(), 1, "the production mobile mount cache must contain one prompt marker row");
        const cacheStatus = cachedView.getByTestId("session-cache-status");
        await cacheStatus.waitFor({ state: "visible", timeout: 30_000 });
        assert.equal(await cacheStatus.count(), 1,
          "the production mobile mount cached view must expose one semantic read-only status");
        await assertCachedSessionComposerReadOnly(page,
          "the production mobile mount cache while /api/servers is held");
        const reloadedCacheReadiness = await waitForReadOnlyTranscriptCache(page, {
          threadId,
          gatewayOrigin: new URL(gateway.baseUrl).origin,
          marker: promptMarker,
          expectedScope: setupScopeExpectation,
        }, 30_000);
        assert.ok(reloadedCacheReadiness.ready,
          "the production mobile mount document reload must read back the committed thread-and-Gateway-origin cache");
        assert.equal(serverHold.pending, 1,
          "the production mobile mount reload must own exactly one held /api/servers request");
        releaseServerHold();
        await waitFor(() => protocol.rootRestore?.response?.forwardedAt !== null &&
          protocol.rootRestore?.response?.forwardedAt !== undefined, 30_000,
        "unchanged Rust thread/resume response forwarded after production-mobile /api/servers release");
        const authoritativeReload = protocol.rootRestore.response;
        assert.equal(authoritativeReload.fixtureTransformed, false,
          "the production mobile mount reload must use the unchanged Rust authority response");
        assert.equal(protocol.errors.length, 0,
          `test WebSocket bridge errors during production-mobile reload: ${protocol.errors.join(" | ")}`);
        await page.getByTestId("session-cache-view").waitFor({ state: "detached", timeout: 30_000 });
        const authorityPrompt = page.getByTestId("message-user").filter({ hasText: promptMarker });
        await authorityPrompt.waitFor({ state: "visible", timeout: 30_000 });
        assert.equal(await authorityPrompt.count(), 1,
          "the unchanged Rust authority response must show the original prompt once after cache replacement");
        await waitFor(() => page.getByTestId("message-input").isEditable(), 30_000,
          "editable composer after production-mobile authority replaces the cached read-only view");
        productionReloadEvidence = {
          entryPath: "/mobile/",
          reloadPath: safePath(page.url()),
          serverHoldRequestCount: serverHold.pending,
          cachedViewReadOnly: true,
          cacheReadback: reloadedCacheReadiness,
          authorityResponseForwarded: authoritativeReload.forwardedAt !== null,
          authorityResponseFixtureTransformed: authoritativeReload.fixtureTransformed,
          authorityPromptRowCount: await authorityPrompt.count(),
          composerEditableAfterAuthority: true,
          scopeEvidenceBoundary: "Observed fields are compared against the exact route, public profile index and an already-observed Gateway server descriptor response. connectionFingerprint is shape-checked only and is not independently verified; this is not a full-scope isolation claim.",
        };
      }
      assert.equal(browserErrors.length, 0, `Browser page errors during setup smoke: ${browserErrors.join(" | ")}`);
      assert.equal(protocol.errors.length, 0, `test WebSocket bridge errors during setup smoke: ${protocol.errors.join(" | ")}`);
      const rustAppServer = await verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore);
      const evidence = {
        caseId: "mobile-session-cache-setup-smoke",
        status: "PASS_SETUP_SMOKE",
        boundary: productionMobileMount
          ? "SETUP_SMOKE_ONLY: caller-pinned deployMount:true Mobile Web archive served at /mobile/, owned Gateway/Rust app-server, one deterministic local full turn, document-reload IndexedDB cache readback, read-only cached view during held /api/servers, and unchanged Rust authority replacement; skips the remaining recovery/anchor/failure/retry/timing assertions; connectionFingerprint is not independently verified; no external Provider/model call, native-phone evidence, or production offline-service-worker claim"
          : "SETUP_SMOKE_ONLY: real Mobile Web plus owned Gateway/Rust app-server, one deterministic local full turn, and thread-and-Gateway-origin cache persistence readback; skips cache restore, anchor, controlled failure/retry, and timing assertions; no external Provider/model call and no native-phone evidence",
        mobileMount: productionMobileMount ? {
          mode: "production-mobile-mount-opt-in",
          mountPath: "/mobile/",
          archiveDeployMountVerified: true,
          archiveSha256: productionMobileMountInputs.archiveSha256,
          originalManifestSha256: productionMobileMountInputs.originalManifestSha256,
          sourceManifestSha256: productionMobileMountInputs.sourceManifestSha256,
          deploymentRoot: mobileDeployment.path,
          deploymentManifestSha256: mobileDeployment.manifestSha256,
          deploymentResourceCount: mobileDeployment.resourceCount,
          deploymentPhysicalFileCount: mobileDeployment.physicalFileCount,
          configuredGatewayVariable: "KCODER_STUDIO_MOBILE_WEB_ROOT",
          rootWebBundleOverride: false,
          reloadEvidence: productionReloadEvidence,
        } : { mode: "legacy-root-web-root" },
        mobileWeb: {
          sourceRoot: mobileWeb.sourceRoot ?? null,
          sourceTreeSha256: mobileWeb.sourceTreeSha256,
          ...sourceIdentityEvidence(sourceIdentity),
          assistantRowConstruction,
          bundleSha256: mobileWeb.bundleSha256,
          bundleFileCount: mobileWeb.bundleFileCount,
          archivePath: mobileWeb.archivePath,
          archiveSha256: mobileWeb.archiveSha256,
        },
        rustAppServer,
        gateway: { baseOrigin: new URL(gateway.baseUrl).origin, authTokenRedacted: true },
        browser: {
          ...await browserIdentityEvidence(chromium, context),
          viewport: { width: 390, height: 844 },
          platform: "Web only; not native or a physical phone",
        },
        threadId,
        taskPath,
        completedTurnCount: protocol.turnCompletions.filter(event => event.threadId === threadId && event.status === "completed").length,
        cacheAuthority: seededCacheReadiness,
        scopeEvidence: seededCacheReadiness.scopeEvidence ?? null,
        clientMessageIdHashPolicy: "per-run HMAC-SHA-256; plaintext IDs and hash key are not persisted",
        rpcRequests: projectProtocolRpcRequests(protocol.requests),
        httpRequests: setupHttpEvidence(serverRequests, serverStatusRequests),
        transportDiagnosticsArtifact: "mobile-session-cache-transport-diagnostics.json",
        setupDiagnostics: setupTraceEvidence(setupDiagnostics),
        providerCalls: 0,
      };
      await context.writeArtifactJson("mobile-session-cache-setup-smoke.json", evidence);
      return evidence;
    }
    const restoredComposerDraft = await createAndPersistUnsentMultilineDraft(page, { threadId, waitFor });
    setupDiagnostics.phase = "cache-recovery-assertions";
    const tailRow = page.getByTestId("message-assistant").filter({ hasText: tailMarker });
    assert.equal(await tailRow.count(), 1, "the completed full-turn transcript must contain one stable tail assistant row");
    const userAnchorSetup = await prepareUserReadingAnchorViewport({ page, promptMarker, readTranscriptViewport });
    viewportEvidence.userAnchorSetup = userAnchorSetup;

    const initialUserGeometry = await armTrustedWheelObservationWithViewport(page, {
      markerText: promptMarker,
      rowDomId: userAnchorSetup.rowDomId,
      rowTestId: "message-user",
    });
    const wheelStart = initialUserGeometry?.wheelStart;
    assert.equal(initialUserGeometry?.rowDomId, userAnchorSetup.rowDomId,
      "the armed viewport must retain the prepared exact user row");
    assert.ok(wheelStart, "the real message-list scroll host must be available for trusted user-row wheel input");
    const wheelMovementDeadline = Date.now() + 5_000;
    const wheelSequenceDiagnostics = {};
    viewportEvidence.userAnchorSetup.wheelSequence = wheelSequenceDiagnostics;
    const wheelSequence = await runTrustedUserAnchorWheelSequenceV1({
      page,
      markerText: promptMarker,
      rowDomId: userAnchorSetup.rowDomId,
      initialGeometry: initialUserGeometry,
      wheelStart,
      readTranscriptViewport,
      readTrustedWheelTargetAtPoint,
      readTrustedWheelObservation,
      diagnostics: wheelSequenceDiagnostics,
      deadlineAtMs: wheelMovementDeadline,
    });
    const finalGestureStartGeometry = wheelSequence.finalWheel.startGeometry;
    const afterWheelGeometry = wheelSequence.afterWheelGeometry;
    const wheelAudit = wheelSequence.wheelAudit;
    assert.equal(afterWheelGeometry.rowMatchCount, 1, "the prompt marker must remain rendered in one user row after the wheel gesture");
    assert.equal(afterWheelGeometry.markerTextMatchCount, 1, "the user marker must remain unique after the wheel gesture");
    assert.equal(afterWheelGeometry.markerIntersectsWindow, true, "the user marker must remain in the real viewport after the wheel gesture");
    assert.equal(afterWheelGeometry.markerIntersectsList, true, "the user marker must intersect the list viewport after the wheel gesture");
    assert.equal(afterWheelGeometry.rowDomId, userAnchorSetup.rowDomId,
      "the trusted wheel must keep the same exact prompt row as its geometric target");
    let coldAnchorScrollResponse = null;
    let liveAnchorReachability = null;
    if (coldProcessSmoke) {
      coldAnchorScrollResponse = observeAnchorScrollResponse({
        startScrollTop: finalGestureStartGeometry.host.scrollTop,
        startOffset: finalGestureStartGeometry.row.offsetFromHost,
        endScrollTop: afterWheelGeometry.host.scrollTop,
        endOffset: afterWheelGeometry.row.offsetFromHost,
      });
      assert.ok(coldAnchorScrollResponse,
        "the real trusted wheel must expose a measurable scrollTop-to-user-row geometry response");
      liveAnchorReachability = assertAnchorScrollReachability(
        afterWheelGeometry,
        afterWheelGeometry.row.offsetFromHost,
        coldAnchorScrollResponse,
        "live user anchor scroll precondition",
      );
    }

    savedAnchorReadiness = await waitForReadOnlyTranscriptCache(page, {
      threadId,
      gatewayOrigin: new URL(gateway.baseUrl).origin,
      marker: promptMarker,
      requireReadingAnchor: true,
      expectedAnchorOffset: coldProcessSmoke || trustedAnchorSetupSmoke ? afterWheelGeometry.row.offsetFromHost : null,
    }, 30_000);
    assert.ok(savedAnchorReadiness.ready, "the trusted wheel reading anchor must be committed to the existing transcript cache");
    assert.equal(savedAnchorReadiness.anchor?.followsLatest, false, "a real wheel gesture must persist detached reading intent");
    anchorAuthorityRead = latestScopedAuthorityRead(protocol, threadId, protocol.activeTaskSocketOrdinal);
    assert.ok(anchorAuthorityRead, "the anchor must map against the latest successful indexed authority page on the task socket");
    anchorDisplayIdentity = resolveUniqueTurnUserAnchorIdentity({
      anchor: savedAnchorReadiness.anchor,
      threadId,
      activeSocketOrdinal: protocol.activeTaskSocketOrdinal,
      requests: protocol.requests,
      indexedHistoryRead: anchorAuthorityRead,
      turnCompletions: protocol.turnCompletions,
    });
    const liveAnchorDomId = userAnchorSetup.rowDomId;
    const canonicalAnchorDomId = `message-${encodeURIComponent(anchorDisplayIdentity.canonicalId)}`;
    const savedAnchorGeometry = await readTranscriptViewport(page, {
      markerText: coldProcessSmoke || trustedAnchorSetupSmoke ? promptMarker : null,
      rowDomId: liveAnchorDomId,
      rowTestId: "message-user",
    });
    assert.equal(savedAnchorGeometry.rowMatchCount, 1, "the persisted anchor row must be mounted exactly once");
    assert.equal(savedAnchorGeometry.rowIntersectsWindow, true, "the persisted anchor row must be inside the browser viewport");
    assert.equal(savedAnchorGeometry.rowIntersectsList, true, "the persisted anchor row must intersect the list viewport");
    assertOffsetNear(savedAnchorGeometry.row.offsetFromHost, savedAnchorReadiness.anchor.offset,
      "read-only IndexedDB anchor versus live row offset from scroll host");
    viewportEvidence.liveAfterTrustedWheel = {
      user: afterWheelGeometry,
      persistedAnchor: savedAnchorReadiness.anchor,
      identityResolution: anchorDisplayIdentity,
      authorityRead: anchorAuthorityRead,
      anchorRow: savedAnchorGeometry,
      wheel: wheelAudit,
      counterWheelPreparation: null,
      coldScrollResponse: coldAnchorScrollResponse,
      coldScrollReachability: liveAnchorReachability,
    };

    if (trustedAnchorSetupSmoke) {
      assert.equal(savedAnchorReadiness.anchor?.messageId, anchorDisplayIdentity.canonicalId,
        "the trusted setup smoke must persist the canonical user message selected by the real turn identity");
      assert.equal(savedAnchorReadiness.anchor?.followsLatest, false,
        "the real trusted wheel must persist detached user reading intent");
      assert.equal(savedAnchorGeometry.markerTextMatchCount, 1,
        "the persisted user anchor must retain the exact prompt marker Range");
      assert.equal(savedAnchorGeometry.markerIntersectsList, true,
        "the persisted user anchor marker must remain in the actual message-list viewport");
      assert.ok(wheelSequence.finalWheel.dispatch?.isTrusted === true &&
        wheelSequence.finalWheel.dispatch?.defaultPreventedAfterDispatch === true &&
        wheelSequence.finalWheel.dispatch?.deltaY === wheelSequence.finalWheel.deltaY,
      "the setup smoke must prove a trusted RNW-handled wheel with the selected measured delta");
      assert.ok(Math.abs(afterWheelGeometry.host.scrollTop - initialUserGeometry.host.scrollTop) > 0.5,
        "the setup smoke must prove real message-list movement rather than a clamped trusted input");
      const evidence = {
        status: "PASS_TRUSTED_ANCHOR_SETUP_SMOKE",
        scope: "one measured trusted wheel and detached canonical user anchor only; no cold-process recovery assertion",
        threadId,
        taskPath: safePath(page.url()),
        userAnchor: {
          canonicalMessageId: savedAnchorReadiness.anchor.messageId,
          followsLatest: savedAnchorReadiness.anchor.followsLatest,
          offset: savedAnchorReadiness.anchor.offset,
          manifestRevision: savedAnchorReadiness.manifestRevision,
        },
        wheel: {
          deltaY: wheelSequence.finalWheel.deltaY,
          targetPreflight: wheelSequence.finalWheel.targetPreflight,
          dispatch: wheelSequence.finalWheel.dispatch,
          scrollSamples: wheelSequence.finalWheel.scrollSamples,
          start: initialUserGeometry,
          after: afterWheelGeometry,
        },
        persistedRow: savedAnchorGeometry,
      };
      await context.writeArtifactJson("mobile-session-cache-trusted-anchor-setup-smoke.json", evidence);
      return evidence;
    }

    if (coldProcessSmoke) {
      const rustAppServer = await verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore);
      const firstBrowserIdentity = await browserIdentityEvidence(chromium, context);
      const evidence = await runColdProcessSmoke({
        context,
        firstChromium: chromium,
        profileName: chromiumProfileName,
        firstPage: page,
        gateway,
        mobileWeb,
        deploymentRoot: mobileDeployment.path,
        productionMobileMountInputs,
        mobileEntryUrl,
        taskPath,
        threadId,
        promptMarker,
        replacementMarker,
        tailMarker,
        gatewayOrigin: new URL(gateway.baseUrl).origin,
        scopeExpectation: setupScopeExpectation,
        cacheAfterTurn: seededCacheReadiness,
        savedAnchor: savedAnchorReadiness,
        anchorScrollResponse: coldAnchorScrollResponse,
        anchorDisplayIdentity,
        protocol,
        installResumeBridge: targetPage => installResumeBridge(
          targetPage, protocol, promptMarker, replacementMarker, context, clientMessageIdHashKey),
        releaseHeldAuthority,
        rustAppServer,
        firstBrowserIdentity,
        waitForReadOnlyTranscriptCache,
        readTranscriptViewport,
        assertOffsetNear,
        capturePrivateScreenshot: (targetPage, filename) => savePrivateScreenshot(targetPage, context, filename),
      });
      assert.equal(browserErrors.length, 0, `Browser page errors during cold process smoke: ${browserErrors.join(" | ")}`);
      assert.equal(protocol.errors.length, 0, `test WebSocket bridge errors during cold process smoke: ${protocol.errors.join(" | ")}`);
      await context.writeArtifactJson("mobile-session-cache-cold-process-smoke.json", evidence);
      return evidence;
    }

    if (cacheUiVisualSmoke) return await runCachedSessionUiVisualMatrix({
      context, page, protocol, browserErrors, gatewayOrigin: new URL(gateway.baseUrl).origin,
      mobileEntryUrl, taskPath, threadId, promptMarker, draft: restoredComposerDraft,
      anchorMessageId: savedAnchorReadiness.anchor.messageId, anchorOffset: savedAnchorReadiness.anchor.offset,
      armServerHold, releaseServerHold, releaseHeldAuthority, waitFor, waitForReadOnlyTranscriptCache,
      assertCachedSessionComposerReadOnly, readTranscriptViewport,
      savePrivateScreenshot: (targetPage, filename) => savePrivateScreenshot(targetPage, context, filename),
      verifyRustAppServer: () => verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore), archiveEvidence,
    });

    if (cacheTimingDelays) {
      const jumpToLatest = page.getByTestId("jump-to-latest");
      assert.equal(await jumpToLatest.count(), 1, "the live transcript must expose exactly one real jump-to-latest control");
      await jumpToLatest.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await jumpToLatest.isEnabled(), true, "the live jump-to-latest control must be enabled before the real click");
      await jumpToLatest.click();

      const latestTailGeometry = await waitFor(async () => {
        const geometry = await readTranscriptViewport(page, {
          markerText: tailMarker,
          rowTestId: "message-assistant",
        });
        return geometry.rowMatchCount === 1 && geometry.markerTextMatchCount === 1 &&
          geometry.markerIntersectsWindow && geometry.markerIntersectsList ? geometry : null;
      }, 10_000, "the actual assistant tail Range to enter the visible message-list viewport after jump-to-latest");
      assert.equal(latestTailGeometry.rowMatchCount, 1, "the tail marker must map to one actual assistant row");
      assert.equal(latestTailGeometry.markerTextMatchCount, 1, "the real assistant tail Range must be unique");
      assert.equal(latestTailGeometry.markerIntersectsWindow, true, "the assistant tail Range must be visible in the browser viewport");
      assert.equal(latestTailGeometry.markerIntersectsList, true, "the assistant tail Range must intersect the message-list viewport");

      const liveRows = await readLiveMessageIdentityRows(page);
      timingLatestAssistantIdentity = resolveLatestCompletedAssistantIdentity({
        threadId,
        activeSocketOrdinal: protocol.activeTaskSocketOrdinal,
        turnCompletions: protocol.turnCompletions,
        indexedHistoryRead: anchorAuthorityRead,
        liveRows,
        tailGeometry: latestTailGeometry,
      });
      const latestAssistantDisplayRowId = timingLatestAssistantIdentity.displayRowId;
      const latestAssistantCanonicalMessageId = timingLatestAssistantIdentity.canonicalMessageId;

      assert.ok(Number.isSafeInteger(savedAnchorReadiness.manifestRevision),
        "the detached user anchor must have a recorded IndexedDB manifest revision before jumping to latest");
      const latestAnchorReadiness = await waitForReadOnlyTranscriptCache(page, {
        threadId,
        gatewayOrigin: new URL(gateway.baseUrl).origin,
        marker: promptMarker,
        ...(setupScopeExpectation ? { expectedScope: setupScopeExpectation } : {}),
        expectedAnchorMessageId: latestAssistantCanonicalMessageId,
        expectedAnchorOffset: 0,
        expectedAnchorOffsetTolerance: 0,
        expectedAnchorFollowsLatest: true,
        minimumManifestRevision: savedAnchorReadiness.manifestRevision + 1,
      }, 30_000);
      assert.ok(latestAnchorReadiness.ready,
        "the real jump-to-latest action must advance IndexedDB and persist the latest assistant anchor at followsLatest/offset 0");
      assert.ok(latestAnchorReadiness.manifestRevision > savedAnchorReadiness.manifestRevision,
        "the persisted latest anchor must advance beyond the detached user-anchor revision");
      assert.equal(latestAnchorReadiness.anchor?.messageId, latestAssistantCanonicalMessageId,
        "the persisted follows-latest anchor must name the canonical latest assistant message ID");
      assert.equal(latestAnchorReadiness.anchor?.followsLatest, true,
        "the real jump-to-latest action must persist followsLatest=true");
      assert.equal(latestAnchorReadiness.anchor?.offset, 0,
        "the real jump-to-latest action must persist offset 0 exactly");
      const latestAnchorEvidence = {
        controlTestId: "jump-to-latest",
        controlCount: 1,
        clicked: true,
        sourceAnchor: savedAnchorReadiness.anchor,
        manifestRevisionBefore: savedAnchorReadiness.manifestRevision,
        persistedAnchor: latestAnchorReadiness.anchor,
        manifestRevisionAfter: latestAnchorReadiness.manifestRevision,
        latestAssistantDisplayRowId,
        latestAssistantCanonicalMessageId,
        latestAssistantIdentity: timingLatestAssistantIdentity,
        tailGeometry: latestTailGeometry,
      };
      viewportEvidence.cacheTimingLatestAnchor = latestAnchorEvidence;

      const directLaneDescriptor = createDirectMobileTimingLaneDescriptor({
        gatewayUrl: gateway.baseUrl,
        mobileUrl: mobileEntryUrl,
      });
      const directSeedOwnershipRelease = await releaseTimingChromium("direct-seed-release", {
        page, protocol, requiredSocketOrdinal: protocol.activeTaskSocketOrdinal });
      const directTimingLane = {
        ...directLaneDescriptor,
        initialPage: null,
        protocol,
        expectedScope: setupScopeExpectation,
        taskPath,
        threadId,
      };
      const timingLanes = [directTimingLane];
      let pairedSetupEvidence = null;
      if (cacheTimingDirectRelay) {
        assert.ok(timingRelayLane, "direct/Relay paired timing requires a registered and entry-validated owned Relay lane");
        const preparedRelay = await prepareRelayTimingLane({
          context,
          chromium,
          releaseTimingChromium,
          gateway,
          relayLane: timingRelayLane,
          directProtocol: protocol,
          threadId,
          taskPath,
          promptMarker,
          replacementMarker,
          clientMessageIdHashKey,
          expectedUserAnchorMessageId: anchorDisplayIdentity.canonicalId,
          expectedAssistantMessageId: timingLatestAssistantIdentity.canonicalMessageId,
          directScopeExpectation: setupScopeExpectation,
          browserErrors,
        });
        timingLanes.push({ ...preparedRelay.lane });
        pairedSetupEvidence = {
          ...preparedRelay.evidence,
          directSeedOwnershipRelease,
        };
      }
      for (const lane of timingLanes) {
        lane.initialPage = await openMobileTimingCacheObserverPage({ chromium, lane });
      }
      const timingBrowserIdentity = await browserIdentityEvidence(chromium, context, chromiumLabel);
      const latestSetupRelease = pairedSetupEvidence?.relayBootstrapOwnershipRelease ?? directSeedOwnershipRelease;
      assert.equal(timingBrowserIdentity.pid, latestSetupRelease.newPid,
        "the first measured sample must use the exact Chromium PID opened after setup release");
      const timingEvidence = await runMobileCacheTimingSamplesV1({
        context,
        lanes: timingLanes,
        initialBrowserOwner: {
          pid: timingBrowserIdentity.pid,
          pgid: timingBrowserIdentity.pgid,
          profileDir: latestSetupRelease.profileDir,
        },
        createSamplePage: () => chromium.newPersistentPage(),
        openCacheObserverPage: lane => openMobileTimingCacheObserverPage({ chromium, lane }),
        releaseTimingPage: (lane, targetPage, release) => releaseTimingChromium("timing-sample-release", {
          ...release, page: targetPage, protocol: lane.protocol, restart: release.restartAfterSample,
        }),
        clientMessageIdHashKey,
        threadId,
        promptMarker,
        replacementMarker,
        tailMarker,
        expectedAssistantMessageId: timingLatestAssistantIdentity.canonicalMessageId,
        delays: cacheTimingDelays,
        paired: cacheTimingDirectRelay,
        pairedSetupEvidence,
        browserErrors,
        readCacheReadiness: (lane, cachePage, options) => waitForReadOnlyTranscriptCache(cachePage, {
          threadId,
          gatewayOrigin: lane.origin,
          marker: promptMarker,
          expectedScope: lane.expectedScope ?? null,
          expectedMessageId: options.expectedMessageId,
          expectedAnchorMessageId: options.expectedAnchorMessageId,
          expectedAnchorFollowsLatest: options.expectedAnchorFollowsLatest,
          expectedAnchorOffset: options.expectedAnchorOffset,
          expectedAnchorOffsetTolerance: options.expectedAnchorOffsetTolerance,
        }, 30_000),
        installResumeBridge: (lane, ...args) => {
          observeMobilePageRpcSockets(args[0], args[1], context, lane.gatewayUrl, lane.rpcPath);
          return installResumeBridge(...args, rawUrl => lane.assertRouteUrl(rawUrl, "rpc"), {
            expectedThreadId: threadId,
            expectedAssistantMessageId: timingLatestAssistantIdentity.canonicalMessageId,
            tailMarker,
          });
        },
        releaseTimingResponse,
        savePrivateScreenshot,
      });
      const rustAppServer = await verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore);
      const evidence = {
        ...timingEvidence,
        caseId: "transcript-cache-real-ui-timing-only",
        status: timingEvidence.failedSamples > 0 || timingEvidence.notRunSamples > 0 ? "FAIL" : "PASS_TIMING_ONLY",
        timingOnly: true,
        defaultDetachedAnchorRecovery: "NOT_RUN_BY_TIMING_ONLY_BRANCH",
        directSeedOwnershipRelease,
        browserOwnerSetup: {
          profileName: chromiumProfileName,
          directSeedRelease: directSeedOwnershipRelease,
          relayBootstrapRelease: pairedSetupEvidence?.relayBootstrapOwnershipRelease ?? null,
        },
        seedCacheReadiness: seededCacheReadiness,
        detachedUserAnchorReadiness: savedAnchorReadiness,
        latestAnchorReadiness,
        latestAnchorEvidence,
        mobileWeb: {
          sourceRoot: mobileWeb.sourceRoot ?? null,
          sourceTreeSha256: mobileWeb.sourceTreeSha256,
          ...sourceIdentityEvidence(sourceIdentity),
          bundleSha256: mobileWeb.bundleSha256,
          bundleFileCount: mobileWeb.bundleFileCount,
        },
        rustAppServer,
        gateway: { baseOrigin: new URL(gateway.baseUrl).origin, authTokenRedacted: true },
        browser: {
          ...timingBrowserIdentity,
          viewport: { width: 390, height: 844 },
          platform: "Web only; not native or a physical phone",
        },
        boundary: "DIAGNOSTIC_ONLY: real deterministic full-turn seed, trusted detached-user wheel, real Mobile jump-to-latest action and verified IndexedDB latest-assistant anchor; this timing-only branch does not execute the default detached-anchor restore/reset assertions; each sample uses a newly started same-profile Chromium process with startup separately recorded, while Gateway/app-server stay warm; not backend cold-start, phone, public-network RTT, or model evidence",
        providerCalls: 0,
        browserErrors: browserErrors.map(error => context.redactText(error)),
        protocolErrors: protocol.errors.map(error => context.redactText(error)),
      };
      await context.writeArtifactJson("mobile-session-cache-timing.json", evidence);
      if (timingEvidence.failedSamples > 0 || timingEvidence.notRunSamples > 0) {
        throw new Error(`cache timing diagnostic had ${timingEvidence.failedSamples} failed and ${timingEvidence.notRunSamples} unrun planned sample(s)`);
      }
      assert.equal(browserErrors.length, 0, `Browser page errors: ${browserErrors.join(" | ")}`);
      assert.equal(protocol.errors.length, 0, `test WebSocket bridge errors: ${protocol.errors.join(" | ")}`);
      assert.equal(protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length,
        1, "the real latest-anchor action and timing samples must not resend the original user turn");
      return evidence;
    }

    const firstServerHold = armServerHold();
    const firstRestoreSocket = protocol.nextSocketOrdinal + 1;
    protocol.rootRestore = { minSocketOrdinal: firstRestoreSocket, threadId, holdMode: "full" };
    await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded" });
    await waitFor(() => firstServerHold.pending > 0, 30_000, "owned /api/servers held during the anchor restore");
    await page.waitForURL(url => url.pathname === taskPath, { timeout: 30_000 });
    const firstCachedView = page.getByTestId("session-cache-view");
    assert.equal(await firstCachedView.count(), 1, "the first restore must expose one cached transcript view");
    await firstCachedView.waitFor({ state: "visible", timeout: 30_000 });
    const firstCachedPrompt = page.getByTestId("message-user").filter({ hasText: promptMarker });
    assert.equal(await firstCachedPrompt.count(), 1, "the cached prompt row must be unique during restore");
    await firstCachedPrompt.waitFor({ state: "visible", timeout: 30_000 });
    await assertCachedSessionComposerReadOnly(page,
      "the cached transcript while /api/servers is held");
    assert.equal(await firstCachedView.getByTestId("message-input").inputValue(), "",
      "the cache view must not expose a draft until the current workspace target owner is re-resolved");
      assert.equal(firstServerHold.pending, 1, "the anchor restore must own exactly one held /api/servers request");
    const cachedAnchorGeometry = await readTranscriptViewport(page, {
      rowDomId: canonicalAnchorDomId,
      rowTestId: "message-user",
    });
    const cachedTailGeometry = await readTranscriptViewport(page, {
      markerText: tailMarker,
      rowTestId: "message-assistant",
    });
    viewportEvidence.cacheWhileServersHeld = { anchorRow: cachedAnchorGeometry, tail: cachedTailGeometry };
    assert.equal(cachedAnchorGeometry.rowMatchCount, 1, "the cached anchor row must remain mounted exactly once");
    assert.equal(cachedAnchorGeometry.rowIntersectsWindow, true, "the cached anchor row must remain in the browser viewport");
    assert.equal(cachedAnchorGeometry.rowIntersectsList, true, "the cached anchor row must intersect the list viewport");
    assert.equal(cachedTailGeometry.markerIntersectsWindow, true, "the cached tail marker must remain in the browser viewport");
    assert.equal(cachedTailGeometry.markerIntersectsList, true, "the cached tail marker must remain in the list viewport");
    assertOffsetNear(cachedAnchorGeometry.row.offsetFromHost, savedAnchorReadiness.anchor.offset,
      "cached row offset from scroll host versus persisted reading anchor");
    releaseServerHold();
    await waitFor(() => protocol.rootRestore?.heldResponse ?? protocol.errors[0] ?? null,
      30_000, "full Rust thread/resume response held after catalog release");
    assert.equal(protocol.errors.length, 0, `test WebSocket bridge errors: ${protocol.errors.join(" | ")}`);
    const heldFullRestore = protocol.rootRestore.heldResponse;
    assert.equal(heldFullRestore.fixtureTransformed, false, "anchor preservation must use the unchanged full Rust authority page");
    assert.ok(heldFullRestore.messageIds.length >= 2, "the held full Rust authority page must contain the original user and assistant rows");
    const firstCacheStatus = page.getByTestId("session-cache-status");
    assert.equal(await firstCacheStatus.count(), 1, "the held full response must expose one cache status indicator");
    await firstCacheStatus.waitFor({ state: "visible", timeout: 30_000 });
    await assertCachedSessionComposerReadOnly(page,
      "the cached transcript while the unchanged full authority response is held");
    const cachedDraftVerification = await verifyCachedReadOnlyMultilineDraft(page, {
      draft: restoredComposerDraft,
      anchorDomId: canonicalAnchorDomId,
      persistedAnchorOffset: savedAnchorReadiness.anchor.offset,
      initialAnchorOffset: cachedAnchorGeometry.row.offsetFromHost,
      readTranscriptViewport,
      waitFor,
    });
    const cachedDraftScrollTop = cachedDraftVerification.scrollTop;
    const cachedWhileResumeHeld = cachedDraftVerification.viewport;
    viewportEvidence.cacheWhileResumeHeld = cachedWhileResumeHeld;

    assert.equal(releaseHeldAuthority(protocol), true, "the unchanged full Rust resume response must be owned by this test route");
    await page.getByTestId("session-cache-view").waitFor({ state: "detached", timeout: 30_000 });
    await tailRow.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: promptMarker }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByTestId("message-user").filter({ hasText: promptMarker }).count(), 1,
      "the unchanged full authority transcript must contain the original prompt once");
    await waitFor(() => page.getByTestId("message-input").isEditable(), 30_000,
      "editable composer after the unchanged full authority response");
    assert.equal(await page.getByTestId("message-input").inputValue(), restoredComposerDraft,
      "the same target-scoped draft must survive cached-to-live authority replacement");
    const firstRestore = protocol.rootRestore.response;
    assert.equal(firstRestore.fixtureTransformed, false, "the first authority page must be the unchanged Rust response");
    assert.ok(typeof firstRestore.markerMessageId === "string" && firstRestore.markerMessageId.length > 0,
      "the full Rust page must identify the original user row");
    const fullAuthorityAnchorGeometry = await readTranscriptViewport(page, {
      rowDomId: canonicalAnchorDomId,
      rowTestId: "message-user",
    });
    const fullAuthorityTailGeometry = await readTranscriptViewport(page, {
      markerText: tailMarker,
      rowTestId: "message-assistant",
    });
    assert.equal(fullAuthorityAnchorGeometry.rowMatchCount, 1, "the same anchor row must remain mounted after full authority replaces cache");
    assert.equal(fullAuthorityAnchorGeometry.rowIntersectsWindow, true, "the full authority anchor row must remain in the browser viewport");
    assert.equal(fullAuthorityAnchorGeometry.rowIntersectsList, true, "the full authority anchor row must intersect the list viewport");
    assert.equal(fullAuthorityTailGeometry.markerIntersectsWindow, true, "the stable tail marker must be visible after full authority restoration");
    assert.equal(fullAuthorityTailGeometry.markerIntersectsList, true, "the stable tail marker must intersect the list viewport after restoration");
    assertOffsetNear(fullAuthorityAnchorGeometry.row.offsetFromHost, savedAnchorReadiness.anchor.offset,
      "full authority row offset from scroll host versus saved anchor");
    viewportEvidence.fullAuthorityAfterCache = {
      anchorRow: fullAuthorityAnchorGeometry,
      tail: fullAuthorityTailGeometry,
      composerDraft: {
        lineCount: restoredComposerDraft.split("\n").length,
        readOnlyScrollTopPx: cachedDraftScrollTop,
        editableDraftPreservedAfterAuthority: true,
      },
    };
    firstRestoreCacheReadiness = await waitForReadOnlyTranscriptCache(page, {
      threadId,
      gatewayOrigin: new URL(gateway.baseUrl).origin,
      marker: promptMarker,
      expectedMessageId: firstRestore.markerMessageId,
      expectedAnchorMessageId: savedAnchorReadiness.anchor.messageId,
      requireReadingAnchor: true,
      minimumManifestRevision: seededCacheReadiness.manifestRevision + 1,
    }, 30_000);
    assert.ok(firstRestoreCacheReadiness.ready,
      "the exact-scope full authority page and reading anchor must commit before the shorter replacement case");

    const shortServerHold = armServerHold();
    const secondRestoreSocket = protocol.nextSocketOrdinal + 1;
    protocol.rootRestore = { minSocketOrdinal: secondRestoreSocket, threadId, holdMode: "short" };
    await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded" });
    await waitFor(() => shortServerHold.pending > 0, 30_000, "owned /api/servers held during the shorter replacement restore");
    await page.waitForURL(url => url.pathname === taskPath, { timeout: 30_000 });
    const shorterCachedView = page.getByTestId("session-cache-view");
    assert.equal(await shorterCachedView.count(), 1, "the shorter restore must expose one cached transcript view");
    await shorterCachedView.waitFor({ state: "visible", timeout: 30_000 });
    const shorterCachedPrompt = page.getByTestId("message-user").filter({ hasText: promptMarker });
    await shorterCachedPrompt.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await shorterCachedPrompt.count(), 1, "the previous full cached prompt must remain until shorter authority arrives");
    await assertCachedSessionComposerReadOnly(page,
      "the cached transcript while the shorter replacement restore waits for /api/servers");
    assert.equal(shortServerHold.pending, 1, "the shorter replacement restore must own exactly one held /api/servers request");

    releaseServerHold();
    await waitFor(() => protocol.rootRestore?.heldResponse ?? protocol.errors[0] ?? null,
      30_000, "shorter transformed Rust thread/resume response held after catalog release");
    assert.equal(protocol.errors.length, 0, `test WebSocket bridge errors: ${protocol.errors.join(" | ")}`);
    const heldRestore = protocol.rootRestore.heldResponse;
    assert.equal(heldRestore.fixtureTransformed, true, "only the shorter replacement response may be changed by the WebSocket fixture");
    const shorterCacheStatus = page.getByTestId("session-cache-status");
    assert.equal(await shorterCacheStatus.count(), 1, "the held shorter response must expose one cache status indicator");
    await shorterCacheStatus.waitFor({ state: "visible", timeout: 30_000 });
    await assertCachedSessionComposerReadOnly(page,
      "the cached transcript while the shorter authority page is held");
    assert.equal(releaseHeldAuthority(protocol), true, "the shorter Rust resume response must be owned by this test route");
    const replacementRow = page.getByTestId("message-user").filter({ hasText: replacementMarker });
    await replacementRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await replacementRow.count(), 1, "the shorter authority page must render its replacement marker once");
    assert.equal(await page.getByTestId("message-user").filter({ hasText: promptMarker }).count(), 0,
      "shorter authoritative resume must remove the stale cached user row absent from its returned page");
    const afterAuthorityRowIds = await messageRowIds(page);
    assert.equal(new Set(afterAuthorityRowIds).size, afterAuthorityRowIds.length,
      "the shorter authoritative page must not render duplicate message identities");
    assert.deepEqual([...afterAuthorityRowIds].sort(), [...heldRestore.messageIds].sort(),
      "live rendered message identities must match the complete shorter response page");
    await waitFor(() => page.getByTestId("message-input").isEditable(), 30_000,
      "editable composer after the shorter authoritative resume completes");
    shortenedCacheReadiness = await waitForReadOnlyTranscriptCache(page, {
      threadId,
      gatewayOrigin: new URL(gateway.baseUrl).origin,
      marker: replacementMarker,
      expectedMessageId: heldRestore.replacementMessageId,
      minimumMessageCount: 1,
      minimumManifestRevision: firstRestoreCacheReadiness.manifestRevision + 1,
    }, 30_000);
    assertCachedAuthorityIdentitySnapshot(shortenedCacheReadiness, heldRestore.messageIds, "shortened authority cache", anchorDisplayIdentity.canonicalId);
    const shortenedViewport = await readTranscriptViewport(page, {
      markerText: replacementMarker,
      rowTestId: "message-user",
    });
    assert.equal(shortenedViewport.rowMatchCount, 1, "the shorter page must render one replacement marker row");
    assert.equal(shortenedViewport.markerIntersectsWindow, true, "the shorter replacement marker must be in the actual viewport");
    assert.equal(shortenedViewport.markerIntersectsList, true, "the shorter replacement marker must intersect the actual message list");
    viewportEvidence.shorterAuthority = shortenedViewport;

    const offlineRequestStart = serverRequests.length;
    armServerFailure();
    const shellResponse = await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded" });
    assert.equal(shellResponse?.status(), 200, "the static Mobile Web shell must remain available during the controlled API failure");
    await page.waitForURL(url => url.pathname === taskPath, { timeout: 30_000 });
    await waitFor(() => serverRequests.slice(offlineRequestStart).some(request => request.failed),
      30_000, "the one controlled /api/servers request failure");
    await waitFor(() => controlledApiFailure?.requestFailedCount === 1,
      5_000, "requestfailed for the exact one-shot /api/servers abort");
    const offlineRequests = serverRequests.slice(offlineRequestStart);
    assert.equal(offlineRequests.filter(request => request.failed).length, 1,
      "the read-only recovery state must be caused by exactly one controlled /api/servers failure");
    assert.equal(offlineRequests.length, 1,
      "no automatic /api/servers retry may bypass the visible user-controlled recovery state");
    assert.equal(controlledApiFailure.requestFailedCount, 1,
      "the controlled API abort must map to one requestfailed event for the same Playwright request instance");
    assert.equal(safePath(controlledApiFailure.url), "/api/servers",
      "the expected request failure must be limited to the exact API route");
    const apiFailureView = page.getByTestId("session-cache-view");
    const apiFailureStatus = page.getByTestId("session-cache-status");
    const apiFailureStatusRole = page.getByRole("status");
    assert.equal(await apiFailureView.count(), 1, "the API-failed route must expose one cached transcript view");
    assert.equal(await apiFailureStatus.count(), 1, "the API-failed route must expose one cache status indicator");
    assert.equal(await apiFailureStatusRole.count(), 1, "the connection failure must be exposed as one semantic status region");
    await apiFailureView.waitFor({ state: "visible", timeout: 30_000 });
    await apiFailureStatus.waitFor({ state: "visible", timeout: 30_000 });
    const apiFailureStatusText = await apiFailureStatusRole.innerText();
    assert.match(apiFailureStatusText, /(?:Partial cache|部分缓存|缓存可能不完整)[\s\S]*?(?:offline|离线)[\s\S]*?(?:read only|只读)/i,
      "the visible status must explain that the displayed history is a partial read-only cache");
    const retryButton = page.getByTestId("session-cache-retry");
    const retryByRole = page.getByRole("button", { name: /^(重新连接|Reconnect)$/ });
    assert.equal(await retryButton.count(), 1, "the API-failed cached view must expose one real retry button");
    assert.equal(await retryByRole.count(), 1, "the retry action must have one accessible localized button name");
    await retryByRole.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await retryByRole.isEnabled(), true, "the one visible retry button must be actionable");
    await replacementRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await replacementRow.count(), 1, "the cached replacement row must remain unique while API is unavailable");
    await assertCachedSessionComposerReadOnly(page,
      "the API-failed cache view");
    const offlineCacheReadiness = await waitForReadOnlyTranscriptCache(page, {
      threadId,
      gatewayOrigin: new URL(gateway.baseUrl).origin,
      marker: replacementMarker,
      expectedMessageId: heldRestore.replacementMessageId,
      expectedAnchorMessageId: shortenedCacheReadiness.anchor?.messageId ?? null,
      requireReadingAnchor: Boolean(shortenedCacheReadiness.anchor && !shortenedCacheReadiness.anchor.followsLatest),
      minimumMessageCount: 1,
      minimumManifestRevision: shortenedCacheReadiness.manifestRevision,
    }, 30_000);
    assertCachedAuthorityIdentitySnapshot(offlineCacheReadiness, heldRestore.messageIds, "offline shortened cache", anchorDisplayIdentity.canonicalId);
    viewportEvidence.apiFailureCachedView = await readTranscriptViewport(page, {
      markerText: replacementMarker,
      rowTestId: "message-user",
    });
    assert.equal(viewportEvidence.apiFailureCachedView.markerIntersectsWindow, true,
      "the confirmed cached marker must remain in the viewport during the controlled API failure");
    assert.equal(viewportEvidence.apiFailureCachedView.markerIntersectsList, true,
      "the confirmed cached marker must intersect the list viewport during the controlled API failure");

    const retryRequestStart = serverRequests.length;
    const retrySocket = protocol.nextSocketOrdinal + 1;
    protocol.rootRestore = { minSocketOrdinal: retrySocket, threadId, holdMode: "forward" };
    await retryByRole.click();
    const successfulRetryRequest = await waitFor(() => {
      const matches = serverRequests.slice(retryRequestStart).filter(request => !request.failed && request.responseStatus === 200);
      return matches[0] ?? null;
    }, 30_000, "real retry click followed by one HTTP 200 /api/servers response");
    const retryRequests = serverRequests.slice(retryRequestStart);
    assert.equal(retryRequests.length, 1, "the user retry must issue exactly one /api/servers request");
    assert.equal(retryRequests[0].method, "GET", "the user retry must use GET /api/servers");
    assert.equal(retryRequests[0].responseStatus, 200, "the user retry request must succeed with HTTP 200");
    await waitFor(() => protocol.rootRestore?.response?.forwardedAt !== null && protocol.rootRestore?.response?.forwardedAt !== undefined,
      30_000, "real Rust thread/resume after the cache retry");
    const recoveredRestore = protocol.rootRestore.response;
    assert.equal(recoveredRestore.fixtureTransformed, false, "retry recovery must use the unchanged real Rust authority page");
    await page.getByTestId("session-cache-view").waitFor({ state: "detached", timeout: 30_000 });
    const recoveredPromptRow = page.getByTestId("message-user").filter({ hasText: promptMarker });
    await recoveredPromptRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await recoveredPromptRow.count(), 1, "the real retry authority page must restore the original prompt once");
    assert.equal(await page.getByTestId("message-user").filter({ hasText: replacementMarker }).count(), 0,
      "the real retry authority page must replace the test-shortened cached page");
    await waitFor(() => page.getByTestId("message-input").isEditable(), 30_000,
      "editable composer after the real retry authority page arrives");
    recoveredCacheReadiness = await waitForReadOnlyTranscriptCache(page, {
      threadId,
      gatewayOrigin: new URL(gateway.baseUrl).origin,
      marker: promptMarker,
      expectedMessageId: recoveredRestore.markerMessageId,
      expectedAnchorMessageId: offlineCacheReadiness.anchor?.messageId ?? null,
      requireReadingAnchor: Boolean(offlineCacheReadiness.anchor && !offlineCacheReadiness.anchor.followsLatest),
      minimumManifestRevision: offlineCacheReadiness.manifestRevision + 1,
    }, 30_000);
    assert.ok(recoveredCacheReadiness.ready, "the successful retry must replace the shortened cache with the complete Rust page");
    assertCachedAuthorityIdentitySnapshot(recoveredCacheReadiness, recoveredRestore.messageIds, "retry full authority cache");
    viewportEvidence.retryAuthority = await readTranscriptViewport(page, {
      markerText: tailMarker,
      rowTestId: "message-assistant",
    });
    assert.equal(viewportEvidence.retryAuthority.markerIntersectsWindow, true,
      "the full Rust transcript tail marker must be in the viewport after retry recovery");
    assert.equal(viewportEvidence.retryAuthority.markerIntersectsList, true,
      "the full Rust transcript tail marker must intersect the message-list viewport after retry recovery");

    assert.equal(browserErrors.length, 0, `Browser page errors: ${browserErrors.join(" | ")}`);
    assert.equal(protocol.errors.length, 0, `test WebSocket bridge errors: ${protocol.errors.join(" | ")}`);
    assert.ok(successfulRetryRequest && successfulRetryRequest.responseStatus === 200,
      "the real retry must recover through an HTTP 200 /api/servers response");
    const completedRetryRequests = serverRequests.slice(retryRequestStart);
    assert.equal(completedRetryRequests.length, 1, "functional recovery must finish with exactly one retry-phase /api/servers request");
    assert.equal(completedRetryRequests[0].method, "GET", "functional recovery retry-phase request must use GET");
    assert.equal(completedRetryRequests[0].responseStatus, 200, "functional recovery retry-phase request must remain HTTP 200");
    assert.equal(protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length,
      1, "cache restoration and retry must not start another user/model turn");

    const rustAppServer = await verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore);
    const evidence = {
      caseId: "transcript-cache-root-restore",
      status: "PASS",
      boundary: "real Mobile Web + owned Gateway + Rust app-server; one unchanged full Rust resume response proves anchor restoration, a later resume response is shortened only by this test WebSocket bridge, and one controlled /api/servers failure leaves the static shell available; no cross-client mutation or full-offline claim",
      mobileWeb: {
        sourceRoot: mobileWeb.sourceRoot ?? null,
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        ...sourceIdentityEvidence(sourceIdentity),
        assistantRowConstruction,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        exportRoot: "RunContext-owned Mobile Web export",
      },
      rustAppServer,
      gateway: { baseOrigin: new URL(gateway.baseUrl).origin, authTokenRedacted: true },
      browser: {
        ...await browserIdentityEvidence(chromium, context),
        viewport: { width: 390, height: 844 },
        platform: "Web only; not native or a physical phone",
      },
      threadId,
      completedTurnCount: protocol.turnCompletions.filter(event => event.threadId === threadId && event.status === "completed").length,
      firstRootRestore: {
        path: taskPath,
        socketOrdinal: firstRestore.socketOrdinal,
        requestId: firstRestore.requestId,
        fixtureTransformed: false,
        messageIds: firstRestore.messageIds,
        messageCount: firstRestore.messageIds.length,
      },
      cacheReadiness: {
        afterCompletedTurn: seededCacheReadiness,
        afterTrustedWheelAnchor: savedAnchorReadiness,
        afterFullAuthorityRestore: firstRestoreCacheReadiness,
        afterShorterAuthorityRestore: shortenedCacheReadiness,
        whileControlledApiFailure: offlineCacheReadiness,
        afterRealRetryAuthorityRestore: recoveredCacheReadiness,
      },
      anchorRestore: {
        heldServerRequests: firstServerHold.pending,
        cacheVisibleWhileServersHeld: true,
        composerReadOnlyWhileServersHeld: true,
        cacheVisibleWhileResumeHeld: true,
        composerReadOnlyWhileResumeHeld: true,
        socketOrdinal: firstRestore.socketOrdinal,
        requestId: firstRestore.requestId,
        unchangedRustResponse: true,
        anchor: savedAnchorReadiness.anchor,
        viewport: {
          afterTrustedWheel: viewportEvidence.liveAfterTrustedWheel,
          whileServersHeld: viewportEvidence.cacheWhileServersHeld,
          whileResumeHeld: viewportEvidence.cacheWhileResumeHeld,
          afterFullAuthority: viewportEvidence.fullAuthorityAfterCache,
        },
      },
      shorterRootRestore: {
        heldServerRequests: shortServerHold.pending,
        cacheVisibleWhileServersHeld: true,
        composerReadOnlyWhileServersHeld: true,
        cacheVisibleWhileResumeHeld: true,
        composerReadOnlyWhileResumeHeld: true,
        socketOrdinal: heldRestore.socketOrdinal,
        requestId: heldRestore.requestId,
        fixtureTransformed: true,
        removedMarker: promptMarker,
        replacementMarker,
        messageCountBefore: firstRestore.messageIds.length,
        messageCountAfter: heldRestore.messageIds.length,
        responseMessageIds: heldRestore.messageIds,
        viewport: viewportEvidence.shorterAuthority,
      },
      apiFailureAndRetry: {
        staticShellStatus: shellResponse.status(),
        controlledFailedServerRequests: offlineRequests.filter(request => request.failed).length,
        controlledFailure: {
          path: safePath(controlledApiFailure.url),
          requestFailedCount: controlledApiFailure.requestFailedCount,
          requestFailureText: controlledApiFailure.requestFailureText,
          matchingConsoleErrorCount: controlledApiFailure.consoleErrorCount,
        },
        cachedViewReadOnly: true,
        retryButtonCount: 1,
        retryClicked: true,
        successfulServerRequestsAfterRetry: serverRequests.slice(retryRequestStart).filter(request => !request.failed).length,
        successfulServerHttpStatus: successfulRetryRequest.responseStatus,
        retryResumeSocketOrdinal: recoveredRestore.socketOrdinal,
        retryFixtureTransformed: recoveredRestore.fixtureTransformed,
        shortenedMarkerRemoved: true,
        viewport: {
          cachedFailureView: viewportEvidence.apiFailureCachedView,
          recoveredAuthority: viewportEvidence.retryAuthority,
        },
      },
      clientMessageIdHashPolicy: "per-run HMAC-SHA-256; plaintext IDs and hash key are not persisted",
      rpcRequests: projectProtocolRpcRequests(protocol.requests),
      activeTaskSocketOrdinal: protocol.activeTaskSocketOrdinal,
      indexedHistoryReads: protocol.indexedHistoryReads,
      resumeResponses: protocol.resumeResponses.map(response => ({
        threadId: response.threadId,
        socketOrdinal: response.socketOrdinal,
        fixtureTransformed: response.fixtureTransformed,
        forwarded: response.forwardedAt !== null,
      })),
      serverRequests: serverRequests.map(({ method, path, held, failed, responseStatus }) => ({ method, path, held, failed, responseStatus })),
      httpRequests: setupHttpEvidence(serverRequests, serverStatusRequests),
      setupDiagnostics: setupTraceEvidence(setupDiagnostics),
      transportDiagnosticsArtifact: "mobile-session-cache-transport-diagnostics.json",
      controlledApiFailure: controlledApiFailure ? {
        path: safePath(controlledApiFailure.url),
        requestFailedCount: controlledApiFailure.requestFailedCount,
        requestFailureText: controlledApiFailure.requestFailureText,
        matchingConsoleErrorCount: controlledApiFailure.consoleErrorCount,
      } : null,
      providerCalls: 0,
      browserErrors,
    };
    await context.writeArtifactJson("mobile-session-cache-recovery.json", evidence);
    return evidence;
  } catch (error) {
    const failureSetupDiagnostics = await captureSetupFailureDiagnostics({
      page,
      context,
      setupDiagnostics,
      protocol,
      serverRequests,
      serverStatusRequests,
      error,
    }).catch(diagnosticError => ({
      phase: setupDiagnostics.phase,
      diagnosticCaptureError: redactedBoundedText(context, diagnosticError?.message || String(diagnosticError), 800),
    }));
    let failureScreenshot = { saved: false, modeVerified: false };
    try { failureScreenshot = await savePrivateScreenshot(page, context, "mobile-session-cache-recovery-failure.png"); }
    catch (screenshotError) {
      failureScreenshot.error = redactedBoundedText(context, screenshotError?.message || String(screenshotError), 800);
    }
    const failureViewportGeometry = await readTranscriptViewport(page, {
      markerText: tailMarker,
      rowTestId: "message-assistant",
    }).catch(() => null);
    const failureUserPromptGeometry = await readTranscriptViewport(page, {
      markerText: promptMarker,
      rowTestId: "message-user",
    }).catch(() => null);
    releaseServerHold();
    releaseHeldAuthority(protocol);
    releaseTimingResponse(protocol.timingSample);
    await context.writeArtifactJson("mobile-session-cache-recovery-failure.json", {
      status: "FAIL",
      failureScreenshot,
      failureViewportGeometry,
      failureUserPromptGeometry,
      coldProcessFailureArtifact: error?.coldProcessFailureArtifact ?? null,
      viewportEvidence,
      visibleTestIds: await visibleTestIds(page).catch(() => []),
      setupDiagnostics: failureSetupDiagnostics,
      urlPath: safePath(page.url()),
      threadId: protocol.rootRestore?.threadId ?? null,
      timingRelaySetupArtifact: error?.timingRelaySetupArtifact ?? null,
      timingRelaySetupScreenshot: error?.timingRelaySetupScreenshot ?? null,
      clientMessageIdHashPolicy: "per-run HMAC-SHA-256; plaintext IDs and hash key are not persisted",
      rpcRequests: projectProtocolRpcRequests(protocol.requests),
      activeTaskSocketOrdinal: protocol.activeTaskSocketOrdinal,
      resumeResponses: protocol.resumeResponses.map(response => ({
        threadId: response.threadId,
        socketOrdinal: response.socketOrdinal,
        fixtureTransformed: response.fixtureTransformed,
        forwarded: response.forwardedAt !== null,
      })),
      serverRequests: serverRequests.map(({ method, path, held, failed, responseStatus }) => ({ method, path, held, failed, responseStatus })),
      controlledApiFailure: controlledApiFailure ? {
        path: safePath(controlledApiFailure.url),
        requestFailedCount: controlledApiFailure.requestFailedCount,
        requestFailureText: controlledApiFailure.requestFailureText,
        matchingConsoleErrorCount: controlledApiFailure.consoleErrorCount,
      } : null,
      bridgeErrors: protocol.errors,
      browserErrors,
      indexedHistoryReads: protocol.indexedHistoryReads,
      turnCompletions: protocol.turnCompletions.map(event => ({
        threadId: event.threadId,
        turnId: event.turnId,
        status: event.status,
        socketOrdinal: event.socketOrdinal,
        at: event.at,
      })),
      anchorAuthorityRead,
      anchorDisplayIdentity,
      timingLatestAssistantIdentity,
      liveMessageIdentityRows: await readLiveMessageIdentityRows(page).catch(() => []),
      assistantRowConstruction,
      transportDiagnosticsArtifact: "mobile-session-cache-transport-diagnostics.json",
      cacheReadiness: {
        afterCompletedTurnBeforeFirstReload: seededCacheReadiness,
        afterTrustedWheelAnchor: savedAnchorReadiness,
        afterFullAuthorityRestore: firstRestoreCacheReadiness,
        afterShorterAuthorityRestore: shortenedCacheReadiness,
        afterRealRetryAuthorityRestore: recoveredCacheReadiness,
        failedProbe: error?.cacheReadiness ?? null,
      },
      error: redactedBoundedText(context, error?.stack || error?.message || String(error), 8_000),
    });
    throw error;
  } finally {
    releaseServerHold();
    releaseHeldAuthority(protocol);
    releaseTimingResponse(protocol.timingSample);
    await page.close().catch(() => {});
    await chromium.close().catch(() => {});
    await context.writeArtifactJsonInternal("mobile-session-cache-transport-diagnostics.json", {
      closeForwarding: cacheTimingDelays
        ? "timing sample ownership uses exact RunContext Chromium process-group exit; route close callbacks are advisory and no Gateway EOF/client-count claim is made"
        : "the first endpoint close is forwarded with legal metadata; owner release requests both still-open paired endpoints; only endpoint onClose callbacks count as actual closure",
      routeCallbackCount: protocol.routeCallbackCount, routeSockets: protocol.routeDiagnostics,
      pageWebSocketCount: protocol.nextPageWebSocketOrdinal, pageWebSockets: protocol.pageWebSockets,
      routeHistory: { total: protocol.nextSocketOrdinal, retained: protocol.routeDiagnostics.length,
        truncated: protocol.nextSocketOrdinal > protocol.routeDiagnostics.length },
      pageRpcHistory: { total: protocol.nextPageRpcSocketOrdinal,
        retained: protocol.pageWebSockets.filter(socket => socket.path === "/rpc").length,
        truncated: protocol.nextPageRpcSocketOrdinal > protocol.pageWebSockets.filter(socket => socket.path === "/rpc").length },
      pageClosedAtMs: protocol.pageClosedAtMs,
      setup: setupTraceEvidence(setupDiagnostics),
      serverRequests: setupHttpEvidence(serverRequests, serverStatusRequests).servers,
      serverStatus: { requestCount: serverStatusRequestCount, responseCount: serverStatusResponseCount,
        requests: serverStatusRequests },
    }).catch(() => {});
  }
});

function createProtocolState() {
  return {
    nextSocketOrdinal: 0,
    requests: [],
    rpcResponses: [],
    targetThreadId: null,
    activeTaskSocketOrdinal: null,
    indexedHistoryReads: [],
    presenceReads: [],
    routeCallbackCount: 0,
    nextPageWebSocketOrdinal: 0,
    nextPageRpcSocketOrdinal: 0,
    routeDiagnostics: [],
    pageWebSockets: [],
    pageClosedAtMs: null,
    turnCompletions: [],
    resumeResponses: [],
    rootRestore: null,
    heldAuthority: null,
    timingSample: null,
    errors: [],
  };
}

async function prepareRelayTimingLane({ context, chromium, releaseTimingChromium, gateway, relayLane, directProtocol, threadId,
  promptMarker, replacementMarker, clientMessageIdHashKey, expectedUserAnchorMessageId, expectedAssistantMessageId,
  directScopeExpectation, browserErrors }) {
  assert.ok(relayLane?.entryValidated, "Relay lane must pass its exact mobile-entry contract before Browser use");
  assert.ok(directScopeExpectation, "paired timing requires the production-mounted direct lane scope");
  const relayPage = await chromium.newPersistentPage();
  await relayPage.setViewportSize({ width: 390, height: 844 });
  const protocol = createProtocolState();
  protocol.targetThreadId = threadId;
  const lane = normalizeRelayMobileTimingLaneV1(relayLane);
  const routeAudit = createMobileTimingLaneRouteAudit("relay-bootstrap");
  const serverInventoryResponses = observeTimingServerInventoryResponses(relayPage, lane);
  const setupDiagnostics = { startedAtMs: performance.now(), phase: "relay-pairing", locatorChecks: [] };
  const browserErrorCountBefore = browserErrors.length;
  observeMobilePageRpcSockets(relayPage, protocol, context, new URL(lane.gatewayUrl), lane.rpcPath);
  relayPage.on("pageerror", error => browserErrors.push(context.redactText(error.message)));
  relayPage.on("console", message => {
    if (message.type() === "error") browserErrors.push(context.redactText(message.text()));
  });

  try {
    await installMobileTimingLaneHttpGuard(relayPage, lane, routeAudit);
    await installResumeBridge(relayPage, protocol, promptMarker, replacementMarker, context,
      clientMessageIdHashKey, null, rawUrl => lane.assertRouteUrl(rawUrl, "rpc"));
    setupDiagnostics.phase = "relay-mobile-entry-and-connect";
    await connectMobile(relayPage, { ...gateway, baseUrl: lane.gatewayUrl }, setupDiagnostics, {
      productionMobileMount: true,
      mobileEntryUrl: lane.mobileUrl,
    });

    setupDiagnostics.phase = "relay-open-sessions";
    await relayPage.getByTestId("sessions").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await relayPage.getByTestId("sessions").count(), 1,
      "Relay pairing must expose one semantic Sessions navigation control");
    await relayPage.getByTestId("sessions").click();
    setupDiagnostics.phase = "relay-select-seeded-session";
    const seededSession = relayPage.getByTestId(`session-${threadId}`);
    await seededSession.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await seededSession.count(), 1,
      "Relay Sessions must expose exactly the existing direct-seeded thread row");
    await seededSession.click();
    setupDiagnostics.phase = "relay-wait-seeded-task";
    await relayPage.getByTestId("message-list").waitFor({ state: "visible", timeout: 30_000 });

    const mobileMountPath = lane.mobileMountPath;
    const route = await waitFor(() => {
      try {
        const candidate = productionMobileTaskRoute(relayPage.url(), mobileMountPath);
        return candidate.threadId === threadId ? candidate : null;
      } catch { return null; }
    }, 30_000, "Relay Mobile opening the exact direct-seeded task route");
    assert.equal(route.threadId, threadId, "Relay task route must identify the exact direct-seeded thread");
    assert.equal(route.routeServerId, directScopeExpectation.routeServerId,
      "Relay task route must retain the direct seed's Gateway server identity");
    assert.equal(route.routeCwd, directScopeExpectation.routeCwd,
      "Relay task route must retain the direct seed's workspace path");
    const relayScopeExpectation = await captureProductionMobileScopeExpectation({
      page: relayPage,
      gateway: { ...gateway, baseUrl: lane.gatewayUrl },
      serverInventoryResponses,
      mobileMountPath,
    });

    const relayResumeRequests = protocol.requests.filter(request =>
      request.method === "thread/resume" && request.threadId === threadId);
    const relayResumeResponses = protocol.rpcResponses.filter(response =>
      response.method === "thread/resume" && response.threadId === threadId);
    assert.equal(relayResumeRequests.length, 1,
      "Relay bootstrap must issue exactly one thread/resume for the shared seed before timing is armed");
    assert.equal(relayResumeResponses.length, 1,
      "Relay bootstrap thread/resume must have exactly one observed RPC response");
    assert.equal(relayResumeResponses[0].socketOrdinal, relayResumeRequests[0].socketOrdinal,
      "Relay bootstrap response must belong to its actual request socket");
    assert.equal(relayResumeResponses[0].success, true, "Relay bootstrap thread/resume must succeed");
    assert.equal(protocol.requests.filter(request => request.method === "turn/start").length, 0,
      "Relay bootstrap must not create or resend a turn");

    setupDiagnostics.phase = "relay-seed-reading-anchor-and-return-to-latest";
    const relayBootstrapAnchorPreparation = await prepareRelayTimingLatestAnchorV1({
      page: relayPage,
      threadId,
      gatewayOrigin: lane.origin,
      marker: promptMarker,
      expectedScope: relayScopeExpectation,
      expectedUserAnchorMessageId,
      expectedAssistantMessageId,
      tailMarker,
      readCacheReadiness: (options, timeout) => waitForReadOnlyTranscriptCache(relayPage, options, timeout),
      prepareUserAnchorViewport: targetPage => prepareUserReadingAnchorViewport({
        page: targetPage, promptMarker, readTranscriptViewport,
      }),
      readTranscriptViewport,
      armTrustedWheelObservationWithViewport,
      readTrustedWheelTargetAtPoint,
      readTrustedWheelObservation,
    });
    const serviceWorker = await assertMobileTimingLaneServiceWorker(relayPage, lane, {
      allowUncontrolledBootstrap: true,
    });
    assert.equal(routeAudit.violations.length, 0,
      "Relay bootstrap HTTP and WebSocket requests must remain inside its exact /g/<id> mount");
    assert.equal(browserErrors.length, browserErrorCountBefore,
      "Relay pairing and the existing-session bootstrap must not add Browser errors");

    lane.taskPath = safePath(relayPage.url());
    const relayBootstrapOwnershipRelease = await releaseTimingChromium("relay-bootstrap-release", {
      page: relayPage, protocol, requiredSocketOrdinal: relayResumeRequests[0].socketOrdinal });
    lane.initialPage = null;
    lane.protocol = protocol;
    lane.expectedScope = relayScopeExpectation;
    lane.threadId = threadId;
    const directSeedTurnStartCount = directProtocol.requests.filter(request =>
      request.method === "turn/start" && request.threadId === threadId).length;
    const relayBootstrapResumeCount = relayResumeRequests.length;
    return {
      lane: Object.freeze(lane),
      evidence: {
        directSeedTurnStartCount,
        relayTurnStartCount: protocol.requests.filter(request => request.method === "turn/start").length,
        relayBootstrapResumeCount,
        relayBootstrapResumeSucceeded: relayResumeResponses[0].success,
        relayBootstrapCacheReady: relayBootstrapAnchorPreparation.latestAnchor.persisted,
        relayBootstrapAnchorPreparation,
        relayBootstrapRouteViolationCount: routeAudit.violations.length,
        relayBootstrapWorkerScopeMatched: serviceWorker.scopeMatchesLane &&
          serviceWorker.workerScriptMatchesLane && serviceWorker.activeState === "activated",
        relayBootstrapControllerPresent: serviceWorker.controllerPresent,
        relayBootstrapControllerState: serviceWorker.controllerState,
        relayBootstrapOwnershipRelease,
      },
    };
  } catch (error) {
    let screenshot = { saved: false, modeVerified: false };
    if (error && typeof error === "object") {
      try {
        screenshot = await savePrivateScreenshot(relayPage, context,
          "mobile-session-cache-timing-relay-setup-failure.png");
      } catch {}
    }
    let ownershipRelease = { status: "NOT_PROVEN", browserOwnerReleased: false, processGroupGone: false };
    try {
      ownershipRelease = await releaseTimingChromium("relay-bootstrap-failure", { restart: false, page: relayPage, protocol,
        requiredSocketOrdinal: protocol.requests.find(request =>
          request.method === "thread/resume" && request.threadId === threadId)?.socketOrdinal ?? null });
    } catch (releaseError) {
      ownershipRelease = { status: "FAIL", errorName: releaseError?.name ?? "Error" };
    }
    const artifactName = "mobile-session-cache-timing-relay-setup-failure.json";
    let artifactWritten = false;
    try {
      await context.writeArtifactJson(artifactName, {
        status: "FAIL",
        phase: setupDiagnostics.phase,
        lane: typeof lane.safeSummary === "function" ? lane.safeSummary() : { lane: "relay" },
        screenshot,
        preassert: projectRelayBootstrapFailureEvidence({
          protocol,
          routeAudit,
          serverInventoryResponses,
          browserErrorCount: Math.max(0, browserErrors.length - browserErrorCountBefore),
          seedThreadId: threadId,
        }),
        ownershipRelease,
        failureClass: error?.name ?? "Error",
        failureMessageRedacted: true,
        credentialsAndThreadIdsPersisted: false,
      });
      artifactWritten = true;
    } catch {}
    if (error && typeof error === "object") {
      error.timingRelaySetupScreenshot = screenshot;
      error.timingRelaySetupArtifact = artifactWritten ? artifactName : null;
    }
    throw error;
  }
}

function observeTimingServerInventoryResponses(page, lane) {
  const observations = [];
  const apiPrefix = `${lane.gatewayPrefix}/api/`;
  page.on("response", response => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== lane.origin || response.request().method() !== "GET" && response.request().method() !== "POST") return;
    const isInventory = response.request().method() === "GET" && url.pathname === `${apiPrefix}servers`;
    const isBootstrap = response.request().method() === "POST" && url.pathname === `${apiPrefix}mobile/session`;
    if (!isInventory && !isBootstrap) return;
    const observed = {
      source: isInventory ? "Relay GET /api/servers" : "Relay POST /api/mobile/session initialServers",
      responseStatus: response.status(),
      atMs: performance.now(),
      ownedGatewayOrigin: true,
      descriptors: null,
      bodyReadComplete: false,
    };
    observations.push(observed);
    if (observations.length > 16) observations.shift();
    observed.bodyRead = response.json().then(payload => {
      const descriptors = isInventory ? payload?.servers : payload?.initialServers?.servers;
      observed.descriptors = Array.isArray(descriptors)
        ? descriptors.slice(0, 32).map(safePublicServerScopeDescriptor).filter(Boolean)
        : null;
      observed.bodyReadComplete = true;
    }).catch(() => {
      observed.bodyReadComplete = true;
      observed.descriptors = null;
    });
  });
  return observations;
}

async function installResumeBridge(page, protocol, staleMarker, replacementMarker, context, clientMessageIdHashKey,
  timingTelemetry = null, routeValidator = null, timingResponseExpectation = null, causalRequestGate = null) {
  await page.routeWebSocket("**/rpc*", socket => {
    const socketOrdinal = ++protocol.nextSocketOrdinal;
    const routeDiagnostic = {
      socketOrdinal,
      callbackAtMs: performance.now(),
      clientToServerForwardCount: 0, firstClientForwardAtMs: null, lastClientForwardAtMs: null,
      callbackToFirstClientForwardMs: null,
      serverToClientForwardCount: 0, firstServerForwardAtMs: null, lastServerForwardAtMs: null,
      upstreamMessageCount: 0,
      clientClosedAtMs: null,
      upstreamClosedAtMs: null,
      firstUpstreamFrameAtMs: null,
      callbackToFirstUpstreamFrameMs: null,
      firstClientForwardToUpstreamFrameMs: null,
      callbackToFirstServerForwardMs: null,
      firstUpstreamFrameToServerForwardMs: null,
    };
    protocol.routeCallbackCount += 1;
    protocol.routeDiagnostics.push(routeDiagnostic);
    if (protocol.routeDiagnostics.length > 8) protocol.routeDiagnostics.shift();
    if (routeValidator) {
      try { routeValidator(socket.url()); }
      catch {
        protocol.errors.push("RPC WebSocket route violated its exact Mobile lane mount");
        void socket.close({ code: 1008, reason: "route outside owned Mobile lane" }).catch(() => {});
        return;
      }
    }
    const timingSample = protocol.timingSample;
    const coldOfflineAudit = protocol.coldOfflineBridgeAudit;
    if (coldOfflineAudit?.active && socketOrdinal >= coldOfflineAudit.firstSocketOrdinal) {
      if (coldOfflineAudit.routes.length < 64) coldOfflineAudit.routes.push(routeDiagnostic);
      else coldOfflineAudit.overflowed = true;
    }
    const upstream = socket.connectToServer();
    routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(socket, upstream, {
      onClientClose: () => {
        if (routeDiagnostic.clientClosedAtMs === null) routeDiagnostic.clientClosedAtMs = performance.now();
      },
      onUpstreamClose: () => {
        if (routeDiagnostic.upstreamClosedAtMs === null) routeDiagnostic.upstreamClosedAtMs = performance.now();
      },
    });
    const calls = new Map();
    const telemetrySequencesByRequestId = timingTelemetry ? new Map() : null;
    socket.onMessage(raw => {
      if (timingSample) {
        timingSample.websocketClientFrameCount += 1;
        timingSample.websocketClientFrameBytes += byteLength(raw);
      }
      const frame = parseFrame(raw);
      let request = null;
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const clientMessageIdEvidence = frame.method === "turn/start"
          ? projectClientMessageIdEvidence(frame.params?.clientMessageId, clientMessageIdHashKey)
          : {};
        const clientPromptMarkerPresent = frame.method === "turn/start"
          ? turnStartIncludesPromptMarker(frame.params, staleMarker)
          : false;
        request = {
          id: String(frame.id),
          method: frame.method,
          threadId: frame.params?.threadId ?? null,
          socketOrdinal,
          at: performance.now(),
          ...clientMessageIdEvidence,
          ...(frame.method === "turn/start" ? { clientPromptMarkerPresent } : {}),
        };
        calls.set(request.id, request);
        if (timingTelemetry) {
          const sequence = recordCacheTimingRpcRequest(timingTelemetry, {
            routeClass: "rpc",
            method: request.method,
            nodeAtMs: request.at,
            payloadBytes: byteLength(raw),
          });
          telemetrySequencesByRequestId.set(request.id, sequence);
        }
        protocol.requests.push(request);
        if (timingSample) {
          timingSample.rpcRequestFrameCount += 1;
          timingSample.rpcRequestFrameBytes += byteLength(raw);
          incrementCount(timingSample.rpcRequestCountsByMethod, request.method);
          if (request.method === "thread/resume" && request.threadId === timingSample.threadId &&
            socketOrdinal >= timingSample.minSocketOrdinal) {
            timingSample.matchingResumeRequestCount += 1;
            if (!timingSample.request) timingSample.request = request;
          }
        }
        const rootRestore = protocol.rootRestore;
        if (rootRestore && request.method === "thread/resume" && request.threadId === rootRestore.threadId &&
          socketOrdinal >= rootRestore.minSocketOrdinal && !rootRestore.request) {
          rootRestore.request = request;
        }
      }
      const forward = () => {
        routeDiagnostic.clientToServerForwardCount += 1;
        const forwardAtMs = performance.now();
        if (routeDiagnostic.firstClientForwardAtMs === null) {
          routeDiagnostic.firstClientForwardAtMs = forwardAtMs;
          routeDiagnostic.callbackToFirstClientForwardMs = Math.max(0, forwardAtMs - routeDiagnostic.callbackAtMs);
        }
        routeDiagnostic.lastClientForwardAtMs = forwardAtMs;
        upstream.send(raw);
      };
      if (causalRequestGate?.capture({ raw, frame, request, socketOrdinal, forward })) return;
      forward();
    });
    upstream.onMessage(raw => {
      const upstreamMessageAtNodeMs = performance.now();
      routeDiagnostic.upstreamMessageCount += 1;
      if (routeDiagnostic.firstUpstreamFrameAtMs === null) {
        routeDiagnostic.firstUpstreamFrameAtMs = performance.now();
        routeDiagnostic.callbackToFirstUpstreamFrameMs = Math.max(0,
          routeDiagnostic.firstUpstreamFrameAtMs - routeDiagnostic.callbackAtMs);
        if (routeDiagnostic.firstClientForwardAtMs !== null) {
          routeDiagnostic.firstClientForwardToUpstreamFrameMs = Math.max(0,
            routeDiagnostic.firstUpstreamFrameAtMs - routeDiagnostic.firstClientForwardAtMs);
        }
      }
      if (timingSample) {
        timingSample.websocketServerFrameCount += 1;
        timingSample.websocketServerFrameBytes += byteLength(raw);
      }
      const frame = parseFrame(raw);
      if (frame?.method === "turn/completed") {
        protocol.turnCompletions.push({
          threadId: frame.params?.threadId ?? frame.params?.turn?.threadId ?? null,
          turnId: frame.params?.turnId ?? frame.params?.turn?.id ?? null,
          status: frame.params?.turn?.status ?? null,
          socketOrdinal,
          at: performance.now(),
        });
      }
      if (frame && frame.id !== undefined) {
        const responseId = String(frame.id);
        const request = calls.get(responseId);
        if (request && typeof frame.method !== "string") {
          protocol.rpcResponses.push({
            requestId: responseId,
            method: request.method,
            threadId: request.threadId,
            socketOrdinal,
            success: !frame.error,
            errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
            atNodeMs: upstreamMessageAtNodeMs,
          });
          if (protocol.rpcResponses.length > 128) protocol.rpcResponses.shift();
        }
        if (timingTelemetry && typeof frame.method !== "string") {
          if (telemetrySequencesByRequestId.has(responseId)) {
            const sequence = telemetrySequencesByRequestId.get(responseId);
            if (sequence !== null) {
              recordCacheTimingRpcResponse(timingTelemetry, {
                sequence,
                nodeAtMs: upstreamMessageAtNodeMs,
                outcome: frame.error ? "error" : "success",
                payloadBytes: byteLength(raw),
              });
            }
          } else {
            // An allocated positive sequence with no pending row makes the helper count this orphan response.
            recordCacheTimingRpcResponse(timingTelemetry, {
              sequence: unpairedRpcTelemetrySequence,
              nodeAtMs: upstreamMessageAtNodeMs,
              outcome: frame.error ? "error" : "success",
              payloadBytes: byteLength(raw),
            });
          }
        }
        if (request?.method === "thread/read/indexed" && typeof request.threadId === "string" &&
          request.socketOrdinal === socketOrdinal) {
          const responseThreadId = typeof frame.result?.thread?.id === "string" ? frame.result.thread.id : null;
          if (responseThreadId === null || responseThreadId === request.threadId) {
            const messages = Array.isArray(frame.result?.messages) ? frame.result.messages : [];
            protocol.indexedHistoryReads.push({
              requestId: request.id,
              threadId: request.threadId,
              responseThreadId,
              requestSocketOrdinal: request.socketOrdinal,
              responseSocketOrdinal: socketOrdinal,
              requestedAtMs: request.at,
              receivedAtMs: performance.now(),
              success: !frame.error,
              errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
              messageCount: messages.length,
              messageIdentities: projectMessageIdentityTuples(messages, clientMessageIdHashKey),
            });
            if (protocol.indexedHistoryReads.length > 8) protocol.indexedHistoryReads.shift();
          }
        }
        if (request?.method === "thread/presence/read" && typeof request.threadId === "string" &&
          request.socketOrdinal === socketOrdinal) {
          const result = frame.result;
          const statuses = new Set(["present", "absent", "unknown"]);
          const reasons = new Set([
            "residentRuntime", "boundDeletedPrimarySource", "coldSourceNotAuthorized", "missingHistoryParent",
            "missingControlDirectory", "missingControlRecord", "missingSourceForLiveRecord", "legacyDeletionWithoutBinding",
            "boundDeletionMissingSourceWithoutLock", "boundDeletionResidualSameIdentity", "compatibilityRootPresent",
            "residentIdentityMismatch", "primarySourceUnavailable", "busy", "unsupported", "observationFailed",
          ]);
          protocol.presenceReads.push({
            requestId: request.id,
            echoId: String(frame.id),
            threadId: typeof result?.threadId === "string" ? result.threadId : null,
            status: statuses.has(result?.status) ? result.status : null,
            reason: reasons.has(result?.reason) ? result.reason : null,
            requestSocketOrdinal: request.socketOrdinal,
            responseSocketOrdinal: socketOrdinal,
            receivedAtMs: performance.now(),
            errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
          });
          if (protocol.presenceReads.length > 8) protocol.presenceReads.shift();
        }
        if (timingSample && request) {
          timingSample.rpcResponseFrameCount += 1;
          timingSample.rpcResponseFrameBytes += byteLength(raw);
          incrementNestedCount(timingSample.rpcResponseCountsByMethodOutcome, request.method, frame.error ? "error" : "success");
        }
        if (timingSample?.request?.id === String(frame.id) && request?.method === "thread/resume" &&
          request.threadId === timingSample.threadId && request.socketOrdinal === socketOrdinal &&
          timingSample.request.socketOrdinal === socketOrdinal && !timingSample.response) {
          const response = {
            success: !frame.error,
            receivedAtNodeMs: upstreamMessageAtNodeMs,
            forwardedAtNodeMs: null,
            appliedHoldRawMs: null,
            appliedHoldMs: null,
            resumePageEvidence: timingResponseExpectation
              ? projectResumeAssistantPageEvidence(frame, timingResponseExpectation)
              : null,
          };
          timingSample.response = response;
          if (!frame.error) {
            timingSample.held = { socket, raw, response, timer: null, routeDiagnostic };
            if (timingSample.requestedHoldMs === 0) {
              forwardTimingResponse(timingSample);
              return;
            }
            timingSample.held.timer = setTimeout(() => forwardTimingResponse(timingSample), timingSample.requestedHoldMs + 2);
            return;
          }
          forwardRouteToClient(socket, routeDiagnostic, raw);
          response.forwardedAtNodeMs = performance.now();
          response.appliedHoldRawMs = response.forwardedAtNodeMs - response.receivedAtNodeMs;
          response.appliedHoldMs = roundTiming(response.appliedHoldRawMs);
          return;
        }
        const rootRestore = protocol.rootRestore;
        if (request?.method === "thread/resume" && rootRestore?.request?.id === request.id &&
          request.socketOrdinal === rootRestore.request.socketOrdinal) {
          const response = {
            threadId: request.threadId,
            requestId: request.id,
            socketOrdinal,
            success: !frame.error,
            errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
            receivedAt: performance.now(),
            forwardedAt: null,
            fixtureTransformed: false,
            messageIds: [],
          };
          let outgoing = frame;
          const holdMode = rootRestore.holdMode ?? "forward";
          if (holdMode === "short") {
            try {
              outgoing = replaceResumePage(frame, staleMarker, replacementMarker);
              response.fixtureTransformed = outgoing !== frame;
            } catch (error) {
              protocol.errors.push(context.redactText(`authority response transform failed: ${error?.message ?? String(error)}`));
            }
          }
          const responseMessages = outgoing.result?.history?.page?.messages ?? [];
          response.messageIds = responseMessages.map(message => message.id);
          response.markerMessageId = responseMessages.find(message => message.role === "user" &&
            typeof message.content === "string" && message.content.includes(staleMarker))?.id ?? null;
          response.replacementMessageId = responseMessages.find(message => message.role === "user" &&
            typeof message.content === "string" && message.content.includes(replacementMarker))?.id ?? null;
          if (holdMode === "full" || holdMode === "short") {
            const held = { socket, raw: response.fixtureTransformed ? JSON.stringify(outgoing) : raw, response, routeDiagnostic };
            protocol.heldAuthority = held;
            rootRestore.heldResponse = response;
            rootRestore.response = response;
            protocol.resumeResponses.push(response);
            return;
          }
          protocol.resumeResponses.push(response);
          rootRestore.response = response;
          forwardRouteToClient(socket, routeDiagnostic, raw);
          response.forwardedAt = performance.now();
          return;
        }
      }
      forwardRouteToClient(socket, routeDiagnostic, raw);
      causalRequestGate?.observeResponse({ raw, frame, request: calls.get(String(frame?.id)), socketOrdinal });
    });
  });
}

function replaceResumePage(frame, staleMarker, replacementMarker) {
  assert.ok(frame?.result && !frame.error, "authoritative thread/resume must succeed before the test transform");
  const page = frame.result.history?.page;
  assert.ok(Array.isArray(page?.messages), "authoritative thread/resume must contain an inline history page");
  const staleUserIndex = page.messages.findIndex(message => message.role === "user" && String(message.content).includes(staleMarker));
  assert.ok(staleUserIndex >= 0, "authority response does not contain the cached user marker");
  const staleUser = page.messages[staleUserIndex];
  const staleAssistantIndex = page.messages.findIndex((message, index) => index !== staleUserIndex && message.role === "assistant" &&
    (staleUser.turnId ? message.turnId === staleUser.turnId : index > staleUserIndex));
  assert.ok(staleAssistantIndex >= 0, "authority response does not contain the completed assistant row for the cached turn");
  const removed = new Set([staleUserIndex, staleAssistantIndex]);
  const messages = page.messages.filter((_message, index) => !removed.has(index));
  const timestampMs = Math.max(...page.messages.map(message => Number(message.timestampMs) || 0), 0) + 1;
  messages.push({ id: `cache-authority-${randomBytes(8).toString("hex")}`, role: "user", content: replacementMarker, timestampMs });
  const transformed = structuredClone(frame);
  const transformedPage = transformed.result.history.page;
  transformedPage.messages = messages;
  transformedPage.rangeStart = 0;
  transformedPage.rangeEnd = messages.length;
  transformedPage.hasMoreBefore = false;
  delete transformedPage.beforeCursor;
  return transformed;
}

function releaseHeldAuthority(protocol) {
  const held = protocol.heldAuthority;
  if (!held) return false;
  protocol.heldAuthority = null;
  forwardRouteToClient(held.socket, held.routeDiagnostic, held.raw);
  held.response.forwardedAt = performance.now();
  return true;
}

function forwardRouteToClient(socket, routeDiagnostic, raw) {
  const atMs = performance.now();
  routeDiagnostic.serverToClientForwardCount += 1;
  if (routeDiagnostic.firstServerForwardAtMs === null) {
    routeDiagnostic.firstServerForwardAtMs = atMs;
    routeDiagnostic.callbackToFirstServerForwardMs = Math.max(0, atMs - routeDiagnostic.callbackAtMs);
    if (routeDiagnostic.firstUpstreamFrameAtMs !== null) {
      routeDiagnostic.firstUpstreamFrameToServerForwardMs = Math.max(0,
        atMs - routeDiagnostic.firstUpstreamFrameAtMs);
    }
  }
  routeDiagnostic.lastServerForwardAtMs = atMs;
  socket.send(raw);
}

function latestScopedAuthorityRead(protocol, threadId, socketOrdinal) {
  return protocol.indexedHistoryReads.filter(read => read.success && read.threadId === threadId &&
    read.requestSocketOrdinal === socketOrdinal && read.responseSocketOrdinal === socketOrdinal).at(-1) ?? null;
}

async function inspectAssistantRowConstruction(mobileRoot) {
  const sourcePath = "src/runtime/task-runtime/snapshotReducer.ts";
  const bytes = await readFile(resolve(mobileRoot, sourcePath));
  const producer = bytes.toString("utf8").match(/export function ensureAssistantMessage\([\s\S]*?\n\}\n/);
  assert.ok(producer, "selected Mobile source must contain ensureAssistantMessage implementation");
  assert.ok(producer[0].includes("id: `assistant-${attemptId || turnId}`"),
    "selected Mobile producer must retain the synthetic local assistant row construction ID");
  return {
    sourcePath,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    producer: "ensureAssistantMessage",
    identityStage: "local row construction before authoritative history reconciliation",
    syntheticIdRule: "for a non-empty attemptId the initial local row ID is assistant-${attemptId}; authoritative history may replace it with canonical message.id",
    finalLiveRowIdentity: "independently checked against the latest canonical indexed-history message ID",
  };
}

async function waitForReadOnlyTranscriptCache(page, {
  threadId,
  gatewayOrigin,
  marker,
  expectedScope = null,
  expectedMessageId = null,
  expectedAnchorMessageId = null,
  expectedAnchorOffset = null,
  expectedAnchorOffsetTolerance = 4,
  expectedAnchorFollowsLatest = null,
  requireReadingAnchor = false,
  minimumMessageCount = 2,
  minimumManifestRevision = null,
}, timeoutMs) {
  let latestSnapshot = null;
  try {
    return await waitFor(async () => {
      const snapshot = await page.evaluate(async ({ threadId, gatewayOrigin, marker, expectedScope, expectedMessageId,
        expectedAnchorMessageId, requireReadingAnchor, minimumMessageCount, minimumManifestRevision }) => {
        const databaseName = "kcoder-confirmed-transcripts-v1";
        if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
          return { ready: false, reason: "database-inventory-unavailable" };
        }
        let inventoryTimer;
        const databases = await Promise.race([
          indexedDB.databases(),
          new Promise((_, reject) => { inventoryTimer = setTimeout(() => reject(new Error("read-only cache inventory timed out")), 1_500); }),
        ]).finally(() => clearTimeout(inventoryTimer));
        if (!databases.some(database => database.name === databaseName)) return { ready: false, reason: "database-not-created" };
        const db = await new Promise((resolve, reject) => {
          let settled = false;
          const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(openTimer);
            callback(value);
          };
          const openTimer = setTimeout(() => settle(reject, new Error("read-only cache open timed out")), 1_500);
          const request = indexedDB.open(databaseName);
          request.onupgradeneeded = () => request.transaction?.abort();
          request.onsuccess = () => {
            if (settled) {
              request.result.close();
              return;
            }
            settle(resolve, request.result);
          };
          request.onerror = () => settle(reject, new Error("read-only cache open failed"));
          request.onblocked = () => settle(reject, new Error("read-only cache open blocked"));
        });
        let manifest;
        let storedEntry;
        try {
          await new Promise((resolve, reject) => {
            let settled = false;
            let transaction;
            const settle = (callback, value) => {
              if (settled) return;
              settled = true;
              clearTimeout(transactionTimer);
              callback(value);
            };
            const transactionTimer = setTimeout(() => {
              settle(reject, new Error("read-only cache transaction timed out"));
              try { transaction?.abort(); } catch {}
            }, 1_500);
            try { transaction = db.transaction(["manifest", "entries"], "readonly"); }
            catch (error) { settle(reject, error); return; }
            const request = transaction.objectStore("manifest").get("current");
            request.onsuccess = () => {
              if (settled) return;
              const rawManifest = request.result;
              if (typeof rawManifest !== "string" || rawManifest.length > 64 * 1024 || new Blob([rawManifest]).size > 64 * 1024) return;
              try { manifest = JSON.parse(rawManifest); }
              catch { return; }
              if (!manifest || manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
                !Array.isArray(manifest.entries) || manifest.entries.length > 16 || !/^[a-f0-9]{64}$/.test(manifest.lastKey ?? "")) return;
              const row = manifest.entries.find(entry => entry?.key === manifest.lastKey);
              if (!row || !/^[a-f0-9]{64}$/.test(row.key) || !/^[a-f0-9]{64}$/.test(row.profileKey) ||
                typeof row.profileId !== "string" || !row.profileId || !Number.isSafeInteger(row.slot) || row.slot < 0 || row.slot >= 32 ||
                !Number.isSafeInteger(row.dataRevision) || row.dataRevision < 0 || row.dataRevision > manifest.revision ||
                !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 512 * 1024) return;
              const entryRequest = transaction.objectStore("entries").get(row.slot);
              entryRequest.onsuccess = () => {
                if (!settled) storedEntry = { row, value: entryRequest.result };
              };
            };
            transaction.oncomplete = () => settle(resolve);
            transaction.onabort = () => settle(reject, new Error("read-only cache transaction aborted"));
            transaction.onerror = () => {};
          });
        } finally {
          db.close();
        }
        const record = storedEntry?.value;
        if (!record || record.revision !== storedEntry.row.dataRevision || !(record.blob instanceof Blob) ||
          record.blob.size > 512 * 1024 || record.blob.size !== storedEntry.row.bytes) {
          return { ready: false, reason: "last-route-entry-missing", manifestRevision: Number.isSafeInteger(manifest?.revision) ? manifest.revision : null };
        }
        let transcript;
        let blobReadTimer;
        try {
          const rawTranscript = await Promise.race([
            record.blob.text(),
            new Promise((_, reject) => { blobReadTimer = setTimeout(() => reject(new Error("read-only cache blob read timed out")), 1_500); }),
          ]).finally(() => clearTimeout(blobReadTimer));
          transcript = JSON.parse(rawTranscript);
        }
        catch { return { ready: false, reason: "last-route-entry-invalid", manifestRevision: manifest.revision }; }
        const scopeMatches = transcript?.scope?.threadId === threadId &&
          typeof transcript?.scope?.profile?.baseUrl === "string" &&
          new URL(transcript.scope.profile.baseUrl).origin === gatewayOrigin;
        let scopeEvidence = null;
        if (expectedScope) {
          let publicProfile = null;
          let activeProfileId = null;
          let profileIndexPresent = false;
          let profileIndexParseable = false;
          let profileCount = null;
          let expectedProfileCount = null;
          try {
            const rawIndex = localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2");
            profileIndexPresent = rawIndex !== null;
            const index = rawIndex ? JSON.parse(rawIndex) : null;
            if (index && Array.isArray(index.profiles)) {
              profileIndexParseable = true;
              profileCount = index.profiles.length;
              activeProfileId = typeof index.activeId === "string" ? index.activeId : null;
              const matches = index.profiles.filter(profile => profile?.id === expectedScope.routeProfileId);
              expectedProfileCount = matches.length;
              if (matches.length === 1) publicProfile = matches[0];
            }
          } catch {}
          const cachedScope = transcript?.scope;
          const cachedProfile = cachedScope?.profile;
          const cachedTarget = cachedScope?.target;
          const descriptor = expectedScope.serverDescriptor;
          const profileGeneration = typeof publicProfile?.authorizationGeneration === "string"
            ? publicProfile.authorizationGeneration : `legacy:${expectedScope.routeProfileId}`;
          const cachedGeneration = typeof cachedProfile?.authorizationGeneration === "string"
            ? cachedProfile.authorizationGeneration : `legacy:${cachedProfile?.id}`;
          const expectedAuthMode = typeof publicProfile?.authMode === "string" ? publicProfile.authMode : "legacy";
          const cachedAuthMode = typeof cachedProfile?.authMode === "string" ? cachedProfile.authMode : "legacy";
          const fields = {
            scopeVersion: cachedScope?.version === 1,
            routeThreadId: cachedScope?.threadId === expectedScope.threadId,
            routeProfileId: cachedProfile?.id === expectedScope.routeProfileId &&
              publicProfile?.id === expectedScope.routeProfileId && activeProfileId === expectedScope.routeProfileId,
            exactGatewayBaseUrl: cachedProfile?.baseUrl === expectedScope.gatewayBaseUrl &&
              publicProfile?.baseUrl === expectedScope.gatewayBaseUrl,
            authorizationMode: cachedAuthMode === expectedAuthMode,
            authorizationGeneration: cachedGeneration === profileGeneration,
            deviceId: (cachedProfile?.deviceId ?? null) === (publicProfile?.deviceId ?? null),
            routeServerId: cachedTarget?.id === expectedScope.routeServerId && descriptor?.id === expectedScope.routeServerId,
            runtime: descriptor?.runtime === "kcoder",
            transport: cachedTarget?.transport === descriptor?.transport,
            principalId: (cachedTarget?.principalId ?? null) === (descriptor?.principalId ?? null),
            role: (cachedTarget?.role ?? null) === (descriptor?.role ?? null),
            workspacePath: (cachedTarget?.workspacePath ?? null) === (descriptor?.workspacePath ?? null),
            routeCwd: cachedScope?.cwd === expectedScope.routeCwd,
          };
          const connectionFingerprintShapeValid = /^[a-f0-9]{64}$/.test(cachedTarget?.connectionFingerprint ?? "");
          scopeEvidence = {
            status: Object.values(fields).every(Boolean) && connectionFingerprintShapeValid
              ? "MATCHED_ON_OBSERVED_FIELDS_FINGERPRINT_UNVERIFIED" : "MISMATCH",
            descriptorSource: expectedScope.descriptorSource,
            descriptorResponseStatus: expectedScope.descriptorResponseStatus,
            fields,
            profileStorage: {
              indexPresent: profileIndexPresent,
              indexParseable: profileIndexParseable,
              profileCount,
              expectedProfileCount,
              activeProfileMatchesExpected: activeProfileId === expectedScope.routeProfileId,
              publicProfilePresent: publicProfile !== null,
              cachedProfilePresent: Boolean(cachedProfile),
              cachedProfileIdMatchesExpected: cachedProfile?.id === expectedScope.routeProfileId,
              cachedBaseUrlMatchesExpected: cachedProfile?.baseUrl === expectedScope.gatewayBaseUrl,
            },
            connectionFingerprintShapeValid,
            connectionFingerprintVerified: false,
          };
        }
        const expectedScopeMatches = !expectedScope || (scopeEvidence?.status === "MATCHED_ON_OBSERVED_FIELDS_FINGERPRINT_UNVERIFIED");
        const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
        const messageIdentities = messages.slice(0, 200).map(message => ({
          id: typeof message?.id === "string" && message.id.length <= 4096 ? message.id : null,
          role: typeof message?.role === "string" && message.role.length <= 32 ? message.role : null,
          turnId: typeof message?.turnId === "string" && message.turnId.length <= 4096 ? message.turnId : null,
          attemptId: typeof message?.attemptId === "string" && message.attemptId.length <= 4096 ? message.attemptId : null,
        }));
        const markerPresent = messages.some(message => typeof message?.content === "string" && message.content.includes(marker));
        const expectedMessagePresent = expectedMessageId === null || messages.some(message => message?.id === expectedMessageId);
        const rawAnchor = transcript?.anchor;
        const anchor = rawAnchor && typeof rawAnchor.messageId === "string" && rawAnchor.messageId.length > 0 &&
          Number.isFinite(rawAnchor.offset) && typeof rawAnchor.followsLatest === "boolean"
          ? { messageId: rawAnchor.messageId, offset: rawAnchor.offset, followsLatest: rawAnchor.followsLatest }
          : null;
        const expectedAnchorPresent = expectedAnchorMessageId === null || anchor?.messageId === expectedAnchorMessageId;
        const readingAnchorReady = !requireReadingAnchor || Boolean(anchor && !anchor.followsLatest);
        const revisionReady = minimumManifestRevision === null || manifest.revision >= minimumManifestRevision;
        const messageCountReady = messages.length >= minimumMessageCount;
        const ready = scopeMatches && expectedScopeMatches && markerPresent && expectedMessagePresent && expectedAnchorPresent && readingAnchorReady && revisionReady &&
          messageCountReady && manifest.lastKey === storedEntry.row.key;
        return {
          ready,
          reason: ready ? null : !scopeMatches || !expectedScopeMatches ? "last-route-scope-mismatch" :
            !markerPresent ? "confirmed-marker-missing" : !expectedMessagePresent ? "expected-authority-row-missing" :
              !expectedAnchorPresent ? "expected-reading-anchor-missing" : !readingAnchorReady ? "detached-reading-anchor-missing" :
                !revisionReady ? "manifest-revision-not-advanced" : !messageCountReady ? "message-count-below-minimum" : "last-route-entry-incomplete",
          manifestRevision: Number.isSafeInteger(manifest.revision) ? manifest.revision : null,
          minimumManifestRevision,
          minimumMessageCount,
          entryRevision: storedEntry.row.dataRevision,
          entrySlot: storedEntry.row.slot,
          entryKey: storedEntry.row.key,
          entryBytes: Number.isSafeInteger(storedEntry.row.bytes) ? storedEntry.row.bytes : null,
          cachedProjectedMessageCount: messages.length,
          messageIdentities,
          scopeMatches,
          expectedScopeMatches,
          expectedMessagePresent,
          expectedAnchorPresent,
          markerPresent,
          scopeEvidence,
          anchorPresent: Boolean(anchor),
          anchor,
        };
      }, { threadId, gatewayOrigin, marker, expectedScope, expectedMessageId, expectedAnchorMessageId, requireReadingAnchor, minimumMessageCount, minimumManifestRevision });
      const readiness = assessPersistedAnchorReadiness(snapshot, expectedAnchorOffset,
        expectedAnchorOffsetTolerance, expectedAnchorFollowsLatest);
      latestSnapshot = readiness;
      return readiness.ready ? readiness : null;
    }, timeoutMs, "read-only thread-and-Gateway-origin transcript cache and last-route commit");
  } catch (error) {
    error.cacheReadiness = latestSnapshot;
    throw error;
  }
}

function forwardTimingResponse(sample, force = false) {
  const held = sample.held;
  if (!held) return false;
  const elapsedMs = performance.now() - held.response.receivedAtNodeMs;
  const remainingMs = sample.requestedHoldMs - elapsedMs;
  if (!force && remainingMs > 0) {
    clearTimeout(held.timer);
    held.timer = setTimeout(() => forwardTimingResponse(sample), Math.ceil(remainingMs) + 1);
    return false;
  }
  sample.held = null;
  clearTimeout(held.timer);
  try {
    forwardRouteToClient(held.socket, held.routeDiagnostic, held.raw);
    held.response.forwardedAtNodeMs = performance.now();
    held.response.appliedHoldRawMs = held.response.forwardedAtNodeMs - held.response.receivedAtNodeMs;
    held.response.appliedHoldMs = roundTiming(held.response.appliedHoldRawMs);
    return true;
  } catch {
    held.response.forwardedAtNodeMs = null;
    held.response.appliedHoldRawMs = null;
    held.response.appliedHoldMs = null;
    held.response.forwardError = true;
    return false;
  }
}

function releaseTimingResponse(sample) {
  return sample ? forwardTimingResponse(sample, true) : false;
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function incrementNestedCount(counts, key, outcome) {
  counts[key] ??= { success: 0, error: 0 };
  counts[key][outcome] += 1;
}

async function browserIdentityEvidence(chromium, context, processLabel = "session-cache-chromium") {
  const ownedProcess = context.processes.get(processLabel);
  return {
    version: await chromium.browser.version(),
    pid: Number.isSafeInteger(chromium.child?.pid) ? chromium.child.pid : null,
    pgid: Number.isSafeInteger(ownedProcess?.pgid) ? ownedProcess.pgid : null,
    executablePath: chromium.executablePath,
  };
}

function sourceIdentityEvidence(sourceIdentity) {
  const snapshotProof = sourceIdentity.snapshotProof ?? null;
  return {
    sourceIdentity: {
      sourceRoots: sourceIdentity.sourceRoots,
      sourceTreeSha256: sourceIdentity.sourceTreeSha256,
      snapshotProof,
    },
    sourceEvidenceClass: snapshotProof
      ? "pinned-immutable-P1-Mobile-source-snapshot"
      : "caller-selected-current-Mobile-source-tree",
  };
}

function interleavedCacheTimingDelays() {
  const levels = [0, 300, 600, 1000];
  return Array.from({ length: 5 }, (_, repeat) => levels.map((_value, index) => levels[(index + repeat) % levels.length])).flat();
}

function roundTiming(value) {
  return Math.round(value * 100) / 100;
}

function byteLength(value) {
  return typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(String(value));
}

async function verifyOwnedRustAppServer(gateway, rustBinary, configuredRustBefore) {
  const ownedRustChildren = await findOwnedExecutableProcesses({
    pgid: gateway.child.pid,
    executablePath: configuredRustBefore.path,
  });
  const ownedChildObserved = ownedRustChildren.some(child => child.sha256 === configuredRustBefore.sha256);
  assert.ok(ownedChildObserved,
    "owned Gateway process tree must include the configured Rust app-server binary");
  const configuredRustAfter = await hashExecutableFile(rustBinary);
  assert.equal(configuredRustAfter.sha256, configuredRustBefore.sha256,
    "configured Rust app-server binary changed during the Browser case");
  return {
    path: configuredRustBefore.path,
    sha256: configuredRustBefore.sha256,
    unchangedAfter: configuredRustAfter.sha256 === configuredRustBefore.sha256,
    ownedChildObserved,
  };
}

async function recordUniqueSetupLocator(page, setupDiagnostics, name, locator) {
  const count = await locator.count();
  const atMs = performance.now();
  const snapshot = {
    name,
    count,
    visible: count === 1 ? await locator.isVisible().catch(() => null) : null,
    enabled: count === 1 ? await locator.isEnabled().catch(() => null) : null,
    disabledAttribute: count === 1 ? await locator.getAttribute("disabled").catch(() => null) : null,
    ariaDisabled: count === 1 ? await locator.getAttribute("aria-disabled").catch(() => null) : null,
    atMs,
  };
  setupDiagnostics.locatorChecks.push(snapshot);
  if (setupDiagnostics.locatorChecks.length > 32) setupDiagnostics.locatorChecks.shift();
  // Record transient absence and let the existing fill/click retain its normal auto-wait.
  assert.ok(count <= 1, `setup locator ${name} must resolve to at most one element`);
  return locator;
}

function setupTraceEvidence(setupDiagnostics) {
  return {
    phase: setupDiagnostics.phase,
    elapsedMs: Math.max(0, performance.now() - setupDiagnostics.startedAtMs),
    locatorChecks: setupDiagnostics.locatorChecks,
  };
}

function setupHttpEvidence(serverRequests, serverStatusRequests) {
  const summarize = requests => requests.map(request => ({
    method: request.method,
    path: request.path,
    startedAtMs: request.startedAtMs ?? request.at ?? null,
    durationMs: request.durationMs ?? null,
    responseStatus: request.responseStatus ?? null,
    failed: request.failed === true || (request.failureCode !== null && request.failureCode !== undefined),
    failureCode: request.failureCode ?? null,
    ...(request.held ? { held: true } : {}),
  }));
  return {
    servers: summarize(serverRequests),
    serverStatusRequests: summarize(serverStatusRequests),
    serverStatusEndpointRole: "Gateway status/health-probe endpoint",
    boundary: "allowlisted endpoint path, method, HTTP status, monotonic timing and classified network failure only; URL query, headers and bodies are excluded",
  };
}

async function captureSetupFailureDiagnostics({
  page,
  context,
  setupDiagnostics,
  protocol,
  serverRequests,
  serverStatusRequests,
  error,
}) {
  const readiness = await Promise.all(setupReadinessTestIds.map(async testId => {
    const locator = page.getByTestId(testId);
    const count = await locator.count().catch(() => null);
    const visible = count === 1 ? await locator.isVisible().catch(() => null) : null;
    const row = {
      testId,
      count,
      visible,
      enabled: count === 1 ? await locator.isEnabled().catch(() => null) : null,
      disabledAttribute: count === 1 ? await locator.getAttribute("disabled").catch(() => null) : null,
      ariaDisabled: count === 1 ? await locator.getAttribute("aria-disabled").catch(() => null) : null,
    };
    if (visible && setupErrorTestIds.has(testId)) {
      const rawText = await locator.evaluate(node => node.textContent ?? "").catch(() => "");
      row.errorText = redactedBoundedText(context, rawText, 600);
    }
    return row;
  }));
  return {
    phase: setupDiagnostics.phase,
    elapsedMs: Math.max(0, performance.now() - setupDiagnostics.startedAtMs),
    failure: {
      name: redactedBoundedText(context, error?.name || "Error", 120),
      message: redactedBoundedText(context, error?.message || String(error), 1_200),
    },
    locatorChecks: setupDiagnostics.locatorChecks,
    visibleTestIds: await visibleTestIds(page).catch(() => []),
    readiness,
    httpRequests: setupHttpEvidence(serverRequests, serverStatusRequests),
    websocket: {
      routeCallbackCount: protocol.routeCallbackCount,
      routeSockets: protocol.routeDiagnostics,
      browserSockets: protocol.pageWebSockets,
      timingBoundary: "route callback and frame-forward timestamps are Node-observed; first upstream frame is not a WebSocket handshake/open timestamp; frame payloads are excluded",
    },
  };
}

function redactedBoundedText(context, value, maximumLength) {
  if (value === null || value === undefined) return null;
  const withoutUrlQuery = String(value).replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi, "$1?[query-redacted]");
  const redacted = context.redactText(withoutUrlQuery);
  return redacted.length <= maximumLength ? redacted : `${redacted.slice(0, maximumLength)}...[truncated]`;
}

function safeNetworkFailureCode(value) {
  return typeof value === "string" && /^net::ERR_[A-Z_]+$/.test(value)
    ? value : "[unclassified-or-redacted]";
}

async function validateProductionMobileMountInputs(env) {
  const archivePath = requiredPinnedAbsolutePath(env, "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE");
  const archiveSha256 = requiredPinnedSha256(env, "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256");
  const sourceRoot = requiredPinnedAbsolutePath(env, "KCODER_E2E_MOBILE_SOURCE_ROOT");
  const sourceManifestPath = requiredPinnedAbsolutePath(env, "KCODER_E2E_MOBILE_SOURCE_MANIFEST");
  const sourceManifestSha256 = requiredPinnedSha256(env, "KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256");
  const archiveBytes = await readPinnedRegularFile(archivePath, archiveSha256, 48 * 1024 * 1024,
    "production Mobile Web archive");
  const sourceManifestBytes = await readPinnedRegularFile(sourceManifestPath, sourceManifestSha256, 2 * 1024 * 1024,
    "production Mobile source snapshot manifest");
  const sourceRootInfo = await lstat(sourceRoot);
  assert.ok(sourceRootInfo.isDirectory() && !sourceRootInfo.isSymbolicLink(),
    "production Mobile source root must be a regular directory");
  assert.equal(await realpath(sourceRoot), sourceRoot, "production Mobile source root must not traverse a symlink");
  const sourceManifest = parsePinnedJson(sourceManifestBytes, "production Mobile source snapshot manifest");
  assert.equal(sourceManifest?.kind, "owned-readonly-p1-mobile-and-shared-input",
    "production Mobile source manifest has an unsupported kind");
  assert.equal(resolve(sourceManifest.mobileRoot ?? ""), sourceRoot,
    "production Mobile source manifest does not identify the selected source root");

  const archive = parsePinnedJson(archiveBytes, "production Mobile Web archive");
  assert.equal(archive?.schemaVersion, 1, "production Mobile Web archive schema is unsupported");
  assert.equal(archive?.kind, "kcoder-mobile-web-export-data-archive",
    "production Mobile Web input must be a verified data-only archive");
  const archivedManifest = archive.originalManifest;
  assert.ok(typeof archivedManifest?.base64 === "string" && archivedManifest.base64.length <= 6 * 1024 * 1024,
    "production Mobile Web archive is missing its bounded original export manifest");
  const originalManifestBytes = Buffer.from(archivedManifest.base64, "base64");
  assert.equal(originalManifestBytes.toString("base64"), archivedManifest.base64,
    "production Mobile Web original export manifest encoding is invalid");
  assert.ok(originalManifestBytes.length <= 4 * 1024 * 1024,
    "production Mobile Web original export manifest exceeds its 4 MiB bound");
  assert.equal(createHash("sha256").update(originalManifestBytes).digest("hex"), archivedManifest.sha256,
    "production Mobile Web original export manifest differs from its embedded SHA-256");
  assert.equal(archive.origin?.exportManifestSha256, archivedManifest.sha256,
    "production Mobile Web archive manifest provenance is inconsistent");
  const originalManifest = parsePinnedJson(originalManifestBytes, "production Mobile Web original export manifest");
  assert.equal(originalManifest?.status, "complete", "production Mobile Web archive was not produced by a complete export");
  assert.equal(originalManifest?.deployMount, true,
    "--production-mobile-mount requires an archive whose original export manifest records deployMount:true");
  return {
    archivePath,
    archiveSha256,
    sourceRoot,
    sourceManifestPath,
    sourceManifestSha256,
    originalManifestSha256: archivedManifest.sha256,
  };
}

function requiredPinnedAbsolutePath(env, name) {
  const value = env[name];
  assert.ok(typeof value === "string" && isAbsolute(value), `${name} must be an explicit absolute path for --production-mobile-mount`);
  const normalized = resolve(value);
  assert.equal(normalized, value, `${name} must be a normalized absolute path for --production-mobile-mount`);
  return normalized;
}

function requiredPinnedSha256(env, name) {
  const value = env[name];
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    `${name} must be an explicit lowercase SHA-256 pin for --production-mobile-mount`);
  return value;
}

async function readPinnedRegularFile(path, expectedSha256, maximumBytes, label) {
  assert.equal(await realpath(path), path, `${label} must not traverse a symlink`);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
    `${label} must be one regular file without a shared hard link`);
  assert.ok(info.size <= maximumBytes, `${label} exceeds its ${maximumBytes}-byte bound`);
  const bytes = await readFile(path);
  assert.equal(bytes.length, info.size, `${label} changed while being read`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256,
    `${label} differs from its caller-provided SHA-256 pin`);
  return bytes;
}

function parsePinnedJson(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} is not valid UTF-8 JSON`); }
}

function safePublicServerScopeDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bounded = item => typeof item === "string" && item.length > 0 && item.length <= 4096 ? item : null;
  const nullable = item => item === undefined || item === null ? null : bounded(item);
  const account = value.accountIdentity;
  if (account !== undefined && account !== null && (typeof account !== "object" || Array.isArray(account))) return null;
  const descriptor = {
    id: bounded(value.id),
    runtime: bounded(value.runtime),
    transport: bounded(value.transport),
    workspacePath: nullable(value.workspacePath),
    principalId: nullable(account?.principalId),
    role: nullable(account?.role),
  };
  if (!descriptor.id || descriptor.runtime !== "kcoder" || !["local", "ssh"].includes(descriptor.transport) ||
      (value.workspacePath != null && !descriptor.workspacePath) ||
      (account?.principalId != null && !descriptor.principalId) || (account?.role != null && !descriptor.role)) return null;
  return descriptor;
}

function productionMobileTaskRoute(pageUrl, mobileMountPath) {
  const url = new URL(pageUrl);
  const unmountedPath = url.pathname.startsWith(`${mobileMountPath}/`)
    ? url.pathname.slice(mobileMountPath.length) : url.pathname;
  const segments = unmountedPath.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  assert.equal(segments[0], "h", "production Mobile cache route must be a task page under /h");
  assert.equal(segments[2], "task", "production Mobile cache route must contain the task segment");
  assert.ok(segments[1] && segments[3] && segments[4], "production Mobile cache route identity is incomplete");
  const cwd = url.searchParams.get("cwd");
  assert.ok(typeof cwd === "string" && cwd.length > 0 && cwd.length <= 4096,
    "production Mobile task route must preserve its bounded cwd query parameter");
  return {
    routeProfileId: segments[1],
    routeServerId: segments[3],
    threadId: segments[4],
    routeCwd: cwd,
  };
}

async function captureProductionMobileScopeExpectation({ page, gateway, serverInventoryResponses, mobileMountPath }) {
  const route = productionMobileTaskRoute(page.url(), mobileMountPath);
  const inventory = await waitFor(async () => {
    const latest = [...serverInventoryResponses].reverse().find(item =>
      item.responseStatus === 200 && item.bodyReadComplete && Array.isArray(item.descriptors) &&
      item.descriptors.some(descriptor => descriptor.id === route.routeServerId));
    return latest ?? null;
  }, 15_000, "already-observed Gateway server descriptor response for Mobile target scope", 50);
  const matches = inventory.descriptors.filter(descriptor => descriptor.id === route.routeServerId);
  assert.equal(matches.length, 1,
    "the already-observed Gateway server descriptor response must contain exactly one descriptor for the task route server");
  return {
    ...route,
    gatewayBaseUrl: gateway.baseUrl,
    descriptorSource: inventory.source,
    descriptorResponseStatus: inventory.responseStatus,
    serverDescriptor: matches[0],
  };
}

async function connectMobile(page, gateway, setupDiagnostics, { productionMobileMount = false, mobileEntryUrl = gateway.baseUrl } = {}) {
  if (productionMobileMount) {
    setupDiagnostics.phase = "production-mobile-mounted-entry";
    await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded" });
  } else {
    setupDiagnostics.phase = "gateway-login-page";
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    const tokenInput = await recordUniqueSetupLocator(
      page, setupDiagnostics, "gateway-token-input", page.locator('input[name="token"]'));
    await tokenInput.fill(gateway.authToken);
    const submitButton = await recordUniqueSetupLocator(
      page, setupDiagnostics, "gateway-login-submit", page.locator('button[type="submit"]'));
    setupDiagnostics.phase = "gateway-login-submit";
    await Promise.all([
      page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
      submitButton.click(),
    ]);
  }
  const directConnection = await recordUniqueSetupLocator(
    page, setupDiagnostics, "welcome-direct-connection", page.getByTestId("welcome-direct-connection"));
  setupDiagnostics.phase = "welcome-direct-connection";
  await directConnection.click();
  const gatewayToken = await recordUniqueSetupLocator(
    page, setupDiagnostics, "gateway-token", page.getByTestId("gateway-token"));
  setupDiagnostics.phase = "fill-gateway-token";
  await gatewayToken.fill(gateway.authToken);
  const gatewayConnect = await recordUniqueSetupLocator(
    page, setupDiagnostics, "gateway-connect", page.getByTestId("gateway-connect"));
  setupDiagnostics.phase = "gateway-connect-click";
  await gatewayConnect.click();
  const newWorkspace = page.getByTestId("new-workspace");
  setupDiagnostics.phase = "wait-new-workspace-visible";
  await newWorkspace.waitFor({ state: "visible", timeout: 30_000 });
  await recordUniqueSetupLocator(page, setupDiagnostics, "new-workspace", newWorkspace);
}

async function createTask(page, prompt, promptMarker, setupDiagnostics) {
  const newWorkspace = await recordUniqueSetupLocator(
    page, setupDiagnostics, "new-workspace", page.getByTestId("new-workspace"));
  setupDiagnostics.phase = "open-new-workspace";
  await newWorkspace.click();
  const promptInput = await openAdvancedNewTaskForm(page, setupDiagnostics, recordUniqueSetupLocator);
  setupDiagnostics.phase = "fill-new-workspace-prompt";
  await promptInput.fill(prompt);
  const createButton = await recordUniqueSetupLocator(
    page, setupDiagnostics, "create-workspace", page.getByTestId("create-workspace"));
  setupDiagnostics.phase = "create-workspace-click";
  await createButton.click();
  setupDiagnostics.phase = "wait-created-task-message";
  await page.getByTestId("message-user").filter({ hasText: promptMarker }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
}

function assertOffsetNear(actual, expected, label, tolerance = 4) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: both offsets must be finite`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: actual ${actual} differs from expected ${expected} by more than ${tolerance}px`);
}

async function messageRowIds(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!list) return [];
    const testIds = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
    const rows = [...new Set(testIds.map(element => element.closest('[id^="message-"]') ?? element))];
    return rows.map(row => {
      if (!row.id.startsWith('message-')) return null;
      const encoded = row.id.slice('message-'.length);
      try { return decodeURIComponent(encoded); } catch { return encoded; }
    });
  });
}

function parseFrame(raw) {
  try { return JSON.parse(String(raw)); } catch { return null; }
}

async function readLiveMessageIdentityRows(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!list) return [];
    const bubbles = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
    const rows = [...new Set(bubbles.map(bubble => bubble.closest('[id^="message-"]') ?? bubble))];
    return rows.slice(0, 200).map(row => {
      const bubble = row.querySelector('[data-testid="message-user"], [data-testid="message-assistant"]');
      const encoded = row.id.startsWith('message-') ? row.id.slice('message-'.length) : null;
      let id = encoded;
      if (encoded !== null) {
        try { id = decodeURIComponent(encoded); } catch {}
      }
      return {
        id,
        role: bubble?.getAttribute('data-testid') === 'message-user' ? 'user' :
          bubble?.getAttribute('data-testid') === 'message-assistant' ? 'assistant' : null,
      };
    });
  });
}

function safePath(url) {
  try { return new URL(url).pathname; } catch { return "[unavailable]"; }
}

async function savePrivateScreenshot(page, context, filename) {
  const path = context.pathInArtifacts(filename);
  await page.screenshot({ path });
  await chmod(path, 0o600);
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, "diagnostic screenshot must be private to its owner");
  return { saved: true, modeVerified: true, modeOctal: mode.toString(8).padStart(3, "0") };
}

async function visibleTestIds(page) {
  return page.locator("[data-testid]").evaluateAll(nodes => nodes.filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).map(node => node.getAttribute("data-testid")).filter(Boolean).slice(0, 80));
}
