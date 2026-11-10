import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertCachedSessionComposerReadOnly } from "../../harness/mobile-session-cache-readonly.mjs";
import { restorePinnedGatewayMobileDeployment } from "../../harness/mobile-pinned-gateway-deployment.mjs";
import { hashExecutableFile, findOwnedExecutableProcesses } from "../../harness/owned-executable-provenance.mjs";
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from "../../harness/rpc.mjs";
import { requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import {
  createPageRpcBridgeConnection,
  installRpcResponseReceiptWitness,
  isExactThreadInvalidationSnapshot,
  isOwnedIndexedAuthorityResponse,
  parseRpcFrame,
  registerPageRpcWebSocketRoute,
} from "./mobile-session-cache-multirealm-helpers.mjs";

const MOBILE_MOUNT = "/mobile";
const TEST_TIMEOUT_MS = 60_000;
const targetFirstPrompt = `MULTIREALM_TARGET_FIRST_${randomBytes(6).toString("hex")}`;
const targetLatePrompt = `MULTIREALM_TARGET_LATE_${randomBytes(6).toString("hex")}`;
const peerPrompt = `MULTIREALM_PEER_${randomBytes(6).toString("hex")}`;
const rustBinary = requiredAbsolutePath("KCODER_E2E_KCODER_BIN");
const expectedRustSha256 = requiredSha256("KCODER_E2E_KCODER_BIN_SHA256");

await runE2E(import.meta.url, {
  testId: "mobile-session-cache-multirealm-late-publisher",
  tier: "full-integration",
  modelPolicy: "model-independent real pinned production-mounted Mobile Web, owned Gateway and Rust app-server; two live pages in one private Chromium profile; local full-turn fixture only; no external Provider or paid model call",
}, async context => {
  const browserDiagnostics = {
    phase: "suite-start",
    bodyCompleted: false,
    failure: null,
    pages: [],
    bridges: [],
    responseReceipt: null,
  };
  try {
  browserDiagnostics.phase = "restore-pinned-deployment";
  const deployment = await restorePinnedGatewayMobileDeployment(context, {
    outputName: "mobile-session-cache-multirealm-deployment",
  });
  const rustStat = await lstat(rustBinary);
  assert.ok(rustStat.isFile() && (rustStat.mode & 0o111) !== 0,
    "caller-pinned KCoder app-server must be an executable regular file");
  await requireExecutable(rustBinary, "caller-pinned KCoder app-server");
  const configuredRustBefore = await hashExecutableFile(rustBinary);
  assert.equal(configuredRustBefore.sha256, expectedRustSha256,
    "caller-pinned KCoder app-server bytes do not match KCODER_E2E_KCODER_BIN_SHA256");

  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const gateway = await startGateway(context, {
    auth: false,
    label: "mobile-session-cache-multirealm-gateway",
    workspace,
    kcoderBin: rustBinary,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_MOBILE_WEB_ROOT: deployment.deployment.path,
    },
  });
  assert.equal(gateway.authToken, "", "this owned Gateway must run with authentication disabled and an empty access token");
  const mobileEntryUrl = new URL(`${MOBILE_MOUNT}/`, gateway.baseUrl).href;
  const mobileResponse = await fetch(mobileEntryUrl, { headers: { accept: "text/html" } });
  assert.equal(mobileResponse.status, 200, "the pinned archive must be served by the actual Gateway /mobile/ mount");
  await mobileResponse.body?.cancel();

  context.addCleanup("verify caller-pinned Rust bytes remain unchanged", async () => {
    const configured = await hashExecutableFile(rustBinary);
    assert.equal(configured.sha256, expectedRustSha256,
      "the configured Rust app-server bytes must retain the caller-pinned SHA-256");
  });

  const chromium = await startChromium(context, {
    label: "mobile-session-cache-multirealm-chromium",
    profileName: "mobile-session-cache-multirealm",
    startTimeoutMs: 60_000,
  });
  browserDiagnostics.phase = "chromium-started";
  const pages = chromium.browser.contexts();
  assert.equal(pages.length, 1, "the owned Chromium must expose exactly one private persistent context");
  const persistentContext = pages[0];
  const pageA = await chromium.newPersistentPage();
  browserDiagnostics.pages.push(observePageDiagnostics(pageA, "A"));
  await pageA.setViewportSize({ width: 390, height: 844 });
  await installRpcResponseReceiptWitness(pageA);
  const mobileSessionBootstrap = { requestCount: 0, responseStatuses: [], rpcToken: null, rpcTokenCaptureFailed: false };
  pageA.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/mobile/session") {
      mobileSessionBootstrap.requestCount++;
    }
  });
  pageA.on("response", response => {
    const request = response.request();
    const url = new URL(response.url());
    if (request.method() === "POST" && url.pathname === "/api/mobile/session") {
      mobileSessionBootstrap.responseStatuses.push(response.status());
      if (response.status() === 200) {
        void response.json().then(payload => {
          const rpcToken = payload?.rpcToken;
          if (typeof rpcToken !== "string" || rpcToken.length === 0) {
            mobileSessionBootstrap.rpcTokenCaptureFailed = true;
            return;
          }
          context.registerSecret(rpcToken);
          mobileSessionBootstrap.rpcToken = rpcToken;
        }).catch(() => {
          mobileSessionBootstrap.rpcTokenCaptureFailed = true;
        });
      }
    }
  });
  const bridgeA = await createPageRpcBridge(pageA);
  browserDiagnostics.bridges.push({ label: "A", state: bridgeA.state });
  const bridgeAState = bridgeA.state;

  browserDiagnostics.phase = "page-a-mobile-bootstrap";
  await pageA.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await connectFreshMobileProfile(pageA, gateway);
  await waitFor(() => mobileSessionBootstrap.responseStatuses.includes(200) ? true : null,
    15_000, "Mobile's own successful POST /api/mobile/session bootstrap");
  assert.equal(mobileSessionBootstrap.requestCount, 1,
    "the Mobile UI must perform its own one device-session bootstrap against the auth-disabled Gateway");
  assert.deepEqual(mobileSessionBootstrap.responseStatuses, [200],
    "the real Mobile session bootstrap must return HTTP 200 on this owned auth-disabled Gateway");
  await waitFor(() => {
    if (mobileSessionBootstrap.rpcTokenCaptureFailed) {
      assert.fail("the successful Mobile bootstrap response must contain a capturable Gateway-issued rpcToken");
    }
    return mobileSessionBootstrap.rpcToken ? true : null;
  }, 5_000, "the real Mobile bootstrap response's Gateway-issued RPC token");
  const profileId = profileIdFromMobileRoute(pageA.url());

  browserDiagnostics.currentCase = "multirealm-first-seed";
  browserDiagnostics.phase = "multirealm-first-seed-create-peer";
  await openNewTaskFromHome(pageA, profileId, mobileEntryUrl, workspace);
  browserDiagnostics.phase = "multirealm-first-seed-peer-turn";
  const peerThreadId = await createFullTurn(pageA, peerPrompt, bridgeAState);
  const peerRoute = taskRoute(pageA.url());
  assert.equal(peerRoute.threadId, peerThreadId, "the visible peer route must match the canonical thread/start response");
  assert.equal(peerRoute.cwd, workspace, "the peer fixture must use the owned workspace path");
  const peerCache = await waitFor(async () => {
    const snapshot = await readTranscriptCacheIndex(pageA, { peerThreadId, peerMarker: peerPrompt });
    return snapshot.peer?.markerMessageIds.length === 1 ? snapshot.peer : null;
  }, 30_000, "the completed peer's real Mobile cache entry to commit before Page A navigates away");
  assert.equal(peerCache.cwd, workspace, "the peer cache entry must retain the exact owned workspace path");

  browserDiagnostics.currentCase = "multirealm-target-seed";
  browserDiagnostics.phase = "multirealm-target-seed-create";
  await pageA.goto(new URL(`h/${encodeURIComponent(profileId)}`, mobileEntryUrl).href,
    { waitUntil: "domcontentloaded", timeout: 30_000 });
  await openNewTaskFromHome(pageA, profileId, mobileEntryUrl, workspace);
  browserDiagnostics.phase = "multirealm-target-seed-turn";
  const targetThreadId = await createFullTurn(pageA, targetFirstPrompt, bridgeAState);
  const targetRoute = taskRoute(pageA.url());
  assert.equal(targetRoute.threadId, targetThreadId, "the visible target route must match the canonical thread/start response");
  assert.equal(targetRoute.profileId, profileId, "the target route must retain the Mobile-created profile identity");
  assert.equal(targetRoute.serverId, "local", "the target route must remain on the owned local Rust server");
  assert.equal(targetRoute.cwd, workspace, "the target route must retain the exact owned workspace scope");

  const cacheBeforeLateTurn = await waitFor(async () => {
    const snapshot = await readTranscriptCacheIndex(pageA, {
      targetThreadId,
      peerThreadId,
      targetMarker: targetFirstPrompt,
      peerMarker: peerPrompt,
    });
    return snapshot.target?.markerMessageIds.length === 1 && snapshot.peer?.markerMessageIds.length === 1
      ? snapshot : null;
  }, 30_000, "the real Mobile turns to commit the target and same-workspace peer into IndexedDB");
  assert.equal(cacheBeforeLateTurn.target.workspaceKey, cacheBeforeLateTurn.peer.workspaceKey,
    "target and peer must occupy the same IndexedDB workspace prefix");
  assert.equal(cacheBeforeLateTurn.manifest.lastKey, cacheBeforeLateTurn.target.key,
    "the target must be the product's current last-route cache entry before deletion");
  assert.equal(cacheBeforeLateTurn.target.cwd, workspace,
    "the target's real cache entry must bind the exact owned workspace path");
  assert.equal(cacheBeforeLateTurn.peer.cwd, workspace,
    "the peer's real cache entry must bind the same owned workspace path");

  browserDiagnostics.phase = "multirealm-two-seeds-complete";
  browserDiagnostics.currentCase = "multirealm-late-publisher";
  const pageB = await chromium.newPersistentPage();
  browserDiagnostics.pages.push(observePageDiagnostics(pageB, "B"));
  await pageB.setViewportSize({ width: 390, height: 844 });
  const bridgeB = await createPageRpcBridge(pageB, {
    holdDeletedResumeThreadId: targetThreadId,
  });
  bridgeB.state.diagnosticExpectedThreadId = targetThreadId;
  browserDiagnostics.bridges.push({ label: "B", state: bridgeB.state });
  browserDiagnostics.phase = "multirealm-two-live-realms";
  await pageB.goto(new URL(`${MOBILE_MOUNT}/welcome`, gateway.baseUrl).href,
    { waitUntil: "domcontentloaded", timeout: 30_000 });
  assert.equal(pageA.isClosed(), false, "Page A must remain alive while Page B is opened");
  assert.equal(pageB.isClosed(), false, "the suite-owned Page B must remain alive at the two-realm gate");
  assert.equal(pageA.context(), persistentContext, "Page A must use the owned persistent BrowserContext");
  assert.equal(pageB.context(), persistentContext, "Page B must use the same owned persistent BrowserContext");
  assert.notEqual(pageA, pageB, "the test requires two distinct simultaneously live pages");
  const [realmA, realmB] = await Promise.all([
    pageA.evaluate(() => { globalThis.__multirealmProbe = crypto.randomUUID(); return globalThis.__multirealmProbe; }),
    pageB.evaluate(() => { globalThis.__multirealmProbe = crypto.randomUUID(); return globalThis.__multirealmProbe; }),
  ]);
  assert.notEqual(realmA, realmB, "the two pages must have distinct live JavaScript realms");
  assert.equal(new URL(pageA.url()).origin, new URL(pageB.url()).origin,
    "both live pages must share the exact same origin");

  bridgeAState.targetThreadId = targetThreadId;
  bridgeAState.armedIndexedPrompt = targetLatePrompt;
  browserDiagnostics.phase = "multirealm-late-turn-awaiting-authority";
  const lateInput = await uniqueTestId(pageA, "message-input", "visible");
  await lateInput.fill(targetLatePrompt);
  const lateSend = await uniqueTestId(pageA, "send-message", "visible");
  await lateSend.click();
  const lateTurnStart = await waitFor(() => bridgeAState.turnStarts.find(row =>
    row.threadId === targetThreadId && row.promptMarker === targetLatePrompt) ?? null,
  TEST_TIMEOUT_MS, "the real Mobile turn/start frame for the target's late authority turn");
  assert.ok(lateTurnStart.clientMessageId, "the late Mobile turn must carry its actual clientMessageId");
  const lateTurnCompleted = await waitFor(() => bridgeAState.turnCompletions.find(row =>
    row.threadId === targetThreadId && row.turnId === lateTurnStart.turnId && row.status === "completed") ?? null,
  TEST_TIMEOUT_MS, "the late target turn to become idle on the real Rust runtime");
  assert.equal(lateTurnCompleted.threadId, targetThreadId,
    "the completed turn must retain the target thread identity before server deletion");

  const heldAuthority = await waitFor(() => bridgeAState.heldAuthority ?? null,
    TEST_TIMEOUT_MS, "Rust to return the target's real indexed transcript page before the browser forwards it");
  assert.equal(heldAuthority.threadId, targetThreadId,
    "the held indexed page must belong to the exact target thread");
  assert.equal(heldAuthority.promptMarkerMatches, true,
    "the held indexed page must contain the second target user row");
  assert.equal(heldAuthority.clientMessageIdMatches, true,
    "the held indexed page must correlate the actual turn's clientMessageId");
  assert.equal(heldAuthority.rangeEnd - heldAuthority.rangeStart, heldAuthority.messageCount,
    "the held response must be a structurally valid indexed history page");
  const ownedRustAtHeldAuthority = await verifyOwnedRustAppServer(gateway, rustBinary, expectedRustSha256);
  assert.equal(pageA.isClosed(), false, "A's old Mobile runtime must stay in its live JavaScript realm");
  assert.equal(taskRoute(pageA.url()).threadId, targetThreadId,
    "A must remain on the original target route while its authority response is held");
  const aLatePromptBeforeRelease = pageA.getByTestId("message-list").getByTestId("message-user")
    .filter({ hasText: targetLatePrompt });
  await aLatePromptBeforeRelease.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await aLatePromptBeforeRelease.count(), 1,
    "A's live Runtime must retain the exact in-flight user's visible row while its indexed authority is held");

  const nodeObserverUrl = new URL(gatewayRpcUrl(gateway, targetRoute.serverId, mobileSessionBootstrap.rpcToken));
  browserDiagnostics.phase = "multirealm-node-delete-and-presence";
  nodeObserverUrl.searchParams.set("workspace", targetRoute.cwd);
  assert.equal(typeof nodeObserverUrl.searchParams.get("token"), "string");
  assert.ok(nodeObserverUrl.searchParams.get("token").length > 0,
    "the Node observer must use the Gateway-issued rpcToken captured from Mobile's successful bootstrap");
  assert.notEqual(nodeObserverUrl.searchParams.get("token"), gateway.authToken,
    "the auth-disabled access credential and Gateway-issued RPC token are separate values");
  const nodeObserver = await openRpc(nodeObserverUrl.href, {
    headers: { Origin: gateway.baseUrl },
    timeoutMs: 15_000,
  });
  context.addCleanup("close multirealm Node deletion observer", () =>
    closeRpcAndWait(nodeObserver, "multirealm Node deletion observer"));
  const initialized = await nodeObserver.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "mobile-session-cache-multirealm", version: "1" },
    capabilities: { experimental: { threadPresenceReadV1: true } },
  }, 15_000);
  assert.equal(initialized?.capabilities?.experimental?.threadPresenceReadV1, true,
    "the independently owned Node client must negotiate typed thread presence");

  browserDiagnostics.phase = "multirealm-a-upstream-disconnect";
  const heldAuthorityLink = bridgeAState.heldAuthority?.link;
  assert.ok(heldAuthorityLink, "A's held indexed authority must retain its original page-scoped route link");
  const authorityLinkState = heldAuthorityLink.connection.state;
  assert.equal(authorityLinkState.clientClosed, false,
    "A's browser-facing RPC route must still be open before the upstream disconnect");
  assert.equal(authorityLinkState.serverClosed, false,
    "A's original Gateway upstream must still be open before the upstream disconnect");
  const aUpstreamDisconnectRequestedAtMs = performance.now();
  assert.equal(await bridgeA.disconnectHeldAuthorityUpstream(), true,
    "the harness must close only the upstream that returned A's held authority");
  await waitFor(() => authorityLinkState.serverClosedAtMs ?? null,
    15_000, "A's Gateway-side WebSocket close event while preserving its page-side route");
  assert.ok(authorityLinkState.serverClosedAtMs >= aUpstreamDisconnectRequestedAtMs,
    "the observed upstream close must follow the explicit disconnect request");
  assert.equal(authorityLinkState.clientClosed, false,
    "the Gateway-side close must not propagate to A's browser-facing socket");
  assert.equal(pageA.isClosed(), false, "A's original Page and JavaScript realm must stay alive after upstream close");
  assert.equal(taskRoute(pageA.url()).threadId, targetThreadId,
    "A must remain on the same target route while its Gateway transport is detached");
  assert.equal(await pageA.evaluate(() => globalThis.__multirealmProbe), realmA,
    "A must retain the exact original JavaScript realm after its upstream closes");
  assert.equal(bridgeAState.heldAuthority.link, heldAuthorityLink,
    "the held response must remain attached to the original Page A WebSocket route");
  await aLatePromptBeforeRelease.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await aLatePromptBeforeRelease.count(), 1,
    "A's existing Runtime must keep its exact late-turn row while only the Gateway side is closed");

  const postDisconnectPresenceRequestedAtMs = performance.now();
  const postDisconnectPresence = await nodeObserver.request("thread/presence/read", {
    threadId: targetThreadId,
  }, 15_000);
  const postDisconnectPresenceCompletedAtMs = performance.now();
  assert.deepEqual(postDisconnectPresence, {
    status: "present",
    threadId: targetThreadId,
    reason: "residentRuntime",
  }, "a read-only Node barrier must confirm the completed resident still exists after A's upstream close");
  assert.ok(postDisconnectPresenceRequestedAtMs >= authorityLinkState.serverClosedAtMs,
    "the read-only barrier must be sent only after Playwright observed A's Gateway-side close");
  assert.equal(await aLatePromptBeforeRelease.count(), 1,
    "A must keep the same pending row while the Node observer confirms the still-present resident");

  const nodeDeleteRequestedAtMs = performance.now();
  const deleted = await nodeObserver.request("thread/delete", { threadId: targetThreadId }, 30_000);
  const nodeDeleteAcknowledgedAtMs = performance.now();
  assert.equal(deleted?.threadId, targetThreadId, "Rust thread/delete must identify the exact target thread");
  assert.equal(deleted?.deleted, true, "Rust thread/delete must remove the now-idle target thread");
  assert.ok(nodeDeleteRequestedAtMs >= postDisconnectPresenceCompletedAtMs,
    "the single delete RPC must follow the completed post-disconnect read-only barrier");
  assert.equal(await aLatePromptBeforeRelease.count(), 1,
    "A must retain its original pending row after Node deletion and before the held response is released");
  const nodePresence = await nodeObserver.request("thread/presence/read", { threadId: targetThreadId }, 15_000);
  assert.deepEqual(nodePresence, {
    status: "absent",
    threadId: targetThreadId,
    reason: "boundDeletedPrimarySource",
  }, "the Node observer must confirm exact bound-deletion absence before Mobile resumes");

  await pageB.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const bTaskRoute = await waitFor(() => {
    try {
      const route = taskRoute(pageB.url());
      return route.threadId === targetThreadId ? route : null;
    } catch { return null; }
  }, TEST_TIMEOUT_MS, "Page B's real Mobile root route to restore the target from the shared last-route cache");
  assert.equal(bTaskRoute.profileId, profileId, "Page B must resume through the profile created by Mobile itself");
  assert.equal(bTaskRoute.serverId, targetRoute.serverId, "Page B must use the target's exact server route");
  assert.equal(bTaskRoute.cwd, targetRoute.cwd, "Page B must use the target's exact workspace route");
  const heldDeletedResume = await waitFor(() => bridgeB.state.heldResumeError ?? null,
    TEST_TIMEOUT_MS, "Page B's real thread/resume to return the typed deleted-thread error");
  assert.equal(heldDeletedResume.threadId, targetThreadId,
    "Page B's held resume failure must belong to the exact target route");
  assert.equal(heldDeletedResume.errorCode, -32022,
    "Page B must receive the Rust deleted-thread resume error code");

  const cachedView = await uniqueTestId(pageB, "session-cache-view", "visible");
  const cachedTargetPrompt = cachedView.getByTestId("message-user").filter({ hasText: targetFirstPrompt });
  await cachedTargetPrompt.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await cachedTargetPrompt.count(), 1,
    "Page B must visibly restore the exact cached target message while its real resume error is held");
  const bCachedCanonicalMessageId = await canonicalMessageId(cachedTargetPrompt);
  assert.equal(bCachedCanonicalMessageId, cacheBeforeLateTurn.target.markerMessageIds[0],
    "Page B's visible cached row must match the canonical ID in the exact target IndexedDB entry");
  await assertCachedSessionComposerReadOnly(pageB,
    "Page B stale cache until authoritative presence is resolved");

  bridgeB.releaseHeldResumeError();
  browserDiagnostics.phase = "multirealm-page-b-confirmed-absence-cleanup";
  const bPresence = await waitFor(() => bridgeB.state.presenceResponses.find(row =>
    row.threadId === targetThreadId && row.status === "absent" && row.reason === "boundDeletedPrimarySource") ?? null,
  TEST_TIMEOUT_MS, "Page B's product Runtime to issue and receive typed thread/presence/read");
  assert.equal(bPresence.errorCode, null, "Page B's typed presence request must succeed");
  assert.equal(bPresence.echoId, bPresence.requestId,
    "Page B's real presence response must echo its exact JSON-RPC request ID");
  await pageB.getByTestId("sessions-confirmed-absence-notice").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await pageB.getByTestId("session-cache-view").count(), 0,
    "Page B's authoritative confirmed absence must remove the cached conversation view");
  assert.equal(await pageB.getByTestId("message-input").count(), 0,
    "Page B's scoped Sessions route after cache revocation must not retain a composer");
  const sessionsUrl = new URL(pageB.url());
  assert.equal(sessionsUrl.pathname, `${MOBILE_MOUNT}/sessions`,
    "confirmed absence must move Page B to the actual Mobile Sessions route");
  assert.equal(sessionsUrl.searchParams.get("profileId"), profileId,
    "the Sessions route must retain the exact profile identity");
  assert.equal(sessionsUrl.searchParams.get("serverId"), targetRoute.serverId,
    "the Sessions route must retain the exact server identity");
  assert.equal(sessionsUrl.searchParams.get("cwd"), targetRoute.cwd,
    "the Sessions route must retain the exact workspace scope");
  assert.equal(sessionsUrl.searchParams.get("notice"), "confirmed-thread-absent",
    "the Sessions route must carry the product's confirmed-absence notice");

  const cacheAfterB = await waitFor(async () => {
    const snapshot = await readTranscriptCacheIndex(pageB, {
      targetThreadId, peerThreadId, expectedTargetKey: cacheBeforeLateTurn.target.key,
    });
    return isExactThreadInvalidationSnapshot(snapshot, cacheBeforeLateTurn.target) ? snapshot : null;
  }, 30_000, "Page B's product confirmed-absence path to invalidate the target cache entry");
  const cacheAfterBAtNodeMs = performance.now();
  assert.ok(cacheAfterB.peer, "the same-workspace peer cache entry must survive target deletion");
  assert.equal(cacheAfterB.peer.key, cacheBeforeLateTurn.peer.key,
    "target CAS must retain the peer's exact cache key");
  assert.equal(cacheAfterB.peer.dataRevision, cacheBeforeLateTurn.peer.dataRevision,
    "target CAS must not rewrite the peer's data revision");
  assert.equal(cacheAfterB.peer.workspaceKey, cacheBeforeLateTurn.peer.workspaceKey,
    "target CAS must preserve the same-workspace peer scope");
  assert.equal(pageA.isClosed(), false, "A must remain alive until after B's product CAS completes");
  assert.equal(taskRoute(pageA.url()).threadId, targetThreadId,
    "A must not navigate away from the old target Runtime before its response is released");

  browserDiagnostics.phase = "multirealm-release-a-late-authority";
  assert.equal(bridgeA.releaseHeldAuthority(), true,
    "the exact authority frame must be forwarded only after Page B commits its CAS tombstone");
  await waitFor(() => bridgeAState.heldAuthority?.forwardedAtMs ? true : null,
    15_000, "the exact already-returned Rust history page to be sent through A's original Browser socket after B's CAS");
  const heldResponseSha256 = createHash("sha256").update(heldAuthority.raw).digest("hex");
  browserDiagnostics.responseReceipt = {
    responseId: heldAuthority.responseId,
    responseSha256: heldResponseSha256,
    browserMessageEventReceived: false,
    eventLoopBarrierCompleted: false,
  };
  const browserResponseReceipt = await waitFor(async () => {
    const receipts = await pageA.evaluate(() => globalThis.__mobileMultirealmRpcResponseReceiptsV1 ?? []);
    return receipts.find(receipt => receipt?.id === String(heldAuthority.requestId) &&
      receipt?.sha256 === heldResponseSha256) ?? null;
  }, 15_000, "Page A's original Browser WebSocket message event to receive the exact held response bytes");
  assert.equal(browserResponseReceipt.id, String(heldAuthority.requestId),
    "the Browser-side witness must identify A's original JSON-RPC response ID");
  assert.equal(browserResponseReceipt.sha256, heldResponseSha256,
    "the Browser-side witness must hash the exact held response frame bytes");
  browserDiagnostics.responseReceipt.browserMessageEventReceived = true;
  await pageA.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  browserDiagnostics.responseReceipt.eventLoopBarrierCompleted = true;
  const aLatePrompt = pageA.getByTestId("message-list").getByTestId("message-user").filter({ hasText: targetLatePrompt });
  await aLatePrompt.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await aLatePrompt.count(), 1, "A's message-list must retain exactly one row for its existing late prompt");
  assert.equal(heldAuthority.responseId, String(heldAuthority.requestId),
    "A must receive the exact JSON-RPC response ID for its original held indexed request");
  assert.equal(heldAuthority.pageSideOpenAtForward, true,
    "the original Browser-side route must still be open when A receives its held response");
  assert.equal(heldAuthority.link.connection.state.serverClosed, true,
    "the held response must reach A after its Gateway-side route has closed");
  assert.equal(heldAuthority.link.connection.state.clientClosed, false,
    "delivering A's held response must not close the original Browser-side route");
  assert.equal(pageA.isClosed(), false, "A's original Page must remain live after the Browser receives the held response");

  // Allow Browser response handling and any queued cache work to settle before observing shared IndexedDB.
  await new Promise(resolve => setTimeout(resolve, 1_000));

  const cacheAfterA = await waitFor(async () => {
    const snapshot = await readTranscriptCacheIndex(pageB, {
      targetThreadId, peerThreadId, expectedTargetKey: cacheBeforeLateTurn.target.key,
    });
    return isExactThreadInvalidationSnapshot(snapshot, cacheBeforeLateTurn.target) &&
      snapshot.peer?.dataRevision === cacheBeforeLateTurn.peer.dataRevision ? snapshot : null;
  }, 10_000, "the shared IndexedDB state to remain stable after A receives the stale authority frame");
  assert.equal(cacheAfterA.manifest.revision, cacheAfterB.manifest.revision,
    "the shared manifest must not advance after Page A receives the held stale authority frame");
  assert.equal(cacheAfterA.target, null, "the deleted target cache entry must remain absent after Page A receives the held stale authority frame");
  assert.equal(cacheAfterA.peer.key, cacheBeforeLateTurn.peer.key,
    "the peer cache entry must remain present after Page A receives the held stale authority frame");
  assert.equal(cacheAfterA.peer.dataRevision, cacheBeforeLateTurn.peer.dataRevision,
    "the peer's exact data revision must remain unchanged after Page A receives the held stale authority frame");
  assert.equal(pageA.isClosed(), false, "A's old page must remain live through the post-release observation");

  const evidence = {
    status: "PASS_MULTIREALM_LATE_AUTHORITY_RECEIPT_NO_RESURRECTION",
    boundary: "Caller-pinned production Mobile archive served by an owned auth-disabled Gateway and procfs-verified Rust app-server; two concurrent pages share one private persistent profile and origin. Page A's real post-completion thread/read/indexed response is held after Rust returns it. A's Gateway-side WebSocket then closes and its Browser-side socket, Page, JavaScript realm, route, and pending request remain live; a separate Node Gateway client deletes the idle thread after a read-only presence barrier, Page B completes real Mobile resume/presence and target cache invalidation, and A then receives the exact held response frame. The Browser witness proves receipt of the exact response bytes only; it does not claim that A's Runtime attempted a cache save. This validates a stale authority delivered after A's Gateway transport disconnect; it does not claim an external delete while A's Gateway client remains connected. The cache artifact checks the pre-late-turn target slot/dataRevision tombstone and peer preservation; it does not expose the CAS expected-version argument. No fixture transcript, personal session, external Provider, or paid call.",
    archiveSha256: deployment.mobileWeb.archiveSha256,
    rust: ownedRustAtHeldAuthority,
    gateway: { authDisabled: gateway.authToken === "", mobileEntryStatus: mobileResponse.status },
    mobileBootstrap: { method: "POST /api/mobile/session", requestCount: mobileSessionBootstrap.requestCount,
      responseStatuses: mobileSessionBootstrap.responseStatuses,
      rpcTokenSource: "the real successful Mobile bootstrap response.rpcToken; value registered as secret and not persisted" },
    browser: {
      onePersistentContext: true,
      pageAAndBAliveAtGate: true,
      pageAAndBShareOwnedPersistentContext: true,
      sameOrigin: true,
      distinctLiveRealms: realmA !== realmB,
      pageAStayedOnTarget: true,
      pageARouteNeverBlanked: true,
      responseReceipt: {
        id: browserResponseReceipt.id,
        sha256: browserResponseReceipt.sha256,
        exactHeldFrameMatched: browserResponseReceipt.sha256 === heldResponseSha256,
        eventLoopBarrierCompleted: browserDiagnostics.responseReceipt.eventLoopBarrierCompleted,
      },
    },
    scope: { profileId, serverId: targetRoute.serverId, cwdMatchesRunWorkspace: targetRoute.cwd === workspace,
      targetThreadId, peerThreadId, targetAndPeerShareWorkspaceKey: cacheBeforeLateTurn.target.workspaceKey === cacheBeforeLateTurn.peer.workspaceKey },
    heldAuthority: {
      sourceMethod: "thread/read/indexed",
      returnedByOwnedRustBeforeNodeDelete: true,
      threadId: heldAuthority.threadId,
      requestId: heldAuthority.requestId,
      responseId: heldAuthority.responseId,
      responseIdMatchesRequest: heldAuthority.responseId === String(heldAuthority.requestId),
      pageSocketId: heldAuthority.socketId,
      pageSocketOpenWhenForwarded: heldAuthority.pageSideOpenAtForward,
      gatewaySocketClosedAtForward: heldAuthority.link.connection.state.serverClosed,
      pageSocketClosedAtForward: heldAuthority.link.connection.state.clientClosed,
      gatewayCloseObservedAtMs: heldAuthority.link.connection.state.serverClosedAtMs,
      rangeStart: heldAuthority.rangeStart,
      rangeEnd: heldAuthority.rangeEnd,
      messageCount: heldAuthority.messageCount,
      userMessageCanonicalId: heldAuthority.canonicalMessageId,
      clientMessageIdMatchedInMemory: heldAuthority.clientMessageIdMatches,
      forwardedOnlyAfterPageBCas: heldAuthority.forwardedAtMs > cacheAfterBAtNodeMs,
    },
    nodeDeletion: {
      rpcTokenNonEmpty: nodeObserverUrl.searchParams.get("token").length > 0,
      rpcTokenSource: "the successful Mobile bootstrap response; value registered as secret and not persisted",
      requestedAfterPageGatewayClose: nodeDeleteRequestedAtMs >= authorityLinkState.serverClosedAtMs,
      requestedAfterReadOnlyPresenceBarrier: nodeDeleteRequestedAtMs >= postDisconnectPresenceCompletedAtMs,
      pageGatewayCloseObservedAtMs: authorityLinkState.serverClosedAtMs,
      postDisconnectPresenceBarrier: {
        method: "thread/presence/read",
        status: postDisconnectPresence.status,
        reason: postDisconnectPresence.reason,
        requestedAtMs: postDisconnectPresenceRequestedAtMs,
        completedAtMs: postDisconnectPresenceCompletedAtMs,
      },
      requestedAtMs: nodeDeleteRequestedAtMs,
      acknowledgedAtMs: nodeDeleteAcknowledgedAtMs,
      targetDeleted: deleted.deleted === true,
      deletedThreadId: deleted.threadId,
      typedPresence: nodePresence,
    },
    pageB: {
      cachedRowCanonicalIdMatched: bCachedCanonicalMessageId === cacheBeforeLateTurn.target.markerMessageIds[0],
      resumeErrorCode: heldDeletedResume.errorCode,
      typedPresence: bPresence,
      sessionsNotice: sessionsUrl.searchParams.get("notice"),
    },
    cache: {
      targetBefore: cacheEntryEvidence(cacheBeforeLateTurn.target),
      peerBefore: cacheEntryEvidence(cacheBeforeLateTurn.peer),
      targetTombstoneAfterB: cacheAfterB.targetTombstone,
      targetAbsentAfterA: cacheAfterA.target === null,
      manifestRevisionAfterB: cacheAfterB.manifest.revision,
      manifestRevisionAfterA: cacheAfterA.manifest.revision,
      peerRevisionBefore: cacheBeforeLateTurn.peer.dataRevision,
      peerRevisionAfterA: cacheAfterA.peer.dataRevision,
    },
    secretsExported: false,
    personalSessionRead: false,
  };
  await context.writeArtifactJson("mobile-session-cache-multirealm-evidence.json", evidence);
  await closeRpcAndWait(nodeObserver, "multirealm Node deletion observer");
  browserDiagnostics.phase = "multirealm-complete";
  browserDiagnostics.bodyCompleted = true;
  return evidence;
  } catch (error) {
    browserDiagnostics.failure = {
      name: typeof error?.name === "string" ? error.name : "Error",
      category: classifyDiagnosticMessage(error?.message),
    };
    throw error;
  } finally {
    if (!browserDiagnostics.bodyCompleted) {
      await context.writeArtifactJsonInternal("mobile-session-cache-multirealm-runtime-diagnostics.json", {
        schemaVersion: 1,
        capturePoint: "suite-body-finally-before-run-context-resource-cleanup",
        caseId: browserDiagnostics.currentCase ?? "multirealm-suite-setup",
        phase: browserDiagnostics.phase,
        failure: browserDiagnostics.failure,
        gatewayLogArtifact: "logs/mobile-session-cache-multirealm-gateway.log",
        pages: await Promise.all(browserDiagnostics.pages.map(snapshotPageDiagnostics)),
        rpcBridges: browserDiagnostics.bridges.map(({ label, state }) => snapshotRpcBridgeDiagnostics(label, state)),
      });
    }
  }
});

async function createPageRpcBridge(page, options = {}) {
  const state = {
    nextSocketId: 0,
    routeCallbackCount: 0,
    clientFrameCount: 0,
    serverFrameCount: 0,
    unparsedClientFrameCount: 0,
    unparsedServerFrameCount: 0,
    droppedPageFramesAfterServerClose: 0,
    links: [],
    requests: [],
    responses: [],
    threadStarts: [],
    turnStarts: [],
    turnCompletions: [],
    resumeResponses: [],
    presenceResponses: [],
    heldAuthority: null,
    heldResumeError: null,
    targetThreadId: null,
    armedIndexedPrompt: null,
    armedResumeThreadId: options.holdDeletedResumeThreadId ?? null,
    diagnosticExpectedThreadId: null,
    diagnosticExpectedPrompt: null,
  };

  await registerPageRpcWebSocketRoute(page, socket => {
    state.routeCallbackCount++;
    const upstream = socket.connectToServer();
    const connection = createPageRpcBridgeConnection(socket, upstream);
    const link = {
      id: ++state.nextSocketId,
      socket,
      upstream,
      connection,
      requestsById: new Map(),
      turnThreadIds: new Set(),
    };
    state.links.push(link);
    socket.onMessage(raw => {
      state.clientFrameCount++;
      const frame = parseRpcFrame(raw);
      if (!frame) state.unparsedClientFrameCount++;
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const input = frame.method === "turn/start" ? frame.params?.input : null;
        const inputTypeCounts = Array.isArray(input) ? input.reduce((counts, item) => {
          const rawType = typeof item?.type === "string" ? item.type : "other";
          const type = ["text", "image", "audio", "resource"].includes(rawType) ? rawType : "other";
          counts[type] = (counts[type] ?? 0) + 1;
          return counts;
        }, {}) : null;
        const textItemCount = Array.isArray(input)
          ? input.filter(item => item?.type === "text" && typeof item.text === "string").length
          : null;
        const request = {
          id: String(frame.id),
          method: frame.method,
          threadId: typeof frame.params?.threadId === "string" ? frame.params.threadId : null,
          socketId: link.id,
          promptMarker: null,
          clientMessageId: null,
          turnId: null,
          ...(frame.method === "turn/start" ? {
            inputIsArray: Array.isArray(input),
            inputItemCount: Array.isArray(input) ? input.length : null,
            inputTypeCounts,
            textItemCount,
            hasText: textItemCount > 0,
          } : {}),
        };
        if (frame.method === "turn/start") {
          const text = Array.isArray(frame.params?.input)
            ? frame.params.input.filter(row => row?.type === "text" && typeof row.text === "string").map(row => row.text).join("\n")
            : "";
          const marker = [targetFirstPrompt, targetLatePrompt, peerPrompt].find(value => text.includes(value)) ?? null;
          request.promptMarker = marker;
          request.clientMessageId = typeof frame.params?.clientMessageId === "string" ? frame.params.clientMessageId : null;
          if (request.threadId) link.turnThreadIds.add(request.threadId);
          if (marker) state.turnStarts.push(request);
        }
        link.requestsById.set(request.id, request);
        state.requests.push(request);
      }
      if (!connection.sendToServer(raw)) state.droppedPageFramesAfterServerClose++;
    });
    upstream.onMessage(raw => {
      state.serverFrameCount++;
      const frame = parseRpcFrame(raw);
      if (!frame) state.unparsedServerFrameCount++;
      if (frame?.method === "turn/completed") {
        state.turnCompletions.push({
          threadId: frame.params?.threadId ?? frame.params?.turn?.threadId ?? null,
          turnId: frame.params?.turnId ?? frame.params?.turn?.id ?? null,
          status: frame.params?.turn?.status ?? null,
          socketId: link.id,
        });
      }
      const request = frame && frame.id !== undefined ? link.requestsById.get(String(frame.id)) : null;
      if (request) {
        const responseThreadId = typeof frame.result?.thread?.id === "string"
          ? frame.result.thread.id
          : typeof frame.result?.turn?.threadId === "string"
            ? frame.result.turn.threadId
            : typeof frame.result?.threadId === "string" ? frame.result.threadId : null;
        const response = {
          requestId: request.id,
          method: request.method,
          threadId: request.threadId,
          responseThreadId,
          outcome: frame.error ? "error" : "result",
          errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
          turnId: typeof frame.result?.turn?.id === "string" ? frame.result.turn.id : null,
        };
        request.response = response;
        state.responses.push(response);
      }
      if (request?.method === "thread/start" && typeof frame.result?.thread?.id === "string") {
        request.responseThreadId = frame.result.thread.id;
        state.threadStarts.push({ requestId: request.id, threadId: frame.result.thread.id, socketId: link.id });
      }
      if (request?.method === "turn/start" && typeof frame.result?.turn?.id === "string") {
        request.turnId = frame.result.turn.id;
        request.responseThreadId = typeof frame.result.turn.threadId === "string" ? frame.result.turn.threadId : request.threadId;
      }
      if (request?.method === "thread/resume") {
        const response = {
          requestId: request.id,
          threadId: request.threadId,
          socketId: link.id,
          errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
        };
        state.resumeResponses.push(response);
        if (state.armedResumeThreadId === request.threadId && response.errorCode === -32022 && !state.heldResumeError) {
          state.heldResumeError = { ...response, raw, link, receivedAtMs: performance.now() };
          return;
        }
      }
      if (request?.method === "thread/presence/read") {
        const response = frame.result ?? {};
        state.presenceResponses.push({
          requestId: request.id,
          echoId: String(frame.id),
          threadId: typeof response.threadId === "string" ? response.threadId : null,
          status: typeof response.status === "string" ? response.status : null,
          reason: typeof response.reason === "string" ? response.reason : null,
          errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
        });
      }
      if (request && isOwnedIndexedAuthorityResponse(request, frame, state.targetThreadId)) {
        const message = frame.result.messages.find(row => row?.role === "user" &&
          typeof row.content === "string" && row.content.includes(state.armedIndexedPrompt));
        if (message && !state.heldAuthority) {
          const lateTurn = state.turnStarts.find(row => row.threadId === state.targetThreadId &&
            row.promptMarker === state.armedIndexedPrompt);
          const held = {
            requestId: request.id,
            threadId: request.threadId,
            responseThreadId: frame.result.thread?.id,
            rangeStart: frame.result.rangeStart,
            rangeEnd: frame.result.rangeEnd,
            messageCount: frame.result.messages.length,
            socketId: link.id,
            canonicalMessageId: message.id,
            promptMarkerMatches: typeof message.id === "string",
            clientMessageIdMatches: Boolean(lateTurn?.clientMessageId) && message.clientMessageId === lateTurn.clientMessageId,
            receivedAtMs: performance.now(),
          };
          state.heldAuthority = { ...held, raw, link, forwardedAtMs: null };
          return;
        }
      }
      connection.sendToPage(raw);
    });
  });

  return {
    state,
    async disconnectHeldAuthorityUpstream() {
      const held = state.heldAuthority;
      if (!held || held.forwardedAtMs !== null) return false;
      return held.link.connection.disconnectServerPreservingPage();
    },
    releaseHeldAuthority() {
      const held = state.heldAuthority;
      if (!held || held.forwardedAtMs !== null) return false;
      const response = parseRpcFrame(held.raw);
      if (!response || String(response.id) !== String(held.requestId) ||
          !held.link.connection.state.serverClosed || held.link.connection.state.clientClosed) return false;
      if (!held.link.connection.sendToPage(held.raw)) return false;
      held.responseId = String(response.id);
      held.pageSideOpenAtForward = !held.link.connection.state.clientClosed;
      held.forwardedAtMs = performance.now();
      return true;
    },
    releaseHeldResumeError() {
      const held = state.heldResumeError;
      if (!held || held.forwardedAtMs !== undefined) return false;
      const response = parseRpcFrame(held.raw);
      if (!response || String(response.id) !== String(held.requestId) ||
          !held.link.connection.sendToPage(held.raw)) return false;
      held.responseId = String(response.id);
      held.forwardedAtMs = performance.now();
      return true;
    },
  };
}

function observePageDiagnostics(page, label) {
  const record = {
    label,
    page,
    pageErrors: [],
    consoleErrors: [],
    httpResponses: [],
    requestFailures: [],
    websockets: [],
  };
  page.on("pageerror", error => pushBounded(record.pageErrors, {
    name: typeof error?.name === "string" ? error.name : "Error",
    category: classifyDiagnosticMessage(error?.message),
  }));
  page.on("console", message => {
    if (!["error", "warning"].includes(message.type())) return;
    pushBounded(record.consoleErrors, { type: message.type(), category: classifyDiagnosticMessage(message.text()) });
  });
  page.on("response", response => {
    const path = safeRequestPath(response.url());
    if (!path.startsWith("/api/") && path !== "/rpc") return;
    pushBounded(record.httpResponses, {
      method: response.request().method(),
      path,
      status: response.status(),
    });
  });
  page.on("requestfailed", request => {
    pushBounded(record.requestFailures, {
      method: request.method(),
      path: safeRequestPath(request.url()),
      category: classifyDiagnosticMessage(request.failure()?.errorText),
    });
  });
  page.on("websocket", socket => {
    const event = { path: safeRequestPath(socket.url()), outcome: "opened", errorCategory: null };
    pushBounded(record.websockets, event);
    socket.on("socketerror", error => { event.errorCategory = classifyDiagnosticMessage(error); });
    socket.on("close", () => { event.outcome = "closed"; });
  });
  return record;
}

async function snapshotPageDiagnostics(record) {
  const { page, label } = record;
  const closed = page.isClosed();
  let location = null;
  try { location = safeMobileLocation(page.url()); } catch {}
  const testIds = [
    "welcome-direct-connection", "gateway-token", "gateway-connect", "new-workspace",
    "new-workspace-prompt", "create-workspace", "message-input", "send-message",
    "message-list", "message-user", "session-cache-view",
  ];
  const locatorCounts = await page.evaluate(ids => Object.fromEntries(ids.map(testId => {
    const matches = [...document.querySelectorAll("[data-testid]")].filter(element => element.getAttribute("data-testid") === testId);
    const first = matches[0];
    const style = first ? getComputedStyle(first) : null;
    const rect = first?.getBoundingClientRect();
    const firstVisible = Boolean(first && style && style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 && rect && rect.width > 0 && rect.height > 0);
    return [testId, { count: matches.length, firstVisible }];
  })), testIds).catch(() => Object.fromEntries(testIds.map(testId => [testId, { count: null, firstVisible: false }])));
  return {
    label,
    closed,
    location,
    locatorCounts,
    pageErrors: record.pageErrors.slice(-20),
    consoleErrors: record.consoleErrors.slice(-20),
    httpResponses: record.httpResponses.slice(-80),
    requestFailures: record.requestFailures.slice(-40),
    websockets: record.websockets.slice(-20),
  };
}

function snapshotRpcBridgeDiagnostics(label, state) {
  const expectedThreadId = state.diagnosticExpectedThreadId;
  const expectedPrompt = state.diagnosticExpectedPrompt;
  const requests = state.requests.slice(-100).map(request => ({
    requestIdHash: diagnosticIdHash(request.id),
    method: request.method,
    threadIdHash: diagnosticIdHash(request.threadId),
    exactThreadMatch: expectedThreadId ? request.threadId === expectedThreadId : null,
    inputIsArray: request.inputIsArray ?? null,
    inputTypeCounts: request.inputTypeCounts ?? null,
    hasText: request.hasText ?? null,
    expectedMarkerEquals: request.method === "turn/start" && expectedPrompt
      ? request.promptMarker === expectedPrompt
      : null,
    rpcResponseStatus: request.response?.outcome ?? "pending",
    rpcErrorCode: request.response?.errorCode ?? null,
    responseThreadIdHash: diagnosticIdHash(request.response?.responseThreadId),
    responseThreadMatchesExpected: expectedThreadId && request.response?.responseThreadId
      ? request.response.responseThreadId === expectedThreadId
      : null,
    turnIdHash: diagnosticIdHash(request.response?.turnId),
  }));
  const turnStartRequests = requests.filter(request => request.method === "turn/start");
  return {
    label,
    socketCount: state.links.length,
    livePageSocketCount: state.links.filter(link => !link.connection.state.clientClosed).length,
    gatewayClosedSocketCount: state.links.filter(link => link.connection.state.serverClosed).length,
    pageClosedSocketCount: state.links.filter(link => link.connection.state.clientClosed).length,
    droppedPageFramesAfterServerClose: state.droppedPageFramesAfterServerClose,
    socketLifecycles: state.links.slice(-20).map(link => ({
      socketId: link.id,
      serverClosed: link.connection.state.serverClosed,
      clientClosed: link.connection.state.clientClosed,
      serverCloseRequested: link.connection.state.serverCloseRequested,
      serverClosedAtMs: link.connection.state.serverClosedAtMs,
      clientClosedAtMs: link.connection.state.clientClosedAtMs,
      droppedPageFramesAfterServerClose: link.connection.state.droppedPageFramesAfterServerClose,
    })),
    websocketRouteCallbackCount: state.routeCallbackCount,
    clientFrameCount: state.clientFrameCount,
    serverFrameCount: state.serverFrameCount,
    unparsedClientFrameCount: state.unparsedClientFrameCount,
    unparsedServerFrameCount: state.unparsedServerFrameCount,
    expectedRouteThreadIdHash: diagnosticIdHash(expectedThreadId),
    requestCount: state.requests.length,
    responseCount: state.responses.length,
    requestMethodCounts: countMethods(state.requests),
    turnStartTotalCount: turnStartRequests.length,
    turnStartExactThreadMatchCount: turnStartRequests.filter(request => request.exactThreadMatch).length,
    turnStartExpectedMarkerMatchCount: turnStartRequests.filter(request => request.expectedMarkerEquals).length,
    threadStartReceipts: state.threadStarts.slice(-20).map(receipt => ({
      requestIdHash: diagnosticIdHash(receipt.requestId),
      responseThreadIdHash: diagnosticIdHash(receipt.threadId),
      exactThreadMatch: expectedThreadId ? receipt.threadId === expectedThreadId : null,
    })),
    requests,
    turnCompletions: state.turnCompletions.slice(-20).map(event => ({
      threadIdHash: diagnosticIdHash(event.threadId),
      exactThreadMatch: expectedThreadId ? event.threadId === expectedThreadId : null,
      turnIdHash: diagnosticIdHash(event.turnId),
      status: event.status,
    })),
  };
}

function countMethods(requests) {
  return requests.reduce((counts, request) => {
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    return counts;
  }, {});
}

function diagnosticIdHash(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return createHash("sha256").update("mobile-multirealm-diagnostic-v1\0").update(String(value)).digest("hex").slice(0, 12);
}

function safeMobileLocation(rawUrl) {
  const url = new URL(rawUrl);
  const segments = url.pathname.split("/");
  const homeIndex = segments.indexOf("h");
  if (homeIndex >= 0 && segments[homeIndex + 1]) {
    segments[homeIndex + 1] = ":profileId";
    if (segments[homeIndex + 2] === "task") {
      if (segments[homeIndex + 3]) segments[homeIndex + 3] = ":serverId";
      if (segments[homeIndex + 4]) segments[homeIndex + 4] = ":threadId";
    }
  }
  return {
    origin: url.origin,
    pathname: segments.join("/") || "/",
    queryKeys: [...url.searchParams.keys()].filter(key => !/(?:token|secret|credential|auth|password|key)/i.test(key)).sort(),
  };
}

function safeRequestPath(rawUrl) {
  try { return new URL(rawUrl).pathname; } catch { return "[invalid-url]"; }
}

function classifyDiagnosticMessage(value) {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (/timeout|timed out|deadline/.test(text)) return "timeout";
  if (/websocket|network|fetch|socket|net::/.test(text)) return "network";
  if (/unauthoriz|forbidden|auth|token/.test(text)) return "authorization";
  if (/protocol|json.?rpc|invalid frame|parse/.test(text)) return "protocol";
  if (/not found|undefined|null|not a function|cannot read/.test(text)) return "runtime";
  if (/error|failed|exception/.test(text)) return "generic-error";
  return text ? "other" : "unavailable";
}

function pushBounded(target, value, limit = 100) {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

async function connectFreshMobileProfile(page, gateway) {
  const direct = await uniqueTestId(page, "welcome-direct-connection", "visible");
  await direct.click();
  const token = await uniqueTestId(page, "gateway-token", "visible");
  await token.fill(gateway.authToken);
  assert.equal(gateway.authToken, "", "Mobile itself must bootstrap against the auth-disabled Gateway");
  const connect = await uniqueTestId(page, "gateway-connect", "visible");
  await Promise.all([
    page.waitForURL(url => url.pathname.startsWith(`${MOBILE_MOUNT}/h/`), { timeout: 30_000 }),
    connect.click(),
  ]);
}

async function openNewTaskFromHome(page, profileId, mobileEntryUrl, workspace) {
  if (!new URL(page.url()).pathname.startsWith(`${MOBILE_MOUNT}/h/`)) {
    await page.goto(new URL(`h/${encodeURIComponent(profileId)}`, mobileEntryUrl).href,
      { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  const create = await uniqueTestId(page, "new-workspace", "visible");
  await create.click();
  await uniqueTestId(page, "new-workspace-prompt", "visible");
  const local = await uniqueTestId(page, "server-option-local", "visible");
  await local.click();
  const workspacePath = await uniqueTestId(page, "workspace-path", "visible");
  await workspacePath.fill(workspace);
}

async function createFullTurn(page, prompt, bridgeState) {
  const promptInput = await uniqueTestId(page, "new-workspace-prompt", "visible");
  await promptInput.fill(prompt);
  const create = await uniqueTestId(page, "create-workspace", "visible");
  await create.click();
  const visibleUser = page.getByTestId("message-list").getByTestId("message-user").filter({ hasText: prompt });
  await visibleUser.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await visibleUser.count(), 1, "the product task must display one scoped user row for its exact prompt");
  const route = await waitFor(() => {
    try { return taskRoute(page.url()); } catch { return null; }
  }, 30_000, "the real Mobile task route to contain a canonical thread ID and workspace scope");
  bridgeState.diagnosticExpectedThreadId = route.threadId;
  bridgeState.diagnosticExpectedPrompt = prompt;
  const start = await waitFor(() => bridgeState.turnStarts.find(row =>
    row.threadId === route.threadId && row.promptMarker === prompt) ?? null,
  30_000, "the real Mobile turn/start frame bound to the task's canonical thread ID");
  assert.ok(start.clientMessageId, "the real Mobile turn/start request must carry a clientMessageId");
  await waitFor(() => start.turnId && start.responseThreadId === route.threadId ? true : null,
    15_000, "Rust thread/start and turn/start receipts to retain their canonical IDs");
  const threadStart = bridgeState.threadStarts.find(row => row.threadId === route.threadId);
  assert.equal(threadStart?.threadId, route.threadId,
    "the task route thread ID must match the canonical Rust thread/start response");
  await waitFor(() => bridgeState.turnCompletions.find(row =>
    row.threadId === route.threadId && row.turnId === start.turnId && row.status === "completed") ?? null,
  TEST_TIMEOUT_MS, "the local full-turn scenario to complete in Rust");
  return route.threadId;
}

async function uniqueTestId(page, testId, state = "visible") {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state, timeout: 30_000 });
  assert.equal(await locator.count(), 1, `Mobile locator ${testId} must be unique before interaction`);
  return locator;
}

function taskRoute(rawUrl) {
  const url = new URL(rawUrl);
  assert.equal(url.pathname.startsWith(`${MOBILE_MOUNT}/`), true, "task URL must remain under the production Mobile mount");
  const segments = url.pathname.slice(MOBILE_MOUNT.length).split("/").filter(Boolean).map(decodeURIComponent);
  assert.equal(segments[0], "h", "Mobile task URL must identify a Gateway profile route");
  assert.equal(segments[2], "task", "Mobile URL must identify a task page");
  assert.ok(segments[1] && segments[3] && segments[4], "Mobile task route must include profile, server and canonical thread IDs");
  const cwd = url.searchParams.get("cwd");
  assert.ok(cwd, "Mobile task URL must preserve its exact workspace query");
  return { profileId: segments[1], serverId: segments[3], threadId: segments[4], cwd };
}

function profileIdFromMobileRoute(rawUrl) {
  const url = new URL(rawUrl);
  const segments = url.pathname.slice(MOBILE_MOUNT.length).split("/").filter(Boolean).map(decodeURIComponent);
  assert.equal(segments[0], "h", "Mobile bootstrap must route into its actual profile home");
  assert.ok(segments[1], "Mobile profile route must have a stable profile ID");
  return segments[1];
}

async function canonicalMessageId(locator) {
  return locator.evaluate(element => {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (!node.id?.startsWith("message-")) continue;
      const encoded = node.id.slice("message-".length);
      try { return decodeURIComponent(encoded); } catch { return encoded; }
    }
    return null;
  });
}

async function readTranscriptCacheIndex(page, {
  targetThreadId, peerThreadId, targetMarker, peerMarker, expectedTargetKey = null,
} = {}) {
  return page.evaluate(async input => {
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
      const snapshot = await new Promise((resolve, reject) => {
        let manifest;
        const records = new Map();
        const transaction = db.transaction(["manifest", "entries"], "readonly");
        transaction.objectStore("manifest").get("current").onsuccess = event => {
          const raw = event.target.result;
          if (typeof raw === "string" && raw.length <= 64 * 1024) {
            try { manifest = JSON.parse(raw); } catch {}
          }
        };
        const entries = transaction.objectStore("entries");
        const cursor = entries.openCursor();
        cursor.onsuccess = event => {
          const item = event.target.result;
          if (!item) return;
          records.set(item.key, item.value);
          item.continue();
        };
        transaction.oncomplete = () => resolve({ manifest, records });
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("cache read transaction aborted"));
      });
      const manifest = snapshot.manifest;
      if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || !Array.isArray(manifest.invalidations)) return { ready: false };
      const rows = [];
      for (const row of manifest.entries) {
        const record = snapshot.records.get(row.slot);
        if (!record || !(record.blob instanceof Blob) || record.revision !== row.dataRevision || record.blob.size > 512 * 1024) continue;
        let parsed;
        try { parsed = JSON.parse(await record.blob.text()); } catch { continue; }
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const markerIds = marker => marker
          ? messages.filter(message => message?.role === "user" && typeof message.content === "string" && message.content.includes(marker))
            .map(message => typeof message.id === "string" ? message.id : null).filter(Boolean)
          : [];
        rows.push({
          key: row.key,
          slot: row.slot,
          dataRevision: row.dataRevision,
          workspaceKey: row.workspaceKey,
          threadId: parsed?.scope?.threadId ?? null,
          cwd: parsed?.scope?.cwd ?? null,
          targetMarkerMessageIds: parsed?.scope?.threadId === input.targetThreadId ? markerIds(input.targetMarker) : [],
          peerMarkerMessageIds: parsed?.scope?.threadId === input.peerThreadId ? markerIds(input.peerMarker) : [],
          messageCount: messages.length,
        });
      }
      const target = rows.find(row => row.threadId === input.targetThreadId) ?? null;
      const peer = rows.find(row => row.threadId === input.peerThreadId) ?? null;
      const targetTombstone = input.expectedTargetKey
        ? manifest.invalidations.find(item => item?.key === `t:${input.expectedTargetKey}`) ?? null
        : null;
      return { ready: true, manifest: { revision: manifest.revision, lastKey: manifest.lastKey,
        invalidations: manifest.invalidations.map(item => ({ key: item?.key ?? null, revision: item?.revision ?? null })) }, entries: rows,
        slotRevisions: [...snapshot.records].map(([slot, record]) => ({
          slot,
          revision: Number.isSafeInteger(record?.revision) ? record.revision : null,
        })),
        target: target ? { ...target, markerMessageIds: target.targetMarkerMessageIds } : null,
        peer: peer ? { ...peer, markerMessageIds: peer.peerMarkerMessageIds } : null,
        targetTombstone };
    } finally { db.close(); }
  }, { targetThreadId, peerThreadId, targetMarker, peerMarker, expectedTargetKey });
}

function cacheEntryEvidence(entry) {
  return { key: entry.key, slot: entry.slot, dataRevision: entry.dataRevision, workspaceKey: entry.workspaceKey,
    markerMessageId: entry.markerMessageIds[0], messageCount: entry.messageCount };
}

async function verifyOwnedRustAppServer(gateway, executablePath, expectedSha256) {
  const matches = await findOwnedExecutableProcesses({ pgid: gateway.child.pid, executablePath });
  const owned = matches.find(process => process.sha256 === expectedSha256);
  assert.ok(owned, "real procfs /proc/<pid>/exe bytes must identify the caller-pinned Rust child in the owned Gateway process group");
  const configured = await hashExecutableFile(executablePath);
  assert.equal(configured.sha256, expectedSha256,
    "the configured Rust app-server bytes must retain the caller-pinned SHA-256");
  return { callerSha256: expectedSha256, ownedProcfsSha256: owned.sha256, ownedChildObserved: true };
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && isAbsolute(value), `${name} must be an explicit absolute caller pin`);
  assert.equal(resolve(value), value, `${name} must be normalized`);
  return value;
}

function requiredSha256(name) {
  const value = process.env[name];
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${name} must be an explicit lowercase SHA-256 caller pin`);
  return value;
}
