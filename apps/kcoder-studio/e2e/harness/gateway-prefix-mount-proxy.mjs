import assert from "node:assert/strict";
import http from "node:http";
import { connect } from "node:net";

const LOOPBACK = "127.0.0.1";
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

/** Strip one owned Gateway prefix and forward only to this run's loopback Gateway. */
export async function startGatewayPrefixMountProxy(context, {
  label = "gateway-prefix-mount-proxy",
  prefix,
} = {}) {
  assert.ok(context && typeof context.registerPort === "function" && typeof context.addCleanup === "function",
    "RunContext port and cleanup ownership is required");
  assert.match(label, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/, "proxy label must be safe");
  assert.match(prefix || "", /^\/g\/[A-Za-z0-9_-]{1,64}$/, "Gateway prefix must be one /g/<id> path");

  const sockets = new Set();
  const upstreamRequests = new Set();
  let gateway = null;
  let closePromise = null;
  const server = http.createServer((request, response) => {
    void handleHttpRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });
      response.end();
    });
  });
  server.on("connection", socket => trackSocket(socket));
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch(() => rejectUpgrade(socket, 502));
  });

  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        for (const request of upstreamRequests) request.destroy();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        if (server.listening) {
          await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
        }
      })();
    }
    return closePromise;
  };
  context.addCleanup(`close ${label}`, close);

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, LOOPBACK, resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.address === LOOPBACK,
    "Gateway prefix proxy must bind only to loopback");
  const port = address.port;
  const origin = `http://${LOOPBACK}:${port}`;
  const authority = new URL(origin).host;
  context.registerPort(label, port);

  async function handleHttpRequest(request, response) {
    if (!isAllowedIngress(request, authority, origin, false)) {
      writePlainResponse(response, request.headers.origin && request.headers.origin !== origin ? 403 : 421);
      return;
    }
    const route = resolveGatewayPrefixMountRoute(request.url || "", prefix, request.method || "");
    if (!route) {
      writePlainResponse(response, 404);
      return;
    }
    if (!gateway) {
      writePlainResponse(response, 503);
      return;
    }

    const target = new URL(route.targetPath, gateway.baseUrl);
    const headers = forwardHttpRequestHeaders(request.headers, authority);
    const upstreamRequest = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: route.targetPath,
      method: request.method,
      headers,
      agent: false,
    }, upstreamResponse => {
      upstreamResponse.on("error", () => response.destroy());
      upstreamResponse.once("aborted", () => response.destroy());
      if (response.destroyed) {
        upstreamResponse.destroy();
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, filterHttpHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    trackRequest(upstreamRequest);
    upstreamRequest.once("error", () => {
      if (!response.headersSent) writePlainResponse(response, 502);
      else response.end();
    });
    request.once("aborted", () => upstreamRequest.destroy());
    request.once("error", () => upstreamRequest.destroy());
    response.once("error", () => upstreamRequest.destroy());
    response.once("close", () => {
      if (!response.writableFinished) upstreamRequest.destroy();
    });
    request.pipe(upstreamRequest);
  }

  async function handleUpgrade(request, clientSocket, head) {
    if (!isAllowedIngress(request, authority, origin, true)) {
      rejectUpgrade(clientSocket, request.headers.origin && request.headers.origin !== origin ? 403 : 421);
      return;
    }
    const route = resolveGatewayPrefixMountRoute(request.url || "", prefix, request.method || "", true);
    if (!route) {
      rejectUpgrade(clientSocket, 404);
      return;
    }
    if (!gateway) {
      rejectUpgrade(clientSocket, 503);
      return;
    }

    const target = new URL(route.targetPath, gateway.baseUrl);
    const upstreamSocket = trackSocket(connect(Number(target.port), target.hostname));
    upstreamSocket.once("connect", () => {
      const headers = forwardUpgradeRequestHeaders(request.headers, authority);
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`),
      );
      upstreamSocket.write(`${request.method} ${route.targetPath} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    upstreamSocket.once("error", () => clientSocket.destroy());
    clientSocket.once("error", () => upstreamSocket.destroy());
    clientSocket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => clientSocket.destroy());
  }

  function trackSocket(socket) {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }

  function trackRequest(request) {
    upstreamRequests.add(request);
    request.once("close", () => upstreamRequests.delete(request));
  }

  return Object.freeze({
    origin,
    port,
    prefix,
    publicAccessUrl: `${origin}${prefix}`,
    baseUrl(path = "") {
      if (typeof path !== "string" || (path && (!path.startsWith("/") || path.startsWith("//")))) {
        throw new Error("Gateway prefix mount path must be relative to the owned prefix");
      }
      return `${origin}${prefix}${path}`;
    },
    setGateway(ownedGateway) {
      if (gateway) throw new Error("Gateway prefix proxy accepts exactly one owned Gateway");
      gateway = validateOwnedGateway(context, ownedGateway);
    },
    close,
  });
}

export function resolveGatewayPrefixMountRoute(rawUrl, prefix, method, upgrade = false) {
  if (!/^\/g\/[A-Za-z0-9_-]{1,64}$/.test(prefix || "") || typeof rawUrl !== "string" ||
      rawUrl.length > 8192 || !rawUrl.startsWith("/") || rawUrl.startsWith("//") ||
      /[\r\n\\]/.test(rawUrl) || typeof method !== "string") return null;
  let parsed;
  try { parsed = new URL(rawUrl, "http://prefix.invalid"); }
  catch { return null; }
  if (parsed.origin !== "http://prefix.invalid" || parsed.hash || !safePath(parsed.pathname)) return null;
  if (!(parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))) return null;
  const suffix = parsed.pathname.slice(prefix.length);
  const targetPath = `${suffix || "/"}${parsed.search}`;
  if (!targetPath.startsWith("/")) return null;
  if (upgrade && (method !== "GET" || !/^\/rpc(?:\?|$)/.test(targetPath))) return null;
  return {
    targetPath,
  };
}

function validateOwnedGateway(context, gateway) {
  assert.ok(gateway && gateway.host === LOOPBACK && Number.isInteger(gateway.port) &&
    typeof gateway.baseUrl === "string", "a loopback Gateway descriptor is required");
  const target = new URL(gateway.baseUrl);
  assert.equal(target.protocol, "http:", "owned Gateway prefix target must use loopback HTTP");
  assert.equal(target.hostname, LOOPBACK, "owned Gateway prefix target must be loopback-only");
  assert.equal(Number(target.port), gateway.port, "Gateway URL and registered port must match");
  assert.ok(context.ports?.some(row => row.port === gateway.port),
    "Gateway target port must already be owned by this RunContext");
  assert.ok(gateway.child && [...(context.processes?.values?.() ?? [])].some(record => record.child === gateway.child),
    "Gateway process must already be owned by this RunContext");
  return { baseUrl: target.origin };
}

function isAllowedIngress(request, authority, origin, upgrade) {
  if (request.headers.host !== authority) return false;
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
  return { ...headers, host: targetHost };
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
