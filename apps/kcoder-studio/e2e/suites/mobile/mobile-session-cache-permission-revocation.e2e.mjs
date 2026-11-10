import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startMobileGatewayAliasProxy } from "../../harness/mobile-gateway-alias-proxy.mjs";
import { restorePinnedGatewayMobileDeployment } from "../../harness/mobile-pinned-gateway-deployment.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import { parseRpcFrame, registerPageRpcWebSocketRoute, createPageRpcBridgeConnection } from "./mobile-session-cache-multirealm-helpers.mjs";
import { requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";

const MOBILE_PREFIX = "/mobile";
const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const TARGET_PROMPT_PREFIX = "CACHE_PERMISSION_REVOKE_";
const EXPECTED_RUST_SHA256 = requiredSha256("KCODER_E2E_KCODER_BIN_SHA256");
const RUST_BINARY = requiredAbsolutePath("KCODER_E2E_KCODER_BIN");
assertRevocationObservationPureContracts();
if (process.argv.includes("--pure-observation-contracts")) {
  process.stdout.write("Permission revocation observation contracts passed.\n");
  process.exit(0);
}

await runE2E(import.meta.url, {
  testId: "mobile-session-cache-permission-revocation",
  tier: "full-integration",
  modelPolicy: "caller-pinned production Mobile archive, run-owned authenticated loopback Gateway, procfs-verified caller-pinned Rust app-server, and two real durable Mobile device grants; deterministic local full turns only, no external Provider, paid call, personal profile, or model behavior claim",
  coverage: {
    included: [
      "real same-origin A/B Mobile profiles and distinct persisted transcript cache scopes through two authenticated Gateway path aliases",
      "B's real device bearer revokes only A's device grant through the Gateway device-management API",
      "A's actual browser HTTP 401 makes its task cache unavailable and clears only A's persistent transcript entries while B's entry remains intact",
    ],
    excluded: ["stale-401/ABA races", "unknown/offline probe behavior", "native-device acceptance", "public Gateway or Relay behavior"],
  },
}, async context => {
  const diagnostics = {
    phase: "suite-start",
    archive: null,
    rust: null,
    gateway: null,
    proxy: null,
    grants: { pairingTokenIssued: false, bootstrapStatuses: [] },
    pages: { ownedPageCount: 0, pageErrors: 0 },
    http401: [],
    revocation: null,
    bridge: null,
    failure: null,
  };
  let page;
  let chromium;
  let grantB;
  let rpcWitness;
  let authorizationHttp;
  let revokeWatermark;
  let aRpcConnectionsAtRevoke;
  const pendingCaptures = new Set();
  try {
    diagnostics.phase = "restore-caller-pinned-mobile-archive";
    const mobileDeployment = await restorePinnedGatewayMobileDeployment(context, {
      outputName: "mobile-session-cache-permission-revocation",
    });
    diagnostics.archive = {
      archiveSha256: mobileDeployment.mobileWeb.archiveSha256,
      sourceTreeSha256: mobileDeployment.mobileWeb.sourceTreeSha256,
      sourceManifestSha256: mobileDeployment.sourceIdentity.snapshotProof?.manifestSha256 ?? null,
    };

    diagnostics.phase = "verify-caller-pinned-rust-input";
    const rustStat = await lstat(RUST_BINARY);
    assert.ok(rustStat.isFile() && (rustStat.mode & 0o111) !== 0,
      "the caller-pinned KCoder app-server must be an executable regular file");
    await requireExecutable(RUST_BINARY, "caller-pinned KCoder app-server");
    const rustConfigured = await hashExecutableFile(RUST_BINARY);
    assert.equal(rustConfigured.sha256, EXPECTED_RUST_SHA256,
      "the configured Rust app-server must match the explicit caller SHA-256 pin");

    const configDir = context.pathInState("private-config");
    const workspaceA = context.pathInState("workspace-a");
    const workspaceB = context.pathInState("workspace-b");
    await Promise.all([
      mkdir(configDir, { recursive: true, mode: 0o700 }),
      mkdir(workspaceA, { recursive: true, mode: 0o700 }),
      mkdir(workspaceB, { recursive: true, mode: 0o700 }),
    ]);
    await chmod(configDir, 0o700);

    diagnostics.phase = "start-owned-same-origin-alias-proxy";
    const aliasProxy = await startMobileGatewayAliasProxy(context, {
      label: "mobile-session-cache-permission-revocation-alias-proxy",
      aliases: ["a", "b"],
    });
    diagnostics.proxy = { loopbackOnly: new URL(aliasProxy.origin).hostname === "127.0.0.1", aliases: aliasProxy.aliases.length };

    diagnostics.phase = "start-owned-authenticated-gateway";
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-session-cache-permission-revocation-gateway",
      workspace: workspaceA,
      kcoderBin: RUST_BINARY,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDeployment.deployment.path,
        KCODER_STUDIO_PUBLIC_ORIGINS: aliasProxy.origin,
        KCODER_STUDIO_MOBILE_WEB_ORIGINS: aliasProxy.origin,
      },
    });
    aliasProxy.setGateway(gateway);
    assert.ok(gateway.authToken.length >= 16, "the owned Gateway must require authentication");
    diagnostics.gateway = { authRequired: true, loopbackOnly: gateway.host === "127.0.0.1" };

    const mobileEntryA = await fetch(aliasProxy.mobileEntryUrl("a"), { redirect: "error", cache: "no-store" });
    const mobileEntryB = await fetch(aliasProxy.mobileEntryUrl("b"), { redirect: "error", cache: "no-store" });
    assert.equal(mobileEntryA.status, 200, "A's signed Mobile alias mount must serve the pinned production Mobile archive");
    assert.equal(mobileEntryB.status, 200, "B's signed Mobile alias mount must serve the pinned production Mobile archive");
    await Promise.all([mobileEntryA.body?.cancel(), mobileEntryB.body?.cancel()]);

    diagnostics.phase = "create-run-owned-mobile-pairing-credential";
    const pairingToken = await getOwnedGatewayPairingCredential(context, gateway);
    diagnostics.grants.pairingTokenIssued = true;

    diagnostics.phase = "start-private-persistent-chromium-profile";
    chromium = await startChromium(context, {
      label: "mobile-session-cache-permission-revocation-chromium",
      profileName: "mobile-session-cache-permission-revocation",
      startTimeoutMs: 60_000,
    });
    const browserContexts = chromium.browser.contexts();
    assert.equal(browserContexts.length, 1, "the Chromium harness must own one private persistent profile context");
    const persistentContext = browserContexts[0];
    page = await chromium.newPersistentPage();
    diagnostics.pages.ownedPageCount = 1;
    page.on("pageerror", () => { diagnostics.pages.pageErrors++; });
    rpcWitness = await installRpcWitness(page);
    authorizationHttp = observeMobileAuthorizationHttp(page, context);

    diagnostics.phase = "pair-real-profile-b-and-seed-its-cache";
    const bootstrapB = captureMobileBootstrap(page, context, pendingCaptures, diagnostics.grants.bootstrapStatuses);
    await connectMobileProfile(page, aliasProxy, "b", pairingToken);
    const grantResultB = await bootstrapB.wait(context);
    scheduleDeviceCleanupIfAvailable(context, aliasProxy, "b", grantResultB, "B");
    grantB = requireDurableDeviceGrant(grantResultB, "B");
    authorizationHttp.expectGrant("b", grantB);
    const profileB = await profileMetadataForRoute(page, "b", aliasProxy);
    verifyGrantMatchesProfile(grantB, profileB, "B");
    const promptB = uniquePrompt("B");
    context.registerSecret(promptB);
    const threadB = await createRealMobileFullTurn(page, "b", workspaceB, promptB, rpcWitness.state, context);
    const taskUrlB = page.url();
    const routeB = parseTaskRoute(taskUrlB);
    assert.equal(routeB.profileId, profileB.id, "B's task route must be owned by B's actual paired profile");
    assert.equal(routeB.cwd, workspaceB, "B's Rust task must use its run-owned workspace");
    const cacheB = await waitFor(async () => {
      const inventory = await readCacheInventory(page, { markers: [{ name: "b", value: promptB }] });
      const row = inventory.entries.find(item => item.profileId === profileB.id && item.threadId === threadB);
      return row ? { inventory, row } : null;
    }, 30_000, "B's real completed Mobile turn to commit its profile-scoped IndexedDB transcript", 50, context.abortSignal);
    assertCacheRow(cacheB.row, profileB, grantB, routeB, workspaceB, "B", "b");

    diagnostics.phase = "close-b-realm-before-pairing-profile-a";
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15_000 });
    await waitFor(() => rpcWitness.state.links.some(link => link.alias === "b") && rpcWitness.state.links
      .filter(link => link.alias === "b").every(link => link.connection.state.clientClosed && link.connection.state.serverClosed)
      ? true : null,
    15_000, "Playwright's B WebSocket route endpoints to report closure from the about:blank navigation before pairing A in a fresh JavaScript realm", 50, context.abortSignal);

    diagnostics.phase = "pair-real-profile-a-and-seed-its-cache";
    const bootstrapA = captureMobileBootstrap(page, context, pendingCaptures, diagnostics.grants.bootstrapStatuses);
    await connectMobileProfile(page, aliasProxy, "a", pairingToken);
    const grantResultA = await bootstrapA.wait(context);
    scheduleDeviceCleanupIfAvailable(context, aliasProxy, "a", grantResultA, "A");
    const grantA = requireDurableDeviceGrant(grantResultA, "A");
    authorizationHttp.expectGrant("a", grantA);
    const profileA = await profileMetadataForRoute(page, "a", aliasProxy);
    verifyGrantMatchesProfile(grantA, profileA, "A");
    assert.ok(profileA.id !== profileB.id, "same-origin Gateway aliases must persist distinct Mobile profile identities");
    assert.ok(profileA.baseUrl !== profileB.baseUrl, "A and B profile cache scopes must retain their distinct alias base URLs");
    assert.equal(new URL(profileA.baseUrl).origin, new URL(profileB.baseUrl).origin,
      "A and B must share one exact browser origin and IndexedDB namespace");
    assert.ok(profileA.deviceId !== profileB.deviceId, "real Mobile pairing must issue distinct durable device grants");

    const promptA = uniquePrompt("A");
    context.registerSecret(promptA);
    const threadA = await createRealMobileFullTurn(page, "a", workspaceA, promptA, rpcWitness.state, context);
    const taskUrlA = page.url();
    const routeA = parseTaskRoute(taskUrlA);
    assert.equal(routeA.profileId, profileA.id, "A's task route must be owned by A's actual paired profile");
    assert.equal(routeA.cwd, workspaceA, "A's Rust task must use its run-owned workspace");
    const cacheBeforeRevoke = await waitFor(async () => {
      const inventory = await readCacheInventory(page, { markers: [{ name: "a", value: promptA }, { name: "b", value: promptB }] });
      const rowA = inventory.entries.find(item => item.profileId === profileA.id && item.threadId === threadA);
      const rowB = inventory.entries.find(item => item.profileId === profileB.id && item.threadId === threadB);
      return rowA && rowB ? { inventory, rowA, rowB } : null;
    }, 30_000, "both real A and B transcript cache rows to coexist in this browser origin's IndexedDB", 50, context.abortSignal);
    assertCacheRow(cacheBeforeRevoke.rowA, profileA, grantA, routeA, workspaceA, "A", "a");
    assertCacheRow(cacheBeforeRevoke.rowB, profileB, grantB, routeB, workspaceB, "B", "b");
    assert.ok(cacheBeforeRevoke.rowA.key !== cacheBeforeRevoke.rowB.key,
      "the two same-origin profiles must own different transcript entry keys");

    diagnostics.phase = "verify-the-owned-rust-server-before-revocation";
    const rustBeforeRevoke = await verifyOwnedRustAppServer(gateway, RUST_BINARY, EXPECTED_RUST_SHA256);
    diagnostics.rust = rustBeforeRevoke;

    diagnostics.phase = "b-bearer-deletes-only-a-device-grant";
    revokeWatermark = authorizationHttp.watermark();
    aRpcConnectionsAtRevoke = snapshotOpenAConnections(rpcWitness.state, revokeWatermark.observedAtMs);
    assert.ok(aRpcConnectionsAtRevoke.linkOrdinals.length > 0,
      "at least one concrete A Gateway WebSocket connection must be open immediately before revocation");
    diagnostics.revocation = {
      requestObservationWatermark: revokeWatermark,
      aOpenRpcConnectionsAtRequest: {
        capturedAtMs: aRpcConnectionsAtRevoke.capturedAtMs,
        linkOrdinals: aRpcConnectionsAtRevoke.linkOrdinals,
      },
      deleteStatus: null,
    };
    const revokeResponse = await ownedGatewayRequest(aliasProxy.baseUrl("b"), `/api/mobile/devices/${encodeURIComponent(grantA.deviceId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${grantB.accessToken}` },
    });
    diagnostics.revocation.deleteStatus = revokeResponse.status;
    assert.equal(revokeResponse.status, 204,
      "B's real Mobile device bearer must revoke A through the Gateway's actual device-management endpoint");
    await revokeResponse.body?.cancel();

    diagnostics.phase = "observe-a-real-browser-unauthorized-response-and-product-denial";
    const deniedRequest = await waitFor(async () => {
      await authorizationHttp.flush();
      return findCapturedGrantUnauthorizedAfterWatermark(authorizationHttp.rows, revokeWatermark, grantA);
    }, 30_000, "A's product-owned browser response observer to capture a post-DELETE-watermark HTTP 401 for the same durable grant", 50, context.abortSignal);
    assert.ok(["servers", "refresh"].includes(deniedRequest.endpoint),
      "the 401 must come from the actual authenticated /api/servers or /api/mobile/session/refresh route");
    diagnostics.revocation.a401Observation = summarizeHttpObservation(deniedRequest);
    diagnostics.http401 = authorizationHttp.rows.filter(row => row.status === 401).map(summarizeHttpObservation);
    await waitFor(() => capturedAConnectionsClosedAfterSnapshot(aRpcConnectionsAtRevoke, rpcWitness.state.links)
      ? true : null,
    15_000, "every A Gateway WebSocket connection observed open before DELETE to receive a new server-side close", 50, context.abortSignal);
    const aRpcCloseEvidence = summarizeAConnectionSnapshot(aRpcConnectionsAtRevoke, rpcWitness.state.links);
    diagnostics.revocation.aRpcCloseEvidence = aRpcCloseEvidence;

    await page.goto(`${aliasProxy.baseUrl("a")}${MOBILE_PREFIX}/h/${encodeURIComponent(profileA.id)}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 });
    const reauthorizeButton = page.getByTestId("reauthorize-active-profile");
    await reauthorizeButton.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await reauthorizeButton.count(), 1,
      "the exact active A profile must expose Mobile's real reauthorization action after the captured 401");

    diagnostics.phase = "wait-for-exact-a-cache-invalidation-and-b-peer-preservation";
    const cacheAfterAInvalidation = await waitFor(async () => {
      const inventory = await readCacheInventory(page, { markers: [{ name: "a", value: promptA }, { name: "b", value: promptB }] });
      const remainingA = inventory.entries.filter(item => item.profileId === profileA.id);
      const remainingB = inventory.entries.find(item => item.profileId === profileB.id && item.threadId === threadB);
      return inventory.ready && remainingA.length === 0 && remainingB
        ? { inventory, remainingA, remainingB } : null;
    }, 20_000, "A's auth-denied profile cleanup to delete all and only A transcript entries while retaining B", 50, context.abortSignal);
    assert.deepEqual(cacheAfterAInvalidation.remainingA, [], "A's exact profile-scoped persistent transcript entries must be removed");
    assert.equal(cacheAfterAInvalidation.remainingB.key, cacheBeforeRevoke.rowB.key,
      "B's peer cache entry key must remain unchanged by A's profile invalidation");
    assert.equal(cacheAfterAInvalidation.remainingB.slot, cacheBeforeRevoke.rowB.slot,
      "B's peer cache slot must remain unchanged by A's profile invalidation");
    assert.equal(cacheAfterAInvalidation.remainingB.dataRevision, cacheBeforeRevoke.rowB.dataRevision,
      "B's peer cache record revision must remain unchanged by A's profile invalidation");

    const profileStateAfter401 = await readProfileMetadataById(page, profileA.id, profileB.id);
    assert.equal(profileStateAfter401.a.baseUrl, profileA.baseUrl,
      "A's profile metadata must remain available for its explicit reauthorization flow");
    assert.equal(profileStateAfter401.b.baseUrl, profileB.baseUrl,
      "B's independent profile metadata must remain intact");
    assert.equal(profileStateAfter401.a.reauthorizationRequiredScope, profileAuthorizationScopeKey(profileA),
      "the persistent denial marker must bind only A's exact profile authorization scope");
    assert.notEqual(profileStateAfter401.b.reauthorizationRequiredScope, profileAuthorizationScopeKey(profileB),
      "A's denial marker must not mark B as requiring reauthorization");

    diagnostics.phase = "verify-a-cached-task-is-not-rendered-after-denial";
    await page.goto(taskUrlA, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const routeAfterDenial = await waitFor(() => {
      try { return parseTaskRoute(page.url()); } catch { return null; }
    }, 15_000, "A's saved task route to remain addressable during its reauthorization recovery", 50, context.abortSignal);
    assert.equal(routeMatches(routeAfterDenial, routeA), true,
      "auth denial must not rewrite A's task route into confirmed absence navigation");
    await waitFor(async () => {
      const cacheViewCount = await page.getByTestId("session-cache-view").count();
      const targetMessageCount = await page.getByTestId("message-list").getByTestId("message-user")
        .filter({ hasText: promptA }).count().catch(() => 0);
      return cacheViewCount === 0 && targetMessageCount === 0 ? true : null;
    }, 15_000, "a fresh Page JavaScript realm to hide A's removed cached transcript instead of rendering stale content", 50, context.abortSignal);
    const noAbsenceNavigation = await page.getByTestId("sessions-confirmed-absence-notice").count();
    assert.equal(noAbsenceNavigation, 0, "authorization denial must not masquerade as confirmed thread absence");

    diagnostics.phase = "prove-b-remains-authorized-after-a-revocation";
    const bServersAfterRevoke = await ownedGatewayRequest(aliasProxy.baseUrl("b"), "/api/servers", {
      headers: { authorization: `Bearer ${grantB.accessToken}` },
    });
    assert.equal(bServersAfterRevoke.status, 200,
      "the same B device bearer must remain authorized after revoking A");
    await bServersAfterRevoke.body?.cancel();
    const bDevicesAfterRevoke = await ownedGatewayRequest(aliasProxy.baseUrl("b"), "/api/mobile/devices", {
      headers: { authorization: `Bearer ${grantB.accessToken}` },
    });
    assert.equal(bDevicesAfterRevoke.status, 200, "B must retain permission to inspect its owned Gateway device grants");
    const bDeviceList = await bDevicesAfterRevoke.json();
    const remainingDeviceIds = Array.isArray(bDeviceList?.devices)
      ? bDeviceList.devices.map(device => device?.id).filter(value => typeof value === "string") : [];
    assert.ok(remainingDeviceIds.includes(grantB.deviceId), "the active B grant must remain in the real Gateway device inventory");
    assert.equal(remainingDeviceIds.includes(grantA.deviceId), false, "the revoked A grant must disappear from the real Gateway device inventory");
    const rustAfterRevoke = await verifyOwnedRustAppServer(gateway, RUST_BINARY, EXPECTED_RUST_SHA256);
    assert.deepEqual(rustAfterRevoke, rustBeforeRevoke,
      "the actual same Rust process and caller-pinned executable must serve A/B setup and post-revocation observations");

    diagnostics.phase = "write-pass-evidence";
    await context.writeArtifactJson("mobile-session-cache-permission-revocation.json", {
      status: "PASS_REAL_DEVICE_GRANT_REVOCATION_AND_PROFILE_CACHE_ISOLATION",
      boundary: "Two real durable Mobile profiles were paired through one authenticated RunContext-owned Gateway using distinct /g/a and /g/b aliases on the same browser origin. Each completed a deterministic local Rust full turn and wrote a distinct IndexedDB transcript scope. Before pairing A, the suite navigated B's Page to about:blank to tear down B's JavaScript realm; the B route endpoint close callbacks produced by that navigation are Playwright-synthesized and do not claim an observed Gateway EOF or lease release. Immediately before B's captured Mobile bearer issued the real DELETE /api/mobile/devices/{A-device-id}, the suite recorded an HTTP response-observer ordinal/time watermark and the exact A Gateway WebSocket connections still open. The DELETE returned 204; a matching A HTTP 401 was observed above that watermark for the same captured device ID and authorization generation, and every snapshotted A connection later reported a server-side close timestamp above the pre-request snapshot. Those A observations are tied to the successful DELETE operation window; a Gateway close may occur before the DELETE response returns, so the artifact does not claim that each close followed the 204 response. A then showed the reauthorization action and its exact persistent transcript rows were removed. A fresh Page JavaScript realm did not render the removed A transcript or claim confirmed absence. B's captured bearer still read /api/servers and the real device inventory still contained B while A was absent. All credentials and transcript content stayed in memory and were excluded from artifacts.",
      pins: {
        mobileArchiveSha256: mobileDeployment.mobileWeb.archiveSha256,
        mobileSourceTreeSha256: mobileDeployment.mobileWeb.sourceTreeSha256,
        mobileSourceManifestSha256: mobileDeployment.sourceIdentity.snapshotProof?.manifestSha256 ?? null,
        rustCallerSha256: EXPECTED_RUST_SHA256,
        rustOwnedProcfsSha256: rustAfterRevoke.ownedProcfsSha256,
      },
      originAndProfiles: {
        sameBrowserOrigin: new URL(profileA.baseUrl).origin === new URL(profileB.baseUrl).origin,
        samePersistentContext: page.context() === persistentContext,
        aliasAProfileHash: hashId(profileA.id),
        aliasBProfileHash: hashId(profileB.id),
        aliasesDiffer: profileA.baseUrl !== profileB.baseUrl,
        distinctDurableDeviceGrants: profileA.deviceId !== profileB.deviceId,
      },
      pairing: {
        aliasAStatus: grantResultA.status,
        aliasBStatus: grantResultB.status,
        durableCapabilityForA: grantA.capabilities.mobileRefreshV1 === true && grantA.capabilities.mobileDeviceManagementV1 === true,
        durableCapabilityForB: grantB.capabilities.mobileRefreshV1 === true && grantB.capabilities.mobileDeviceManagementV1 === true,
        rawPairingOrAccessCredentialsPersisted: false,
      },
      cacheBeforeRevoke: {
        aliasA: cacheRowEvidence(cacheBeforeRevoke.rowA, profileA, workspaceA),
        aliasB: cacheRowEvidence(cacheBeforeRevoke.rowB, profileB, workspaceB),
        sharedIndexedDbNamespace: true,
      },
      revocation: {
        method: "DELETE",
        path: "/api/mobile/devices/{A-device-id}",
        bearerProfile: "B",
        status: revokeResponse.status,
        aRealHttp401: summarizeHttpObservation(deniedRequest),
        requestObservationWatermark: revokeWatermark,
        a401ObservedAfterRequestWatermark: deniedRequest.responseCallbackOrdinal > revokeWatermark.responseCallbackOrdinal,
        a401MatchesCapturedADeviceGrant: deniedRequest.grantDeviceId === grantA.deviceId &&
          deniedRequest.grantAuthorizationGeneration === grantA.authorizationGeneration,
        aRpcServerSideCloseEvidence: aRpcCloseEvidence,
        aReauthorizationActionVisible: true,
        aPersistentTranscriptEntriesAfter: cacheAfterAInvalidation.remainingA.length,
        bCacheEntryPreserved: {
          keyHashUnchanged: cacheAfterAInvalidation.remainingB.key === cacheBeforeRevoke.rowB.key,
          slotUnchanged: cacheAfterAInvalidation.remainingB.slot === cacheBeforeRevoke.rowB.slot,
          dataRevisionUnchanged: cacheAfterAInvalidation.remainingB.dataRevision === cacheBeforeRevoke.rowB.dataRevision,
        },
        aDenialMarkerMatchesExactProfileScope: true,
        bDenialMarkerSet: false,
        aStaleTranscriptVisibleInFreshPageRealm: false,
        confirmedAbsenceNavigationShown: noAbsenceNavigation > 0,
        peerStatusAfterRevoke: bServersAfterRevoke.status,
        remainingDeviceHashes: remainingDeviceIds.map(hashId),
        aDeviceListed: remainingDeviceIds.includes(grantA.deviceId),
        bDeviceListed: remainingDeviceIds.includes(grantB.deviceId),
      },
      diagnostics: {
        phase: diagnostics.phase,
        pageErrors: diagnostics.pages.pageErrors,
        bridge: summarizeRpc(rpcWitness.state),
        http: authorizationHttp.rows.map(summarizeHttpObservation),
      },
    });
  } catch (error) {
    await Promise.allSettled([...pendingCaptures]);
    diagnostics.failure = { name: typeof error?.name === "string" ? error.name : "Error", category: classifyError(error) };
    if (diagnostics.revocation && aRpcConnectionsAtRevoke && rpcWitness) {
      diagnostics.revocation.aRpcCloseEvidence = summarizeAConnectionSnapshot(
        aRpcConnectionsAtRevoke,
        rpcWitness.state.links,
      );
    }
    await context.writeArtifactJson("mobile-session-cache-permission-revocation-failure.json", {
      phase: diagnostics.phase,
      failure: diagnostics.failure,
      archive: diagnostics.archive,
      rust: diagnostics.rust,
      gateway: diagnostics.gateway,
      proxy: diagnostics.proxy,
      grants: diagnostics.grants,
      revocation: diagnostics.revocation,
      pages: {
        ...diagnostics.pages,
        location: page && !page.isClosed() ? safePageLocation(page.url()) : null,
      },
      bridge: rpcWitness ? summarizeRpc(rpcWitness.state) : null,
      http401: authorizationHttp
        ? authorizationHttp.rows.filter(row => row.status === 401).map(summarizeHttpObservation)
        : diagnostics.http401,
    }).catch(() => {});
    throw error;
  }
});

async function getOwnedGatewayPairingCredential(context, gateway) {
  const login = await fetch(`${gateway.baseUrl}/login`, {
    method: "POST",
    headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: gateway.authToken }),
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(login.status, 303, "the owned Gateway admin token must create its actual loopback login session");
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie, "the owned Gateway login must issue its real admin cookie");
  context.registerSecret(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  context.registerSecret(cookie);
  const pairing = await fetch(`${gateway.baseUrl}/api/mobile/pairing`, {
    headers: { accept: "application/json", cookie },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(pairing.status, 200, "the authenticated Gateway pairing API must issue the Mobile pairing credential");
  const payload = await pairing.json();
  assert.match(payload?.token ?? "", /^[a-f0-9]{64}$/, "the owned pairing credential must be a real Gateway-issued 256-bit token");
  context.registerSecret(payload.token);
  return payload.token;
}

function captureMobileBootstrap(page, context, pendingCaptures, statuses) {
  const capture = { done: false, result: null };
  const onResponse = response => {
    const url = safeUrl(response.url());
    if (response.request().method() !== "POST" || !url?.pathname.endsWith("/api/mobile/session")) return;
    statuses.push(response.status());
    const pending = response.status() === 200
      ? response.json().then(payload => {
          for (const value of [payload?.accessToken, payload?.refreshToken, payload?.rpcToken]) {
            if (typeof value === "string" && value.length >= 8) context.registerSecret(value);
          }
          capture.result = {
            status: response.status(),
            accessToken: payload?.accessToken,
            refreshToken: payload?.refreshToken,
            rpcToken: payload?.rpcToken,
            deviceId: payload?.deviceId,
            authorizationGeneration: payload?.authorizationGeneration,
            capabilities: payload?.capabilities,
          };
          capture.done = true;
        }).catch(() => { capture.result = { status: response.status(), malformed: true }; capture.done = true; })
      : Promise.resolve().then(() => { capture.result = { status: response.status() }; capture.done = true; });
    pendingCaptures.add(pending);
    void pending.finally(() => pendingCaptures.delete(pending));
    page.off("response", onResponse);
  };
  page.on("response", onResponse);
  return {
    async wait(context) {
      return waitFor(() => capture.done ? capture.result : null, 30_000,
        "the actual Mobile POST /api/mobile/session response for this profile", 50, context.abortSignal);
    },
  };
}

function requireDurableDeviceGrant(result, label) {
  assert.equal(result.status, 200, `${label}'s real Mobile UI bootstrap must succeed`);
  assert.equal(result.malformed, undefined, `${label}'s Mobile bootstrap response must be valid JSON`);
  assert.ok(typeof result.accessToken === "string" && result.accessToken.length >= 16,
    `${label}'s Mobile bootstrap must return a real access token`);
  assert.ok(typeof result.refreshToken === "string" && result.refreshToken.length >= 32,
    `${label}'s Mobile bootstrap must return a real durable refresh token`);
  assert.ok(typeof result.rpcToken === "string" && result.rpcToken.length >= 8,
    `${label}'s Mobile bootstrap must return the actual Gateway RPC token`);
  assert.ok(typeof result.deviceId === "string" && typeof result.authorizationGeneration === "string",
    `${label}'s Mobile bootstrap must identify its actual durable device grant`);
  assert.equal(result.capabilities?.mobileRefreshV1, true,
    `${label}'s real Mobile profile must negotiate durable refresh support`);
  assert.equal(result.capabilities?.mobileDeviceManagementV1, true,
    `${label}'s real Mobile profile must negotiate device management support`);
  return result;
}

async function connectMobileProfile(page, aliasProxy, alias, pairingToken) {
  const baseUrl = aliasProxy.baseUrl(alias);
  const welcome = new URL(`${baseUrl}${MOBILE_PREFIX}/welcome`);
  welcome.searchParams.set("gateway", baseUrl);
  welcome.searchParams.set("reauth", `permission-revocation-${alias}`);
  await page.goto(welcome.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const pairingInput = await uniqueTestId(page, "gateway-token");
  await pairingInput.fill(pairingToken);
  const connectButton = await uniqueTestId(page, "gateway-connect");
  await Promise.all([
    page.waitForURL(url => url.pathname.includes(`${MOBILE_PREFIX}/h/`), { timeout: 30_000 }),
    connectButton.click(),
  ]);
  assert.equal(new URL(page.url()).origin, new URL(baseUrl).origin,
    "the paired Mobile profile must remain on the same loopback browser origin");
}

async function installRpcWitness(page) {
  const state = {
    routeCallbackCount: 0,
    nextLinkOrdinal: 0,
    links: [],
    threadStarts: [],
    turnStarts: [],
    turnCompletions: [],
    expectedPrompts: new Map(),
  };
  await registerPageRpcWebSocketRoute(page, socket => {
    state.routeCallbackCount++;
    const url = safeUrl(socket.url());
    const alias = url?.pathname.match(/^\/g\/([ab])\/rpc$/)?.[1] ?? null;
    const upstream = socket.connectToServer();
    const connection = createPageRpcBridgeConnection(socket, upstream);
    const requests = new Map();
    state.links.push({
      linkOrdinal: ++state.nextLinkOrdinal,
      alias,
      openedAtMs: performance.now(),
      connection,
    });
    socket.onMessage(raw => {
      const frame = parseRpcFrame(raw);
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const row = {
          id: String(frame.id),
          method: frame.method,
          threadId: typeof frame.params?.threadId === "string" ? frame.params.threadId : null,
          markerMatches: frame.method === "turn/start" && inputText(frame.params?.input) === state.expectedPrompts.get(alias),
        };
        requests.set(row.id, row);
      }
      connection.sendToServer(raw);
    });
    upstream.onMessage(raw => {
      const frame = parseRpcFrame(raw);
      const request = frame && frame.id !== undefined ? requests.get(String(frame.id)) : null;
      if (request?.method === "thread/start" && typeof frame.result?.thread?.id === "string") {
        state.threadStarts.push({ alias, threadId: frame.result.thread.id });
      }
      if (request?.method === "turn/start" && typeof frame.result?.turn?.id === "string") {
        state.turnStarts.push({ alias, threadId: frame.result.turn.threadId ?? request.threadId,
          markerMatches: request.markerMatches, turnId: frame.result.turn.id });
      }
      if (frame?.method === "turn/completed") {
        state.turnCompletions.push({
          alias,
          threadId: frame.params?.threadId ?? frame.params?.turn?.threadId ?? null,
          status: frame.params?.turn?.status ?? null,
        });
      }
      connection.sendToPage(raw);
    });
  });
  return { state };
}

function observeMobileAuthorizationHttp(page, context) {
  const rows = [];
  const pending = new Set();
  const expected = new Map();
  let responseCallbackOrdinal = 0;
  page.on("response", response => {
    const observedAtMs = performance.now();
    const ordinal = ++responseCallbackOrdinal;
    const url = safeUrl(response.url());
    const request = response.request();
    if (!url) return;
    const alias = aliasFromPath(url.pathname);
    const endpoint = gatewayApiEndpoint(url.pathname);
    if (!alias || !["servers", "refresh"].includes(endpoint)) return;
    const grantAtResponse = expected.get(alias) ?? null;
    const observation = {
      responseCallbackOrdinal: ordinal,
      observedAtMs,
      alias,
      endpoint,
      method: request.method(),
      status: response.status(),
      credentialMatchesProfile: false,
      grantDeviceId: grantAtResponse?.deviceId ?? null,
      grantAuthorizationGeneration: grantAtResponse?.authorizationGeneration ?? null,
    };
    rows.push(observation);
    const promise = request.allHeaders().then(async headers => {
      const grant = grantAtResponse;
      if (grant && endpoint === "servers")
        observation.credentialMatchesProfile = headers.authorization === `Bearer ${grant.accessToken}`;
      if (grant && endpoint === "refresh") {
        let body;
        try { body = JSON.parse(request.postData() || "{}"); } catch { body = null; }
        observation.credentialMatchesProfile = body?.refreshToken === grant.refreshToken && body?.deviceId === grant.deviceId;
        if (observation.credentialMatchesProfile && response.status() === 200) {
          const payload = await response.json().catch(() => null);
          if (payload?.deviceId === grant.deviceId && payload?.authorizationGeneration === grant.authorizationGeneration &&
              typeof payload.accessToken === "string" && payload.accessToken.length >= 8 &&
              typeof payload.refreshToken === "string" && payload.refreshToken.length >= 32) {
            context.registerSecret(payload.accessToken);
            context.registerSecret(payload.refreshToken);
            expected.set(alias, { ...grant, accessToken: payload.accessToken, refreshToken: payload.refreshToken });
          }
        }
      }
    }).catch(() => {});
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  });
  return {
    rows,
    expectGrant(alias, grant) { expected.set(alias, grant); },
    watermark() {
      return {
        responseCallbackOrdinal,
        observedAtMs: performance.now(),
      };
    },
    async flush() { await Promise.all([...pending]); },
  };
}

function findCapturedGrantUnauthorizedAfterWatermark(rows, watermark, grant) {
  return rows.find(row => row.alias === "a" && row.status === 401 &&
    row.responseCallbackOrdinal > watermark.responseCallbackOrdinal &&
    row.observedAtMs >= watermark.observedAtMs &&
    row.credentialMatchesProfile && row.grantDeviceId === grant.deviceId &&
    row.grantAuthorizationGeneration === grant.authorizationGeneration &&
    ((row.endpoint === "servers" && row.method === "GET") ||
      (row.endpoint === "refresh" && row.method === "POST"))) ?? null;
}

function snapshotOpenAConnections(state, capturedAtMs) {
  return {
    capturedAtMs,
    linkOrdinals: state.links.filter(link => link.alias === "a" &&
      !link.connection.state.clientClosed && !link.connection.state.serverClosed)
      .map(link => link.linkOrdinal),
  };
}

function capturedAConnectionsClosedAfterSnapshot(snapshot, links) {
  if (!snapshot?.linkOrdinals?.length) return false;
  const byOrdinal = new Map(links.map(link => [link.linkOrdinal, link]));
  return snapshot.linkOrdinals.every(ordinal => {
    const link = byOrdinal.get(ordinal);
    const state = link?.connection?.state;
    return link?.alias === "a" && state?.serverClosed === true &&
      Number.isFinite(state.serverClosedAtMs) && state.serverClosedAtMs > snapshot.capturedAtMs;
  });
}

function summarizeAConnectionSnapshot(snapshot, links) {
  const byOrdinal = new Map(links.map(link => [link.linkOrdinal, link]));
  return {
    capturedAtMs: snapshot.capturedAtMs,
    capturedOpenCount: snapshot.linkOrdinals.length,
    allCapturedConnectionsServerClosedAfterSnapshot: capturedAConnectionsClosedAfterSnapshot(snapshot, links),
    connections: snapshot.linkOrdinals.map(linkOrdinal => {
      const link = byOrdinal.get(linkOrdinal);
      const state = link?.connection?.state;
      return {
        linkOrdinal,
        serverClosed: state?.serverClosed === true,
        serverClosedAtMs: Number.isFinite(state?.serverClosedAtMs) ? state.serverClosedAtMs : null,
        closedAfterSnapshot: Number.isFinite(state?.serverClosedAtMs) && state.serverClosedAtMs > snapshot.capturedAtMs,
      };
    }),
  };
}

function assertRevocationObservationPureContracts() {
  const grant = { deviceId: "owned-device-a", authorizationGeneration: "generation-a" };
  const watermark = { responseCallbackOrdinal: 7, observedAtMs: 70 };
  const unauthorized = {
    observedAtMs: 71,
    alias: "a",
    endpoint: "servers",
    method: "GET",
    status: 401,
    credentialMatchesProfile: true,
    grantDeviceId: grant.deviceId,
    grantAuthorizationGeneration: grant.authorizationGeneration,
  };
  assert.equal(findCapturedGrantUnauthorizedAfterWatermark([
    { ...unauthorized, responseCallbackOrdinal: 7, observedAtMs: 69 },
  ], watermark, grant), null, "a pre-watermark A 401 must not satisfy revocation evidence");
  assert.equal(findCapturedGrantUnauthorizedAfterWatermark([
    { ...unauthorized, responseCallbackOrdinal: 8, grantDeviceId: "other-device" },
  ], watermark, grant), null, "a post-watermark 401 from another device grant must not satisfy evidence");
  assert.equal(findCapturedGrantUnauthorizedAfterWatermark([
    { ...unauthorized, responseCallbackOrdinal: 8, grantAuthorizationGeneration: "other-generation" },
  ], watermark, grant), null, "a post-watermark 401 from another authorization generation must not satisfy evidence");
  assert.ok(findCapturedGrantUnauthorizedAfterWatermark([
    { ...unauthorized, responseCallbackOrdinal: 8 },
  ], watermark, grant), "a post-watermark 401 for the captured A grant is eligible evidence");

  const snapshot = snapshotOpenAConnections({ links: [
    { linkOrdinal: 1, alias: "a", connection: { state: { clientClosed: false, serverClosed: false } } },
    { linkOrdinal: 2, alias: "a", connection: { state: { clientClosed: false, serverClosed: true } } },
    { linkOrdinal: 3, alias: "b", connection: { state: { clientClosed: false, serverClosed: false } } },
  ] }, watermark.observedAtMs);
  assert.deepEqual(snapshot.linkOrdinals, [1], "only open A connections belong to the pre-request close snapshot");
  assert.equal(capturedAConnectionsClosedAfterSnapshot(snapshot, [
    { linkOrdinal: 1, alias: "a", connection: { state: { serverClosed: true, serverClosedAtMs: 69 } } },
  ]), false, "an old A server close must not satisfy the post-snapshot close assertion");
  assert.equal(capturedAConnectionsClosedAfterSnapshot(snapshot, [
    { linkOrdinal: 1, alias: "a", connection: { state: { serverClosed: true, serverClosedAtMs: 71 } } },
  ]), true, "a newly server-closed captured A connection is eligible evidence");
}

async function createRealMobileFullTurn(page, alias, workspace, prompt, bridgeState, context) {
  bridgeState.expectedPrompts.set(alias, prompt);
  const newWorkspace = await uniqueTestId(page, "new-workspace");
  await newWorkspace.click();
  await uniqueTestId(page, "new-workspace-prompt");
  const server = await uniqueTestId(page, "server-option-local");
  await server.click();
  const workspacePath = await uniqueTestId(page, "workspace-path");
  await workspacePath.fill(workspace);
  const promptField = await uniqueTestId(page, "new-workspace-prompt");
  await promptField.fill(prompt);
  const createButton = await uniqueTestId(page, "create-workspace");
  await createButton.click();
  const route = await waitFor(() => {
    try { return parseTaskRoute(page.url()); } catch { return null; }
  }, 30_000, "Mobile's created task route to expose a canonical thread, profile, and workspace", 50, context.abortSignal);
  assert.equal(route.cwd, workspace, "the task route must carry this profile's run-owned workspace");
  const userMessage = page.getByTestId("message-list").getByTestId("message-user").filter({ hasText: prompt });
  await userMessage.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await userMessage.count(), 1, "the UI must show exactly the unique real user message for this turn");
  await waitFor(() => bridgeState.threadStarts.find(row => row.threadId === route.threadId) ?? null,
    30_000, "the exact Rust thread/start receipt matching the Mobile task route", 50, context.abortSignal);
  await waitFor(() => bridgeState.turnStarts.find(row => row.threadId === route.threadId && row.markerMatches) ?? null,
    30_000, "the actual Mobile turn/start RPC for the unique prompt marker", 50, context.abortSignal);
  await waitFor(() => bridgeState.turnCompletions.find(row => row.threadId === route.threadId && row.status === "completed") ?? null,
    60_000, "the deterministic run-owned Rust full-turn fixture to complete", 50, context.abortSignal);
  return route.threadId;
}

async function profileMetadataForRoute(page, alias, aliasProxy) {
  const route = await waitFor(() => {
    try { return parseProfileRoute(page.url()); } catch { return null; }
  }, 15_000, `${alias}'s real Mobile profile route to expose its persisted profile ID`, 50);
  const metadata = await readProfileMetadataById(page, route.profileId);
  assert.ok(metadata, `${alias}'s actual Mobile pair must persist a profile metadata row`);
  assert.equal(metadata.baseUrl, aliasProxy.baseUrl(alias), `${alias}'s persisted profile must retain its exact /g/${alias} Gateway alias`);
  assert.equal(metadata.authMode, "device", `${alias}'s profile must use a real durable device grant`);
  return metadata;
}

async function uniqueTestId(page, testId) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await locator.count(), 1, `Mobile locator ${testId} must be unique before interaction`);
  return locator;
}

function verifyGrantMatchesProfile(grant, profile, label) {
  assert.ok(profile.deviceId === grant.deviceId, `${label}'s persisted Mobile profile must refer to its actual bootstrap device ID`);
  assert.ok(profile.authorizationGeneration === grant.authorizationGeneration,
    `${label}'s persisted Mobile profile must refer to its actual bootstrap authorization generation`);
}

async function readProfileMetadataById(page, ...ids) {
  return page.evaluate(({ key, ids: wanted }) => {
    let index;
    try { index = JSON.parse(localStorage.getItem(key) || "{}"); } catch { return null; }
    const select = id => {
      const rows = Array.isArray(index.profiles) ? index.profiles.filter(row => row?.id === id) : [];
      if (rows.length !== 1) return null;
      const row = rows[0];
      return {
        id: row.id,
        baseUrl: row.baseUrl,
        authMode: row.authMode ?? "legacy",
        deviceId: row.deviceId ?? null,
        authorizationGeneration: row.authorizationGeneration ?? null,
        reauthorizationRequiredScope: row.reauthorizationRequiredScope ?? null,
      };
    };
    if (wanted.length === 1) return select(wanted[0]);
    return { a: select(wanted[0]), b: select(wanted[1]), activeIdPresent: typeof index.activeId === "string" };
  }, { key: PROFILE_INDEX_KEY, ids });
}

async function readCacheInventory(page, { markers }) {
  return page.evaluate(async ({ databaseName, expectedMarkers }) => {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return { ready: false, entries: [] };
    const databaseRows = await indexedDB.databases();
    if (!databaseRows.some(row => row.name === databaseName)) return { ready: false, entries: [] };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Mobile transcript cache read was blocked"));
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
          const row = event.target.result;
          if (!row) return;
          records.set(row.key, row.value);
          row.continue();
        };
        transaction.oncomplete = () => resolve({ manifest, records });
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("Mobile transcript cache read aborted"));
      });
      const manifest = data.manifest;
      if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || !Array.isArray(manifest.invalidations))
        return { ready: false, entries: [] };
      const entries = [];
      for (const indexRow of manifest.entries) {
        const stored = data.records.get(indexRow.slot);
        if (!stored || !(stored.blob instanceof Blob) || stored.revision !== indexRow.dataRevision || stored.blob.size > 512 * 1024) continue;
        let record;
        try { record = JSON.parse(await stored.blob.text()); } catch { continue; }
        const scope = record?.scope;
        if (!scope?.profile || !scope?.target || typeof scope.threadId !== "string") continue;
        const messages = Array.isArray(record.messages) ? record.messages : [];
        const markerCounts = Object.fromEntries(expectedMarkers.map(([name, marker]) => [name,
          messages.filter(message => message?.role === "user" && typeof message.content === "string" && message.content.includes(marker)).length]));
        entries.push({
          key: indexRow.key,
          profileKey: indexRow.profileKey,
          slot: indexRow.slot,
          dataRevision: indexRow.dataRevision,
          workspaceKey: indexRow.workspaceKey ?? null,
          profileId: scope.profile.id,
          profileBaseUrl: scope.profile.baseUrl,
          authMode: scope.profile.authMode,
          deviceId: scope.profile.deviceId ?? null,
          threadId: scope.threadId,
          cwd: scope.cwd,
          serverId: scope.target.id,
          markerCounts,
          invalidated: manifest.invalidations.some(item => item?.key === `t:${indexRow.key}` || item?.key === `p:${indexRow.profileKey}`),
        });
      }
      return {
        ready: true,
        manifest: { revision: manifest.revision, lastKey: manifest.lastKey },
        entries,
      };
    } finally { db.close(); }
  }, {
    databaseName: "kcoder-confirmed-transcripts-v1",
    expectedMarkers: markers.map(marker => [marker.name, marker.value]),
  });
}

function assertCacheRow(row, profile, grant, route, workspace, label, markerName) {
  assert.ok(row, `${label}'s exact real Mobile transcript row must exist`);
  assert.ok(row.profileId === profile.id, `${label}'s cache must carry the exact Mobile profile owner`);
  assert.ok(row.profileBaseUrl === profile.baseUrl, `${label}'s cache scope must carry the exact alias base URL`);
  assert.ok(row.deviceId === grant.deviceId, `${label}'s cache must bind its own durable device identity`);
  assert.equal(row.authMode, "device", `${label}'s transcript must be scoped to device authorization`);
  assert.ok(row.threadId === route.threadId, `${label}'s row must carry the canonical Rust thread ID`);
  assert.equal(row.serverId, "local", `${label}'s cache must belong to the run-owned local Rust target`);
  assert.equal(row.cwd, workspace, `${label}'s cache must carry its exact run-owned workspace`);
  assert.equal(row.markerCounts?.[markerName], 1,
    `${label}'s persisted transcript must include exactly one matching unique user-turn marker`);
  assert.equal(row.invalidated, false, `${label}'s cache must not be invalidated before revocation`);
}

function cacheRowEvidence(row, profile, workspace) {
  return {
    profileIdHash: hashId(row.profileId),
    profileBaseUrlHash: hashId(row.profileBaseUrl),
    profileBaseUrlMatchesExpectedAlias: row.profileBaseUrl === profile.baseUrl,
    deviceIdHash: hashId(row.deviceId),
    threadIdHash: hashId(row.threadId),
    serverId: row.serverId,
    workspaceMatchesRunOwnedPath: row.cwd === workspace,
    keyHash: hashId(row.key),
    slotHash: hashId(row.slot),
    dataRevision: row.dataRevision,
    invalidated: row.invalidated,
  };
}

async function ownedGatewayRequest(baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { accept: "application/json", ...headers },
    ...(body === undefined ? {} : { body }),
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
  });
}

function scheduleDeviceCleanupIfAvailable(context, aliasProxy, alias, grant, label) {
  if (typeof grant?.accessToken !== "string" || grant.accessToken.length < 8) return;
  context.addCleanup(`revoke ${label} owned Mobile device grant`, async () => {
    const response = await ownedGatewayRequest(aliasProxy.baseUrl(alias), "/api/mobile/session", {
      method: "DELETE",
      headers: { authorization: `Bearer ${grant.accessToken}` },
    });
    if (![204, 401].includes(response.status)) {
      await response.body?.cancel();
      throw new Error(`${label} owned Mobile device cleanup returned HTTP ${response.status}`);
    }
    await response.body?.cancel();
  });
}

async function verifyOwnedRustAppServer(gateway, executablePath, expectedSha256) {
  const matches = await findOwnedExecutableProcesses({ pgid: gateway.child.pid, executablePath });
  const owned = matches.find(process => process.sha256 === expectedSha256);
  assert.ok(owned, "procfs /proc/<pid>/exe must identify the caller-pinned Rust child inside the owned Gateway process group");
  const configured = await hashExecutableFile(executablePath);
  assert.equal(configured.sha256, expectedSha256, "the configured Rust executable must retain its explicit caller SHA-256");
  return { callerSha256: expectedSha256, ownedProcfsSha256: owned.sha256, ownedChildObserved: true };
}

function parseTaskRoute(rawUrl) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const mount = parts.lastIndexOf("mobile");
  assert.ok(mount >= 0, "the route must remain under the production Mobile mount");
  assert.equal(parts[mount + 1], "h", "the route must be a Gateway profile task route");
  assert.equal(parts[mount + 3], "task", "the route must identify a Mobile task");
  const route = {
    alias: url.pathname.match(/^\/g\/([ab])\/mobile\//)?.[1] ?? null,
    profileId: parts[mount + 2],
    serverId: parts[mount + 4],
    threadId: parts[mount + 5],
    cwd: url.searchParams.get("cwd"),
  };
  assert.ok(route.profileId && route.serverId && route.threadId && route.cwd,
    "the Mobile task route must contain its exact profile, target, thread, and workspace");
  return route;
}

function routeMatches(actual, expected) {
  return Boolean(actual && expected && actual.alias === expected.alias && actual.profileId === expected.profileId &&
    actual.serverId === expected.serverId && actual.threadId === expected.threadId && actual.cwd === expected.cwd);
}

function parseProfileRoute(rawUrl) {
  const url = new URL(rawUrl);
  const aliasMatch = url.pathname.match(/^\/g\/([ab])\/mobile\//);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const mount = parts.lastIndexOf("mobile");
  assert.ok(aliasMatch && mount >= 0 && parts[mount + 1] === "h" && parts[mount + 2],
    "the paired route must identify an exact profile beneath its same-origin alias");
  return { alias: aliasMatch[1], profileId: parts[mount + 2] };
}

function profileAuthorizationScopeKey(profile) {
  return JSON.stringify([profile.id, profile.baseUrl, profile.authMode ?? "legacy",
    profile.authorizationGeneration, profile.deviceId]);
}

function aliasFromPath(pathname) {
  return pathname.match(/^\/g\/([ab])(?=\/)/)?.[1] ?? null;
}

function gatewayApiEndpoint(pathname) {
  const route = pathname.replace(/^\/g\/[ab](?=\/)/, "");
  if (route === "/api/servers") return "servers";
  if (route === "/api/mobile/session/refresh") return "refresh";
  return null;
}

function summarizeHttpObservation(row) {
  return {
    responseCallbackOrdinal: row.responseCallbackOrdinal,
    observedAtMs: row.observedAtMs,
    alias: row.alias,
    endpoint: row.endpoint,
    method: row.method,
    status: row.status,
    credentialMatchesProfile: row.credentialMatchesProfile,
    grantDeviceIdHash: typeof row.grantDeviceId === "string" ? hashId(row.grantDeviceId) : null,
    grantAuthorizationGenerationHash: typeof row.grantAuthorizationGeneration === "string"
      ? hashId(row.grantAuthorizationGeneration) : null,
  };
}

function summarizeRpc(state) {
  return {
    routeCallbackCount: state.routeCallbackCount,
    linkCount: state.links.length,
    aGatewaySideCloseCount: state.links.filter(link => link.alias === "a" && link.connection.state.serverClosed).length,
    bNavigationSynthesizedServerRouteCloseCount: state.links.filter(link => link.alias === "b" && link.connection.state.serverClosed).length,
    threadStartReceiptCount: state.threadStarts.length,
    turnStartCount: state.turnStarts.length,
    completedTurnCount: state.turnCompletions.filter(row => row.status === "completed").length,
  };
}

function safePageLocation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/");
    const mobile = parts.indexOf("mobile");
    if (mobile >= 0) {
      if (parts[mobile + 2]) parts[mobile + 2] = ":profileId";
      if (parts[mobile + 3] === "task") {
        if (parts[mobile + 4]) parts[mobile + 4] = ":serverId";
        if (parts[mobile + 5]) parts[mobile + 5] = ":threadId";
      }
    }
    return { origin: url.origin, pathname: parts.join("/"), queryKeys: [...url.searchParams.keys()].sort() };
  } catch { return null; }
}

function safeUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function inputText(input) {
  if (!Array.isArray(input)) return "";
  return input.filter(item => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text).join("\n");
}

function uniquePrompt(alias) {
  return `${TARGET_PROMPT_PREFIX}${alias}_${randomHex(8)}`;
}

function randomHex(length) {
  return randomBytes(length).toString("hex");
}

function hashId(value) {
  return typeof value === "string" && value
    ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
}

function classifyError(error) {
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (/timeout|timed out|deadline/.test(message)) return "timeout";
  if (/unauthoriz|forbidden|auth|token/.test(message)) return "authorization";
  if (/websocket|network|fetch|socket|net::/.test(message)) return "network";
  if (/protocol|rpc|invalid frame|parse/.test(message)) return "protocol";
  if (/not found|undefined|null|not a function|cannot read/.test(message)) return "runtime";
  return "assertion-or-setup";
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} must be explicitly pinned by the caller`);
  assert.ok(isAbsolute(value), `${name} must be an absolute path`);
  return resolve(value);
}

function requiredSha256(name) {
  const value = process.env[name];
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${name} must be an explicit lowercase caller SHA-256 pin`);
  return value;
}
