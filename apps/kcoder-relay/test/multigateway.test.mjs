// Contract tests for isolated tenants on one public Relay authority. These use
// real loopback HTTP and WebSocket sockets; the fake Gateways never run a model.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, Agent } from 'node:http';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { startClient } from '../src/client.mjs';
import { startRelay } from '../src/server.mjs';
import { isolatedGatewayAuthority } from '../src/gateway-origin.mjs';

const SHARED_HOST = 'relay.example';
const GATEWAY_IDS = ['a', 'b'];
// Each Gateway is reached on its own isolated origin; the shared root only redirects.
const gatewayHost = id => isolatedGatewayAuthority(SHARED_HOST, id);
const hostForPath = path => {
  const match = String(path).match(/^\/g\/([A-Za-z0-9_-]{1,64})(?:\/|\?|$)/);
  return match ? gatewayHost(match[1]) : SHARED_HOST;
};

function opaqueToken() {
  return randomBytes(32).toString('hex');
}

function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
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
    gatewaySecret: opaqueToken(),
    additionalGatewaySecrets: new Set(),
    accessTokens: new Set(),
    browserTokens: new Set(),
    moduleReads: 0,
    peakModuleReads: 0,
    accessGrantMetadata: new Map(),
    rpcToken: opaqueToken(),
    proofRequests: [],
    validationRequests: [],
    protectedApiRequests: [],
    rpcUpgradeRequests: [],
    validationDelayMs: 0,
    validationHang: false,
    connectionEndpoints: new Set([`https://${gatewayHost(id)}/g/${id}`]),
    server: null,
    websocketServer: null,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway.invalid');
    if (req.method === 'POST' && url.pathname === '/api/mobile/session/relay-validation') {
      let payload;
      try { payload = JSON.parse((await collectRequestBody(req)).toString('utf8')); }
      catch { res.writeHead(400); res.end('bad request'); return; }
      state.validationRequests.push({
        credentialHash: typeof payload?.credential === 'string' ? tokenHash(payload.credential) : null,
        requestId: payload?.requestId,
        path: url.pathname,
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        relayHeader: req.headers['x-kcoder-relay-validation'],
      });
      const keys = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).sort() : [];
      if (req.headers['x-kcoder-relay-validation'] !== state.gatewaySecret || req.headers.origin || req.headers.authorization ||
          req.headers.cookie || req.headers['content-type'] !== 'application/json' ||
          keys.join(',') !== 'credential,kind,requestId,version' || payload.version !== 1 || payload.kind !== 'access' ||
          !/^[a-f0-9]{48}$/.test(payload.requestId || '') || typeof payload.credential !== 'string') {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      const metadata = state.accessGrantMetadata.get(payload.credential);
      if (!metadata) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      if (state.validationHang) return;
      if (state.validationDelayMs > 0) await delay(state.validationDelayMs);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        version: 1,
        kind: 'access',
        requestId: payload.requestId,
        accessTokenHash: tokenHash(payload.credential),
        rpcTokenHash: tokenHash(state.rpcToken),
        expiresAt: metadata.expiresAt,
        accessExpiresAt: metadata.expiresAt,
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/mobile/connection-proof') {
      const proofRequest = {
        nonce: url.searchParams.get('nonce'),
        endpoint: url.searchParams.get('endpoint'),
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
      };
      state.proofRequests.push(proofRequest);
      if (!state.connectionEndpoints.has(proofRequest.endpoint)) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'Connection endpoint is not available' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ gateway: state.label, signedNonce: `${state.id}:${proofRequest.nonce}`, endpoint: proofRequest.endpoint }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/session') {
      let payload;
      try { payload = JSON.parse((await collectRequestBody(req)).toString('utf8')); }
      catch { res.writeHead(400); res.end('bad request'); return; }
      if (payload?.token !== state.gatewaySecret && !state.additionalGatewaySecrets.has(payload?.token)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      const accessToken = opaqueToken();
      state.accessTokens.add(accessToken);
      const expiresAt = Date.now() + 60_000;
      state.accessGrantMetadata.set(accessToken, { expiresAt });
      // A Gateway uses one long-lived RPC token for all of its mobile sessions.
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `kcoder_session=${opaqueToken()}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(JSON.stringify({
        accessToken,
        rpcToken: state.rpcToken,
        expiresAt,
      }));
      return;
    }

    const cookie = /(?:^|;\s*)__Host-kcoder_studio_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const accessToken = req.headers.authorization !== undefined
      ? /^Bearer (.+)$/.exec(req.headers.authorization)?.[1]
      : state.browserTokens.has(cookie) ? cookie : undefined;
    if (url.pathname.startsWith('/api/')) state.protectedApiRequests.push({
      path: url.pathname,
      accessHash: accessToken ? tokenHash(accessToken) : null,
      validationHeader: req.headers['x-kcoder-relay-validation'],
    });
    if (!accessToken || !state.accessTokens.has(accessToken)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }

    if (url.pathname.startsWith('/src/')) {
      state.moduleReads++;
      state.peakModuleReads = Math.max(state.peakModuleReads, state.moduleReads);
      await delay(15);
      state.moduleReads--;
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('export const ready = true;');
      return;
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      state.accessTokens.delete(accessToken);
      state.accessGrantMetadata.delete(accessToken);
      state.browserTokens.delete(accessToken);
      res.writeHead(303, { location: '/login', 'set-cookie': '__Host-kcoder_studio_session=; Path=/; Secure; Max-Age=0' });
      res.end();
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
    if (url.pathname === '/api/scope-headers') {
      res.writeHead(200, { 'content-type': 'text/plain', 'service-worker-allowed': '/',
        'set-cookie': 'session=fixture; Path=/g/a/; path=/; Domain=example.invalid; HttpOnly' });
      res.end('scoped');
      return;
    }
    if (url.pathname === '/api/cookie' || url.pathname === '/api/kcoder-account') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ gateway: state.label, cookie: req.headers.cookie ?? null }));
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
    state.rpcUpgradeRequests.push({ path: url.pathname, cookie: req.headers.cookie ?? null, accessHash: /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] ? tokenHash(/^Bearer (.+)$/.exec(req.headers.authorization || '')[1]) : null });
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
    const cookie = /(?:^|;\s*)__Host-kcoder_studio_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const browserAuthorized = state.browserTokens.has(cookie) && state.accessTokens.has(cookie)
      && url.searchParams.get('token') === state.rpcToken;
    if (url.pathname !== '/rpc' || (!mobileWebAuthorized && !rpcAuthorized && !browserAuthorized)) {
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
  gatewaySecret,
  cookie,
  validationHeader,
  contentType,
  body,
  host = gatewayHost(id),
  agent = false,
  timeoutMs = 4000,
}) {
  const headers = { host };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (gatewaySecret) headers['content-type'] = 'application/json';
  if (contentType) headers['content-type'] = contentType;
  if (validationHeader) headers['x-kcoder-relay-validation'] = validationHeader;
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
    if (gatewaySecret) outgoing.end(JSON.stringify({ token: gatewaySecret }));
    else outgoing.end();
  });
}

function parseJsonBody(response) {
  try { return JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error('Relay response did not contain valid JSON'); }
}

async function pairGateway(fixture, id, token = fixture.gateways.get(id).gatewaySecret) {
  const response = await httpThroughRelay(fixture, {
    id,
    path: '/api/mobile/session',
    method: 'POST',
    gatewaySecret: token,
  });
  assert.equal(response.status, 200, 'valid per-Gateway pairing must succeed');
  const session = parseJsonBody(response);
  assert.equal(typeof session.accessToken, 'string', 'pairing returns a mobile access token');
  assert.equal(typeof session.rpcToken, 'string', 'pairing returns an RPC token');
  return { ...session, setCookie: response.headers['set-cookie'] };
}

function issueGatewayAccess(gateway, accessToken = opaqueToken()) {
  const expiresAt = Date.now() + 60_000;
  gateway.accessTokens.add(accessToken);
  gateway.accessGrantMetadata.set(accessToken, { expiresAt });
  return { accessToken, rpcToken: gateway.rpcToken, expiresAt };
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
    headers: { host: hostForPath(path), ...headers },
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
        gatewaySecret: gateway.gatewaySecret,
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

  const scoped = await httpThroughRelay(fixture, { id: 'a', path: '/api/scope-headers', accessToken: firstA.accessToken });
  assert.equal(scoped.headers['service-worker-allowed'], '/g/a/');
  const scopedCookie = scoped.headers['set-cookie'][0];
  assert.equal((scopedCookie.match(/;\s*path=/ig) || []).length, 1);
  assert.ok(scopedCookie.endsWith('; Path=/g/a/'));
  assert.ok(!/;\s*Domain=/i.test(scopedCookie));

  const rpcA = await openRpc(fixture, 'a', secondA);
  assert.equal(rpcA.status, 101, 'Bearer plus query RPC token opens Gateway A RPC');
  assert.equal(await websocketEcho(rpcA.ws, 'ping'), 'gateway-a:ping');
  const mobileWebA = await openMobileWebRpc(fixture, 'a', firstA.accessToken, firstA.rpcToken);
  assert.equal(mobileWebA.status, 101, 'Mobile Web session subprotocol opens Gateway A RPC');
  assert.equal(await websocketEcho(mobileWebA.ws, 'web'), 'gateway-a:web');
  const rpcB = await openRpc(fixture, 'b', sessionB);
  assert.equal(rpcB.status, 101, 'Gateway B has an independent RPC tunnel');
  assert.equal(await websocketEcho(rpcB.ws, 'ping'), 'gateway-b:ping');

  // Browsers attach parent-domain (pre-isolation) and unrelated cookies to the
  // isolated subdomain; the target Gateway sees only its own host cookie, byte-exact.
  const aCookieValue = String(aCookie || '').split(';', 1)[0];
  const hostCookie = '__Host-kcoder_studio_session=own%2Fvalue=x';
  const upstreamCookie = async cookie => {
    const response = await httpThroughRelay(fixture, { id: 'a', path: '/api/cookie', accessToken: firstA.accessToken, cookie });
    assert.equal(response.status, 200);
    return parseJsonBody(response).cookie;
  };
  assert.equal(await upstreamCookie(`${aCookieValue}; kcoder_studio_session=parent;  ${hostCookie} ;other=1`), hostCookie,
    'only the isolated host session cookie reaches the Gateway');
  assert.equal(await upstreamCookie(`${aCookieValue}; kcoder_studio_session=parent`), null, 'legacy and sibling cookies are dropped');
  assert.equal(await upstreamCookie(`${hostCookie}; __Host-kcoder_studio_session=second`), null, 'a repeated host cookie is dropped');
  assert.equal(await upstreamCookie(`__host-kcoder_studio_session=case; __Host-kcoder_studio_sessionX=y`), null, 'names match exactly');

  const before = fixture.gateways.get('a').rpcUpgradeRequests.length;
  const cookieRpc = await openWebSocket(fixture, {
    path: rpcPath('a', firstA.rpcToken),
    headers: { authorization: `Bearer ${firstA.accessToken}`, cookie: [`${aCookieValue}; ${hostCookie}`, 'kcoder_studio_session=parent'] },
  });
  assert.equal(cookieRpc.status, 101, 'Bearer RPC does not depend on any cookie');
  assert.equal(fixture.gateways.get('a').rpcUpgradeRequests[before].cookie, hostCookie,
    'the raw WebSocket handshake forwards one filtered Cookie line');
  const duplicateRpc = await openWebSocket(fixture, {
    path: rpcPath('a', firstA.rpcToken),
    headers: { authorization: `Bearer ${firstA.accessToken}`, cookie: [hostCookie, '__Host-kcoder_studio_session=second'] },
  });
  assert.equal(duplicateRpc.status, 101);
  assert.equal(fixture.gateways.get('a').rpcUpgradeRequests[before + 1].cookie, null, 'repeated host cookies across lines are dropped');
});

test('isolated origins: the shared root only redirects safe navigations and host, path or Origin mixing fails', async t => {
  const fixture = await startFixture(t);
  const sessionA = await pairGateway(fixture, 'a');

  const own = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken, host: `${gatewayHost('a').toUpperCase()}:443`,
  });
  assert.equal(own.status, 200, 'host case and an explicit default port name the same origin');
  assert.equal(parseJsonBody(own).gateway, 'gateway-a');
  assert.equal(own.headers['origin-agent-cluster'], '?1');

  const page = await httpThroughRelay(fixture, { id: 'b', path: '/mobile/connect', host: SHARED_HOST });
  assert.equal(page.status, 308, 'a shared-root page navigation moves to its own Gateway origin');
  assert.equal(page.headers.location, `https://${gatewayHost('b')}/g/b/mobile/connect`);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  for (const [path, method, accessToken] of [
    ['/api/whoami', 'GET', sessionA.accessToken],
    ['/login?token=must-not-be-redirected', 'GET'],
    ['/mobile/?access_token=must-not-be-redirected', 'GET'],
    // Any query fails closed: non-standard credential names and encodings are never enumerated.
    ['/mobile/connect?api_key=must-not-leak&jwt=must-not-leak&x-tenant-cred=must-not-leak', 'GET'],
    ['/mobile/connect?%61ccess%5Ftoken=must-not-leak', 'GET'],
    ['/mobile/connect?routes=public', 'GET'],
    ['/mobile/connect?', 'GET'],
    ['/mobile/', 'POST'],
    ['/mobile/', 'GET', sessionA.accessToken],
    [`/rpc?token=${sessionA.rpcToken}`, 'GET'],
  ]) {
    const response = await httpThroughRelay(fixture, { id: 'a', path, method, accessToken, host: SHARED_HOST });
    assert.equal(response.status, 426, `${method} ${path} is not proxied or redirected from the shared root`);
    assert.equal(response.headers.location, undefined);
    assert.doesNotMatch(response.body.toString('utf8'), /must-not-leak/, 'the query is never reflected');
    assert.equal(parseJsonBody(response).code, 'RELAY_ORIGIN_ISOLATION_REQUIRED');
  }

  const mixed = await httpThroughRelay(fixture, { id: 'b', path: '/api/whoami', accessToken: sessionA.accessToken, host: gatewayHost('a') });
  assert.equal(mixed.status, 421, 'Gateway A origin cannot address Gateway B by path');
  const traversal = await httpThroughRelay(fixture, { id: 'a', path: '/../b/api/whoami', accessToken: sessionA.accessToken });
  assert.equal(traversal.status, 400, 'dot segments cannot re-target another mount');

  const crossOrigin = await openWebSocket(fixture, {
    path: rpcPath('a', sessionA.rpcToken),
    headers: { authorization: `Bearer ${sessionA.accessToken}`, origin: `https://${gatewayHost('b')}` },
  });
  assert.equal(crossOrigin.status, 403, "another Gateway origin cannot open this Gateway's RPC");
  const sharedSocket = await openWebSocket(fixture, {
    path: rpcPath('a', sessionA.rpcToken), headers: { host: SHARED_HOST, authorization: `Bearer ${sessionA.accessToken}` },
  });
  assert.equal(sharedSocket.status, 426, 'WebSocket credentials are never accepted on the shared root');
  const ownSocket = await openRpc(fixture, 'a', sessionA);
  assert.equal(ownSocket.status, 101);

  const ask = (domain, headers = {}) => new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port: fixture.relay.controlPort, headers,
      path: `/_relay/tls-ask?domain=${encodeURIComponent(domain)}`,
    }, response => { response.resume(); resolve(response.statusCode); });
    outgoing.once('error', reject);
    outgoing.end();
  });
  assert.equal(await ask(gatewayHost('a')), 200, 'Caddy may obtain a certificate for an active Gateway origin');
  assert.equal(await ask(gatewayHost('unregistered')), 403);
  assert.equal(await ask(SHARED_HOST), 403);
  assert.equal(await ask(gatewayHost('a'), { host: SHARED_HOST }), 403, 'the public /_relay route cannot query the ask');
  assert.equal(await ask(gatewayHost('a'), { 'x-forwarded-for': '203.0.113.9' }), 403);
});

test('desktop cookies share Gateway validation across API, RPC and a bounded Vite module burst', async t => {
  const fixture = await startFixture(t, { maxConnectionsA: 64, maxBytesA: 8 * 1024 * 1024,
    trafficWindowMs: 60_000, connectTimeout: 3000 });
  const gateway = fixture.gateways.get('a');
  const session = issueGatewayAccess(gateway, randomUUID());
  gateway.browserTokens.add(session.accessToken);
  const cookie = `__Host-kcoder_studio_session=${session.accessToken}`;
  const first = await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami', cookie });
  assert.equal(first.status, 200);
  const productCookie = `__Host-kcoder_studio_session_account_${'a'.repeat(24)}=${'b'.repeat(43)}`;
  const withProductCookie = `${cookie}; ${productCookie}; unrelated=private`;
  const account = await httpThroughRelay(fixture, { id: 'a', path: '/api/kcoder-account', cookie: withProductCookie });
  assert.equal(account.status, 200);
  assert.equal(parseJsonBody(account).cookie, `${cookie}; ${productCookie}`);
  const unrelated = await httpThroughRelay(fixture, { id: 'a', path: '/api/cookie', cookie: withProductCookie });
  assert.equal(parseJsonBody(unrelated).cookie, cookie);

  assert.equal(gateway.validationRequests.length, 1);
  assert.equal(gateway.validationRequests[0].cookie, undefined);
  assert.equal(gateway.validationRequests[0].authorization, undefined);
  assert.equal((await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami',
    cookie: `kcoder_studio_session=${session.accessToken}` })).status, 401,
  'a legacy parent-domain cookie cannot authorize an isolated Gateway');
  assert.equal((await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami',
    cookie: `kcoder_studio_session=parent; ${cookie}` })).status, 200,
  'the isolated host cookie remains authoritative beside a parent-domain cookie');
  const rpc = await openWebSocket(fixture, { path: rpcPath('a', session.rpcToken), headers: { cookie } });
  assert.equal(rpc.status, 101);
  assert.equal(await websocketEcho(rpc.ws, 'desktop'), 'gateway-a:desktop');

  const modules = await Promise.all(Array.from({ length: 180 }, (_, n) =>
    httpThroughRelay(fixture, { id: 'a', path: `/src/module-${n}.ts`, cookie, timeoutMs: 10_000 })));
  assert.ok(modules.every(response => response.status === 200), 'a module burst must queue instead of dropping imports');
  assert.ok(gateway.peakModuleReads > 2 && gateway.peakModuleReads <= 16);
  assert.equal(gateway.validationRequests.length, 1);

  for (const options of [
    { id: 'b', cookie },
    { id: 'a', cookie: `${cookie}; ${cookie}` },
    { id: 'a', cookie, accessToken: opaqueToken() },
  ]) {
    assert.equal((await httpThroughRelay(fixture, { ...options, path: '/api/whoami' })).status, 401);
  }
  gateway.accessTokens.delete(session.accessToken);
  assert.equal((await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami', cookie })).status, 401,
    'a routing grant never replaces Gateway authorization');
  gateway.accessTokens.add(session.accessToken);
  const closed = once(rpc.ws, 'close');
  assert.equal((await httpThroughRelay(fixture, { id: 'a', path: '/logout', method: 'POST', cookie })).status, 303);
  await withTimeout(closed, 3000, 'logout did not release the browser RPC route');
  assert.equal((await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami', cookie })).status, 401);
});

test('unknown LAN-issued access is read-only validated once before Relay HTTP and RPC admission', async t => {
  const fixture = await startFixture(t);
  const gatewayA = fixture.gateways.get('a');
  const directSession = issueGatewayAccess(gatewayA);
  gatewayA.validationDelayMs = 100;

  const [rest, rpc] = await Promise.all([
    httpThroughRelay(fixture, { id: 'a', path: '/api/whoami', accessToken: directSession.accessToken }),
    openRpc(fixture, 'a', directSession),
  ]);
  assert.equal(rest.status, 200, 'a real Gateway-issued LAN access token can use public REST');
  assert.equal(parseJsonBody(rest).gateway, 'gateway-a');
  assert.equal(rpc.status, 101, 'the same direct-issued access token can use public RPC');
  assert.equal(await websocketEcho(rpc.ws, 'same-profile'), 'gateway-a:same-profile');
  const directHash = tokenHash(directSession.accessToken);
  const validations = gatewayA.validationRequests.filter(value => value.credentialHash === directHash);
  assert.equal(validations.length, 1, 'concurrent REST/RPC misses share one token-hash validation flight');
  assert.deepEqual({
    path: validations[0].path,
    host: validations[0].host,
    origin: validations[0].origin,
    authorization: validations[0].authorization,
    cookie: validations[0].cookie,
    relayHeader: validations[0].relayHeader,
  }, {
    path: '/api/mobile/session/relay-validation',
    host: gatewayHost('a'),
    origin: undefined,
    authorization: undefined,
    cookie: undefined,
    relayHeader: gatewayA.gatewaySecret,
  }, 'only the selected Gateway pairing credential reaches the private validation endpoint');

  const spoofedHeader = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: directSession.accessToken, validationHeader: 'public-spoof',
  });
  assert.equal(spoofedHeader.status, 200, 'a public internal-header attempt cannot disturb an already admitted token');
  assert.equal(gatewayA.protectedApiRequests.at(-1).validationHeader, undefined, 'the Relay strips the internal header from public API traffic');

  const validationBeforePublicCall = gatewayA.validationRequests.length;
  const privatePath = await httpThroughRelay(fixture, {
    id: 'a',
    path: '/api/mobile/session/relay-validation?anything=1',
    method: 'POST',
    body: JSON.stringify({ version: 1, kind: 'access', credential: directSession.accessToken, requestId: 'c'.repeat(48) }),
    contentType: 'application/json',
    validationHeader: gatewayA.gatewaySecret,
  });
  assert.equal(privatePath.status, 404, 'public callers cannot invoke the internal validation route');
  assert.equal(gatewayA.validationRequests.length, validationBeforePublicCall, 'the public path never reaches Gateway validation');

  const gatewayB = fixture.gateways.get('b');
  const directB = issueGatewayAccess(gatewayB);
  const crossTenant = await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami', accessToken: directB.accessToken });
  assert.equal(crossTenant.status, 401, 'a real token from another Gateway cannot be adopted into this Gateway cache');
  assert.equal(gatewayA.protectedApiRequests.some(value => value.accessHash === tokenHash(directB.accessToken)), false,
    'failed validation never forwards the original business API request');

  const anonymousBefore = gatewayA.validationRequests.length;
  const anonymousApi = await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami' });
  assert.equal(anonymousApi.status, 401, 'other APIs remain authenticated');
  assert.equal(gatewayA.validationRequests.length, anonymousBefore, 'no credential means no validation tunnel');
  await closeWebSocket(rpc.ws);
});

test('unknown access validation has a hard deadline and is fenced when Gateway control drops', async t => {
  const fixture = await startFixture(t, { connectTimeout: 8_000 });
  const gatewayA = fixture.gateways.get('a');
  const timedOutSession = issueGatewayAccess(gatewayA);
  gatewayA.validationHang = true;
  const timedOut = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: timedOutSession.accessToken, timeoutMs: 7_000,
  });
  assert.equal(timedOut.status, 504, 'a Gateway that withholds validation cannot hold public access indefinitely');
  assert.equal(gatewayA.protectedApiRequests.some(value => value.accessHash === tokenHash(timedOutSession.accessToken)), false,
    'timed-out validation never forwards the original API request');

  gatewayA.validationHang = false;
  gatewayA.validationDelayMs = 1_000;
  const disconnectedSession = issueGatewayAccess(gatewayA);
  const disconnectedHash = tokenHash(disconnectedSession.accessToken);
  const inFlight = httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: disconnectedSession.accessToken, timeoutMs: 3_000,
  });
  await withTimeout((async () => {
    while (!gatewayA.validationRequests.some(value => value.credentialHash === disconnectedHash)) await delay(5);
  })(), 1_000, 'Relay did not send the read-only validation request');
  fixture.clientById.get('a').client.close();
  const disconnected = await withTimeout(inFlight, 2_000, 'Gateway control loss did not settle validation');
  assert.equal(disconnected.status, 503, 'control loss returns unavailable and fences stale authorization metadata');
  assert.equal(gatewayA.protectedApiRequests.some(value => value.accessHash === disconnectedHash), false,
    'a disconnected Gateway cannot admit or receive the original business request');
});

test('pairing and session credentials are owned by one Gateway, including Mobile Web subprotocols', async t => {
  const fixture = await startFixture(t);
  const sessionA = await pairGateway(fixture, 'a');
  const sessionB = await pairGateway(fixture, 'b');

  const wrongPairing = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/mobile/session', method: 'POST', gatewaySecret: fixture.gateways.get('b').gatewaySecret,
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

test('anonymous connection proofs use the selected public Gateway route and accept only the exact probe shape', async t => {
  const fixture = await startFixture(t);
  const nonceA = 'a'.repeat(48);
  const nonceB = 'b'.repeat(48);
  const endpointA = `https://${gatewayHost('a')}/g/a`;
  const endpointB = `https://${gatewayHost('b')}/g/b`;

  const proofForBThroughRouteA = await httpThroughRelay(fixture, {
    id: 'a',
    path: `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointB)}`,
    accessToken: opaqueToken(),
    cookie: 'kcoder_session=must-not-cross-the-proof-boundary',
  });
  assert.equal(proofForBThroughRouteA.status, 404, 'Gateway A cannot sign a challenge naming Gateway B endpoint');
  assert.deepEqual(fixture.gateways.get('a').proofRequests.at(-1), {
    nonce: nonceA, endpoint: endpointB, authorization: undefined, cookie: undefined,
  }, 'proof requests do not forward caller bearer or cookie credentials');

  const proofA = await httpThroughRelay(fixture, {
    id: 'a', path: `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}`,
  });
  assert.equal(proofA.status, 200, 'a valid proof GET is the only unauthenticated API exception');
  assert.deepEqual(parseJsonBody(proofA), {
    gateway: 'gateway-a', signedNonce: `a:${nonceA}`, endpoint: endpointA,
  }, 'the public /g/a route returns a proof from Gateway A');

  const cacheBustedProof = await httpThroughRelay(fixture, {
    id: 'a', path: `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}&_=1234567890123456`,
  });
  assert.equal(cacheBustedProof.status, 200, 'one bounded decimal fetch cachebuster preserves proof access');
  assert.deepEqual(parseJsonBody(cacheBustedProof), parseJsonBody(proofA), 'the cachebuster does not affect the signed proof');

  const proofB = await httpThroughRelay(fixture, {
    id: 'b',
    path: `/api/mobile/connection-proof?nonce=${nonceB}&endpoint=${encodeURIComponent(endpointB)}`,
  });
  assert.equal(proofB.status, 200);
  assert.equal(parseJsonBody(proofB).signedNonce, `b:${nonceB}`, 'the public /g/b route reaches only Gateway B');
  assert.equal(fixture.gateways.get('a').proofRequests.length, 3);
  assert.equal(fixture.gateways.get('b').proofRequests.length, 1);

  const rejectedPaths = [
    `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}&extra=1`,
    `/api/mobile/connection-proof?nonce=${nonceA}&nonce=${nonceB}&endpoint=${encodeURIComponent(endpointA)}`,
    `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}&endpoint=${encodeURIComponent(endpointA)}`,
    `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}&_=1&_=2`,
    `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}&_=12345678901234567`,
    `/api/mobile/connection-proof?%6Eonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}`,
    `/api/mobile/connection-proof?nonce=${nonceA}&%65ndpoint=${encodeURIComponent(endpointA)}`,
    `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}&padding=${'x'.repeat(4096)}`,
  ];
  for (const path of rejectedPaths) {
    const rejected = await httpThroughRelay(fixture, { id: 'a', path });
    assert.equal(rejected.status, 400, path);
  }
  const proofWithBody = await httpThroughRelay(fixture, {
    id: 'a', method: 'GET', body: 'unexpected',
    path: `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}`,
  });
  assert.equal(proofWithBody.status, 400, 'GET bodies remain outside the anonymous proof exception');
  const postProof = await httpThroughRelay(fixture, {
    id: 'a', method: 'POST', path: `/api/mobile/connection-proof?nonce=${nonceA}&endpoint=${encodeURIComponent(endpointA)}`,
  });
  assert.equal(postProof.status, 401, 'the proof path does not open anonymous POST access');
  const otherApi = await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami' });
  assert.equal(otherApi.status, 401, 'every other API route still requires Gateway access authorization');
});

test('Relay forwards a Gateway-rotated phone pairing credential for Gateway validation', async t => {
  const fixture = await startFixture(t);
  const gateway = fixture.gateways.get('a');
  const rotatedGatewaySecret = opaqueToken();
  gateway.additionalGatewaySecrets.add(rotatedGatewaySecret);

  const paired = await pairGateway(fixture, 'a', rotatedGatewaySecret);
  assert.equal(typeof paired.accessToken, 'string', 'Gateway-approved rotating credential receives a mobile session');
  const otherGatewayCredential = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/mobile/session', method: 'POST',
    gatewaySecret: fixture.gateways.get('b').gatewaySecret,
  });
  assert.equal(otherGatewayCredential.status, 401, 'the selected Gateway rejects a credential that it did not issue');
});

test('the shared Host and tenant id are checked per request, keepalive does not cross tenants, and offline routes fail', async t => {
  const fixture = await startFixture(t, { onlineIds: ['b'] });
  const sessionB = await pairGateway(fixture, 'b');

  const offlineA = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/mobile/session', method: 'POST',
    gatewaySecret: fixture.gateways.get('a').gatewaySecret,
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

test('Relay restart revalidates a still-live Gateway access grant without creating another pairing', async t => {
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

  const sessionAfterRestart = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', accessToken: sessionA.accessToken,
  });
  assert.equal(sessionAfterRestart.status, 200, 'the Gateway read-only validator restores a live access hash after Relay restart');
  assert.equal(fixture.gateways.get('a').validationRequests.some(value => value.credentialHash === tokenHash(sessionA.accessToken)), true,
    'Relay restart recovery consults the Gateway instead of restoring local token state');
});
