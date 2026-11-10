import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { mkdir } from "node:fs/promises";
import { startClient } from "../../../kcoder-relay/src/client.mjs";
import { startRelay } from "../../../kcoder-relay/src/server.mjs";
import { parseGatewayConnectionRoutes } from "../../shared/gatewayConnectionRoutes.js";
import { startGateway } from "../harness/gateway.mjs";
import { waitFor } from "../harness/run-context.mjs";

const RELAY_GATEWAY_ID = "mobile-dual-route-browser";

/** Start isolated real Gateway/Relay transports for a Mobile Web browser acceptance. */
export async function startBrowserDualRouteFixture(context, { mobileWebOrigin, gatewayEnv = {} }) {
  if (!gatewayEnv || Object.getPrototypeOf(gatewayEnv) !== Object.prototype || Array.isArray(gatewayEnv)) {
    throw new TypeError("gatewayEnv must be a plain object of isolated Gateway environment overrides");
  }
  for (const name of Object.keys(gatewayEnv)) {
    if (!/^KCODER_STUDIO_(?:P2P(?:_[A-Z0-9_]+)?|MOBILE_WEB_ROOT|MOBILE_ACCESS_TTL_MS)$/.test(name)) {
      throw new TypeError(`Unsupported browser fixture Gateway override: ${name}`);
    }
  }
  const webOrigin = canonicalHttpOrigin(mobileWebOrigin);
  const lanAddress = findPrivateIpv4();
  const routeProxy = await createRouteProxy(context, lanAddress);
  const lanUrl = `http://${lanAddress}:${routeProxy.port}`;
  const publicUrl = `${lanUrl}/g/${RELAY_GATEWAY_ID}`;
  const publicOrigin = new URL(lanUrl).origin;
  const publicOrigins = [...new Set([publicOrigin, webOrigin])].join(",");
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
  context.addCleanup("close browser dual-route Relay", () => relay.close());
  context.registerPort("mobile-dual-route-browser-relay-control", relay.controlPort);
  context.registerPort("mobile-dual-route-browser-relay-public", relay.proxyPort);
  routeProxy.setRelayUpstream("127.0.0.1", relay.proxyPort);

  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversStore = context.pathInState("gateway/servers-store.json");
  const gateway = await startGateway(context, {
    label: "mobile-dual-route-browser-gateway",
    host: "127.0.0.1",
    workspace,
    authToken: relayPairingToken,
    env: {
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_SERVERS_STORE: serversStore,
      KCODER_STUDIO_LAN_ACCESS_URLS: lanUrl,
      KCODER_STUDIO_PUBLIC_ORIGINS: publicOrigins,
      KCODER_STUDIO_PUBLIC_ACCESS_URL: publicUrl,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: webOrigin,
      ...gatewayEnv,
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
    onDiagnostic: record => {
      if (record.event === "control_open") relayOnline = true;
      if (["control_close", "control_error"].includes(record.event)) relayOnline = false;
    },
  });
  context.addCleanup("close browser dual-route Relay client", () => relayClient.close());
  await waitFor(() => relayOnline ? true : null, 10_000, "browser fixture Relay client online", 25, context.abortSignal);

  const adminCookie = await loginGatewayAdmin(context, gateway.baseUrl, relayPairingToken);
  const readAdminPairing = async () => {
    const response = await fetch(`${gateway.baseUrl}/api/mobile/pairing`, {
      cache: "no-store",
      headers: { cookie: adminCookie },
    });
    if (!response.ok) throw new Error(`Isolated Gateway pairing administration returned HTTP ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value.devices)) throw new Error("Isolated Gateway pairing administration returned no device list");
    return value;
  };
  const pairingResponse = await readAdminPairing();
  const routes = parseGatewayConnectionRoutes(pairingResponse.connectionRoutes);
  if (!routes || pairingResponse.publicBaseUrl !== publicUrl ||
      !routes.endpoints.some(endpoint => endpoint.kind === "lan" && endpoint.url === lanUrl) ||
      !routes.endpoints.some(endpoint => endpoint.kind === "public" && endpoint.url === publicUrl)) {
    throw new Error("Isolated Gateway did not advertise the expected signed LAN and public route descriptor");
  }
  if (typeof pairingResponse.token !== "string" || !pairingResponse.token) {
    throw new Error("Isolated Gateway pairing endpoint returned no pairing token");
  }
  context.registerSecret(pairingResponse.token);
  const pairing = {
    token: pairingResponse.token,
    expiresAt: pairingResponse.expiresAt,
    publicBaseUrl: pairingResponse.publicBaseUrl,
    connectionRoutes: routes,
  };

  const ownedDeviceIds = new Set();
  const initialDeviceIds = new Set(pairingResponse.devices.map(device => device.id));
  const observeOwnedDevices = value => {
    for (const device of value.devices) {
      if (!initialDeviceIds.has(device.id)) ownedDeviceIds.add(device.id);
    }
    return value.devices.length;
  };
  const adminDeviceCount = async () => observeOwnedDevices(await readAdminPairing());
  const revokeDevice = async deviceId => {
    if (typeof deviceId !== "string" || !/^[A-Za-z0-9-]{16,128}$/.test(deviceId)) return false;
    observeOwnedDevices(await readAdminPairing());
    if (!ownedDeviceIds.has(deviceId)) return false;
    const response = await fetch(`${gateway.baseUrl}/api/mobile/pairing/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: {
        cookie: adminCookie,
        origin: gateway.baseUrl,
        "content-type": "application/json",
      },
    });
    if (response.status !== 204) throw new Error(`Isolated Gateway device cleanup returned HTTP ${response.status}`);
    ownedDeviceIds.delete(deviceId);
    return true;
  };
  context.addCleanup("revoke browser-created Mobile devices", async () => {
    observeOwnedDevices(await readAdminPairing());
    for (const deviceId of [...ownedDeviceIds]) await revokeDevice(deviceId);
  });
  const health = async () => {
    try {
      const deviceCount = await adminDeviceCount();
      return { gatewayOk: true, relayOnline, lanUp: !routeProxy.isLanDown(), deviceCount };
    } catch {
      return { gatewayOk: false, relayOnline, lanUp: !routeProxy.isLanDown(), deviceCount: null };
    }
  };

  return {
    lanUrl,
    publicUrl,
    pairing,
    routes,
    records: routeProxy.records,
    setLanDown: routeProxy.setLanDown,
    setPublicDown: routeProxy.setPublicDown,
    setPublicBusinessDown: routeProxy.setPublicBusinessDown,
    setP2PSignalingDown: routeProxy.setP2PSignalingDown,
    setP2PAnswerSignatureInvalid: routeProxy.setP2PAnswerSignatureInvalid,
    health,
    adminDeviceCount,
    revokeDevice,
  };
}

function canonicalHttpOrigin(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error("mobileWebOrigin must be an HTTP(S) origin"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash ||
      (value !== parsed.origin && value !== `${parsed.origin}/`)) {
    throw new Error("mobileWebOrigin must be one canonical HTTP(S) origin");
  }
  return parsed.origin;
}

function randomCredential(context) {
  const value = randomBytes(32).toString("base64url");
  context.registerSecret(value);
  return value;
}

function findPrivateIpv4() {
  const addresses = [...new Set(Object.values(networkInterfaces()).flatMap(rows => (rows || [])
    .filter(row => row && row.internal !== true && row.family === "IPv4" && isPrivateIpv4(row.address))
    .map(row => row.address)))];
  addresses.sort((left, right) => ipv4Preference(left) - ipv4Preference(right) ||
    left.localeCompare(right, undefined, { numeric: true }));
  if (addresses.length === 0) throw new Error("UNMET_PREREQUISITE: no non-loopback RFC1918 IPv4 address for the browser route fixture");
  return addresses[0];
}

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function ipv4Preference(address) {
  return address.startsWith("10.") ? 0 : address.startsWith("192.168.") ? 1 : 2;
}

async function createRouteProxy(context, listenHost) {
  const records = [];
  const bridges = new Set();
  let lanDown = false;
  let publicDown = false;
  let publicBusinessDown = false;
  let p2pSignalingDown = false;
  let p2pAnswerSignatureInvalid = false;
  let gatewayUpstream;
  let relayUpstream;
  const relayPath = new RegExp(`^/g/${RELAY_GATEWAY_ID}(?:/|$)`);
  const selectRoute = path => relayPath.test(path)
    ? { route: "public", target: relayUpstream }
    : { route: "lan", target: gatewayUpstream };

  const server = createHttpServer((request, response) => {
    const record = recordRequest(request, false);
    records.push(record);
    const { route, target } = selectRoute(request.url || "/");
    record.route = route;
    if (p2pSignalingDown && isP2PSignalingPath(request.url || "/")) {
      record.injectedFailure = "p2p-signaling-unavailable";
      request.resume();
      response.writeHead(503, { "cache-control": "no-store", "content-type": "application/json" });
      response.end(JSON.stringify({ error: "owned fixture P2P signaling path unavailable" }));
      record.responseStatus = 503;
      return;
    }
    if (route === "public" && publicBusinessDown && !isP2PProofOrSignalPath(request.url || "/")) {
      record.transportFailure = true;
      record.injectedFailure = "public-business-unavailable";
      request.resume();
      response.destroy();
      return;
    }
    if ((route === "lan" && lanDown) || (route === "public" && publicDown) || !target) {
      record.transportFailure = true;
      request.resume();
      response.destroy();
      return;
    }
    const outgoing = httpRequest({
      host: target.host,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: request.headers,
    }, upstreamResponse => {
      record.responseStatus = upstreamResponse.statusCode || 502;
      captureResponseHeaders(record, request.headers, upstreamResponse.headers);
      if (route === "public" && p2pAnswerSignatureInvalid && isP2POfferPath(request.url || "/")) {
        const chunks = [];
        let byteCount = 0;
        upstreamResponse.on("data", chunk => {
          byteCount += chunk.length;
          if (byteCount <= 128 * 1024) chunks.push(chunk);
        });
        upstreamResponse.once("end", () => {
          if (byteCount > 128 * 1024 || record.responseStatus !== 200) {
            response.writeHead(record.responseStatus, upstreamResponse.headers);
            response.end(byteCount > 128 * 1024 ? "" : Buffer.concat(chunks, byteCount));
            return;
          }
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks, byteCount).toString("utf8")); }
          catch {
            response.writeHead(record.responseStatus, upstreamResponse.headers);
            response.end(Buffer.concat(chunks, byteCount));
            return;
          }
          if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
              typeof payload.signature !== "string" || !/^[a-f0-9]{128}$/.test(payload.signature)) {
            response.writeHead(record.responseStatus, upstreamResponse.headers);
            response.end(Buffer.concat(chunks, byteCount));
            return;
          }
          payload.signature = payload.signature === "0".repeat(128) ? "f".repeat(128) : "0".repeat(128);
          const transformed = Buffer.from(JSON.stringify(payload));
          const headers = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([name]) =>
            !["content-length", "transfer-encoding", "content-encoding", "etag", "content-md5"].includes(name.toLowerCase())));
          headers["content-length"] = String(transformed.length);
          record.injectedFailure = "p2p-answer-signature-invalid";
          response.writeHead(record.responseStatus, headers);
          response.end(transformed);
        });
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    outgoing.on("error", () => {
      record.transportFailure = true;
      response.destroy();
    });
    request.pipe(outgoing);
  });

  server.on("upgrade", (request, socket, head) => {
    const record = recordRequest(request, true);
    records.push(record);
    const { route, target } = selectRoute(request.url || "/");
    record.route = route;
    if (p2pSignalingDown && isP2PSignalingPath(request.url || "/")) {
      record.injectedFailure = "p2p-signaling-unavailable";
      socket.destroy();
      return;
    }
    if (route === "public" && publicBusinessDown && !isP2PProofOrSignalPath(request.url || "/")) {
      record.transportFailure = true;
      record.injectedFailure = "public-business-unavailable";
      socket.destroy();
      return;
    }
    if ((route === "lan" && lanDown) || (route === "public" && publicDown) || !target) {
      record.transportFailure = true;
      socket.destroy();
      return;
    }

    const bridge = { route, clientSocket: socket, outgoing: undefined, upstreamSocket: undefined };
    bridges.add(bridge);
    const removeBridge = () => bridges.delete(bridge);
    socket.once("close", removeBridge);
    const outgoing = httpRequest({
      host: target.host,
      port: target.port,
      method: "GET",
      path: request.url,
      headers: request.headers,
    });
    bridge.outgoing = outgoing;
    outgoing.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      bridge.upstreamSocket = upstreamSocket;
      record.responseStatus = upstreamResponse.statusCode || 101;
      captureResponseHeaders(record, request.headers, upstreamResponse.headers);
      writeUpgradeResponse(socket, upstreamResponse);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      upstreamSocket.once("close", removeBridge);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    outgoing.on("response", upstreamResponse => {
      record.responseStatus = upstreamResponse.statusCode || 502;
      captureResponseHeaders(record, request.headers, upstreamResponse.headers);
      writeUpgradeResponse(socket, upstreamResponse);
      upstreamResponse.pipe(socket);
      upstreamResponse.once("close", removeBridge);
    });
    outgoing.on("error", () => {
      record.transportFailure = true;
      socket.destroy();
      removeBridge();
    });
    outgoing.end();
  });

  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost, resolveListening);
  });
  const port = server.address().port;
  context.registerPort("mobile-dual-route-browser-private-proxy", port);
  context.addCleanup("close browser dual-route private proxy", async () => {
    for (const bridge of [...bridges]) destroyBridge(bridge);
    server.closeAllConnections?.();
    await new Promise(resolveClosed => server.close(() => resolveClosed()));
  });

  return {
    port,
    records,
    setGatewayUpstream(host, upstreamPort) { gatewayUpstream = { host, port: upstreamPort }; },
    setRelayUpstream(host, upstreamPort) { relayUpstream = { host, port: upstreamPort }; },
    isLanDown() { return lanDown; },
    setLanDown(value) {
      lanDown = Boolean(value);
      if (lanDown) {
        for (const bridge of [...bridges]) {
          if (bridge.route === "lan") destroyBridge(bridge);
        }
      }
    },
    setPublicDown(value) {
      publicDown = Boolean(value);
      if (publicDown) {
        for (const bridge of [...bridges]) {
          if (bridge.route === "public") destroyBridge(bridge);
        }
      }
    },
    setPublicBusinessDown(value) { publicBusinessDown = Boolean(value); },
    setP2PSignalingDown(value) { p2pSignalingDown = Boolean(value); },
    setP2PAnswerSignatureInvalid(value) { p2pAnswerSignatureInvalid = Boolean(value); },
  };
}

function isP2PSignalingPath(value) {
  let pathname;
  try { pathname = new URL(value, "http://owned.invalid").pathname; }
  catch { return false; }
  return pathname === "/api/mobile/p2p" || pathname.startsWith("/api/mobile/p2p/") ||
    pathname === `/g/${RELAY_GATEWAY_ID}/api/mobile/p2p` || pathname.startsWith(`/g/${RELAY_GATEWAY_ID}/api/mobile/p2p/`);
}

function isP2POfferPath(value) {
  let pathname;
  try { pathname = new URL(value, "http://owned.invalid").pathname; }
  catch { return false; }
  return pathname === "/api/mobile/p2p/offer" ||
    pathname === `/g/${RELAY_GATEWAY_ID}/api/mobile/p2p/offer`;
}

function isP2PProofOrSignalPath(value) {
  let pathname;
  try { pathname = new URL(value, "http://owned.invalid").pathname; }
  catch { return false; }
  return pathname === "/api/mobile/connection-proof" ||
    pathname === `/g/${RELAY_GATEWAY_ID}/api/mobile/connection-proof` ||
    isP2PSignalingPath(value);
}

function destroyBridge(bridge) {
  bridge.outgoing?.destroy();
  bridge.upstreamSocket?.destroy();
  bridge.clientSocket.destroy();
}

function recordRequest(request, upgrade) {
  const parsed = new URL(request.url || "/", `http://${request.headers.host || "owned.invalid"}`);
  return {
    method: request.method || "GET",
    path: parsed.pathname,
    queryKeys: [...new Set([...parsed.searchParams.keys()])].sort(),
    hasAuthorization: typeof request.headers.authorization === "string",
    hasCookie: typeof request.headers.cookie === "string",
    hasOrigin: typeof request.headers.origin === "string",
    hasPrivateNetworkRequestHeader: typeof request.headers["access-control-request-private-network"] === "string",
    hasRequestedMethodHeader: typeof request.headers["access-control-request-method"] === "string",
    upgrade,
    route: undefined,
    responseStatus: undefined,
    hasCorsAllowOriginResponse: false,
    corsAllowOriginMatchesRequest: false,
    hasPrivateNetworkAllowResponse: false,
    transportFailure: false,
  };
}

function captureResponseHeaders(record, requestHeaders, responseHeaders) {
  const allowOrigin = responseHeaders["access-control-allow-origin"];
  record.hasCorsAllowOriginResponse = typeof allowOrigin === "string";
  record.corsAllowOriginMatchesRequest = record.hasOrigin && allowOrigin === requestHeaders.origin;
  record.hasPrivateNetworkAllowResponse = typeof responseHeaders["access-control-allow-private-network"] === "string";
}

function writeUpgradeResponse(socket, response) {
  socket.write(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || "Bad Gateway"}\r\n`);
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
  }
  socket.write("\r\n");
}

async function loginGatewayAdmin(context, baseUrl, authToken) {
  const login = await fetch(`${baseUrl}/login?token=${encodeURIComponent(authToken)}`, { redirect: "manual" });
  if (login.status !== 303) throw new Error(`Isolated Gateway admin login returned HTTP ${login.status}`);
  const setCookies = login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""];
  const rawCookie = setCookies.find(value => value.includes("kcoder_studio_session="));
  const cookieValue = /kcoder_studio_session=([^;]+)/.exec(rawCookie || "")?.[1];
  if (!cookieValue) throw new Error("Isolated Gateway admin login returned no session cookie");
  context.registerSecret(cookieValue);
  context.registerSecret(decodeURIComponent(cookieValue));
  const cookie = `kcoder_studio_session=${cookieValue}`;
  context.registerSecret(cookie);
  return cookie;
}
