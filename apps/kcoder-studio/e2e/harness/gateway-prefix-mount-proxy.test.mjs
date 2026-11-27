import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import nodeTest from "node:test";
import {
  resolveGatewayPrefixMountRoute,
  startGatewayPrefixMountProxy,
} from "./gateway-prefix-mount-proxy.mjs";

const test = nodeTest;
const prefix = "/g/settings-route-owned";

test("Gateway prefix mount strips only its exact safe prefix", () => {
  assert.deepEqual(resolveGatewayPrefixMountRoute(`${prefix}/settings/kcoder-servers`, prefix, "GET"), {
    targetPath: "/settings/kcoder-servers",
  });
  assert.deepEqual(resolveGatewayPrefixMountRoute(`${prefix}/rpc?token=owned`, prefix, "GET", true), {
    targetPath: "/rpc?token=owned",
  });
  for (const path of [
    "/other/settings",
    "/api/admin",
    "/assets/runtime-chunk.js",
    "/assets/%2e%2e/admin",
    `${prefix}/../admin`,
    `${prefix}/%2e%2e/admin`,
    `${prefix}/%2fadmin`,
    `//foreign.test${prefix}/settings`,
    `${prefix}/settings#fragment`,
  ]) {
    assert.equal(resolveGatewayPrefixMountRoute(path, prefix, "GET"), null, path);
  }
  assert.equal(resolveGatewayPrefixMountRoute(`${prefix}/api/admin`, prefix, "POST", true), null);
});

test("owned prefix mount forwards only its safe prefixed routes to the owned Gateway", async t => {
  const context = fakeContext();
  const requests = [];
  const upgrades = [];
  const sockets = new Set();
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      path: request.url,
      method: request.method,
      body: Buffer.concat(chunks).toString("utf8"),
      host: request.headers.host,
      origin: request.headers.origin ?? null,
      authorization: request.headers.authorization ?? null,
    });
    response.writeHead(201, { "content-type": "application/json", "x-owned-upstream": "true" });
    response.end('{"ok":true}');
  });
  upstream.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  upstream.on("upgrade", (request, socket) => {
    upgrades.push({ path: request.url, host: request.headers.host, origin: request.headers.origin });
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.resume();
  });
  context.addCleanup("close fake Gateway", async () => {
    const closed = new Promise(resolve => upstream.listening ? upstream.close(resolve) : resolve());
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections();
    await closed;
  });
  await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  const targetPort = upstream.address().port;
  const child = { pid: targetPort };
  const gateway = {
    baseUrl: `http://127.0.0.1:${targetPort}`,
    host: "127.0.0.1",
    port: targetPort,
    child,
  };
  context.registerPort("fixture-gateway", targetPort);
  context.processes.set("fixture-gateway", { child });

  const proxy = await startGatewayPrefixMountProxy(context, { label: "owned-prefix-mount", prefix });
  proxy.setGateway(gateway);
  t.after(() => runCleanups(context));

  const response = await fetch(proxy.baseUrl("/api/owned-check?revision=1"), {
    method: "POST",
    headers: {
      authorization: "Bearer owned-request-key",
      "content-type": "application/json",
      origin: proxy.origin,
    },
    body: '{"write":"owned"}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-owned-upstream"), "true");
  assert.deepEqual(JSON.parse(await response.text()), { ok: true });
  assert.deepEqual(requests[0], {
    path: "/api/owned-check?revision=1",
    method: "POST",
    body: '{"write":"owned"}',
    host: new URL(proxy.origin).host,
    origin: proxy.origin,
    authorization: "Bearer owned-request-key",
  });

  assert.equal((await fetch(`${proxy.origin}/unmounted/path`)).status, 404);
  assert.equal((await fetch(`${proxy.origin}/assets/runtime-chunk.js`)).status, 404);
  assert.equal((await fetch(proxy.baseUrl("/api/owned-check"), { headers: { origin: "http://foreign.test" } })).status, 403);

  const upgraded = await requestUpgrade(proxy, prefix, proxy.origin);
  assert.equal(upgraded.statusCode, 101);
  assert.deepEqual(upgrades, [{
    path: "/rpc?token=owned",
    host: new URL(proxy.origin).host,
    origin: proxy.origin,
  }]);
  upgraded.socket.destroy();
});

function requestUpgrade(proxy, pathPrefix, origin) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: proxy.port,
      path: `${pathPrefix}/rpc?token=owned`,
      method: "GET",
      headers: {
        host: new URL(origin).host,
        origin,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    request.once("upgrade", response => resolve(response));
    request.once("response", response => {
      response.resume();
      reject(new Error(`Expected WebSocket upgrade; received HTTP ${response.statusCode}`));
    });
    request.once("error", reject);
    request.end();
  });
}

function fakeContext() {
  return {
    ports: [],
    processes: new Map(),
    cleanups: [],
    secrets: new Set(),
    registerPort(label, port) { this.ports.push({ label, port }); },
    registerSecret(value) { this.secrets.add(value); },
    addCleanup(label, callback) { this.cleanups.push({ label, callback }); },
  };
}

async function runCleanups(context) {
  for (const item of [...context.cleanups].reverse()) await item.callback();
}
