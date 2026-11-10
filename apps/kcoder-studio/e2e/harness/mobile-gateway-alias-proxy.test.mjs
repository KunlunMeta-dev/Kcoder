import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import {
  resolveMobileGatewayAliasRoute,
  startMobileGatewayAliasProxy,
} from "./mobile-gateway-alias-proxy.mjs";

test("alias route selection preserves only approved Mobile, auth, server, and RPC paths", () => {
  assert.deepEqual(resolveMobileGatewayAliasRoute("/g/a/api/mobile/devices/device-1234567890123456", "DELETE"), {
    alias: "a",
    targetPath: "/api/mobile/devices/device-1234567890123456",
    kind: "mobile-auth",
  });
  assert.deepEqual(resolveMobileGatewayAliasRoute(
    "/g/b/rpc?token=opaque-test-value&server=local&channel=runtime&workspace=%2Ftmp%2Fowned",
    "GET",
    { upgrade: true },
  ), {
    alias: "b",
    targetPath: "/rpc?token=opaque-test-value&server=local&channel=runtime&workspace=%2Ftmp%2Fowned",
    kind: "rpc",
  });
  assert.deepEqual(resolveMobileGatewayAliasRoute("/mobile/_expo/static/js/web/index.js", "GET"), {
    alias: null,
    targetPath: "/mobile/_expo/static/js/web/index.js",
    kind: "static",
  });
  for (const [url, method, options] of [
    ["/g/c/api/servers", "GET", {}],
    ["/g/a/api/admin/secrets", "GET", {}],
    ["/g/a/api/mobile/devices/device-1234567890123456", "GET", {}],
    ["/g/a/api/mobile/session/refresh", "DELETE", {}],
    ["/g/a/rpc?token=x&server=local&channel=runtime&debug=true", "GET", { upgrade: true }],
    ["/g/a/rpc?token=&server=local&channel=runtime", "GET", { upgrade: true }],
    ["/g/a/rpc?token=x&token=y&server=local&channel=runtime", "GET", { upgrade: true }],
    ["/g/a/rpc?token=x&server=local&channel=runtime&workspace=%2Ftmp%2Fa&workspace=%2Ftmp%2Fb", "GET", { upgrade: true }],
    ["/g/a/api/servers/local/cwd-observation?workspace=%2Ftmp%2Fx&other=x", "GET", {}],
    ["/g/a/api/servers/%2e%2e/admin", "GET", {}],
  ]) {
    assert.equal(resolveMobileGatewayAliasRoute(url, method, options), null,
      `${method} ${url} must stay outside the alias allowlist`);
  }
});

test("HTTP alias forwards the exact body, end-to-end headers, Origin, and response status", async t => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      path: request.url,
      method: request.method,
      body: Buffer.concat(chunks).toString("utf8"),
      origin: request.headers.origin,
      authorization: request.headers.authorization,
      host: request.headers.host,
      requestHop: request.headers["x-request-hop"] ?? null,
      mobileMount: request.headers["x-kcoder-mobile-mount"] ?? null,
      mobileMountProof: request.headers["x-kcoder-mobile-mount-proof"] ?? null,
    });
    response.writeHead(201, {
      "content-type": "application/json",
      "x-contract-receipt": "preserved",
      connection: "x-response-hop, keep-alive",
      "x-response-hop": "must-not-cross",
    });
    response.end('{"accepted":true}');
  });
  const context = fakeContext();
  const target = await listen(upstream);
  ownGateway(context, target);
  const proxy = await startMobileGatewayAliasProxy(context, { label: "alias-http-contract" });
  proxy.setGateway(target);
  t.after(async () => { await runCleanups(context); await closeServer(upstream); });

  const body = '{"token":"opaque-test-pairing-value","durableDeviceAuthorization":true}';
  const response = await fetch(`${proxy.baseUrl("a")}/api/mobile/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer opaque-test-access-value",
      origin: proxy.origin,
    },
    body,
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-contract-receipt"), "preserved");
  assert.equal(await response.text(), '{"accepted":true}');
  assert.deepEqual(received[0], {
    path: "/api/mobile/session",
    method: "POST",
    body,
    origin: proxy.origin,
    authorization: "Bearer opaque-test-access-value",
    host: new URL(proxy.origin).host,
    requestHop: null,
    mobileMount: null,
    mobileMountProof: null,
  });

  const mobilePage = await fetch(`${proxy.baseUrl("a")}/mobile/`, { headers: { origin: proxy.origin } });
  assert.equal(mobilePage.status, 201);
  const mountPrefix = "/g/a";
  assert.equal(received[1].path, "/mobile/");
  assert.equal(received[1].host, new URL(proxy.origin).host,
    "Gateway must see the browser's configured public authority for mount admission");
  assert.equal(received[1].mobileMount, mountPrefix);
  assert.equal(received[1].mobileMountProof, createHmac("sha256", target.authToken)
    .update(JSON.stringify(["kcoder-mobile-mount-v1", new URL(proxy.origin).host, mountPrefix])).digest("hex"));

  const hopResponse = await requestHttp(proxy.port, {
    method: "POST",
    path: "/g/a/api/mobile/session",
    headers: {
      host: new URL(proxy.origin).host,
      origin: proxy.origin,
      connection: "x-request-hop, keep-alive",
      "x-request-hop": "must-not-cross",
      "content-type": "application/json",
      "content-length": String(body.length),
    },
  }, body);
  assert.equal(hopResponse.status, 201);
  assert.equal(hopResponse.headers["x-response-hop"], undefined,
    "response headers nominated by Connection must not cross the alias boundary");
  assert.equal(received[2].requestHop, null,
    "request headers nominated by Connection must not cross the alias boundary");

  const rejectedOrigin = await fetch(`${proxy.baseUrl("a")}/api/servers`, {
    headers: { origin: "http://unapproved.invalid" },
  });
  assert.equal(rejectedOrigin.status, 403, "foreign browser origins must be rejected before reaching the Gateway");
  const rejectedPath = await fetch(`${proxy.origin}/api/mobile/session`, { method: "POST" });
  assert.equal(rejectedPath.status, 404, "credential-bearing routes must require one explicit Gateway alias");
  assert.equal(received.length, 3, "rejected requests must never reach the target Gateway");
});

test("WebSocket alias forwards the real upgrade path and both frame directions", async t => {
  const upgrades = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    upgrades.push({ path: request.url, origin: request.headers.origin, host: request.headers.host });
    const key = request.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Upgrade-Contract: preserved\r\n\r\n`);
    socket.once("data", () => socket.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])));
  });
  const context = fakeContext();
  const target = await listen(upstream);
  ownGateway(context, target);
  const proxy = await startMobileGatewayAliasProxy(context, { label: "alias-ws-contract" });
  proxy.setGateway(target);
  const socket = new net.Socket();
  t.after(async () => {
    socket.destroy();
    await runCleanups(context);
    for (const upstreamSocket of upstreamSockets) upstreamSocket.destroy();
    await closeServer(upstream);
  });
  const connected = once(socket, "connect");
  socket.connect(proxy.port, "127.0.0.1");
  await connected;
  const responseHeadPromise = readUntil(socket, "\r\n\r\n");
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  socket.write([
    "GET /g/b/rpc?token=opaque-test-rpc-value&server=local&channel=runtime HTTP/1.1",
    `Host: ${new URL(proxy.origin).host}`,
    `Origin: ${proxy.origin}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "\r\n",
  ].join("\r\n"));
  const responseHead = await responseHeadPromise;
  assert.match(responseHead, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.match(responseHead, /upgrade: websocket/i);
  assert.match(responseHead, /x-upgrade-contract: preserved/i);
  assert.deepEqual(upgrades, [{
    path: "/rpc?token=opaque-test-rpc-value&server=local&channel=runtime",
    origin: proxy.origin,
    host: new URL(proxy.origin).host,
  }]);

  const framePromise = readBytes(socket, 7);
  const mask = Buffer.from([1, 2, 3, 4]);
  const clear = Buffer.from("hello");
  const masked = Buffer.from(clear.map((value, index) => value ^ mask[index % 4]));
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | clear.length]), mask, masked]));
  assert.deepEqual(await framePromise, Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
});

function fakeContext() {
  const context = {
    ports: [],
    processes: new Map(),
    cleanups: [],
    registerPort(label, port) { this.ports.push({ label, port }); },
    registerSecret() {},
    addCleanup(label, callback) { this.cleanups.push({ label, callback }); },
  };
  return context;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    host: "127.0.0.1",
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    authToken: "fixture-gateway-auth-token",
    child: { pid: address.port },
  };
}

function requestHttp(port, options, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, ...options }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function ownGateway(context, gateway) {
  context.registerPort("fixture-gateway", gateway.port);
  context.processes.set("fixture-gateway", { child: gateway.child });
}

async function runCleanups(context) {
  for (const item of [...context.cleanups].reverse()) await item.callback();
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function readUntil(socket, delimiter) {
  const marker = Buffer.from(delimiter);
  return readBytesUntil(socket, buffer => buffer.indexOf(marker) >= 0)
    .then(buffer => buffer.subarray(0, buffer.indexOf(marker) + marker.length).toString("latin1"));
}

function readBytes(socket, length) {
  return readBytesUntil(socket, buffer => buffer.length >= length).then(buffer => buffer.subarray(0, length));
}

function readBytesUntil(socket, ready) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Timed out reading owned WebSocket fixture")), 5_000);
    const onData = chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (ready(bytes)) finish(null, bytes);
    };
    const onError = error => finish(error);
    const onClose = () => finish(new Error("Owned WebSocket fixture closed unexpectedly"));
    function finish(error, value) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (ready(bytes)) finish(null, bytes);
  });
}
