// One-shot, model-independent acceptance of Mobile LAN-first/public-Relay route
// selection against an owned Gateway and Relay. Run only with the explicit gate.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createMobileDeviceAuth, mobileDeviceStoreIdentity } from "../../src/mobile-device-auth.js";
import { startClient } from "../../../kcoder-relay/src/client.mjs";
import { startRelay } from "../../../kcoder-relay/src/server.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { parseGatewayConnectionRoutes } from "../../shared/gatewayConnectionRoutes.js";

const RUN_FLAG = "KCODER_E2E_PRIVATE_MOBILE_DUAL_ROUTE_ACCEPTANCE";
const RELAY_GATEWAY_ID = "route-acceptance";
const EVIDENCE_BOUNDARY = "Node bundle of the current Mobile HTTP/RPC route consumers with Expo Crypto and Android Platform shims plus a Node ws adapter for the React Native null-protocol constructor; random authenticated local KCODER_STUDIO_MOCK Gateway; real in-process Relay and two candidate routes behind one RunContext-owned private-interface HTTP proxy; no Provider, model call, real credential, Browser, or native-device claim; HTTP is development-only and does not prove production TLS";

if (process.env[RUN_FLAG] !== "1") {
  throw new Error(`${RUN_FLAG}=1 is required for this private one-shot acceptance`);
}

await runE2E(import.meta.url, {
  testId: "mobile-dual-route-real-gateway-relay-transport",
  tier: "manual-live",
  modelPolicy: EVIDENCE_BOUNDARY,
  retainSuccessLogs: true,
}, async context => {
  const originalHttpFlags = {
    gateway: process.env.KCODER_STUDIO_ALLOW_HTTP,
    expo: process.env.EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP,
  };
  process.env.KCODER_STUDIO_ALLOW_HTTP = "1";
  process.env.EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP = "1";
  try {
    const lanAddress = findPrivateIpv4();
    const routeProxy = await createOwnedRouteProxy(context, lanAddress);
    const lanUrl = `http://${lanAddress}:${routeProxy.port}`;
    const publicOrigin = new URL(lanUrl).origin;
    const publicUrl = `${publicOrigin}/g/${RELAY_GATEWAY_ID}`;
    const allowedOrigins = publicOrigin;

    const relaySecret = randomCredential(context);
    const relayPairingToken = randomCredential(context);
    const relay = await startRelay({
      gateways: [{
        id: RELAY_GATEWAY_ID,
        secret: relaySecret,
        pairingToken: relayPairingToken,
        maxConnections: 64,
        maxBytesPerWindow: 8 * 1024 * 1024,
        trafficWindowMs: 10_000,
      }],
      sharedHosts: [`${lanAddress}:${routeProxy.port}`],
      controlPort: 0,
      proxyPort: 0,
      connectTimeout: 5_000,
    });
    context.addCleanup("close owned dual-route Relay", () => relay.close());
    context.registerPort("mobile-dual-route-relay-control", relay.controlPort);
    context.registerPort("mobile-dual-route-relay-public", relay.proxyPort);
    routeProxy.setRelayUpstream("127.0.0.1", relay.proxyPort);

    // The Relay validates Gateway authentication with the same pairing token
    // configured on the real private Relay wrapper. The control secret stays separate.
    const gatewayAuthToken = relayPairingToken;
    const workspace = context.pathInState("workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const gateway = await startGateway(context, {
      label: "mobile-dual-route-mock-gateway",
      host: "127.0.0.1",
      workspace,
      authToken: gatewayAuthToken,
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_WEB_ROOT: "",
        KCODER_STUDIO_SERVERS_STORE: context.pathInState("gateway/servers-store.json"),
        KCODER_STUDIO_LAN_ACCESS_URLS: lanUrl,
        KCODER_STUDIO_PUBLIC_ORIGINS: allowedOrigins,
        KCODER_STUDIO_PUBLIC_ACCESS_URL: publicUrl,
        KCODER_STUDIO_ALLOW_HTTP: "1",
      },
    });
    routeProxy.setGatewayUpstream("127.0.0.1", gateway.port);

    let relayOnline = false;
    const relayClient = await startClient({
      url: `http://127.0.0.1:${relay.controlPort}`,
      secret: relaySecret,
      gatewayId: RELAY_GATEWAY_ID,
      gateway: gateway.baseUrl,
      allowInsecure: true,
      retryMs: 50,
      onOnline: () => { relayOnline = true; },
    });
    context.addCleanup("close owned dual-route Relay client", () => relayClient.close());
    await waitFor(() => relayOnline ? true : null, 10_000, "owned static Relay client online", 25, context.abortSignal);

    const clientModules = await bundleMobileConsumers(context);
    const cookie = await loginAndReadPairing(context, gateway.baseUrl, gatewayAuthToken);
    const pairing = cookie.pairing;
    const routes = parseGatewayConnectionRoutes(pairing.connectionRoutes);
    assert.ok(routes, "the Gateway pairing response must advertise the signed route descriptor");
    assert.equal(routes.endpoints[0]?.kind, "lan");
    assert.equal(routes.endpoints[0]?.url, lanUrl);
    assert.equal(routes.endpoints.at(-1)?.kind, "public");
    assert.equal(routes.endpoints.at(-1)?.url, publicUrl);
    assert.equal(pairing.publicBaseUrl, publicUrl);

    const directBootstrap = await clientModules.http.exchangeMobileSessionWithBootstrap(
      lanUrl,
      pairing.token,
      "dual-route direct LAN acceptance",
      context.abortSignal,
      routes,
    );
    const directProfile = directBootstrap.profile;
    registerProfileCredentials(context, directProfile);
    assert.equal(directProfile.baseUrl, lanUrl, "the selected transport must not rewrite the canonical profile baseUrl");
    assert.deepEqual(directProfile.connectionRoutes, routes, "the paired profile must retain the same Gateway identity and route descriptor");
    assert.equal(directProfile.authMode, "device");
    assert.equal(Object.hasOwn(directProfile, "proofCredential"), false);
    assert.equal(Object.hasOwn(routes, "proofCredential"), false);

    const initialLanRecords = laneRouteRecords(routeProxy.records);
    const initialPublicRecords = publicRouteRecords(routeProxy.records);
    const pairingRequest = initialLanRecords.find(record => record.method === "POST" && record.path === "/api/mobile/session");
    assert.ok(pairingRequest, "pairing exchange must traverse the LAN candidate");
    assert.equal(initialLanRecords.filter(record => record.method === "POST" && record.path === "/api/mobile/session").length, 1, "the Gateway is paired exactly once through LAN");
    assert.equal(pairingRequest.hasAuthorization, false, "pairing token is sent only in the selected LAN exchange body");
    assert.ok(pairingRequest.bodyKeys.includes("token"));
    assert.equal(initialPublicRecords.filter(record => record.path.endsWith("/api/mobile/session")).length, 0, "the selected LAN pairing exchange must not be broadcast to the public Relay candidate");
    assertProofRequestsAreUnauthenticated(initialLanRecords, initialPublicRecords);
    assert.equal(await clientModules.routes.resolveGatewayRoute(directProfile, { force: true }), lanUrl, "a healthy LAN proof must win over the verified public candidate");

    const beforeHealthyLan = countAuthorizedApi(laneRouteRecords(routeProxy.records), "/api/mobile/devices");
    const beforeHealthyPublic = countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices");
    const directDevices = await clientModules.http.gatewayRequest(directProfile, "/api/mobile/devices");
    assert.ok(Array.isArray(directDevices.devices) && directDevices.devices.some(device => device.id === directProfile.deviceId));
    assert.equal(countAuthorizedApi(laneRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeHealthyLan, 1, "a normal authenticated API call must use its selected LAN address once");
    assert.equal(countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeHealthyPublic, 0, "an authenticated API call must not be sent to an unselected public address");

    const wrongGateway = await startWrongGatewayProof(context, lanAddress);
    assert.notEqual(wrongGateway.identity.gatewayId, routes.gatewayId);
    const wrongGatewayDescriptor = {
      ...routes,
      endpoints: [{ kind: "lan", url: wrongGateway.url }, ...routes.endpoints],
    };
    const wrongGatewayProfile = {
      ...directProfile,
      id: `${directProfile.id}-wrong-gateway-proof`,
      connectionRoutes: wrongGatewayDescriptor,
    };
    const selectedAfterWrongProof = await clientModules.routes.resolveGatewayRoute(wrongGatewayProfile, { force: true });
    assert.equal(selectedAfterWrongProof, lanUrl, "a separately signed proof from another Gateway must be rejected");
    assert.equal(wrongGateway.proofCount(), 1, "the foreign route must receive a challenge probe");

    routeProxy.setLanDown(true);
    const beforeFailedLan = countAuthorizedApi(laneRouteRecords(routeProxy.records), "/api/mobile/devices");
    const beforeFallbackPublic = countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices");
    let afterLanFailure;
    let failoverError;
    try {
      afterLanFailure = await clientModules.http.gatewayRequest(directProfile, "/api/mobile/devices");
    } catch (error) {
      failoverError = error;
    }
    assert.equal(countAuthorizedApi(laneRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeFailedLan, 1, "one authorized attempt may fail at the selected LAN transport");
    assert.equal(countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeFallbackPublic, 1, "the GET must retry once after selecting the verified public Relay route");
    const selectedAfterLanFailure = await clientModules.routes.resolveGatewayRoute(directProfile, { force: true });
    assert.equal(selectedAfterLanFailure, publicUrl, "the failed LAN proof must cause public-route selection");
    if (failoverError || !Array.isArray(afterLanFailure?.devices)) {
      const relayRejected = publicRouteRecords(routeProxy.records).findLast(record => record.path.endsWith("/api/mobile/devices") && record.hasAuthorization);
      if (relayRejected?.responseStatus === 401) {
        await context.writeArtifactJson("mobile-dual-route-acceptance.json", {
          status: "blocked-by-product-defect",
          failure: "LAN pairing issued this device grant directly from Gateway; Relay later rejected the same grant after successful public route selection",
          expectedPublicRoute: publicUrl,
          selectedPublicRoute: selectedAfterLanFailure,
          directProfileBaseUrl: directProfile.baseUrl,
          pairingSessionViaLan: laneRouteRecords(routeProxy.records).filter(record => record.method === "POST" && record.path === "/api/mobile/session").length,
          pairingSessionViaPublicRelay: publicRouteRecords(routeProxy.records).filter(record => record.path.endsWith("/api/mobile/session")).length,
          lanAuthenticatedAttempts: countAuthorizedApi(laneRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeFailedLan,
          publicRelayAuthenticatedAttempts: countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeFallbackPublic,
          publicRelayStatus: relayRejected.responseStatus,
          evidenceBoundary: EVIDENCE_BOUNDARY,
          transportSecurity: "HTTP development-only; no production TLS claim",
        });
        throw new Error("PRODUCT_BLOCKER: same-device LAN pairing grant is not recognized by the Relay after route failover (HTTP 401)");
      }
      throw failoverError || new Error("public route failover did not return an authenticated device API response");
    }
    assert.ok(afterLanFailure.devices.some(device => device.id === directProfile.deviceId));

    const servers = await clientModules.http.listServers(directProfile);
    assert.ok(Array.isArray(servers) && servers.length > 0, "the Gateway supplies a real RPC target identity");
    const rpcClient = await clientModules.rpc.GatewayRpcClient.connect(directProfile, servers[0], undefined, "runtime", { signal: context.abortSignal });
    context.addCleanup("close owned Mobile Gateway RPC client", () => rpcClient.close());
    const rpcResult = await rpcClient.request("thread/list", { archived: false });
    assert.ok(rpcResult && Array.isArray(rpcResult.threads), "RPC initialize and thread/list must complete through the selected public Relay route");
    assert.ok(publicRouteRecords(routeProxy.records).some(record => record.upgrade && record.path.startsWith(`/g/${RELAY_GATEWAY_ID}/rpc`) && record.hasAuthorization), "RPC WebSocket must traverse the public Relay route with the selected device credential");
    rpcClient.close();

    const legacyProfile = { ...directProfile, connectionRoutes: undefined };
    assert.equal(await clientModules.routes.resolveGatewayRoute(legacyProfile), legacyProfile.baseUrl, "legacy profiles without descriptors continue to use their canonical baseUrl");
    const beforeLegacyLan = countAuthorizedApi(laneRouteRecords(routeProxy.records), "/api/mobile/devices");
    const beforeLegacyPublic = countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices");
    await assert.rejects(
      clientModules.http.gatewayRequest(legacyProfile, "/api/mobile/devices"),
      error => error instanceof Error,
      "a legacy profile does not gain unadvertised route failover",
    );
    assert.equal(countAuthorizedApi(laneRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeLegacyLan, 1);
    assert.equal(countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeLegacyPublic, 0);

    routeProxy.setLanDown(false);
    await new Promise(resolveWait => setTimeout(resolveWait, 5_100));
    clientModules.routes.invalidateGatewayRoute(directProfile);
    assert.equal(await clientModules.routes.resolveGatewayRoute(directProfile, { force: true }), lanUrl, "the recovered LAN route becomes preferred after its bounded failure cooldown");
    const beforeLanRefresh = countRouteRequest(laneRouteRecords(routeProxy.records), "POST", "/api/mobile/session/refresh");
    const beforePublicRefresh = countRouteRequest(publicRouteRecords(routeProxy.records), "POST", "/api/mobile/session/refresh");
    const lanRefreshedProfile = await clientModules.http.refreshMobileSession(directProfile, randomRotationId(context));
    registerProfileCredentials(context, lanRefreshedProfile);
    assert.equal(lanRefreshedProfile.id, directProfile.id);
    assert.equal(lanRefreshedProfile.deviceId, directProfile.deviceId, "LAN refresh must retain the existing device family");
    assert.equal(lanRefreshedProfile.authorizationGeneration, directProfile.authorizationGeneration);
    assert.equal(countRouteRequest(laneRouteRecords(routeProxy.records), "POST", "/api/mobile/session/refresh") - beforeLanRefresh, 1, "the token rotation must traverse recovered LAN");
    assert.equal(countRouteRequest(publicRouteRecords(routeProxy.records), "POST", "/api/mobile/session/refresh") - beforePublicRefresh, 0);
    const refreshedDeviceList = await clientModules.http.gatewayRequest(lanRefreshedProfile, "/api/mobile/devices");
    assert.equal(refreshedDeviceList.devices.length, 1, "LAN refresh must not create another device");

    routeProxy.setLanDown(true);
    const beforeWsFirstPublicApi = countAuthorizedHttpRequests(publicRouteRecords(routeProxy.records));
    const beforeWsFirstRelayUpgrades = countAuthorizedRpcUpgrades(publicRouteRecords(routeProxy.records));
    clientModules.routes.invalidateGatewayRoute(lanRefreshedProfile, lanUrl);
    const wsFirstRpcClient = await clientModules.rpc.GatewayRpcClient.connect(
      lanRefreshedProfile,
      servers[0],
      undefined,
      "runtime",
      { signal: context.abortSignal },
    );
    context.addCleanup("close owned refreshed-token WS-first RPC client", () => wsFirstRpcClient.close());
    const wsFirstRpcResult = await wsFirstRpcClient.request("thread/list", { archived: false });
    wsFirstRpcClient.close();
    assert.ok(wsFirstRpcResult && Array.isArray(wsFirstRpcResult.threads), "the refreshed device token must complete RPC through Relay before any public API request");
    assert.equal(countAuthorizedHttpRequests(publicRouteRecords(routeProxy.records)) - beforeWsFirstPublicApi, 0, "no authenticated HTTP API may precede the refreshed-token WebSocket-first request");
    assert.equal(countAuthorizedRpcUpgrades(publicRouteRecords(routeProxy.records)) - beforeWsFirstRelayUpgrades, 1, "the refreshed-token WebSocket-first connect must make exactly one authenticated Relay upgrade");
    await context.writeArtifactJson("mobile-dual-route-ws-first.json", {
      status: "passed",
      oneLanPair: initialLanRecords.filter(record => record.method === "POST" && record.path === "/api/mobile/session").length === 1,
      devicesAfterLanRefresh: refreshedDeviceList.devices.length,
      authenticatedPublicHttpRequestsBeforeWsFirst: 0,
      authenticatedRelayRpcUpgrades: 1,
      rpcMethod: "thread/list",
      rpcThreadCount: wsFirstRpcResult.threads.length,
      evidenceBoundary: EVIDENCE_BOUNDARY,
    });

    const beforeNewTokenRelayGet = countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices");
    const newTokenRelayDevices = await clientModules.http.gatewayRequest(lanRefreshedProfile, "/api/mobile/devices");
    assert.equal(countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices") - beforeNewTokenRelayGet, 1, "Relay must admit the refreshed access token for authenticated API traffic");
    assert.equal(newTokenRelayDevices.devices.length, 1);
    assert.equal(newTokenRelayDevices.devices[0].id, directProfile.deviceId);

    const beforeRelayRefresh = countRouteRequest(publicRouteRecords(routeProxy.records), "POST", "/api/mobile/session/refresh");
    const relayRefreshedProfile = await clientModules.http.refreshMobileSession(lanRefreshedProfile, randomRotationId(context));
    registerProfileCredentials(context, relayRefreshedProfile);
    assert.equal(relayRefreshedProfile.id, directProfile.id);
    assert.equal(relayRefreshedProfile.deviceId, directProfile.deviceId);
    assert.equal(relayRefreshedProfile.authorizationGeneration, directProfile.authorizationGeneration);
    assert.equal(countRouteRequest(publicRouteRecords(routeProxy.records), "POST", "/api/mobile/session/refresh") - beforeRelayRefresh, 1, "Relay refresh must retain the same device authorization");
    const finalDevices = await clientModules.http.gatewayRequest(relayRefreshedProfile, "/api/mobile/devices");
    assert.equal(finalDevices.devices.length, 1, "Relay refresh must not issue or register another device");
    assert.equal(finalDevices.devices[0].id, directProfile.deviceId);

    const allRecords = [...routeProxy.records, ...wrongGateway.records];
    assert.ok(allRecords.every(record => record.proofCredentialKeySeen !== true), "no request descriptor/body may carry a proofCredential field");
    assert.equal(directProfile.baseUrl, lanUrl, "route changes must leave the durable profile address stable");
    await context.writeArtifactJson("mobile-dual-route-acceptance.json", {
      status: "passed",
      evidenceBoundary: EVIDENCE_BOUNDARY,
      transportSecurity: "HTTP development-only; no production TLS claim",
      lanAddress,
      routeKinds: routes.endpoints.map(endpoint => endpoint.kind),
      directProfileBaseUrl: directProfile.baseUrl,
      selectedInitially: lanUrl,
      selectedAfterLanFailure: publicUrl,
      pairingSessionViaLan: laneRouteRecords(routeProxy.records).filter(record => record.method === "POST" && record.path === "/api/mobile/session").length,
      pairingSessionViaPublicRelay: publicRouteRecords(routeProxy.records).filter(record => record.path.endsWith("/api/mobile/session")).length,
      authenticatedDeviceApiViaLan: countAuthorizedApi(laneRouteRecords(routeProxy.records), "/api/mobile/devices"),
      authenticatedDeviceApiViaPublicRelay: countAuthorizedApi(publicRouteRecords(routeProxy.records), "/api/mobile/devices"),
      publicRelayProofProbes: publicRouteRecords(routeProxy.records).filter(record => record.path.endsWith("/api/mobile/connection-proof")).length,
      foreignGatewayProofProbes: wrongGateway.proofCount(),
      publicRelayRpcUpgrades: publicRouteRecords(routeProxy.records).filter(record => record.upgrade && record.path.startsWith(`/g/${RELAY_GATEWAY_ID}/rpc`)).length,
      lanDeviceRefreshes: countRouteRequest(laneRouteRecords(routeProxy.records), "POST", "/api/mobile/session/refresh"),
      publicRelayDeviceRefreshes: countRouteRequest(publicRouteRecords(routeProxy.records), "POST", "/api/mobile/session/refresh"),
      finalDeviceCount: finalDevices.devices.length,
      proofCredentialFieldSeen: allRecords.some(record => record.proofCredentialKeySeen === true),
      legacyDescriptorFallback: "canonical baseUrl only; no route failover",
    });
  } finally {
    restoreEnv("KCODER_STUDIO_ALLOW_HTTP", originalHttpFlags.gateway);
    restoreEnv("EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP", originalHttpFlags.expo);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function randomCredential(context) {
  const value = randomBytes(32).toString("base64url");
  context.registerSecret(value);
  return value;
}

function findPrivateIpv4() {
  const candidates = [...new Set(Object.values(networkInterfaces()).flatMap(rows => (rows || [])
    .filter(row => row && row.internal !== true && row.family === "IPv4" && isRfc1918(row.address))
    .map(row => row.address)))].sort((left, right) => {
    const score = value => value.startsWith("10.") ? 0 : value.startsWith("192.168.") ? 1 : 2;
    return score(left) - score(right) || left.localeCompare(right, undefined, { numeric: true });
  });
  if (candidates.length === 0) throw new Error("UNMET_PREREQUISITE: this host has no non-loopback RFC1918 IPv4 address for route acceptance");
  return candidates[0];
}

function isRfc1918(value) {
  const parts = value.split(".").map(Number);
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

async function createOwnedRouteProxy(context, listenHost) {
  const records = [];
  let lanDown = false;
  let gatewayUpstream;
  let relayUpstream;
  const relayPath = new RegExp(`^/g/${RELAY_GATEWAY_ID}(?:/|$)`);
  const selectUpstream = path => relayPath.test(path)
    ? { route: "public", target: relayUpstream }
    : { route: "lan", target: gatewayUpstream };
  const server = createHttpServer((request, response) => {
    const record = recordRequest(request, false);
    records.push(record);
    inspectBodyKeys(request, record);
    const { route, target } = selectUpstream(request.url || "/");
    record.route = route;
    if ((route === "lan" && lanDown) || !target) {
      request.resume();
      response.destroy();
      return;
    }
    const outgoing = httpRequest({
      host: target.host,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: request.headers.host },
    }, upstreamResponse => {
      record.responseStatus = upstreamResponse.statusCode || 502;
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    outgoing.on("error", () => response.destroy());
    request.pipe(outgoing);
  });
  server.on("upgrade", (request, socket, head) => {
    const record = recordRequest(request, true);
    records.push(record);
    const { route, target } = selectUpstream(request.url || "/");
    record.route = route;
    if ((route === "lan" && lanDown) || !target) {
      socket.destroy();
      return;
    }
    const outgoing = httpRequest({
      host: target.host,
      port: target.port,
      method: "GET",
      path: request.url,
      headers: { ...request.headers, host: request.headers.host },
    });
    outgoing.on("upgrade", (upgradeResponse, upstreamSocket, upstreamHead) => {
      socket.write(`HTTP/1.1 ${upgradeResponse.statusCode || 101} ${upgradeResponse.statusMessage || "Switching Protocols"}\r\n`);
      for (let index = 0; index < upgradeResponse.rawHeaders.length; index += 2) {
        socket.write(`${upgradeResponse.rawHeaders[index]}: ${upgradeResponse.rawHeaders[index + 1]}\r\n`);
      }
      socket.write("\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    outgoing.on("response", response => {
      socket.write(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || "Bad Gateway"}\r\n`);
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
      }
      socket.write("\r\n");
      response.pipe(socket);
    });
    outgoing.on("error", () => socket.destroy());
    outgoing.end();
  });
  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost, resolveListening);
  });
  const port = server.address().port;
  context.registerPort("mobile-dual-route-private-interface-proxy", port);
  context.addCleanup("close owned dual-route private-interface proxy", () => closeHttpServer(server));
  return {
    port,
    records,
    setLanDown(value) { lanDown = value; },
    setGatewayUpstream(host, upstreamPort) { gatewayUpstream = { host, port: upstreamPort }; },
    setRelayUpstream(host, upstreamPort) { relayUpstream = { host, port: upstreamPort }; },
    async close() { await closeHttpServer(server); },
  };
}

function laneRouteRecords(records) {
  return records.filter(record => record.route === "lan");
}

function publicRouteRecords(records) {
  return records.filter(record => record.route === "public");
}

function recordRequest(request, upgrade) {
  const rawPath = request.url || "/";
  const parsed = new URL(rawPath, `http://${request.headers.host || "owned.invalid"}`);
  return {
    method: request.method || "GET",
    path: parsed.pathname,
    queryKeys: [...new Set([...parsed.searchParams.keys()])].sort(),
    hasAuthorization: typeof request.headers.authorization === "string",
    hasCookie: typeof request.headers.cookie === "string",
    upgrade,
    bodyKeys: [],
    proofCredentialKeySeen: /proofcredential/i.test(rawPath),
  };
}

function inspectBodyKeys(request, record) {
  const chunks = [];
  let bytes = 0;
  request.on("data", chunk => {
    bytes += chunk.length;
    if (bytes <= 65_536) chunks.push(Buffer.from(chunk));
    else chunks.length = 0;
  });
  request.on("end", () => {
    if (bytes > 65_536 || chunks.length === 0) return;
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        record.bodyKeys = Object.keys(value).sort();
        record.proofCredentialKeySeen = Object.keys(value).some(key => /proofcredential/i.test(key));
      }
    } catch { /* Bodies are inspected only when they are bounded JSON objects. */ }
  });
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise(resolveClosed => server.close(() => resolveClosed()));
}

async function startWrongGatewayProof(context, host) {
  let auth;
  let endpoint;
  let proofCount = 0;
  const records = [];
  const server = createHttpServer(async (request, response) => {
    const record = recordRequest(request, false);
    records.push(record);
    const url = new URL(request.url || "/", `http://${request.headers.host || "owned.invalid"}`);
    const nonce = url.searchParams.get("nonce");
    const requestedEndpoint = url.searchParams.get("endpoint");
    if (request.method !== "GET" || url.pathname !== "/api/mobile/connection-proof" ||
        url.searchParams.size !== 2 || !nonce || requestedEndpoint !== endpoint) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    proofCount += 1;
    try {
      const proof = await auth.signConnectionProof(nonce, requestedEndpoint);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(proof));
    } catch {
      response.writeHead(503, { "cache-control": "no-store" });
      response.end();
    }
  });
  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolveListening);
  });
  const port = server.address().port;
  context.registerPort("mobile-dual-route-wrong-gateway-proof", port);
  context.addCleanup("close owned foreign Gateway proof fixture", () => closeHttpServer(server));
  endpoint = `http://${host}:${port}`;
  const authToken = randomCredential(context);
  auth = createMobileDeviceAuth({
    directory: context.pathInState("foreign-gateway-auth"),
    identity: mobileDeviceStoreIdentity(authToken),
    isConnectionEndpointAllowed: value => value === endpoint,
  });
  const identity = await auth.getConnectionIdentity();
  return {
    url: endpoint,
    identity,
    records,
    proofCount: () => proofCount,
    async close() { await closeHttpServer(server); },
  };
}

async function loginAndReadPairing(context, baseUrl, adminToken) {
  const login = await fetch(`${baseUrl}/login?token=${encodeURIComponent(adminToken)}`, { redirect: "manual" });
  assert.equal(login.status, 303, "isolated Gateway admin login must create a private session");
  const setCookies = login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""];
  const rawCookie = setCookies.find(value => value.includes("kcoder_studio_session="));
  assert.ok(rawCookie, "isolated Gateway login must return its admin session cookie");
  const cookieValue = /kcoder_studio_session=([^;]+)/.exec(rawCookie)?.[1];
  assert.ok(cookieValue);
  context.registerSecret(decodeURIComponent(cookieValue));
  const response = await fetch(`${baseUrl}/api/mobile/pairing`, {
    headers: { cookie: `kcoder_studio_session=${cookieValue}` },
  });
  assert.equal(response.status, 200, "admin session must retrieve the real Gateway pairing descriptor");
  const pairing = await response.json();
  assert.equal(typeof pairing.token, "string");
  context.registerSecret(pairing.token);
  return { pairing };
}

function assertProofRequestsAreUnauthenticated(lanRecords, publicRecords) {
  const proofs = [...lanRecords, ...publicRecords].filter(record => record.path.endsWith("/api/mobile/connection-proof"));
  assert.ok(proofs.length >= 2, "both LAN and public candidates must receive real challenge probes");
  for (const proof of proofs) {
    assert.deepEqual(proof.queryKeys, ["endpoint", "nonce"], "proof probes carry only nonce and the canonical endpoint");
    assert.equal(proof.hasAuthorization, false);
    assert.equal(proof.hasCookie, false);
    assert.equal(proof.proofCredentialKeySeen, false);
  }
}

function countAuthorizedApi(records, path) {
  return records.filter(record => record.path.endsWith(path) && record.hasAuthorization).length;
}

function countRouteRequest(records, method, path) {
  return records.filter(record => record.method === method && record.path.endsWith(path)).length;
}

function countAuthorizedHttpRequests(records) {
  return records.filter(record => !record.upgrade && record.hasAuthorization).length;
}

function countAuthorizedRpcUpgrades(records) {
  return records.filter(record => record.upgrade && record.hasAuthorization && record.path.startsWith(`/g/${RELAY_GATEWAY_ID}/rpc`)).length;
}

function randomRotationId(context) {
  const value = randomBytes(18).toString("hex");
  context.registerSecret(value);
  return value;
}

function registerProfileCredentials(context, profile) {
  for (const name of ["accessToken", "refreshToken", "rpcToken"]) {
    if (typeof profile[name] === "string") context.registerSecret(profile[name]);
  }
}

async function bundleMobileConsumers(context) {
  const mobileRoot = resolve(appRoot, "mobile");
  const requireMobile = createRequire(resolve(mobileRoot, "package.json"));
  const esbuild = requireMobile("esbuild");
  const outputDirectory = context.pathInState("mobile-consumer-bundle");
  const nodeShim = `
    import { randomBytes, webcrypto } from "node:crypto";
    export const Platform = { OS: "android" };
    export const CryptoDigestAlgorithm = { SHA256: "SHA-256" };
    export function getRandomBytes(byteCount) { return new Uint8Array(randomBytes(byteCount)); }
    export async function digest(algorithm, data) { return webcrypto.subtle.digest(algorithm, data); }
  `;
  const aliases = {
    name: "dual-route-node-platform-and-expo-crypto-shim",
    setup(build) {
      build.onResolve({ filter: /^expo-crypto$/ }, () => ({ path: "expo-crypto", namespace: "dual-route-shim" }));
      build.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native", namespace: "dual-route-shim" }));
      build.onLoad({ filter: /.*/, namespace: "dual-route-shim" }, () => ({ contents: nodeShim, loader: "js" }));
    },
  };
  await esbuild.build({
    absWorkingDir: mobileRoot,
    stdin: {
      contents: [
        'export * from "./src/gateway/http";',
        'export * from "./src/gateway/rpc";',
        'export * from "./src/gateway/connection-routes";',
      ].join("\n"),
      resolveDir: mobileRoot,
      sourcefile: "mobile-dual-route-consumers.ts",
    },
    outfile: resolve(outputDirectory, "mobile-consumers.mjs"),
    bundle: true,
    tsconfig: resolve(mobileRoot, "tsconfig.json"),
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "bundle",
    plugins: [aliases],
    logLevel: "silent",
  });
  const relayRequire = createRequire(resolve(repoRoot, "apps/kcoder-relay/package.json"));
  const WebSocket = relayRequire("ws");
  class ReactNativeWebSocketConstructorAdapter extends WebSocket {
    constructor(address, protocols, options) {
      super(address, protocols == null ? [] : protocols, options);
    }
  }
  globalThis.WebSocket = ReactNativeWebSocketConstructorAdapter;
  const client = await import(pathToFileURL(resolve(outputDirectory, "mobile-consumers.mjs")).href);
  return { http: client, rpc: client, routes: client };
}
