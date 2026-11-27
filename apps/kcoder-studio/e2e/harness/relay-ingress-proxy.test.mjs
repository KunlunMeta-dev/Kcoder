import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import nodeTest from 'node:test';
import { RunContext, waitFor } from './run-context.mjs';
import { closeRpcAndWait, openRpc } from './rpc.mjs';
import { startHttpsGatewayProxy, startRelayIngressProxy } from './https-gateway-proxy.mjs';

const gatewayId = 'a'.repeat(32);
const prefix = `/g/${gatewayId}`;
const rpcQuery = '?token=unit-token&server=local&workspace=%2Fowned';
const test = (name, callback) => nodeTest(name, { timeout: 30_000 }, callback);

async function owned(name, callback) {
  const context = await RunContext.create(import.meta.url, { testId: name, tier: 'unit', cleanupTimeoutMs: 15_000 });
  let failure;
  try { await callback(context); } catch (error) { failure = error; }
  await context.finish(failure ? 'failed' : 'passed', null, failure);
  if (failure) throw failure;
}

async function backend(context, label) {
  const requests = [], upgrades = [], sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { 'content-type': 'text/plain', 'x-fixture': label }); response.end('fixture-response');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    upgrades.push({ path: request.url, headers: request.headers, headBytes: head.length });
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('end', () => socket.end());
    // Drain raw WebSocket close bytes so the following FIN can emit end; no RPC is dispatched.
    socket.resume();
  });
  context.addCleanup(`close ${label} fixture`, async () => {
    const done = new Promise(resolve => server.listening ? server.close(resolve) : resolve());
    for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await done;
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; context.registerPort(label, port);
  return { port, origin: `http://127.0.0.1:${port}`, requests, upgrades, sockets };
}

function exchange(url, { method = 'GET', body = '', headers = {}, tls = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = (tls ? httpsRequest : httpRequest)(url, { method, headers, agent: false, ...(tls ? { rejectUnauthorized: false } : {}) }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.setTimeout(5_000, () => request.destroy(new Error('fixture HTTP timeout'))); request.once('error', reject); request.end(body);
  });
}

test('relay ingress requires numeric ports registered to the run', async () => owned('relay-ingress-port-contract', async context => {
  await assert.rejects(startRelayIngressProxy(context, { controlPort: 80, proxyPort: 81, gatewayId }), /registered/);
  await assert.rejects(startRelayIngressProxy(context, { controlPort: '80', proxyPort: 81, gatewayId }), /loopback port/);
}));

test('relay ingress forwards exact HTTP routes, method, body and headers to fixed targets', async () => owned('relay-ingress-http', async context => {
  const control = await backend(context, 'control'), proxy = await backend(context, 'proxy');
  const ingress = await startRelayIngressProxy(context, { controlPort: control.port, proxyPort: proxy.port, gatewayId });
  const headers = { host: 'public.fixture', origin: 'https://public.fixture', authorization: 'Bearer unit-token', 'content-type': 'application/json' };
  for (const [path, method] of [['/_relay/register', 'POST'], [`${prefix}/api/mobile/session`, 'POST'], [`${prefix}/api/mobile/session`, 'DELETE'], [`${prefix}/api/servers`, 'GET']]) {
    const response = await exchange(ingress.origin + path, { method, headers, body: method === 'POST' ? '{}' : '' });
    assert.equal(response.status, 200); assert.equal(response.body, 'fixture-response');
  }
  assert.equal(control.requests.length, 1); assert.equal(proxy.requests.length, 3);
  assert.equal(control.requests[0].path, '/_relay/register'); assert.equal(control.requests[0].method, 'POST'); assert.equal(control.requests[0].body, '{}');
  assert.equal(control.requests[0].headers.authorization, headers.authorization);
  assert.equal(proxy.requests[0].headers.authorization, headers.authorization);
  assert.equal(proxy.requests[0].headers.host, headers.host); assert.equal(proxy.requests[0].headers.origin, headers.origin);
}));

test('relay ingress rejects foreign paths, ambiguous queries and method mismatches without upstream writes', async () => owned('relay-ingress-rejects', async context => {
  const control = await backend(context, 'control'), proxy = await backend(context, 'proxy');
  const ingress = await startRelayIngressProxy(context, { controlPort: control.port, proxyPort: proxy.port, gatewayId });
  for (const [path, method] of [['/_relay/register?destination=http://foreign', 'POST'], ['/_relay/register', 'GET'],
    ['/_relay/control', 'GET'], ['/_relay/data?id=' + 'f'.repeat(48), 'GET'], [`${prefix}/api/servers?target=foreign`, 'GET'],
    [`/g/${'b'.repeat(32)}/api/servers`, 'GET'], [`${prefix}/api/servers`, 'POST'], ['/unrelated', 'GET']]) {
    assert.equal((await exchange(ingress.origin + path, { method })).status, 404);
  }
  assert.equal(control.requests.length + proxy.requests.length, 0);
}));

test('relay ingress forwards control/data and RPC upgrades on fixed ports with original query and auth', async () => owned('relay-ingress-upgrades', async context => {
  const control = await backend(context, 'control'), proxy = await backend(context, 'proxy');
  const ingress = await startRelayIngressProxy(context, { controlPort: control.port, proxyPort: proxy.port, gatewayId });
  const clients = [];
  context.addCleanup('close fixture RPCs', () => Promise.all(clients.map(rpc => closeRpcAndWait(rpc))));
  const paths = ['/_relay/control', '/_relay/data?id=' + 'f'.repeat(48), `${prefix}/rpc${rpcQuery}`];
  for (const path of paths) clients.push(await openRpc(ingress.origin.replace('http:', 'ws:') + path, { headers: { Authorization: 'Bearer unit-token' } }));
  assert.deepEqual(control.upgrades.map(row => row.path), paths.slice(0, 2)); assert.equal(proxy.upgrades[0].path, paths[2]);
  assert.equal(proxy.upgrades[0].headers.authorization, 'Bearer unit-token');
  await assert.rejects(openRpc(ingress.origin.replace('http:', 'ws:') + `${prefix}/rpc${rpcQuery}&token=duplicate`, { timeoutMs: 1_000 }));
  await assert.rejects(openRpc(ingress.origin.replace('http:', 'ws:') + '/_relay/data?id=' + 'f'.repeat(48) + '&id=duplicate', { timeoutMs: 1_000 }));
  assert.equal(control.upgrades.length, 2); assert.equal(proxy.upgrades.length, 1);
}));

test('relay ingress cleanup closes upgraded client and both forwarding sockets', async () => owned('relay-ingress-cleanup', async context => {
  const control = await backend(context, 'control'), proxy = await backend(context, 'proxy');
  const ingress = await startRelayIngressProxy(context, { controlPort: control.port, proxyPort: proxy.port, gatewayId });
  const rpc = await openRpc(ingress.origin.replace('http:', 'ws:') + '/_relay/control');
  const cleanup = context.cleanups.find(row => row.label === 'close owned relay-ingress-proxy');
  await cleanup.callback();
  await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED && control.sockets.size === 0, 5_000, 'both forwarding endpoints closed');
  assert.equal(rpc.socket.readyState, rpc.socket.constructor.CLOSED);
  await assert.rejects(exchange(ingress.origin + `${prefix}/api/servers`));
}));

test('existing HTTPS wrapper retains no-target status, setTarget and callbackRequests', async () => owned('https-proxy-legacy', async context => {
  const target = await backend(context, 'https-upstream');
  const proxy = await startHttpsGatewayProxy(context);
  assert.equal((await exchange(proxy.origin + '/before', { tls: true })).status, 503);
  proxy.setTarget(target.origin);
  const response = await exchange(proxy.origin + '/oauth/mcp/callback?code=unit-code', { tls: true,
    headers: { cookie: 'unit-cookie=present', host: 'localhost' } });
  assert.equal(response.status, 200); assert.equal(response.body, 'fixture-response');
  assert.deepEqual(proxy.callbackRequests, [{ sessionHeaderPresent: true, host: 'localhost' }]);
  assert.equal(target.requests[0].path, '/oauth/mcp/callback?code=unit-code');
}));
