import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertCachedSessionComposerReadOnly } from "../../harness/mobile-session-cache-readonly.mjs";
import { restorePinnedGatewayMobileDeployment } from "../../harness/mobile-pinned-gateway-deployment.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from "../../harness/rpc.mjs";
import { requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import {
  createPageRpcBridgeConnection,
  parseRpcFrame,
  registerPageRpcWebSocketRoute,
} from "./mobile-session-cache-multirealm-helpers.mjs";
import {
  COMPATIBILITY_ROOT_UNKNOWN_REASON,
  matchesExactCompatibilityRootUnknown,
  shouldWithholdExactCompatibilityRootUnknown,
} from "./mobile-session-cache-unknown-offline-v1-helpers.mjs";

const MOBILE_MOUNT = "/mobile";
const TARGET_PROMPT = `CACHE_UNKNOWN_OFFLINE_V1_${randomBytes(8).toString("hex")}`;
const RUST_BINARY = requiredAbsolutePath("KCODER_E2E_KCODER_BIN");
const EXPECTED_RUST_SHA256 = requiredSha256("KCODER_E2E_KCODER_BIN_SHA256");
const BROWSER_RPC_TIMEOUT_MS = 2_000;
const PRESENCE_PHASE_TIMEOUT_MS = 2_500;
const pendingBootstrapCaptures = [];

await runE2E(import.meta.url, {
  testId: "mobile-session-cache-unknown-offline-v1",
  tier: "full-integration",
  modelPolicy: "model-independent caller-pinned production Mobile archive, run-owned Gateway and procfs-verified Rust app-server; one real local full-turn fixture; no external Provider, paid call, personal profile, or model behavior claim",
  coverage: {
    included: [
      "real Rust compatibilityRootPresent unknown after exact UI-created thread deletion",
      "real Mobile thread/resume -32022 triggers negotiated product thread/presence/read",
      "one precisely scoped E2E response-loss injection leaves cache and task route intact",
    ],
    excluded: ["permission revocation", "stale 401 refresh", "same-origin profile aliases", "cold-process or real-device acceptance"],
  },
}, async context => {
  const diagnostics = {
    phase: "suite-start",
    gateway: null,
    rust: null,
    bootstrap: { requestCount: 0, statuses: [], rpcTokenCaptured: false },
    pages: [],
    bridges: [],
    failure: null,
  };
  try {
    diagnostics.phase = "restore-caller-pinned-mobile-archive";
    const deployment = await restorePinnedGatewayMobileDeployment(context, {
      outputName: "mobile-session-cache-unknown-offline-v1-deployment",
    });

    diagnostics.phase = "verify-caller-pinned-rust-binary";
    const rustStat = await lstat(RUST_BINARY);
    assert.ok(rustStat.isFile() && (rustStat.mode & 0o111) !== 0,
      "caller-pinned KCoder app-server must be an executable regular file");
    await requireExecutable(RUST_BINARY, "caller-pinned KCoder app-server");
    const configuredRustBefore = await hashExecutableFile(RUST_BINARY);
    assert.equal(configuredRustBefore.sha256, EXPECTED_RUST_SHA256,
      "caller-pinned KCoder app-server bytes must match KCODER_E2E_KCODER_BIN_SHA256");

    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("private-config");
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(configDir, { recursive: true, mode: 0o700 }),
    ]);
    await chmod(configDir, 0o700);

    diagnostics.phase = "start-run-owned-loopback-gateway";
    const gateway = await startGateway(context, {
      auth: false,
      label: "mobile-session-cache-unknown-offline-v1-gateway",
      workspace,
      kcoderBin: RUST_BINARY,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_MOBILE_WEB_ROOT: deployment.deployment.path,
      },
    });
    diagnostics.gateway = { loopback: gateway.host === "127.0.0.1", authDisabled: gateway.authToken === "" };
    assert.equal(gateway.authToken, "", "the run-owned Gateway must expose only the auth-disabled Mobile bootstrap path");
    const mobileEntryUrl = new URL(`${MOBILE_MOUNT}/`, gateway.baseUrl).href;
    const mobileResponse = await fetch(mobileEntryUrl, { headers: { accept: "text/html" } });
    assert.equal(mobileResponse.status, 200, "the caller-pinned Mobile archive must be served on this owned Gateway's /mobile mount");
    await mobileResponse.body?.cancel();

    const chromium = await startChromium(context, {
      label: "mobile-session-cache-unknown-offline-v1-chromium",
      profileName: "mobile-session-cache-unknown-offline-v1",
      startTimeoutMs: 60_000,
    });
    const browserContexts = chromium.browser.contexts();
    assert.equal(browserContexts.length, 1, "the harness must own one private persistent Chromium context");
    const persistentContext = browserContexts[0];
    const pageA = await chromium.newPersistentPage();
    const pageADiagnostics = observePage(pageA, "A");
    diagnostics.pages.push(pageADiagnostics);
    await pageA.setViewportSize({ width: 390, height: 844 });
    const bootstrap = { rpcToken: null, rpcTokenCaptureFailed: false };
    pageA.on("request", request => {
      const url = safeUrl(request.url());
      if (request.method() === "POST" && url?.pathname === "/api/mobile/session") {
        diagnostics.bootstrap.requestCount++;
      }
    });
    pageA.on("response", response => {
      const url = safeUrl(response.url());
      if (response.request().method() !== "POST" || url?.pathname !== "/api/mobile/session") return;
      diagnostics.bootstrap.statuses.push(response.status());
      if (response.status() !== 200) return;
      const capture = response.json().then(payload => {
        const rpcToken = payload?.rpcToken;
        if (typeof rpcToken !== "string" || rpcToken.length === 0) {
          bootstrap.rpcTokenCaptureFailed = true;
          return;
        }
        context.registerSecret(rpcToken);
        bootstrap.rpcToken = rpcToken;
        diagnostics.bootstrap.rpcTokenCaptured = true;
      }).catch(() => { bootstrap.rpcTokenCaptureFailed = true; });
      pendingBootstrapCaptures.push(capture);
    });

    diagnostics.phase = "install-page-a-rpc-observer-before-first-navigation";
    const bridgeA = await installMobileRpcObserver(pageA, TARGET_PROMPT);
    diagnostics.bridges.push({ label: "A", state: bridgeA.state });
    await pageA.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await connectFreshMobileProfile(pageA, gateway);
    await waitFor(() => diagnostics.bootstrap.statuses.includes(200) ? true : null,
      15_000, "Mobile's successful POST /api/mobile/session bootstrap");
    assert.equal(diagnostics.bootstrap.requestCount, 1, "Mobile must make one device-session bootstrap request");
    assert.deepEqual(diagnostics.bootstrap.statuses, [200], "Mobile's owned bootstrap must complete with HTTP 200");
    await waitFor(() => {
      if (bootstrap.rpcTokenCaptureFailed) assert.fail("the Mobile bootstrap response lacked a Gateway-issued rpcToken");
      return bootstrap.rpcToken ? true : null;
    }, 5_000, "the actual rpcToken returned by Mobile's successful bootstrap");
    await Promise.all(pendingBootstrapCaptures);

    const profileId = profileIdFromRoute(pageA.url());
    await openNewTaskFromHome(pageA, profileId, mobileEntryUrl, workspace);
    const threadId = await createFullTurn(pageA, TARGET_PROMPT, bridgeA.state);
    const targetRoute = taskRoute(pageA.url());
    assert.equal(targetRoute.threadId, threadId, "the Mobile task route must match Rust's canonical thread/start receipt");
    assert.equal(targetRoute.cwd, workspace, "the real task must bind the run-owned workspace");
    assert.equal(targetRoute.serverId, "local", "the task must use the run-owned local Rust app-server");
    const targetTaskUrl = pageA.url();
    const cacheBefore = await waitFor(async () => {
      const snapshot = await readCacheIndex(pageA, { threadId, marker: TARGET_PROMPT });
      return snapshot.target?.markerMessageIds.length === 1 && snapshot.target.key === snapshot.manifest.lastKey
        ? snapshot : null;
    }, 30_000, "the real completed Mobile turn to commit its exact IndexedDB transcript and lastKey");
    assert.equal(cacheBefore.target.cwd, workspace, "the persisted cache scope must match the exact run workspace");
    assert.equal(cacheBefore.target.invalidated, false, "the seeded cache row must not already carry a target tombstone");
    assert.equal(bridgeA.state.turnCompletions.filter(row => row.threadId === threadId && row.status === "completed").length, 1,
      "the seed must be a real completed Rust turn, not a mocked transcript");

    diagnostics.phase = "verify-owned-rust-process-before-delete";
    const rustAtSeed = await verifyOwnedRustAppServer(gateway, RUST_BINARY, EXPECTED_RUST_SHA256);
    diagnostics.rust = rustAtSeed;
    assert.equal(bridgeA.state.requests.filter(request => request.method === "thread/presence/read").length, 0,
      "normal task creation must not issue a presence probe");

    diagnostics.phase = "close-page-a-mobile-transport-preserving-profile-data";
    await pageA.goto("about:blank", { waitUntil: "domcontentloaded" });
    await waitFor(() => bridgeA.state.links.length > 0 && bridgeA.state.links.every(link =>
      link.connection.state.clientClosed && link.connection.state.serverClosed) ? true : null,
    15_000, "A's Mobile page and Gateway WebSocket route to close before independent real deletion");
    assert.equal(pageA.isClosed(), false, "A remains a live suite-owned page after transport close");

    diagnostics.phase = "node-real-delete-and-compatibility-root-unknown";
    const nodeRpcUrl = new URL(gatewayRpcUrl(gateway, targetRoute.serverId, bootstrap.rpcToken));
    nodeRpcUrl.searchParams.set("workspace", targetRoute.cwd);
    assert.ok(nodeRpcUrl.searchParams.get("token"), "Node must use the actual Mobile-issued RPC token");
    const nodeObserver = await openRpc(nodeRpcUrl.href, {
      headers: { Origin: gateway.baseUrl },
      timeoutMs: 15_000,
    });
    context.addCleanup("close unknown-offline Node RPC observer", () =>
      closeRpcAndWait(nodeObserver, "unknown-offline Node RPC observer"));
    try {
      const initialized = await nodeObserver.request("initialize", {
        protocolVersion: "2026-07-27",
        clientInfo: { name: "mobile-session-cache-unknown-offline-v1", version: "1" },
        capabilities: { experimental: { threadPresenceReadV1: true } },
      }, 15_000);
      assert.equal(initialized?.capabilities?.experimental?.threadPresenceReadV1, true,
        "the independent Node observer must negotiate the real presence capability");
      const resumed = await nodeObserver.request("thread/resume", { threadId }, 30_000);
      assert.equal(resumed?.thread?.id, threadId, "the pre-delete observer must resume the exact Mobile-created thread");
      const deletion = await nodeObserver.request("thread/delete", { threadId }, 30_000);
      assert.equal(deletion?.threadId, threadId, "the real Rust delete receipt must identify the target thread");
      assert.equal(deletion?.deleted, true, "the real Rust delete must remove the exact target thread");

      const canonicalWorkspace = await realpath(workspace);
      const legacyKey = canonicalWorkspace.replace(/[\/\\: ]/g, "_");
      assert.ok(legacyKey.length > 0 && legacyKey.length <= 255,
        "the owned workspace must map to a filesystem-supported legacy compatibility key");
      const compatibilityRoot = resolve(configDir, "projects", legacyKey);
      await mkdir(compatibilityRoot, { recursive: true, mode: 0o700 });
      await chmod(compatibilityRoot, 0o700);
      const compatibilityStat = await lstat(compatibilityRoot);
      assert.ok(compatibilityStat.isDirectory() && !compatibilityStat.isSymbolicLink(),
        "the compatibility candidate must be a real directory inside this run's private config");
      assert.equal(compatibilityStat.mode & 0o077, 0,
        "the synthetic compatibility root must remain private to this run's user");

      const rustPresence = await nodeObserver.request("thread/presence/read", { threadId }, 15_000);
      assert.deepEqual(rustPresence, {
        status: "unknown",
        threadId,
        reason: COMPATIBILITY_ROOT_UNKNOWN_REASON,
      }, "the current Rust app-server must return typed unknown for its exact real deleted thread and secure compatibility root");
      diagnostics.nodeUnknown = {
        capabilityNegotiated: true,
        resumedExactThread: true,
        deleteAcknowledged: true,
        deleted: deletion.deleted,
        presence: { status: rustPresence.status, reason: rustPresence.reason, threadIdMatches: rustPresence.threadId === threadId },
        compatibilityRootCreatedByThisRun: true,
      };
    } finally {
      await closeRpcAndWait(nodeObserver, "unknown-offline Node RPC observer");
    }

    const rustAfterDelete = await verifyOwnedRustAppServer(gateway, RUST_BINARY, EXPECTED_RUST_SHA256);
    assert.deepEqual(rustAfterDelete, rustAtSeed,
      "the same procfs-owned caller-pinned Rust executable must serve the entire gate");

    diagnostics.phase = "open-page-b-from-shared-profile-and-observe-real-unknown";
    const pageB = await chromium.newPersistentPage();
    const pageBDiagnostics = observePage(pageB, "B");
    diagnostics.pages.push(pageBDiagnostics);
    await pageB.setViewportSize({ width: 390, height: 844 });
    const bridgeB = await installMobileRpcObserver(pageB, TARGET_PROMPT);
    diagnostics.bridges.push({ label: "B", state: bridgeB.state });
    await pageB.goto(targetTaskUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.equal(pageA.isClosed(), false, "the cache-writing Page A must remain live in the owned Chromium profile");
    assert.equal(pageB.isClosed(), false, "the recovery Page B must remain live in the same owned profile");
    assert.equal(pageA.context(), persistentContext, "Page A must retain the owned persistent browser context");
    assert.equal(pageB.context(), persistentContext, "Page B must share Page A's exact persistent browser context");
    assert.notEqual(pageA, pageB, "the recovery must use a separate Browser page and JavaScript realm");
    assert.equal(new URL(pageB.url()).origin, new URL(targetTaskUrl).origin,
      "Page B must recover the cache from the exact origin where Page A wrote it");

    await waitFor(() => bridgeB.state.resumeFailures.find(row => row.threadId === threadId && row.errorCode === -32022) ?? null,
      30_000, "Page B's real Mobile thread/resume failure for the exact deleted target");
    const productUnknown = await waitFor(() => bridgeB.state.presenceResponses.find(row =>
      row.threadId === threadId && row.status === "unknown" &&
      row.reason === COMPATIBILITY_ROOT_UNKNOWN_REASON && row.deliveredToPage) ?? null,
    15_000, "the actual Rust compatibilityRootPresent response to reach Page B's product Runtime");
    const firstResumeFailure = bridgeB.state.resumeFailures.find(row => row.threadId === threadId && row.errorCode === -32022);
    assert.equal(productUnknown.responseMatchesRequest, true,
      "the actual Rust unknown result must echo the exact Browser presence request ID");
    assert.equal(productUnknown.exactCompatibilityRootUnknown, true,
      "the Browser must receive the exact typed Rust compatibilityRootPresent result");
    assert.equal(productUnknown.threadIdMatchesRoute, true,
      "the actual Rust unknown result must belong to Page B's exact task route");
    assert.ok(firstResumeFailure && productUnknown.requestOrdinal > firstResumeFailure.requestOrdinal,
      "the real presence request must follow Page B's qualifying resume -32022 on the same bridge");
    assert.equal(bridgeB.state.initializedPresenceCapability, true,
      "Page B's own Mobile initialize response must negotiate threadPresenceReadV1");
    const rustAtBrowserProbe = await verifyOwnedRustAppServer(gateway, RUST_BINARY, EXPECTED_RUST_SHA256);
    assert.deepEqual(rustAtBrowserProbe, rustAtSeed,
      "the Page B response must still come through the procfs-pinned run-owned Rust process");

    const uiAfterUnknown = await assertCachedRouteAndUi(
      pageB, targetRoute, TARGET_PROMPT, cacheBefore.target.markerMessageIds[0]);
    const cacheAfterUnknown = await readCacheIndex(pageB, { threadId, marker: TARGET_PROMPT });
    assertCachePreserved(cacheBefore, cacheAfterUnknown, "real Rust unknown response");
    const targetTurnStartsAfterUnknown = bridgeB.state.turnStarts.length;
    assert.equal(targetTurnStartsAfterUnknown, 0,
      "the typed unknown recovery path must not automatically resend the cached prompt");

    diagnostics.phase = "inject-one-exact-presence-response-loss";
    const requestCountBeforeTimeout = bridgeB.state.requests.length;
    const responseCountBeforeTimeout = bridgeB.state.presenceResponses.length;
    bridgeB.armOneCompatibilityUnknownResponseLoss(threadId);
    await pageB.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    const secondResumeFailure = await waitFor(() => {
      const failures = bridgeB.state.resumeFailures.filter(row => row.threadId === threadId && row.errorCode === -32022);
      return failures.length >= 2 ? failures[1] : null;
    }, 30_000, "Page B's second real resume failure after reloading the same cached task route");
    const withheld = await waitFor(() => bridgeB.state.presenceResponses.find(row => row.withheldByInjectedFault) ?? null,
      15_000, "the bridge to withhold exactly one actual Rust compatibilityRootPresent response");
    assert.equal(bridgeB.fault.consumed, true, "the explicitly armed response-loss injection must be consumed once");
    assert.equal(withheld.threadIdMatchesRoute, true, "the withheld actual response must belong to the exact target thread");
    assert.equal(withheld.responseMatchesRequest, true, "the withheld actual response must match the exact product request ID");
    assert.equal(withheld.exactCompatibilityRootUnknown, true,
      "the withheld frame must itself be the exact typed Rust compatibilityRootPresent result");
    assert.ok(withheld.requestOrdinal > requestCountBeforeTimeout,
      "the injected response must correspond to a presence request made after the second real resume failure");
    assert.ok(withheld.requestOrdinal > secondResumeFailure.requestOrdinal,
      "the injected presence request must follow the exact second resume failure on the same Mobile bridge");
    assert.ok(withheld.atMs >= 0, "the response-loss injection must record its monotonic start time");
    await waitFor(() => performance.now() - withheld.atMs >= PRESENCE_PHASE_TIMEOUT_MS + 500 ? true : null,
      5_000, "the Browser RPC and product presence phase timeout to expire after the withheld response");
    assert.ok(bridgeB.state.requests.length > requestCountBeforeTimeout,
      "the timeout branch must follow a fresh real Browser resume request");
    assert.equal(bridgeB.state.presenceResponses.length - responseCountBeforeTimeout, 1,
      "the Gateway/Rust must return exactly one presence response in the single-use timeout branch");
    const timeoutDeliveries = bridgeB.state.presenceResponses.slice(responseCountBeforeTimeout)
      .filter(row => row.deliveredToPage);
    assert.equal(timeoutDeliveries.length, 0,
      "the one injected presence response loss must not accidentally deliver a second response to the Browser");

    const uiAfterTimeout = await assertCachedRouteAndUi(
      pageB, targetRoute, TARGET_PROMPT, cacheBefore.target.markerMessageIds[0]);
    const cacheAfterTimeout = await readCacheIndex(pageB, { threadId, marker: TARGET_PROMPT });
    assertCachePreserved(cacheBefore, cacheAfterTimeout, "injected presence response timeout");
    const targetTurnStartsAfterTimeout = bridgeB.state.turnStarts.length;
    assert.equal(targetTurnStartsAfterTimeout, 0,
      "the presence timeout path must not automatically resend the cached prompt");

    diagnostics.phase = "write-pass-evidence";
    assert.equal(bridgeB.state.turnStarts.length, 0,
      "neither unknown/offline branch may issue a target turn/start before PASS evidence is written");
    const finalRust = await verifyOwnedRustAppServer(gateway, RUST_BINARY, EXPECTED_RUST_SHA256);
    assert.deepEqual(finalRust, rustAtSeed, "the Rust owner and executable hash must remain stable through the final IDB read");
    const finalTargetTurnStartCount = bridgeB.state.turnStarts.length;
    assert.equal(finalTargetTurnStartCount, 0,
      "no target turn/start may arrive while final evidence is being prepared");
    const pageASnapshot = await snapshotPage(pageADiagnostics);
    const pageBSnapshot = await snapshotPage(pageBDiagnostics);
    const bridgeASummary = summarizeBridge(bridgeA.state);
    const bridgeBSummary = summarizeBridge(bridgeB.state);
    const finalTargetTurnStartCountAfterSnapshots = bridgeB.state.turnStarts.length;
    assert.equal(finalTargetTurnStartCountAfterSnapshots, 0,
      "no target turn/start may arrive before PASS evidence is written");
    await context.writeArtifactJson("mobile-session-cache-unknown-offline-v1.json", {
      status: "PASS_UNKNOWN_AND_INJECTED_PRESENCE_TIMEOUT_CACHE_RETENTION",
      boundary: "Real caller-pinned Mobile Web archive on a run-owned loopback Gateway and procfs-verified Rust app-server. Page A writes the exact cache using a deterministic local full turn; a separate Page B in the same private persistent profile reaches the same task after an independent real Rust delete. B's real thread/resume -32022 triggers the negotiated product probe and receives Rust's unmodified unknown/compatibilityRootPresent result. A second real resume/probe response is withheld exactly once by the E2E WebSocket bridge and the page is observed beyond the 2.5s presence phase deadline. Both branches retain the exact target cache entry and lastKey, show the cached read-only message, and stay on the task route. The withheld response is explicit test fault injection, not a claim that network loss itself triggers the probe. No personal session, real provider, paid call, permission revocation, stale 401, or real-device behavior is covered.",
      pins: {
        mobileArchiveSha256: deployment.mobileWeb.archiveSha256,
        mobileSourceManifestSha256: deployment.sourceIdentity.snapshotProof?.manifestSha256 ?? null,
        mobileSourceTreeSha256: deployment.mobileWeb.sourceTreeSha256,
        rustCallerSha256: EXPECTED_RUST_SHA256,
        rustOwnedProcfsSha256: finalRust.ownedProcfsSha256,
      },
      gateway: { authDisabled: gateway.authToken === "", mobileEntryStatus: mobileResponse.status, loopbackOnly: true },
      mobileBootstrap: {
        requestCount: diagnostics.bootstrap.requestCount,
        responseStatuses: diagnostics.bootstrap.statuses,
        rpcTokenSource: "actual successful Mobile POST /api/mobile/session response.rpcToken; registered as secret and not persisted",
      },
      scope: {
        profileIdHash: hashId(targetRoute.profileId),
        serverId: targetRoute.serverId,
        workspaceMatchesRunOwnedPath: targetRoute.cwd === workspace,
        targetThreadIdHash: hashId(threadId),
      },
      realRustUnknown: {
        nodeObserverResumeExactThread: diagnostics.nodeUnknown.resumedExactThread,
        nodeObserverDeleteAcknowledged: diagnostics.nodeUnknown.deleteAcknowledged,
        nodeObserverPresence: diagnostics.nodeUnknown.presence,
        browserResumeErrorCode: -32022,
        browserPresenceCapabilityNegotiated: true,
        browserResult: {
          status: productUnknown.status,
          reason: productUnknown.reason,
          requestResponseIdsMatched: productUnknown.responseMatchesRequest,
          threadMatchesRoute: productUnknown.threadIdMatchesRoute,
          deliveredToProductPage: productUnknown.deliveredToPage,
        },
        pageAAndPageBShareOwnedPersistentContext: pageA.context() === pageB.context(),
        pageBUsesExactSeedOrigin: new URL(pageB.url()).origin === new URL(targetTaskUrl).origin,
        targetCacheBefore: cacheEvidence(cacheBefore),
        targetCacheAfter: cacheEvidence(cacheAfterUnknown),
        cachedUi: uiAfterUnknown,
        targetTurnStartCount: targetTurnStartsAfterUnknown,
      },
      injectedPresenceTimeout: {
        injected: true,
        injectionPoint: "the Browser RPC bridge withheld one actual Rust compatibilityRootPresent response after matching exact method, request ID, and target thread ID",
        actualRustResponse: { status: withheld.status, reason: withheld.reason, requestResponseIdsMatched: withheld.responseMatchesRequest },
        withheldExactlyOnce: bridgeB.fault.consumed,
        expectedBrowserRequestTimeoutMs: BROWSER_RPC_TIMEOUT_MS,
        expectedPresencePhaseDeadlineMs: PRESENCE_PHASE_TIMEOUT_MS,
        observedBeyondPresencePhaseDeadlineMs: Math.round(performance.now() - withheld.atMs),
        productResponseDelivered: false,
        targetCacheBefore: cacheEvidence(cacheBefore),
        targetCacheAfter: cacheEvidence(cacheAfterTimeout),
        cachedUi: uiAfterTimeout,
        targetTurnStartCount: targetTurnStartsAfterTimeout,
        finalTargetTurnStartCount: finalTargetTurnStartCountAfterSnapshots,
      },
      diagnostics: {
        phase: diagnostics.phase,
        browserA: pageASnapshot,
        browserB: pageBSnapshot,
        bridgeA: bridgeASummary,
        bridgeB: bridgeBSummary,
      },
    });
  } catch (error) {
    await Promise.allSettled(pendingBootstrapCaptures);
    diagnostics.failure = { name: typeof error?.name === "string" ? error.name : "Error", category: classifyError(error) };
    await context.writeArtifactJson("mobile-session-cache-unknown-offline-v1-failure-diagnostics.json", {
      phase: diagnostics.phase,
      failure: diagnostics.failure,
      bootstrap: diagnostics.bootstrap,
      gateway: diagnostics.gateway,
      rust: diagnostics.rust,
      pages: await Promise.all(diagnostics.pages.map(snapshotPage)),
      bridges: diagnostics.bridges.map(({ label, state }) => ({ label, state: summarizeBridge(state) })),
    }).catch(() => {});
    throw error;
  }
});

async function installMobileRpcObserver(page, marker) {
  const state = {
    routeCallbackCount: 0,
    links: [],
    requests: [],
    methodCounts: {},
    threadStarts: [],
    turnStarts: [],
    turnCompletions: [],
    resumeFailures: [],
    presenceResponses: [],
    initializedPresenceCapability: false,
    requestOrdinal: 0,
  };
  const fault = { injected: false, consumed: false, threadId: null };
  await registerPageRpcWebSocketRoute(page, socket => {
    state.routeCallbackCount++;
    const upstream = socket.connectToServer();
    const connection = createPageRpcBridgeConnection(socket, upstream);
    const link = { connection, requestsById: new Map() };
    state.links.push(link);
    socket.onMessage(raw => {
      const frame = parseRpcFrame(raw);
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const request = {
          id: String(frame.id),
          method: frame.method,
          threadId: typeof frame.params?.threadId === "string" ? frame.params.threadId : null,
          ordinal: ++state.requestOrdinal,
          atMs: performance.now(),
          markerMatches: frame.method === "turn/start" && inputText(frame.params?.input).includes(marker),
        };
        link.requestsById.set(request.id, request);
        state.requests.push(request);
        state.methodCounts[request.method] = (state.methodCounts[request.method] ?? 0) + 1;
        if (request.method === "turn/start" && request.markerMatches) state.turnStarts.push(request);
      }
      connection.sendToServer(raw);
    });
    upstream.onMessage(raw => {
      const frame = parseRpcFrame(raw);
      const request = frame && frame.id !== undefined ? link.requestsById.get(String(frame.id)) : null;
      if (request?.method === "initialize") {
        state.initializedPresenceCapability = frame.result?.capabilities?.experimental?.threadPresenceReadV1 === true;
      }
      if (request?.method === "thread/start" && typeof frame.result?.thread?.id === "string") {
        state.threadStarts.push({ requestId: request.id, threadId: frame.result.thread.id });
      }
      if (request?.method === "turn/start" && typeof frame.result?.turn?.id === "string") {
        request.turnId = frame.result.turn.id;
        request.responseThreadId = frame.result.turn.threadId ?? request.threadId;
      }
      if (frame?.method === "turn/completed") {
        state.turnCompletions.push({
          threadId: frame.params?.threadId ?? frame.params?.turn?.threadId ?? null,
          status: frame.params?.turn?.status ?? null,
        });
      }
      if (request?.method === "thread/resume" && Number.isSafeInteger(frame.error?.code)) {
        state.resumeFailures.push({
          requestIdHash: hashId(request.id),
          threadId: request.threadId,
          requestOrdinal: request.ordinal,
          errorCode: frame.error.code,
          atMs: performance.now(),
        });
      }
      if (request?.method === "thread/presence/read") {
        const row = {
          requestId: request.id,
          requestOrdinal: request.ordinal,
          requestAtMs: request.atMs,
          threadId: typeof frame.result?.threadId === "string" ? frame.result.threadId : request.threadId,
          status: typeof frame.result?.status === "string" ? frame.result.status : null,
          reason: typeof frame.result?.reason === "string" ? frame.result.reason : null,
          errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
          responseMatchesRequest: String(frame.id) === request.id,
          threadIdMatchesRoute: frame.result?.threadId === request.threadId,
          exactCompatibilityRootUnknown: matchesExactCompatibilityRootUnknown(frame, {
            requestId: request.id,
            threadId: request.threadId,
          }),
          deliveredToPage: false,
          withheldByInjectedFault: false,
          atMs: performance.now(),
        };
        if (shouldWithholdExactCompatibilityRootUnknown(request, frame, fault)) {
          row.withheldByInjectedFault = true;
          state.presenceResponses.push(row);
          return;
        }
        const sent = connection.sendToPage(raw);
        row.deliveredToPage = sent;
        state.presenceResponses.push(row);
        return;
      }
      connection.sendToPage(raw);
    });
  });

  return {
    state,
    fault,
    armOneCompatibilityUnknownResponseLoss(threadId) {
      assert.equal(fault.injected, false, "the presence response-loss fault can only be armed once");
      fault.injected = true;
      fault.consumed = false;
      fault.threadId = threadId;
    },
  };
}

function inputText(input) {
  if (!Array.isArray(input)) return "";
  return input.filter(item => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text).join("\n");
}

function observePage(page, label) {
  const record = { page, label, pageErrors: [], consoleErrors: [], http: [], failures: [], websockets: [] };
  page.on("pageerror", error => pushBounded(record.pageErrors, { category: classifyError(error) }));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) {
      pushBounded(record.consoleErrors, { type: message.type(), category: classifyError(message.text()) });
    }
  });
  page.on("response", response => {
    const url = safeUrl(response.url());
    if (!url || (!url.pathname.startsWith("/api/") && url.pathname !== "/rpc")) return;
    pushBounded(record.http, { method: response.request().method(), path: url.pathname, status: response.status() });
  });
  page.on("requestfailed", request => {
    const url = safeUrl(request.url());
    pushBounded(record.failures, {
      method: request.method(),
      path: url?.pathname ?? "[invalid-url]",
      category: classifyError(request.failure()?.errorText),
    });
  });
  page.on("websocket", socket => {
    const url = safeUrl(socket.url());
    const event = { path: url?.pathname ?? "[invalid-url]", closed: false };
    pushBounded(record.websockets, event);
    socket.on("close", () => { event.closed = true; });
    socket.on("socketerror", error => { event.errorCategory = classifyError(error); });
  });
  return record;
}

async function snapshotPage(record) {
  if (!record) return null;
  const { page, label } = record;
  const testIds = [
    "welcome-direct-connection", "gateway-token", "gateway-connect", "new-workspace",
    "new-workspace-prompt", "create-workspace", "message-input", "send-message",
    "message-list", "message-user", "session-cache-view", "session-cache-status",
    "sessions-confirmed-absence-notice",
  ];
  const locatorCounts = await page.evaluate(ids => Object.fromEntries(ids.map(testId => {
    const matches = [...document.querySelectorAll("[data-testid]")]
      .filter(element => element.getAttribute("data-testid") === testId);
    const element = matches[0];
    const rect = element?.getBoundingClientRect();
    return [testId, { count: matches.length, firstVisible: Boolean(rect?.width && rect?.height) }];
  })), testIds).catch(() => Object.fromEntries(testIds.map(id => [id, { count: null, firstVisible: false }])));
  return {
    label,
    closed: page.isClosed(),
    location: safeLocation(page.url()),
    locatorCounts,
    pageErrors: record.pageErrors.slice(-12),
    consoleErrors: record.consoleErrors.slice(-12),
    http: record.http.slice(-50),
    requestFailures: record.failures.slice(-20),
    websockets: record.websockets.slice(-12),
  };
}

function summarizeBridge(state) {
  return {
    routeCallbackCount: state.routeCallbackCount,
    socketCount: state.links.length,
    methodCounts: { ...state.methodCounts },
    initializedPresenceCapability: state.initializedPresenceCapability,
    turnStartCount: state.turnStarts.length,
    completedTurns: state.turnCompletions.map(row => ({ threadIdHash: hashId(row.threadId), status: row.status })),
    resumeFailures: state.resumeFailures.map(row => ({ ...row, threadId: undefined, threadIdHash: hashId(row.threadId) })),
    presenceResponses: state.presenceResponses.map(row => ({
      requestIdHash: hashId(row.requestId),
      requestOrdinal: row.requestOrdinal,
      threadIdHash: hashId(row.threadId),
      status: row.status,
      reason: row.reason,
      errorCode: row.errorCode,
      responseMatchesRequest: row.responseMatchesRequest,
      threadIdMatchesRoute: row.threadIdMatchesRoute,
      exactCompatibilityRootUnknown: row.exactCompatibilityRootUnknown,
      deliveredToPage: row.deliveredToPage,
      withheldByInjectedFault: row.withheldByInjectedFault,
    })),
    pageClosedSockets: state.links.filter(link => link.connection.state.clientClosed).length,
    gatewayClosedSockets: state.links.filter(link => link.connection.state.serverClosed).length,
  };
}

async function connectFreshMobileProfile(page, gateway) {
  const directConnection = await uniqueTestId(page, "welcome-direct-connection");
  await directConnection.click();
  const token = await uniqueTestId(page, "gateway-token");
  await token.fill(gateway.authToken);
  assert.equal(gateway.authToken, "", "Mobile must bootstrap against this auth-disabled run-owned Gateway");
  const connectButton = await uniqueTestId(page, "gateway-connect");
  await Promise.all([
    page.waitForURL(url => url.pathname.startsWith(`${MOBILE_MOUNT}/h/`), { timeout: 30_000 }),
    connectButton.click(),
  ]);
}

async function openNewTaskFromHome(page, profileId, mobileEntryUrl, workspace) {
  if (!new URL(page.url()).pathname.startsWith(`${MOBILE_MOUNT}/h/`)) {
    await page.goto(new URL(`h/${encodeURIComponent(profileId)}`, mobileEntryUrl).href,
      { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  const newWorkspaceButton = await uniqueTestId(page, "new-workspace");
  await newWorkspaceButton.click();
  await uniqueTestId(page, "new-workspace-prompt");
  const localServerOption = await uniqueTestId(page, "server-option-local");
  await localServerOption.click();
  const workspacePath = await uniqueTestId(page, "workspace-path");
  await workspacePath.fill(workspace);
}

async function createFullTurn(page, prompt, bridgeState) {
  const promptField = await uniqueTestId(page, "new-workspace-prompt");
  await promptField.fill(prompt);
  const createWorkspaceButton = await uniqueTestId(page, "create-workspace");
  await createWorkspaceButton.click();
  const route = await waitFor(() => {
    try { return taskRoute(page.url()); } catch { return null; }
  }, 30_000, "the Mobile task route to expose its canonical thread ID and workspace");
  const visibleUser = page.getByTestId("message-list").getByTestId("message-user").filter({ hasText: prompt });
  await visibleUser.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await visibleUser.count(), 1, "the real task must show one scoped user row for its unique prompt marker");
  await waitFor(() => bridgeState.turnStarts.find(row => row.threadId === route.threadId && row.markerMatches) ?? null,
    30_000, "the real Mobile turn/start request to bind the UI marker to its canonical route thread");
  const threadStart = await waitFor(() => bridgeState.threadStarts.find(row => row.threadId === route.threadId) ?? null,
    15_000, "the real Rust thread/start receipt to match the exact Mobile route");
  assert.equal(threadStart.threadId, route.threadId, "Rust's canonical thread ID must match the Mobile route");
  const turnStart = bridgeState.turnStarts.find(row => row.threadId === route.threadId && row.markerMatches);
  await waitFor(() => turnStart?.turnId ? true : null, 15_000, "the real Rust turn/start receipt");
  await waitFor(() => bridgeState.turnCompletions.find(row =>
    row.threadId === route.threadId && row.status === "completed") ?? null,
  60_000, "the deterministic local Rust fixture turn to complete");
  return route.threadId;
}

async function readCacheIndex(page, { threadId, marker }) {
  return page.evaluate(async ({ threadId: targetThreadId, marker: targetMarker }) => {
    const databaseName = "kcoder-confirmed-transcripts-v1";
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return { ready: false };
    const inventory = await indexedDB.databases();
    if (!inventory.some(row => row.name === databaseName)) return { ready: false };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("cache database open blocked"));
    });
    try {
      const data = await new Promise((resolve, reject) => {
        let manifest;
        const records = new Map();
        const transaction = db.transaction(["manifest", "entries"], "readonly");
        transaction.objectStore("manifest").get("current").onsuccess = event => {
          const raw = event.target.result;
          if (typeof raw === "string" && raw.length <= 64 * 1024) {
            try { manifest = JSON.parse(raw); } catch {}
          }
        };
        const cursor = transaction.objectStore("entries").openCursor();
        cursor.onsuccess = event => {
          const entry = event.target.result;
          if (!entry) return;
          records.set(entry.key, entry.value);
          entry.continue();
        };
        transaction.oncomplete = () => resolve({ manifest, records });
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("cache read aborted"));
      });
      const manifest = data.manifest;
      if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) ||
          !Array.isArray(manifest.invalidations)) return { ready: false };
      let target = null;
      for (const row of manifest.entries) {
        const record = data.records.get(row.slot);
        if (!record || !(record.blob instanceof Blob) || record.revision !== row.dataRevision || record.blob.size > 512 * 1024) continue;
        let parsed;
        try { parsed = JSON.parse(await record.blob.text()); } catch { continue; }
        if (parsed?.scope?.threadId !== targetThreadId) continue;
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const matchingMessages = messages.filter(message => message?.role === "user" &&
          typeof message.content === "string" && message.content.includes(targetMarker));
        target = {
          key: row.key,
          slot: row.slot,
          dataRevision: row.dataRevision,
          workspaceKey: row.workspaceKey,
          threadId: parsed.scope.threadId,
          cwd: parsed.scope.cwd ?? null,
          markerMessageIds: matchingMessages.map(message => typeof message.id === "string" ? message.id : null).filter(Boolean),
          messageCount: messages.length,
        };
        break;
      }
      const invalidated = target ? manifest.invalidations.some(item => item?.key === `t:${target.key}`) : null;
      return {
        ready: true,
        manifest: { revision: manifest.revision, lastKey: manifest.lastKey },
        target: target ? { ...target, invalidated } : null,
      };
    } finally {
      db.close();
    }
  }, { threadId, marker });
}

async function assertCachedRouteAndUi(page, expectedRoute, marker, canonicalMessageIdExpected) {
  const actualRoute = await waitFor(() => {
    try { return taskRoute(page.url()); } catch { return null; }
  }, 15_000, "Mobile to remain on the exact target task route");
  assert.deepEqual(actualRoute, expectedRoute, "unknown/offline must preserve the complete profile/server/thread/workspace task scope");
  const cachedView = await uniqueTestId(page, "session-cache-view");
  const cachedMessage = cachedView.getByTestId("message-user").filter({ hasText: marker });
  await cachedMessage.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await cachedMessage.count(), 1, "the cached read-only view must show exactly the original target message");
  assert.equal(await canonicalMessageId(cachedMessage), canonicalMessageIdExpected,
    "the visible cached user row must retain the canonical ID from the exact IndexedDB record");
  const status = await uniqueTestId(page, "session-cache-status");
  assert.equal(await status.isVisible(), true, "the read-only cache status must remain visible");
  await assertCachedSessionComposerReadOnly(page, "unknown/offline cache rendering");
  assert.equal(await page.getByTestId("sessions-confirmed-absence-notice").count(), 0,
    "unknown/offline must not show confirmed absence navigation or notice");
  return { taskRouteStillExact: true, cachedMessageVisible: true, readOnly: true, confirmedAbsenceNoticeVisible: false };
}

function assertCachePreserved(before, after, phase) {
  assert.equal(after.ready, true, `${phase}: IndexedDB must remain readable through a readonly transaction`);
  assert.ok(after.target, `${phase}: the exact target row must remain in IndexedDB`);
  assert.equal(after.target.key, before.target.key, `${phase}: the target entry key must remain unchanged`);
  assert.equal(after.target.slot, before.target.slot, `${phase}: the target slot must remain unchanged`);
  assert.equal(after.target.dataRevision, before.target.dataRevision, `${phase}: the target data revision must remain unchanged`);
  assert.equal(after.target.workspaceKey, before.target.workspaceKey, `${phase}: the workspace prefix must remain unchanged`);
  assert.equal(after.target.cwd, before.target.cwd, `${phase}: the exact workspace scope must remain unchanged`);
  assert.deepEqual(after.target.markerMessageIds, before.target.markerMessageIds,
    `${phase}: the original canonical user identity must remain unchanged`);
  assert.equal(after.target.invalidated, false, `${phase}: the product must not write a target tombstone`);
  assert.equal(after.manifest.lastKey, before.target.key, `${phase}: the exact target must remain lastKey`);
}

function cacheEvidence(snapshot) {
  return {
    ready: snapshot.ready,
    lastKeyIsTarget: snapshot.manifest?.lastKey === snapshot.target?.key,
    targetKeyHash: hashId(snapshot.target?.key),
    targetSlot: snapshot.target?.slot ?? null,
    targetDataRevision: snapshot.target?.dataRevision ?? null,
    targetWorkspaceKeyHash: hashId(snapshot.target?.workspaceKey),
    targetMarkerMessageCount: snapshot.target?.markerMessageIds?.length ?? 0,
    targetInvalidated: snapshot.target?.invalidated ?? null,
    messageCount: snapshot.target?.messageCount ?? null,
  };
}

function canonicalMessageId(locator) {
  return locator.evaluate(element => {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (!node.id?.startsWith("message-")) continue;
      const encoded = node.id.slice("message-".length);
      try { return decodeURIComponent(encoded); } catch { return encoded; }
    }
    return null;
  });
}

async function uniqueTestId(page, testId) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await locator.count(), 1, `Mobile locator ${testId} must be unique before use`);
  return locator;
}

async function verifyOwnedRustAppServer(gateway, executablePath, expectedSha256) {
  const matches = await findOwnedExecutableProcesses({ pgid: gateway.child.pid, executablePath });
  const owned = matches.find(process => process.sha256 === expectedSha256);
  assert.ok(owned, "procfs /proc/<pid>/exe must identify the caller-pinned Rust child inside this owned Gateway process group");
  const configured = await hashExecutableFile(executablePath);
  assert.equal(configured.sha256, expectedSha256, "the configured Rust binary must retain its caller-pinned SHA-256");
  return { callerSha256: expectedSha256, ownedProcfsSha256: owned.sha256, ownedChildObserved: true };
}

function taskRoute(rawUrl) {
  const url = new URL(rawUrl);
  assert.ok(url.pathname.startsWith(`${MOBILE_MOUNT}/`), "the Mobile route must remain under the production mount");
  const parts = url.pathname.slice(MOBILE_MOUNT.length).split("/").filter(Boolean).map(decodeURIComponent);
  assert.equal(parts[0], "h", "the task must remain on its exact Mobile Gateway profile route");
  assert.equal(parts[2], "task", "the Mobile route must identify a task");
  const cwd = url.searchParams.get("cwd");
  assert.ok(parts[1] && parts[3] && parts[4] && cwd, "profile, server, thread, and workspace must all be present in the route");
  return { profileId: parts[1], serverId: parts[3], threadId: parts[4], cwd };
}

function profileIdFromRoute(rawUrl) {
  const url = new URL(rawUrl);
  const parts = url.pathname.slice(MOBILE_MOUNT.length).split("/").filter(Boolean).map(decodeURIComponent);
  assert.equal(parts[0], "h", "the Mobile bootstrap must route into its own created profile home");
  assert.ok(parts[1], "the Mobile profile route must have a stable ID");
  return parts[1];
}

function safeUrl(rawUrl) {
  try { return new URL(rawUrl); } catch { return null; }
}

function safeLocation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split("/");
    const hIndex = segments.indexOf("h");
    if (hIndex >= 0 && segments[hIndex + 1]) {
      segments[hIndex + 1] = ":profileId";
      if (segments[hIndex + 2] === "task") {
        if (segments[hIndex + 3]) segments[hIndex + 3] = ":serverId";
        if (segments[hIndex + 4]) segments[hIndex + 4] = ":threadId";
      }
    }
    return {
      origin: url.origin,
      pathname: segments.join("/") || "/",
      queryKeys: [...url.searchParams.keys()].filter(key => !/(?:token|secret|credential|auth|password|key)/i.test(key)).sort(),
    };
  } catch { return null; }
}

function classifyError(error) {
  const text = typeof error === "string" ? error.toLowerCase() :
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (/timeout|timed out|deadline/.test(text)) return "timeout";
  if (/websocket|network|fetch|socket|net::/.test(text)) return "network";
  if (/unauthoriz|forbidden|auth|token/.test(text)) return "authorization";
  if (/protocol|json.?rpc|invalid frame|parse/.test(text)) return "protocol";
  if (/not found|undefined|null|not a function|cannot read/.test(text)) return "runtime";
  if (/error|failed|exception/.test(text)) return "generic-error";
  return text ? "other" : "unavailable";
}

function hashId(value) {
  if (typeof value !== "string" || !value) return null;
  return createHash("sha256").update("mobile-cache-unknown-offline-v1\0").update(value).digest("hex").slice(0, 12);
}

function pushBounded(target, value, limit = 80) {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && isAbsolute(value), `${name} must be an explicit absolute path`);
  return resolve(value);
}

function requiredSha256(name) {
  const value = process.env[name];
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${name} must be an explicit lowercase SHA-256 pin`);
  return value;
}
