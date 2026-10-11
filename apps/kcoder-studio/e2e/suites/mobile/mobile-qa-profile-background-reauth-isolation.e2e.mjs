import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";

const SERVER_ID = "backend4a";
const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const gatewayRoleProbeA = { baseUrl: "http://127.0.0.1:43275" };
const gatewayRoleProbeB = { baseUrl: "https://127.0.0.1:33113" };
assert.equal(
  gatewayRoleForOrigin("ws://127.0.0.1:43275/rpc", gatewayRoleProbeA, gatewayRoleProbeB),
  "A",
);
assert.equal(
  gatewayRoleForOrigin("wss://127.0.0.1:33113/rpc", gatewayRoleProbeA, gatewayRoleProbeB),
  "B",
);

await runE2E(import.meta.url, {
  testId: "mobile-qa-profile-background-reauth-isolation",
  tier: "model-independent",
  modelPolicy:
    "real Mobile Web profile state and TaskRuntime.resume over two isolated loopback KCODER_STUDIO_MOCK Gateways; no app-server binary or model request",
}, async context => {
  const approvedBundleRoot = requiredEnvironmentValue("KCODER_E2E_APPROVED_MOBILE_WEB_ROOT");
  const approvedBundleManifest = requiredEnvironmentValue("KCODER_E2E_APPROVED_MOBILE_WEB_MANIFEST");
  const approvedSourceTreeSha256 = requiredSha256Pin("KCODER_E2E_APPROVED_MOBILE_WEB_SOURCE_SHA256");
  const approvedManifestSha256 = requiredSha256Pin("KCODER_E2E_APPROVED_MOBILE_WEB_MANIFEST_SHA256");
  const approvedBundleSha256 = requiredSha256Pin("KCODER_E2E_APPROVED_MOBILE_WEB_BUNDLE_SHA256");
  const mobileWeb = await reuseMobileWebExport(context, {
    bundleRoot: resolve(approvedBundleRoot),
    manifestPath: resolve(approvedBundleManifest),
    expectedSourceTreeSha256: approvedSourceTreeSha256,
    expectedManifestSha256: approvedManifestSha256,
    expectedBundleSha256: approvedBundleSha256,
    label: "mobile-profile-background-reauth",
    outputName: "mobile-web-export",
  });
  assert.equal(
    mobileWeb.sourceTreeSha256,
    approvedSourceTreeSha256,
    "the Mobile Web bundle must match the explicitly approved source snapshot",
  );
  assert.equal(
    mobileWeb.sourceManifestSha256,
    approvedManifestSha256,
    "the retained Mobile Web manifest must match its explicit SHA-256 pin",
  );
  assert.equal(
    mobileWeb.bundleSha256,
    approvedBundleSha256,
    "the retained Mobile Web bundle must match its explicit SHA-256 pin",
  );
  const workspaceA = context.pathInState("workspace-a");
  const workspaceB = context.pathInState("workspace-b");
  await Promise.all([
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
  ]);
  const serversA = await context.writeStateJson("servers-a.json", [mockServer(workspaceA)]);
  const serversB = await context.writeStateJson("servers-b.json", [mockServer(workspaceB)]);
  const gatewayA = await startGateway(context, {
    auth: true,
    label: "mobile-profile-reauth-gateway-a",
    workspace: workspaceA,
    serversFile: serversA,
    env: {
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
    },
  });
  const gatewayB = await startGateway(context, {
    auth: true,
    label: "mobile-profile-reauth-gateway-b",
    workspace: workspaceB,
    serversFile: serversB,
    env: {
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl,
    },
  });
  assert.notEqual(gatewayA.port, gatewayB.port, "profiles must use independent loopback Gateways");
  assert.equal(gatewayRoleForOrigin(new URL(`${gatewayA.wsUrl}/rpc`).origin, gatewayA, gatewayB), "A");
  assert.equal(gatewayRoleForOrigin(new URL(`${gatewayB.wsUrl}/rpc`).origin, gatewayA, gatewayB), "B");

  const chromium = await startChromium(context, {
    label: "mobile-profile-reauth-chromium",
  });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });

  const roleForOrigin = origin => gatewayRoleForOrigin(origin, gatewayA, gatewayB);
  const rpcSockets = [];
  const observedRpcSockets = [];
  const serverResponses = [];
  let aRevoked = false;
  let profileAForHandshakeEvidence = null;
  page.on("websocket", socket => {
    let gatewayRole = null;
    try { gatewayRole = roleForOrigin(new URL(socket.url()).origin); } catch {}
    const record = { gatewayRole, sentMethods: Object.create(null), closed: false };
    observedRpcSockets.push(record);
    socket.on("framesent", event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (typeof frame.method === "string") {
          record.sentMethods[frame.method] = (record.sentMethods[frame.method] ?? 0) + 1;
        }
      } catch {}
    });
    socket.on("close", () => { record.closed = true; });
  });
  page.on("response", response => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.pathname !== "/api/servers") return;
    const gatewayRole = roleForOrigin(url.origin);
    if (!gatewayRole) return;
    serverResponses.push({
      gatewayRole,
      method: response.request().method(),
      status: response.status(),
      afterARevoked: aRevoked,
      headerOwnerFingerprint: bearerHeaderFingerprint(response.request()),
    });
  });
  await page.routeWebSocket("**/rpc*", async socket => {
    let gatewayRole = null;
    try { gatewayRole = roleForOrigin(new URL(socket.url()).origin); } catch {}
    const protocols = socket.protocols();
    const sessionProtocol = protocols.find(protocol =>
      protocol.startsWith("kcoder-session."),
    );
    const gateway = gatewayRole === "A" ? gatewayA : gatewayRole === "B" ? gatewayB : null;
    const cookie = gateway
      ? await sessionCookieEvidence(context, page, gateway)
      : { present: false, fingerprint: null };
    const upstream = socket.connectToServer();
    const record = {
      gatewayRole,
      closed: false,
      serverClosed: false,
      threadResumeRequests: 0,
      protocolSessionFingerprint: sessionProtocol
        ? shortHash(sessionProtocol.slice("kcoder-session.".length))
        : null,
      gatewayCookiePresent: cookie.present,
      gatewayCookieFingerprint: cookie.fingerprint,
      gatewayCookieMatchesProfileBearer:
        gatewayRole === "A" && profileAForHandshakeEvidence
          ? cookie.fingerprint === shortHash(profileAForHandshakeEvidence.accessToken)
          : null,
      client: socket,
      upstream,
    };
    rpcSockets.push(record);
    // Playwright disables close forwarding when onClose is registered, so relay it explicitly.
    let forwardingClose = false;
    socket.onClose((code, reason) => {
      record.closed = true;
      if (forwardingClose) return;
      forwardingClose = true;
      return upstream.close(closeOptions(code, reason));
    });
    upstream.onClose((code, reason) => {
      record.serverClosed = true;
      if (forwardingClose) return;
      forwardingClose = true;
      return socket.close(closeOptions(code, reason));
    });
    socket.onMessage(raw => {
      try {
        const frame = JSON.parse(String(raw));
        if (frame.method === "thread/resume") record.threadResumeRequests += 1;
      } catch {}
      upstream.send(raw);
    });
    upstream.onMessage(raw => socket.send(raw));
  });

  await connectInitialProfile(page, gatewayA);
  const profileA = await readProfile(page, gatewayA.baseUrl);
  profileAForHandshakeEvidence = profileA;
  registerProfileSecrets(context, profileA);
  const aLoginCookie = await sessionCookieEvidence(context, page, gatewayA);
  assert.equal(aLoginCookie.present, true, "A's web login must own a Gateway session cookie");
  assert.notEqual(
    aLoginCookie.fingerprint,
    shortHash(profileA.accessToken),
    "A's Mobile bearer must differ from the preserved web-login cookie session",
  );

  // Keep the real task socket owned by profile A's mobile bearer; the isolated
  // browser's earlier web-login cookie is a separate valid Gateway session.
  await page.context().clearCookies({ name: "kcoder_studio_session" });
  const aCookieAfterClear = await sessionCookieEvidence(context, page, gatewayA);
  assert.equal(
    aCookieAfterClear.present,
    false,
    "the owned browser login cookie must be absent before the Mobile-authenticated A task resumes",
  );
  const aPreResumeSockets = rpcSockets.filter(socket =>
    socket.gatewayRole === "A" && !(socket.closed && socket.serverClosed),
  );
  for (const socket of aPreResumeSockets) {
    await closeOwnedRouteSocket(socket, "E2E reset A's pre-resume cookie-owned transport");
  }
  await waitFor(
    () => aPreResumeSockets.every(socket => socket.closed && socket.serverClosed),
    10_000,
    "all pre-resume A sockets close after clearing the owned login cookie",
    50,
    context.abortSignal,
  );

  // This is the real Mobile Web task route and TaskRuntime.resume callback path.
  // The Gateway's deterministic mock thread requires no turn or model request.
  await visibleTestId(page, "thread-mock-active-session").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await visibleTestId(page, "thread-mock-active-session").click();
  await visibleTestId(page, "message-input-root").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  try {
    await waitFor(
      () => rpcSockets.some(socket => socket.gatewayRole === "A" && socket.threadResumeRequests > 0),
      30_000,
      "A's real Mobile Web thread/resume request",
      50,
      context.abortSignal,
    );
  } catch (error) {
    const testIds = await page.locator("[data-testid]").evaluateAll(elements =>
      elements.map(element => element.getAttribute("data-testid"))
        .filter(value => typeof value === "string")
        .slice(0, 120),
    ).catch(() => []);
    await context.writeArtifactJson("a-resume-observation-failure.json", {
      routePath: (() => { try { return new URL(page.url()).pathname; } catch { return null; } })(),
      visibleTestIds: testIds,
      observedRpcSockets,
      proxiedRpcSockets: rpcSockets.map(socket => ({
        gatewayRole: socket.gatewayRole,
        closed: socket.closed,
        serverClosed: socket.serverClosed,
        threadResumeRequests: socket.threadResumeRequests,
      })),
      timeoutName: error?.name ?? "Error",
    });
    throw error;
  }
  const aInitialResumedSocket = rpcSockets.find(socket =>
    socket.gatewayRole === "A" && socket.threadResumeRequests > 0,
  );
  assert.ok(aInitialResumedSocket, "A task resume must use a routed A Gateway socket");
  assert.equal(
    aInitialResumedSocket.protocolSessionFingerprint,
    shortHash(profileA.accessToken),
    "A's real route must carry the Mobile profile bearer as its WebSocket session protocol",
  );
  assert.equal(
    aInitialResumedSocket.gatewayCookiePresent,
    false,
    "the A resume handshake must not carry the unrelated web-login cookie",
  );
  assert.equal(
    aInitialResumedSocket.gatewayCookieMatchesProfileBearer,
    false,
    "the A task socket must not inherit cookie authentication instead of its Mobile bearer",
  );

  await openDrawerSettings(page);
  await clickAddGateway(page);
  await visibleTestId(page, "welcome-direct-connection").click();
  await visibleTestId(page, "gateway-endpoint").fill(gatewayB.baseUrl);
  await visibleTestId(page, "gateway-token").fill(gatewayB.authToken);
  await visibleTestId(page, "gateway-connect").click();
  await visibleTestId(page, "new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const profileB = await readProfile(page, gatewayB.baseUrl);
  registerProfileSecrets(context, profileB);
  const profileABearerFingerprint = shortHash(profileA.accessToken);
  const profileBBearerFingerprint = shortHash(profileB.accessToken);
  assert.notEqual(
    profileABearerFingerprint,
    profileBBearerFingerprint,
    "A and B must have distinct Mobile bearer sessions",
  );
  await waitForStoredActiveProfile(page, profileB.id);
  await waitFor(
    () => serverResponses.some(item => item.gatewayRole === "B" && item.method === "GET" && item.status === 200),
    30_000,
    "B's successful /api/servers response after connection commit",
    50,
    context.abortSignal,
  );
  const bInitialServers200 = serverResponses.find(item =>
    item.gatewayRole === "B" && item.method === "GET" && item.status === 200,
  );
  assert.ok(bInitialServers200, "B must have a real browser /api/servers success before resuming its task");
  assert.equal(
    bInitialServers200.headerOwnerFingerprint,
    shortHash(profileB.accessToken),
    "B's real /api/servers success must use the B profile Authorization owner",
  );
  assert.equal(
    await visibleTestId(page, "reauthorize-active-profile").count(),
    0,
    "newly committed B must start with a healthy active runtime",
  );
  await visibleTestId(page, "thread-mock-active-session").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await visibleTestId(page, "thread-mock-active-session").click();
  await visibleTestId(page, "message-input-root").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await waitFor(
    () => rpcSockets.some(socket => socket.gatewayRole === "B" && socket.threadResumeRequests > 0),
    30_000,
    "B's real Mobile Web thread/resume request while A's runtime remains registered",
    50,
    context.abortSignal,
  );
  const bResumedSocket = rpcSockets.find(socket =>
    socket.gatewayRole === "B" && socket.threadResumeRequests > 0,
  );
  assert.ok(bResumedSocket, "B task resume must use a routed B Gateway socket");
  assert.equal(
    bResumedSocket.protocolSessionFingerprint,
    shortHash(profileB.accessToken),
    "B's real route must carry the Mobile profile session protocol",
  );
  assert.equal(
    bResumedSocket.gatewayCookiePresent,
    false,
    "the B route must not inherit an unrelated host-auth session",
  );

  // Exercise an explicit setActiveProfile(B) after the successful B connection commit.
  await openDrawerSettings(page);
  await switchToProfile(page, profileA);
  await visibleTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await openDrawerSettings(page);
  const bServers200BeforeSwitch = serverResponses.filter(item =>
    item.gatewayRole === "B" && item.method === "GET" && item.status === 200,
  ).length;
  await switchToProfile(page, profileB);
  await visibleTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await waitForStoredActiveProfile(page, profileB.id);
  await waitFor(
    () => serverResponses.slice(bServers200BeforeSwitch).some(item =>
      item.gatewayRole === "B" && item.method === "GET" && item.status === 200,
    ),
    30_000,
    "a fresh B /api/servers 200 after the explicit A-to-B profile switch",
    50,
    context.abortSignal,
  );
  const bFreshSwitchResponse = serverResponses.slice(bServers200BeforeSwitch).find(item =>
    item.gatewayRole === "B" && item.method === "GET" && item.status === 200,
  );
  assert.ok(bFreshSwitchResponse, "switching back to B must produce a fresh browser response");
  assert.equal(
    bFreshSwitchResponse.headerOwnerFingerprint,
    shortHash(profileB.accessToken),
    "the fresh B response after profile switch must use B's profile bearer",
  );
  const aResumedSocket = aInitialResumedSocket;
  assert.ok(aResumedSocket, "A's resumed runtime must remain registered across the B task and profile switches");
  assert.equal(
    aResumedSocket.closed || aResumedSocket.serverClosed,
    false,
    "A's resumed runtime socket must remain live until the test revokes its owned bearer",
  );
  assert.equal(
    await visibleTestId(page, "reauthorize-active-profile").count(),
    0,
    "B must have no reauthorization banner before A expires",
  );
  await openDrawerSettings(page);
  assert.equal(
    await visibleTestId(page, `reauthorize-profile-${profileB.id}`).count(),
    0,
    "B's Settings row must have no reauthorization action before A expires",
  );

  const aSessionBeforeRevoke = await readProfile(page, gatewayA.baseUrl);
  registerProfileSecrets(context, aSessionBeforeRevoke);
  const revokeA = await fetch(`${gatewayA.baseUrl}/api/mobile/session`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${aSessionBeforeRevoke.accessToken}` },
  });
  assert.equal(revokeA.status, 204, "the test revokes only its owned A Mobile session");
  aRevoked = true;
  await waitFor(
    () => aResumedSocket.closed && aResumedSocket.serverClosed,
    10_000,
    "A's profile-owned task socket closes on both routed ends after A session revocation",
    50,
    context.abortSignal,
  );
  await waitFor(
    () => serverResponses.some(item =>
      item.gatewayRole === "A" && item.method === "GET" && item.status === 401 && item.afterARevoked,
    ),
    30_000,
    "A background reconnect's authenticated /api/servers 401",
    50,
    context.abortSignal,
  );
  const aUnauthorizedResponse = serverResponses.find(item =>
    item.gatewayRole === "A" && item.method === "GET" && item.status === 401 && item.afterARevoked,
  );
  assert.ok(aUnauthorizedResponse, "A's post-revocation 401 must be observed from the real Mobile page");
  assert.equal(
    aUnauthorizedResponse.headerOwnerFingerprint,
    shortHash(profileA.accessToken),
    "A's observed background 401 must be for the A profile Authorization owner",
  );
  await page.waitForTimeout(300);

  const bStillAuthorized = await fetch(`${gatewayB.baseUrl}/api/servers`, {
    headers: { Authorization: `Bearer ${profileB.accessToken}` },
  });
  assert.equal(bStillAuthorized.status, 200, "A's revocation must leave B's Gateway session valid");
  const settingsReauthorizationB =
    (await visibleTestId(page, `reauthorize-profile-${profileB.id}`).count()) > 0;
  const aSocketRecords = rpcSockets.filter(socket => socket.gatewayRole === "A");
  const evidenceBeforeHome = {
    gatewayMode: "KCODER_STUDIO_MOCK",
    mockServerId: SERVER_ID,
    appServerBinaryStarted: false,
    mobileWebSourceTreeSha256: mobileWeb.sourceTreeSha256,
    mobileWebBundleSha256: mobileWeb.bundleSha256,
    mobileWebBundleFileCount: mobileWeb.bundleFileCount,
    approvedBundleManifestSha256: mobileWeb.sourceManifestSha256 ?? null,
    approvedBundlePins: {
      sourceTreeSha256: approvedSourceTreeSha256,
      manifestSha256: approvedManifestSha256,
      bundleSha256: approvedBundleSha256,
    },
    mobileBearerFingerprints: {
      A: profileABearerFingerprint,
      B: profileBBearerFingerprint,
      distinct: profileABearerFingerprint !== profileBBearerFingerprint,
    },
    profileIdsSha256: {
      A: shortHash(profileA.id),
      B: shortHash(profileB.id),
    },
    taskIdSha256: shortHash("mock-active-session"),
    aThreadResumeRequests: aSocketRecords.reduce((sum, socket) => sum + socket.threadResumeRequests, 0),
    bThreadResumeRequests: rpcSockets
      .filter(socket => socket.gatewayRole === "B")
      .reduce((sum, socket) => sum + socket.threadResumeRequests, 0),
    aSocketClosed: aSocketRecords.some(socket => socket.closed || socket.serverClosed),
    aResumedTaskSocketClosed: aResumedSocket.closed && aResumedSocket.serverClosed,
    aResumedSocketRetainedBeforeRevocation: true,
    aWebLoginOwnerFingerprint: aLoginCookie.fingerprint,
    aWebLoginOwnerMatchesProfileSession: aLoginCookie.fingerprint === shortHash(profileA.accessToken),
    aWebLoginMarkerClearedBeforeResume: !aCookieAfterClear.present,
    aResumedSocketIdentity: {
      protocolSessionFingerprint: aResumedSocket.protocolSessionFingerprint,
      protocolSessionMatchesMobileBearer:
        aResumedSocket.protocolSessionFingerprint === shortHash(profileA.accessToken),
      hostAuthMarkerPresentAtHandshake: aResumedSocket.gatewayCookiePresent,
      hostAuthMarkerFingerprintAtHandshake: aResumedSocket.gatewayCookieFingerprint,
      hostAuthMarkerMatchesProfileSession: aResumedSocket.gatewayCookieMatchesProfileBearer,
      inferredOwner: "A profile selected through the session protocol; no host-auth marker",
    },
    aServers401AfterRevocation: serverResponses.filter(item =>
      item.gatewayRole === "A" && item.method === "GET" && item.status === 401 && item.afterARevoked,
    ).length,
    bServers200BeforeRevocation: serverResponses.filter(item =>
      item.gatewayRole === "B" && item.method === "GET" && item.status === 200 && !item.afterARevoked,
    ).length,
    bServers200BeforeExplicitSwitch: bServers200BeforeSwitch,
    bServers200AfterExplicitSwitch: serverResponses.slice(bServers200BeforeSwitch).filter(item =>
      item.gatewayRole === "B" && item.method === "GET" && item.status === 200,
    ).length,
    bFreshSwitchResponseUsesBProfile:
      bFreshSwitchResponse.headerOwnerFingerprint === profileBBearerFingerprint,
    bServers200AfterRevocation: bStillAuthorized.status === 200,
    bBearerFingerprintUsedForIndependentSuccess: profileBBearerFingerprint,
    settingsReauthorizationB,
    serverResponses,
    rpcSockets: rpcSockets.map(socket => ({
      gatewayRole: socket.gatewayRole,
      closed: socket.closed,
      serverClosed: socket.serverClosed,
      threadResumeRequests: socket.threadResumeRequests,
      protocolSessionFingerprint: socket.protocolSessionFingerprint,
      hostAuthMarkerPresent: socket.gatewayCookiePresent,
      hostAuthMarkerFingerprint: socket.gatewayCookieFingerprint,
    })),
    observedRpcSockets: observedRpcSockets.map(socket => ({
      gatewayRole: socket.gatewayRole,
      closed: socket.closed,
      sentMethods: socket.sentMethods,
    })),
  };
  await page.getByLabel(await backLabel(page), { exact: true }).and(page.locator(":visible")).click();
  await visibleTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const homeReauthorizationB =
    (await visibleTestId(page, "reauthorize-active-profile").count()) > 0;
  const profileBStillActive = await isStoredActiveProfile(page, profileB.id);
  await context.writeArtifactJson("mobile-profile-background-reauth-isolation.json", {
    ...evidenceBeforeHome,
    homeReauthorizationB,
    profileBStillActive,
  });

  assert.equal(
    profileBStillActive,
    true,
    "B must remain the active profile after A's background reauthorization callback",
  );
  assert.equal(
    settingsReauthorizationB,
    false,
    "A's background 401 must not mark the current B profile as requiring reauthorization",
  );
  assert.equal(
    homeReauthorizationB,
    false,
    "A's background 401 must not show B's active-profile reauthorization banner",
  );
});

function mockServer(workspace) {
  return {
    id: SERVER_ID,
    label: "Backend 4A fixture",
    runtime: "kcoder",
    transport: "local",
    command: process.execPath,
    workspace,
  };
}

function gatewayRoleForOrigin(origin, gatewayA, gatewayB) {
  let canonicalOrigin;
  try {
    const url = new URL(origin);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    canonicalOrigin = url.origin;
  } catch {
    return null;
  }
  if (canonicalOrigin === gatewayA.baseUrl) return "A";
  if (canonicalOrigin === gatewayB.baseUrl) return "B";
  return null;
}

async function connectInitialProfile(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await visibleTestId(page, "welcome-direct-connection").click();
  await visibleTestId(page, "gateway-endpoint").fill(gateway.baseUrl);
  await visibleTestId(page, "gateway-token").fill(gateway.authToken);
  await visibleTestId(page, "gateway-connect").click();
  await visibleTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function openDrawerSettings(page) {
  const menu = page.locator(
    '[aria-label="打开任务列表"]:visible, [aria-label="打开导航"]:visible',
  );
  await menu.first().click();
  const drawer = visibleTestId(page, "mobile-drawer");
  await drawer.waitFor({ state: "visible", timeout: 10_000 });
  await drawer.getByLabel("设置", { exact: true }).click();
}

async function clickAddGateway(page) {
  const label = (await page.locator("html").getAttribute("lang")) === "en"
    ? "Add Gateway"
    : "添加 Gateway";
  await page.getByText(label, { exact: true }).and(page.locator(":visible")).click();
}

async function switchToProfile(page, profile) {
  const prefix = (await page.locator("html").getAttribute("lang")) === "en"
    ? "Switch to"
    : "切换到";
  await page.getByLabel(`${prefix} ${profile.label}`, { exact: true })
    .and(page.locator(":visible"))
    .click();
  await waitForStoredActiveProfile(page, profile.id);
}

function visibleTestId(page, testId) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

async function readProfile(page, baseUrl) {
  const profile = await page.evaluate(({ profileIndexKey, expectedBaseUrl }) => {
    const index = JSON.parse(localStorage.getItem(profileIndexKey) ?? "null");
    const profiles = Array.isArray(index) ? index : index?.profiles;
    if (!Array.isArray(profiles)) return null;
    const stored = profiles.find(item => item?.baseUrl === expectedBaseUrl);
    if (!stored) return null;
    let key = stored.secretKey;
    if (typeof key !== "string") {
      let hash = 0x811c9dc5;
      for (let index = 0; index < stored.id.length; index += 1) {
        hash ^= stored.id.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      key = `kcoder-studio-mobile.gateway-secret.${(hash >>> 0).toString(16).padStart(8, "0")}`;
    }
    const secret = JSON.parse(localStorage.getItem(key) ?? "null");
    if (typeof secret?.accessToken !== "string" || typeof secret?.rpcToken !== "string") return null;
    return {
      id: stored.id,
      label: stored.label,
      baseUrl: stored.baseUrl,
      accessToken: secret.accessToken,
      rpcToken: secret.rpcToken,
    };
  }, { profileIndexKey: PROFILE_INDEX_KEY, expectedBaseUrl: baseUrl });
  assert.ok(profile, `expected an owned Mobile profile for Gateway role ${baseUrl === new URL(page.url()).origin ? "active-origin" : "other"}`);
  return profile;
}

function registerProfileSecrets(context, profile) {
  if (profile.accessToken.length >= 8) context.registerSecret(profile.accessToken);
  if (profile.rpcToken.length >= 8) context.registerSecret(profile.rpcToken);
}

async function sessionCookieEvidence(context, page, gateway) {
  const cookie = (await page.context().cookies(gateway.baseUrl))
    .find(item => item.name === "kcoder_studio_session");
  if (typeof cookie?.value === "string" && cookie.value.length >= 8) {
    context.registerSecret(cookie.value);
  }
  return {
    present: typeof cookie?.value === "string" && cookie.value.length > 0,
    fingerprint: typeof cookie?.value === "string" && cookie.value.length > 0
      ? shortHash(cookie.value)
      : null,
  };
}

async function closeOwnedRouteSocket(socket, reason) {
  const options = { code: 4001, reason };
  await socket.upstream.close(options);
  await socket.client.close(options);
}

function closeOptions(code, reason) {
  return {
    ...(code === 1000 || (typeof code === "number" && code >= 3000 && code <= 4999)
      ? { code }
      : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

async function waitForStoredActiveProfile(page, profileId) {
  await page.waitForFunction(({ key, expected }) => {
    try { return JSON.parse(localStorage.getItem(key) ?? "null")?.activeId === expected; }
    catch { return false; }
  }, { key: PROFILE_INDEX_KEY, expected: profileId }, { timeout: 15_000 });
}

async function isStoredActiveProfile(page, profileId) {
  return page.evaluate(({ key, expected }) => {
    try { return JSON.parse(localStorage.getItem(key) ?? "null")?.activeId === expected; }
    catch { return false; }
  }, { key: PROFILE_INDEX_KEY, expected: profileId });
}

async function backLabel(page) {
  return (await page.locator("html").getAttribute("lang")) === "en" ? "Back" : "返回";
}

function requiredEnvironmentValue(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.trim().length > 0, `${name} is required`);
  return value.trim();
}

function requiredSha256Pin(name) {
  const value = requiredEnvironmentValue(name);
  assert.ok(/^[a-f0-9]{64}$/.test(value), `${name} must be a lowercase SHA-256 digest`);
  return value;
}

function bearerHeaderFingerprint(request) {
  const authorization = request.headers()?.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? shortHash(match[1]) : null;
}

function shortHash(value) {
  return shortHashBytes(Buffer.from(String(value)));
}

function shortHashBytes(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
