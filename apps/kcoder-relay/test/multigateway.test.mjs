// Contract tests for isolated tenants on one public Relay authority. These use
// real loopback HTTP and WebSocket sockets; the fake Gateways never run a model.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, Agent } from 'node:http';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { startClient } from '../src/client.mjs';
import { startRelay } from '../src/server.mjs';

const SHARED_HOST = 'relay.example';
const GATEWAY_IDS = ['a', 'b'];

function opaqueToken() {
  return randomBytes(32).toString('hex');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

async function startFakeGateway(id) {
  const state = {
    id,
    label: `gateway-${id}`,
    pairingToken: opaqueToken(),
    additionalPairingTokens: new Set(),
    accessTokens: new Set(),
    rpcToken: opaqueToken(),
    server: null,
    websocketServer: null,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway.invalid');
    if (req.method === 'POST' && url.pathname === '/api/mobile/session') {
      let payload;
      try { payload = JSON.parse((await collectRequestBody(req)).toString('utf8')); }
      catch { res.writeHead(400); res.end('bad request'); return; }
      if (payload?.token !== state.pairingToken && !state.additionalPairingTokens.has(payload?.token)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      const accessToken = opaqueToken();
      state.accessTokens.add(accessToken);
      // A Gateway uses one long-lived RPC token for all of its mobile sessions.
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `kcoder_session=${opaqueToken()}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(JSON.stringify({
        accessToken,
        rpcToken: state.rpcToken,
        expiresAt: Date.now() + 60_000,
      }));
      return;
    }

    const accessToken = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!accessToken || !state.accessTokens.has(accessToken)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }

    if (url.pathname === '/api/whoami') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ gateway: state.label, path: url.pathname }));
      return;
    }
    if (url.pathname === '/api/echo-size') {
      const body = await collectRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ gateway: state.label, bytes: body.length }));
      return;
    }
    if (url.pathname === '/api/cookie') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ gateway: state.label, hasCookie: Boolean(req.headers.cookie) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://gateway.invalid');
    const offeredProtocols = (req.headers['sec-websocket-protocol'] || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    const mobileAccess = offeredProtocols
      .find(value => value.startsWith('kcoder-session.'))
      ?.slice('kcoder-session.'.length);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const mobileWebAuthorized = mobileAccess && state.accessTokens.has(mobileAccess)
      && url.searchParams.get('token') === state.rpcToken;
    const rpcAuthorized = bearer && state.accessTokens.has(bearer)
      && url.searchParams.get('token') === state.rpcToken;
    if (url.pathname !== '/rpc' || (!mobileWebAuthorized && !rpcAuthorized)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    websocketServer.handleUpgrade(req, socket, head, ws => {
      websocketServer.emit('connection', ws, req);
    });
  });
  websocketServer.on('connection', ws => {
    ws.on('message', (data, binary) => {
      const message = binary ? Buffer.from(data) : data.toString();
      ws.send(binary ? Buffer.concat([Buffer.from(`${state.label}:`), message]) : `${state.label}:${message}`, { binary });
    });
  });

  state.server = server;
  state.websocketServer = websocketServer;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.url = `http://127.0.0.1:${server.address().port}`;
  return state;
}

function gatewayPath(id, path) {
  return `/g/${id}${path.startsWith('/') ? path : `/${path}`}`;
}

function httpThroughRelay(fixture, {
  id,
  path,
  method = 'GET',
  accessToken,
  pairingToken,
  cookie,
  body,
  host = SHARED_HOST,
  agent = false,
  timeoutMs = 4000,
}) {
  const headers = { host };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (pairingToken) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/octet-stream';
  return new Promise(resolve => {
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
    const outgoing = request({
      hostname: '127.0.0.1',
      port: fixture.relay.proxyPort,
      method,
      path: gatewayPath(id, path),
      headers,
      agent,
    }, response => {
      const chunks = [];
      const socket = outgoing.socket;
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => finish({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        socket,
      }));
      response.once('aborted', () => finish({ status: 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('error', () => finish({ status: 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy());
    outgoing.once('error', () => finish({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    if (body !== undefined) outgoing.write(body);
    if (pairingToken) outgoing.end(JSON.stringify({ token: pairingToken }));
    else outgoing.end();
  });
}

function parseJsonBody(response) {
  try { return JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error('Relay response did not contain valid JSON'); }
}

async function pairGateway(fixture, id, token = fixture.gateways.get(id).pairingToken) {
  const response = await httpThroughRelay(fixture, {
    id,
    path: '/api/mobile/session',
    method: 'POST',
    pairingToken: token,
  });
  assert.equal(response.status, 200, 'valid per-Gateway pairing must succeed');
  const session = parseJsonBody(response);
  assert.equal(typeof session.accessToken, 'string', 'pairing returns a mobile access token');
  assert.equal(typeof session.rpcToken, 'string', 'pairing returns an RPC token');
  return { ...session, setCookie: response.headers['set-cookie'] };
}

function openWebSocket(fixture, {
  port = fixture.relay.proxyPort,
  path,
  headers = {},
  protocols,
  timeoutMs = 2500,
}) {
  const endpoint = `ws://127.0.0.1:${port}${path}`;
  const options = {
    handshakeTimeout: timeoutMs,
    perMessageDeflate: false,
    headers: { host: SHARED_HOST, ...headers },
  };
  const ws = protocols
    ? new WebSocket(endpoint, protocols, options)
    : new WebSocket(endpoint, options);
  fixture.sockets.add(ws);
  ws.on('error', () => {});
  return withTimeout(new Promise(resolve => {
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    ws.once('open', () => finish({ status: 101, ws }));
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode || 0;
      response.resume();
      finish({ status, ws: null });
    });
    ws.once('error', () => finish({ status: 0, ws: null }));
  }), timeoutMs + 500, 'WebSocket handshake timed out');
}

function rpcPath(id, rpcToken) {
  return `${gatewayPath(id, '/rpc')}?token=${encodeURIComponent(rpcToken)}`;
}

async function openRpc(fixture, id, session) {
  return openWebSocket(fixture, {
    path: rpcPath(id, session.rpcToken),
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
}

async function openMobileWebRpc(fixture, id, accessToken, rpcToken) {
  return openWebSocket(fixture, {
    path: rpcPath(id, rpcToken),
    protocols: ['kcoder-studio', `kcoder-session.${accessToken}`],
  });
}

async function websocketEcho(ws, value) {
  const message = once(ws, 'message');
  ws.send(value);
  const [data] = await withTimeout(message, 2500, 'WebSocket echo timed out');
  return data.toString();
}

async function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState !== WebSocket.OPEN) {
    ws.terminate();
    return;
  }
  const closed = once(ws, 'close').catch(() => {});
  ws.close();
  await Promise.race([closed, delay(300)]);
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
}

async function connectClient(fixture, id, identity = id === 'a' ? 'legacy-device' : 'gateway-id') {
  let resolveInitialOnline;
  let initialOnline = new Promise(resolve => { resolveInitialOnline = resolve; });
  const onlineWaiters = new Set();
  const clientOptions = {
    url: `http://127.0.0.1:${fixture.relay.controlPort}`,
    secret: fixture.gateways.get(id).secret,
    gateway: fixture.gateways.get(id).url,
    allowInsecure: true,
    retryMs: 35,
    onOnline() {
      resolveInitialOnline?.();
      resolveInitialOnline = null;
      for (const resolve of onlineWaiters) resolve();
      onlineWaiters.clear();
    },
  };
  if (identity === 'legacy-device') clientOptions.device = id;
  else clientOptions.gatewayId = id;
  const client = startClient(clientOptions);
  fixture.clients.add(client);
  await withTimeout(initialOnline, 3000, 'Gateway client did not become online');
  return {
    client,
    waitNextOnline() {
      return new Promise(resolve => onlineWaiters.add(resolve));
    },
  };
}

async function startFixture(t, {
  onlineIds = GATEWAY_IDS,
  maxConnectionsA = 8,
  maxBytesA = 64 * 1024,
  maxBytesB = 64 * 1024,
  trafficWindowMs = 250,
  connectTimeout = 500,
} = {}) {
  const fixture = {
    gateways: new Map(),
    clients: new Set(),
    sockets: new Set(),
    agents: new Set(),
    relay: null,
    relayOptions: null,
    clientById: new Map(),
  };
  t.after(async () => {
    for (const client of fixture.clients) client.close();
    for (const ws of fixture.sockets) ws.terminate();
    for (const agent of fixture.agents) agent.destroy();
    if (fixture.relay) await fixture.relay.close();
    await Promise.all([...fixture.gateways.values()].map(async gateway => {
      for (const ws of gateway.websocketServer.clients) ws.terminate();
      gateway.server.closeAllConnections();
      await new Promise(resolve => gateway.server.close(resolve));
      gateway.websocketServer.close();
    }));
  });

  for (const id of GATEWAY_IDS) fixture.gateways.set(id, await startFakeGateway(id));
  fixture.relayOptions = {
    gateways: GATEWAY_IDS.map(id => {
      const gateway = fixture.gateways.get(id);
      const secret = opaqueToken();
      gateway.secret = secret;
      return {
        id,
        secret,
        pairingToken: gateway.pairingToken,
        maxConnections: id === 'a' ? maxConnectionsA : 8,
        maxBytesPerWindow: id === 'a' ? maxBytesA : maxBytesB,
        trafficWindowMs,
      };
    }),
    sharedHosts: [SHARED_HOST],
    controlPort: 0,
    proxyPort: 0,
    connectTimeout,
  };

  fixture.relay = await startRelay(fixture.relayOptions);
  for (const id of onlineIds) fixture.clientById.set(id, await connectClient(fixture, id));
  return fixture;
}

function controlHeaders(gateway, { device = gateway.id, gatewayId = gateway.id } = {}) {
  return {
    authorization: `Bearer ${gateway.secret}`,
    'x-kcoder-device': device,
    'x-kcoder-gateway-id': gatewayId,
  };
}

async function readOpenControlMessage(ws) {
  const promise = new Promise((resolve, reject) => {
    const onMessage = raw => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      if (message?.type === 'open' && typeof message.id === 'string') {
        ws.removeListener('message', onMessage);
        resolve(message);
      }
    };
    const onClose = () => reject(new Error('Relay control closed before open request'));
    ws.on('message', onMessage);
    ws.once('close', onClose);
  });
  return withTimeout(promise, 2500, 'Relay control did not receive an open request');
}

test('shared /g/id routing isolates HTTP, WebSocket, pairing, cookies, and multiple sessions', async t => {
  const fixture = await startFixture(t);
  const firstA = await pairGateway(fixture, 'a');
  const secondA = await pairGateway(fixture, 'a');
  const sessionB = await pairGateway(fixture, 'b');

  assert.ok(firstA.accessToken !== secondA.accessToken, 'each pairing creates its own access token');
  assert.ok(firstA.rpcToken === secondA.rpcToken, 'one Gateway shares its RPC token across sessions');

  const aCookie = Array.isArray(firstA.setCookie) ? firstA.setCookie[0] : firstA.setCookie;
  const bCookie = Array.isArray(sessionB.setCookie) ? sessionB.setCookie[0] : sessionB.setCookie;
  assert.ok(typeof aCookie === 'string' && /(?:^|;\s*)Path=\/g\/a\//i.test(aCookie), 'Gateway A cookie is scoped to /g/a/');
  assert.ok(typeof bCookie === 'string' && /(?:^|;\s*)Path=\/g\/b\//i.test(bCookie), 'Gateway B cookie is scoped to /g/b/');
  assert.ok(!/;\s*Domain=/i.test(aCookie || '') && !/;\s*Domain=/i.test(bCookie || ''), 'tenant cookies do not set a shared Domain');

  for (const [id, session] of [['a', firstA], ['a', secondA], ['b', sessionB]]) {
    const response = await httpThroughRelay(fixture, { id, path: '/api/whoami', accessToken: session.accessToken });
    assert.equal(response.status, 200, 'each cached access token remains valid for its Gateway');
    assert.equal(parseJsonBody(response).gateway, `gateway-${id}`, 'HTTP path prefix is routed to its owning Gateway');
  }

  const rpcA = await openRpc(fixture, 'a', secondA);
  assert.equal(rpcA.status, 101, 'Bearer plus query RPC token opens Gateway A RPC');
  assert.equal(await websocketEcho(rpcA.ws, 'ping'), 'gateway-a:ping');
  const mobileWebA = await openMobileWebRpc(fixture, 'a', firstA.accessToken, firstA.rpcToken);
  assert.equal(mobileWebA.status, 101, 'Mobile Web session subprotocol opens Gateway A RPC');
  assert.equal(await websocketEcho(mobileWebA.ws, 'web'), 'gateway-a:web');
  const rpcB = await openRpc(fixture, 'b', sessionB);
  assert.equal(rpcB.status, 101, 'Gateway B has an independent RPC tunnel');
  assert.equal(await websocketEcho(rpcB.ws, 'ping'), 'gateway-b:ping');

  const aCookieValue = String(aCookie || '').split(';', 1)[0];
  const cookieResponse = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/cookie', accessToken: firstA.accessToken, cookie: aCookieValue,
  });
  assert.equal(cookieResponse.status, 200, 'Gateway A accepts its scoped cookie');
  assert.equal(parseJsonBody(cookieResponse).hasCookie, true);
});

test('pairing and session credentials are owned by one Gateway, including Mobile Web subprotocols', async t => {
  const fixture = await startFixture(t);
  const sessionA = await pairGateway(fixture, 'a');
  const sessionB = await pairGateway(fixture, 'b');

  const wrongPairing = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/mobile/session', method: 'POST', pairingToken: fixture.gateways.get('b').pairingToken,
  });
  assert.equal(wrongPairing.status, 401, 'Gateway B pairing token cannot pair Gateway A');

  const bearerCrossTenant = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionB.accessToken,
  });
  assert.equal(bearerCrossTenant.status, 401, 'Gateway B access token cannot authorize Gateway A HTTP');

  const rpcCrossTenant = await openWebSocket(fixture, {
    path: rpcPath('a', sessionB.rpcToken),
    headers: { authorization: `Bearer ${sessionA.accessToken}` },
  });
  assert.ok(rpcCrossTenant.status >= 400, 'another Gateway RPC token cannot authorize an RPC upgrade');

  const mobileWebCrossTenant = await openMobileWebRpc(fixture, 'b', sessionA.accessToken, sessionB.rpcToken);
  assert.ok(mobileWebCrossTenant.status >= 400, 'kcoder-session token is checked against the selected Gateway');

  const correctMobileWeb = await openMobileWebRpc(fixture, 'b', sessionB.accessToken, sessionB.rpcToken);
  assert.equal(correctMobileWeb.status, 101, 'the same Mobile Web subprotocol succeeds for its owner');
  assert.equal(await websocketEcho(correctMobileWeb.ws, 'owned'), 'gateway-b:owned');
});

test('Relay forwards a Gateway-rotated phone pairing credential for Gateway validation', async t => {
  const fixture = await startFixture(t);
  const gateway = fixture.gateways.get('a');
  const rotatedPairingToken = opaqueToken();
  gateway.additionalPairingTokens.add(rotatedPairingToken);

  const paired = await pairGateway(fixture, 'a', rotatedPairingToken);
  assert.equal(typeof paired.accessToken, 'string', 'Gateway-approved rotating credential receives a mobile session');
  const otherGatewayCredential = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/mobile/session', method: 'POST',
    pairingToken: fixture.gateways.get('b').pairingToken,
  });
  assert.equal(otherGatewayCredential.status, 401, 'the selected Gateway rejects a credential that it did not issue');
});

test('the shared Host and tenant id are checked per request, keepalive does not cross tenants, and offline routes fail', async t => {
  const fixture = await startFixture(t, { onlineIds: ['b'] });
  const sessionB = await pairGateway(fixture, 'b');

  const offlineA = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/mobile/session', method: 'POST',
    pairingToken: fixture.gateways.get('a').pairingToken,
  });
  assert.ok(offlineA.status === 503 || offlineA.status === 0, 'configured but offline Gateway A fails closed');

  const unknownId = await httpThroughRelay(fixture, { id: 'missing', path: '/api/whoami' });
  assert.ok(unknownId.status >= 400, 'unknown tenant ids are rejected');
  const unknownHost = await httpThroughRelay(fixture, {
    id: 'b', path: '/api/whoami', accessToken: sessionB.accessToken, host: 'other.example',
  });
  assert.ok(unknownHost.status >= 400, 'unregistered Host values are rejected');

  fixture.clientById.set('a', await connectClient(fixture, 'a', 'legacy-device'));
  const sessionA = await pairGateway(fixture, 'a');
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  fixture.agents.add(agent);
  const first = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken, agent,
  });
  const second = await httpThroughRelay(fixture, {
    id: 'b', path: '/api/whoami', accessToken: sessionB.accessToken, agent,
  });
  assert.equal(first.status, 200, 'first keepalive request reaches Gateway A');
  assert.equal(second.status, 200, 'second keepalive request is routed to Gateway B');
  assert.equal(parseJsonBody(first).gateway, 'gateway-a');
  assert.equal(parseJsonBody(second).gateway, 'gateway-b');
  assert.equal(first.headers.connection, 'close', 'Gateway A response explicitly closes the public keepalive socket');
  assert.equal(second.headers.connection, 'close', 'Gateway B response explicitly closes the public keepalive socket');
  assert.ok(first.socket && second.socket && first.socket !== second.socket,
    'the HTTP Agent opens a fresh public socket between tenant requests');

  const badHostOnKeepalive = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken, host: 'untrusted.example', agent,
  });
  assert.ok(badHostOnKeepalive.status >= 400, 'Host is checked on every request after Agent reconnects');

  fixture.clientById.get('a').client.close();
  await delay(60);
  const disconnectedA = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken,
  });
  assert.ok(disconnectedA.status === 503 || disconnectedA.status === 0, 'disconnecting Gateway A makes only A unavailable');
  const survivingB = await httpThroughRelay(fixture, {
    id: 'b', path: '/api/whoami', accessToken: sessionB.accessToken,
  });
  assert.equal(survivingB.status, 200, 'Gateway B HTTP remains available after Gateway A disconnects');
  const survivingBRpc = await openRpc(fixture, 'b', sessionB);
  assert.equal(survivingBRpc.status, 101, 'Gateway B RPC remains available after Gateway A disconnects');
  assert.equal(await websocketEcho(survivingBRpc.ws, 'survived'), 'gateway-b:survived');
});

test('control credentials cannot be mixed, duplicate controls get 409, and data IDs stay tenant-scoped', async t => {
  const fixture = await startFixture(t, { connectTimeout: 300 });
  const sessionA = await pairGateway(fixture, 'a');

  const swappedControl = await openWebSocket(fixture, {
    port: fixture.relay.controlPort,
    path: '/_relay/control',
    headers: controlHeaders(fixture.gateways.get('a'), { device: 'a', gatewayId: 'b' }),
  });
  assert.ok(swappedControl.status >= 400, 'Gateway A secret cannot be combined with Gateway B identity');

  const duplicateControl = await openWebSocket(fixture, {
    port: fixture.relay.controlPort,
    path: '/_relay/control',
    headers: controlHeaders(fixture.gateways.get('a')),
  });
  assert.equal(duplicateControl.status, 409, 'a second control connection for one Gateway is rejected');

  const aClient = fixture.clientById.get('a');
  aClient.client.close();
  fixture.clients.delete(aClient.client);
  fixture.clientById.delete('a');
  const controlA = await openWebSocket(fixture, {
    port: fixture.relay.controlPort,
    path: '/_relay/control',
    headers: controlHeaders(fixture.gateways.get('a')),
  });
  assert.equal(controlA.status, 101, 'Gateway A can reconnect with its own control identity');

  const nextOpen = readOpenControlMessage(controlA.ws);
  const pendingRequest = httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken,
  });
  const openMessage = await nextOpen;
  assert.match(openMessage.id, /^[a-f0-9]{48}$/, 'pending data IDs use the Relay transport format');

  const stolenData = await openWebSocket(fixture, {
    port: fixture.relay.controlPort,
    path: `/_relay/data?id=${encodeURIComponent(openMessage.id)}`,
    headers: controlHeaders(fixture.gateways.get('b')),
  });
  assert.ok(stolenData.status >= 400, 'Gateway B cannot claim Gateway A pending data IDs');
  const failedPending = await pendingRequest;
  assert.ok(failedPending.status === 503 || failedPending.status === 504 || failedPending.status === 0,
    'unclaimed Gateway A data request times out safely');
});

test('connection and byte-window limits for A leave Gateway B usable', async t => {
  const fixture = await startFixture(t, {
    maxConnectionsA: 1,
    maxBytesA: 4 * 1024,
    maxBytesB: 16 * 1024,
    trafficWindowMs: 180,
  });
  const sessionA = await pairGateway(fixture, 'a');
  const sessionB = await pairGateway(fixture, 'b');

  const heldA = await openRpc(fixture, 'a', sessionA);
  assert.equal(heldA.status, 101, 'the first Gateway A data connection is admitted');
  const overConnectionLimitA = await openRpc(fixture, 'a', sessionA);
  assert.ok(overConnectionLimitA.status !== 101, 'Gateway A connection limit rejects an additional socket');
  const independentB = await openRpc(fixture, 'b', sessionB);
  assert.equal(independentB.status, 101, 'Gateway A connection limit does not block Gateway B');
  assert.equal(await websocketEcho(independentB.ws, 'still-online'), 'gateway-b:still-online');
  await closeWebSocket(heldA.ws);
  await closeWebSocket(independentB.ws);

  await delay(220);
  const largeBody = Buffer.alloc(4096, 71);
  const limitedA = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/echo-size', method: 'POST', accessToken: sessionA.accessToken, body: largeBody,
  });
  let limitedABytes = null;
  if (limitedA.status === 200) {
    try { limitedABytes = parseJsonBody(limitedA).bytes; }
    catch { /* A throttled response may end before the upstream JSON is complete. */ }
  }
  assert.ok(
    limitedA.status === 0 || limitedA.status >= 400 || limitedABytes !== largeBody.length,
    'Gateway A byte budget limits an over-window transfer',
  );

  const unaffectedB = await httpThroughRelay(fixture, {
    id: 'b', path: '/api/echo-size', method: 'POST', accessToken: sessionB.accessToken, body: largeBody,
  });
  assert.equal(unaffectedB.status, 200, 'Gateway A byte budget does not reject Gateway B');
  assert.equal(parseJsonBody(unaffectedB).bytes, largeBody.length, 'Gateway B receives its complete body');

  await delay(220);
  const recoveredA = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken,
  });
  assert.equal(recoveredA.status, 200, 'Gateway A is available again after its short traffic window');
});

test('Relay restart clears cached pairing sessions and requires re-pairing', async t => {
  const fixture = await startFixture(t);
  const sessionA = await pairGateway(fixture, 'a');
  const beforeRestart = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken,
  });
  assert.equal(beforeRestart.status, 200, 'paired Gateway A session works before restart');

  const aClient = fixture.clientById.get('a');
  const reconnected = aClient.waitNextOnline();
  const controlPort = fixture.relay.controlPort;
  const proxyPort = fixture.relay.proxyPort;
  await fixture.relay.close();
  fixture.relay = await startRelay({ ...fixture.relayOptions, controlPort, proxyPort });
  await withTimeout(reconnected, 4000, 'Gateway A client did not reconnect after Relay restart');

  const staleSession = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken,
  });
  assert.equal(staleSession.status, 401, 'cached access token hashes are not restored across Relay restart');
  const newSession = await pairGateway(fixture, 'a');
  const afterRepair = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: newSession.accessToken,
  });
  assert.equal(afterRepair.status, 200, 'a fresh Gateway A pairing restores access');
});
