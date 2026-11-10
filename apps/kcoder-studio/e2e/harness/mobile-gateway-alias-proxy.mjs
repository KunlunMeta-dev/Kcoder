import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";

const LOOPBACK = "127.0.0.1";
const DEFAULT_ALIASES = ["a", "b"];
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Map one explicitly owned same-origin Gateway alias to an allowed upstream route. */
export function resolveMobileGatewayAliasRoute(rawUrl, method, {
  aliases = DEFAULT_ALIASES,
  upgrade = false,
} = {}) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/") || rawUrl.startsWith("//") ||
      typeof method !== "string" || !Array.isArray(aliases)) return null;
  let parsed;
  try { parsed = new URL(rawUrl, "http://alias.invalid"); }
  catch { return null; }
  if (parsed.origin !== "http://alias.invalid" || parsed.hash || !safePath(parsed.pathname)) return null;

  let alias = null;
  let targetPath = parsed.pathname;
  const match = parsed.pathname.match(/^\/g\/([A-Za-z0-9_-]{1,64})(?=\/|$)/);
  if (match) {
    alias = match[1];
    if (!aliases.includes(alias)) return null;
    targetPath = parsed.pathname.slice(match[0].length) || "/";
    if (!targetPath.startsWith("/")) return null;
  }

  const pathname = targetPath;
  const query = parsed.search;
  if (upgrade) {
    if (alias === null || method !== "GET" || pathname !== "/rpc" ||
        !hasOnlyQueryKeys(parsed.searchParams, ["token", "server", "channel", "workspace"]) ||
        !["token", "server", "channel", "workspace"].every(key => parsed.searchParams.getAll(key).length <= 1) ||
        ["token", "server", "channel"].some(key => !parsed.searchParams.get(key))) return null;
    return { alias, targetPath: `${pathname}${query}`, kind: "rpc" };
  }

  if ((method === "GET" || method === "HEAD") &&
      (pathname === "/mobile" || pathname.startsWith("/mobile/") || pathname === "/favicon.ico")) {
    return { alias, targetPath: `${pathname}${query}`, kind: "static" };
  }
  if (alias === null) return null;
  if (pathname === "/api/mobile/session" && ["POST", "DELETE"].includes(method)) {
    return { alias, targetPath: `${pathname}${query}`, kind: "mobile-auth" };
  }
  if (pathname === "/api/mobile/session/refresh" && method === "POST") {
    return { alias, targetPath: `${pathname}${query}`, kind: "mobile-auth" };
  }
  if (pathname === "/api/mobile/devices" && method === "GET") {
    return { alias, targetPath: `${pathname}${query}`, kind: "mobile-auth" };
  }
  if (/^\/api\/mobile\/devices\/[A-Za-z0-9-]{16,128}$/.test(pathname) && method === "DELETE") {
    return { alias, targetPath: `${pathname}${query}`, kind: "mobile-auth" };
  }
  if (["/api/servers", "/api/servers/status"].includes(pathname) && method === "GET") {
    return { alias, targetPath: `${pathname}${query}`, kind: "server-read" };
  }
  if (pathname === "/api/servers/test" && method === "POST") {
    return { alias, targetPath: `${pathname}${query}`, kind: "server-read" };
  }
  if (/^\/api\/servers\/[A-Za-z0-9_-]{1,128}$/.test(pathname) &&
      ["GET", "PUT", "DELETE"].includes(method)) {
    return { alias, targetPath: `${pathname}${query}`, kind: "server-read" };
  }
  if (/^\/api\/servers\/[A-Za-z0-9_-]{1,128}\/cwd-observation$/.test(pathname) && method === "GET" &&
      hasOnlyQueryKeys(parsed.searchParams, ["workspace", "expectedTargetIdentity"])) {
    return { alias, targetPath: `${pathname}${query}`, kind: "server-read" };
  }
  return null;
}

/** Start an HTTP/WebSocket path alias that forwards only to one RunContext-owned loopback Gateway. */
export async function startMobileGatewayAliasProxy(context, {
  label = "mobile-gateway-alias-proxy",
  aliases = DEFAULT_ALIASES,
} = {}) {
  assert.ok(context && typeof context.registerPort === "function" && typeof context.addCleanup === "function",
    "RunContext port and cleanup ownership is required");
  assert.match(label, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/, "proxy label must be a safe RunContext label");
  assert.ok(Array.isArray(aliases) && aliases.length >= 2 && aliases.every(value => /^[A-Za-z0-9_-]{1,64}$/.test(value)) &&
    new Set(aliases).size === aliases.length, "at least two distinct safe aliases are required");

  const sockets = new Set();
  const upstreamRequests = new Set();
  let gateway = null;
  let closePromise = null;
  let origin = null;
  const server = http.createServer((request, response) => {
    void handleHttpRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });
      response.end();
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch(() => rejectUpgrade(socket, 502));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, LOOPBACK, resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.address === LOOPBACK,
    "alias proxy must bind an owned loopback address");
  const port = address.port;
  origin = `http://${LOOPBACK}:${port}`;
  context.registerPort(label, port);

  async function handleHttpRequest(request, response) {
    if (!isAllowedIngress(request, origin, false)) {
      writePlainResponse(response, request.headers.origin && request.headers.origin !== origin ? 403 : 421);
      return;
    }
    const route = resolveMobileGatewayAliasRoute(request.url || "", request.method || "", { aliases });
    if (!route) {
      writePlainResponse(response, 404);
      return;
    }
    if (!gateway) {
      writePlainResponse(response, 503);
      return;
    }
    const target = new URL(route.targetPath, gateway.baseUrl);
    const headers = forwardHttpRequestHeaders(request.headers, new URL(origin).host);
    addMobileMountProof(headers, route, gateway.mountKey, origin);
    const upstreamRequest = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: route.targetPath,
      method: request.method,
      headers,
      agent: false,
    }, upstreamResponse => {
      const headers = filterHttpHeaders(upstreamResponse.headers);
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, headers);
      upstreamResponse.pipe(response);
    });
    trackRequest(upstreamRequest);
    upstreamRequest.once("error", () => {
      if (!response.headersSent) writePlainResponse(response, 502);
      else response.end();
    });
    request.once("aborted", () => upstreamRequest.destroy());
    response.once("close", () => {
      if (!response.writableFinished) upstreamRequest.destroy();
    });
    request.pipe(upstreamRequest);
  }

  async function handleUpgrade(request, clientSocket, head) {
    if (!isAllowedIngress(request, origin, true)) {
      rejectUpgrade(clientSocket, request.headers.origin && request.headers.origin !== origin ? 403 : 421);
      return;
    }
    const route = resolveMobileGatewayAliasRoute(request.url || "", request.method || "", { aliases, upgrade: true });
    if (!route) {
      rejectUpgrade(clientSocket, 404);
      return;
    }
    if (!gateway) {
      rejectUpgrade(clientSocket, 503);
      return;
    }
    const target = new URL(route.targetPath, gateway.baseUrl);
    const upstreamRequest = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: route.targetPath,
      method: "GET",
      headers: forwardUpgradeRequestHeaders(request.headers, new URL(origin).host),
      agent: false,
    });
    trackRequest(upstreamRequest);
    upstreamRequest.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const status = upstreamResponse.statusCode || 502;
      clientSocket.write(serializeUpgradeResponse(status, upstreamResponse.statusMessage, upstreamResponse.rawHeaders));
      if (upstreamHead?.length) clientSocket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      sockets.add(upstreamSocket);
      upstreamSocket.once("close", () => sockets.delete(upstreamSocket));
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      clientSocket.once("error", () => upstreamSocket.destroy());
      upstreamSocket.once("error", () => clientSocket.destroy());
      clientSocket.once("close", () => upstreamSocket.destroy());
      upstreamSocket.once("close", () => clientSocket.destroy());
    });
    upstreamRequest.once("response", upstreamResponse => {
      clientSocket.write(serializeHttpResponse(upstreamResponse.statusCode || 502,
        upstreamResponse.statusMessage, upstreamResponse.headers));
      upstreamResponse.pipe(clientSocket);
    });
    upstreamRequest.once("error", () => rejectUpgrade(clientSocket, 502));
    upstreamRequest.end();
  }

  function trackRequest(request) {
    upstreamRequests.add(request);
    request.once("close", () => upstreamRequests.delete(request));
  }

  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        for (const request of upstreamRequests) request.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
      })();
    }
    return closePromise;
  };

  context.addCleanup(`close ${label}`, close);

  return {
    origin,
    port,
    aliases: [...aliases],
    baseUrl(alias) {
      if (!aliases.includes(alias)) throw new Error("Unknown owned Gateway alias");
      return `${origin}/g/${alias}`;
    },
    mobileEntryUrl(alias) {
      return `${this.baseUrl(alias)}/mobile/`;
    },
    setGateway(ownedGateway) {
      if (gateway) throw new Error("The alias proxy accepts exactly one owned Gateway");
      gateway = validateOwnedGateway(context, ownedGateway);
    },
    close,
  };
}

function validateOwnedGateway(context, gateway) {
  assert.ok(gateway && gateway.host === LOOPBACK && Number.isInteger(gateway.port) &&
    typeof gateway.baseUrl === "string", "a loopback Gateway descriptor is required");
  const target = new URL(gateway.baseUrl);
  assert.equal(target.protocol, "http:", "the owned alias target must use loopback HTTP");
  assert.equal(target.hostname, LOOPBACK, "the owned alias target must be loopback-only");
  assert.equal(Number(target.port), gateway.port, "Gateway URL and registered port must match");
  assert.ok(context.ports?.some(row => row.port === gateway.port),
    "the target Gateway port must already be owned by this RunContext");
  assert.ok(gateway.child && [...(context.processes?.values?.() ?? [])].some(record => record.child === gateway.child),
    "the target Gateway process must already be owned by this RunContext");
  assert.ok(typeof gateway.authToken === "string" && gateway.authToken.length >= 8,
    "an authenticated owned Gateway token is required for signed Mobile mount aliases");
  context.registerSecret(gateway.authToken);
  return { baseUrl: `${target.origin}`, mountKey: gateway.authToken };
}

function addMobileMountProof(headers, route, mountKey, origin) {
  if (route.kind !== "static" || route.alias === null ||
      !(route.targetPath === "/mobile" || route.targetPath.startsWith("/mobile/"))) return;
  const prefix = `/g/${route.alias}`;
  const canonicalAuthority = new URL(origin).host;
  headers["x-kcoder-mobile-mount"] = prefix;
  headers["x-kcoder-mobile-mount-proof"] = createHmac("sha256", mountKey)
    .update(JSON.stringify(["kcoder-mobile-mount-v1", canonicalAuthority, prefix]))
    .digest("hex");
}

function isAllowedIngress(request, origin, upgrade) {
  if (request.headers.host !== new URL(origin).host) return false;
  if (upgrade) return request.headers.origin === origin &&
    request.headers.upgrade?.toLowerCase() === "websocket" &&
    request.headers.connection?.toLowerCase().split(/\s*,\s*/).includes("upgrade");
  return !request.headers.origin || request.headers.origin === origin;
}

function safePath(pathname) {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return false;
  for (const segment of pathname.split("/")) {
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch { return false; }
    if (decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded) || /%(?:2f|5c|2e)/i.test(decoded)) return false;
  }
  return true;
}

function hasOnlyQueryKeys(searchParams, allowed) {
  return [...searchParams.keys()].every(key => allowed.includes(key));
}

function forwardHttpRequestHeaders(headers, targetHost) {
  const connectionHeaders = connectionTokens(headers.connection);
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower) || connectionHeaders.has(lower)) continue;
    output[key] = value;
  }
  output.host = targetHost;
  return output;
}

function forwardUpgradeRequestHeaders(headers, targetHost) {
  const output = { ...headers, host: targetHost };
  delete output["proxy-authorization"];
  delete output["proxy-connection"];
  return output;
}

function filterHttpHeaders(headers) {
  const connectionHeaders = connectionTokens(headers.connection);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => {
    const lower = key.toLowerCase();
    return !HOP_BY_HOP_HEADERS.has(lower) && !connectionHeaders.has(lower);
  }));
}

function connectionTokens(value) {
  return new Set((Array.isArray(value) ? value.join(",") : String(value || ""))
    .split(",").map(item => item.trim().toLowerCase()).filter(Boolean));
}

function writePlainResponse(response, status) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  const phrase = status === 403 ? "Forbidden" : status === 421 ? "Misdirected Request" :
    status === 503 ? "Service Unavailable" : status === 502 ? "Bad Gateway" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}

function serializeUpgradeResponse(status, statusMessage, rawHeaders = []) {
  const lines = [`HTTP/1.1 ${status} ${statusMessage || "Switching Protocols"}`];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function serializeHttpResponse(status, statusMessage, headers = {}) {
  const lines = [`HTTP/1.1 ${status} ${statusMessage || "Bad Gateway"}`];
  for (const [name, value] of Object.entries(filterHttpHeaders(headers))) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(String(item))) continue;
      lines.push(`${name}: ${item}`);
    }
  }
  lines.push("Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
}
