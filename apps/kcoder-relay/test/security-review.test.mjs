// Adversarial boundary checks that are intentionally separate from the
// multitenant contract suite while the relay implementation is being reviewed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request, createServer } from 'node:http';
import { createConnection } from 'node:net';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { startClient } from '../src/client.mjs';
import { startRelay } from '../src/server.mjs';

const SHARED_HOST = 'relay-review.example:8451';

function token() {
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

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

async function startFakeGateway(id, { expiresInMs = 60_000 } = {}) {
  const state = {
    id,
    pairingToken: token(),
    accessTokens: new Set(),
    rpcToken: token(),
    allowedOrigin: `https://mobile-${id}.example`,
    preflights: [],
    apiRequests: 0,
    truncateNextSessionResponse: false,
    slowUploadMs: 0,
    slowUploadChunks: 0,
    server: null,
    websocketServer: null,
    dataChannels: new Set(),
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://gateway.invalid');
    if (request.method === 'OPTIONS') {
      state.preflights.push({ path: request.url, host: request.headers.host, origin: request.headers.origin });
      const allowed = request.headers.origin === state.allowedOrigin;
      response.writeHead(allowed ? 204 : 403, allowed ? {
        'access-control-allow-origin': state.allowedOrigin,
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
        vary: 'Origin',
      } : { 'content-type': 'application/json' });
      response.end(allowed ? undefined : JSON.stringify({ error: 'Origin rejected by Gateway' }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/mobile/session') {
      let payload;
      try { payload = JSON.parse((await readBody(request)).toString('utf8')); }
      catch { response.writeHead(400); response.end('bad request'); return; }
      if (payload?.token !== state.pairingToken) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (state.truncateNextSessionResponse) {
        state.truncateNextSessionResponse = false;
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '256',
        });
        response.write('{"accessToken":"truncated');
        setTimeout(() => response.destroy(), 20);
        return;
      }
      const accessToken = token();
      state.accessTokens.add(accessToken);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        accessToken,
        rpcToken: state.rpcToken,
        expiresAt: Date.now() + expiresInMs,
      }));
      return;
    }

    const accessToken = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];
    if (!accessToken || !state.accessTokens.has(accessToken)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/api/whoami') {
      state.apiRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ gateway: id }));
      return;
    }
    if (url.pathname === '/api/slow-upload') {
      const hash = createHash('sha256');
      let bytes = 0;
      let chunks = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        chunks += 1;
        hash.update(chunk);
        if (state.slowUploadMs > 0) await delay(state.slowUploadMs);
      }
      state.slowUploadChunks = chunks;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ bytes, chunks, sha256: hash.digest('hex') }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://gateway.invalid');
    const accessToken = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];
    if (url.pathname !== '/rpc' || !state.accessTokens.has(accessToken) || url.searchParams.get('token') !== state.rpcToken) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, ws => websocketServer.emit('connection', ws));
  });
  websocketServer.on('connection', ws => {
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  });

  state.server = server;
  state.websocketServer = websocketServer;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.url = `http://127.0.0.1:${server.address().port}`;
  return state;
}

async function startFixture(t, {
  expiresInA = 60_000,
  maxConnectionsA = 8,
  maxConnectionsB = 8,
  maxBytesA = 4 * 1024 * 1024,
  maxBytesB = 4 * 1024 * 1024,
  pairingBodyTimeoutMs = 5_000,
} = {}) {
  const fixture = { gateways: new Map(), clients: new Map(), sockets: new Set(), relay: null };
  fixture.gateways.set('a', await startFakeGateway('a', { expiresInMs: expiresInA }));
  fixture.gateways.set('b', await startFakeGateway('b'));
  const gateways = [...fixture.gateways].map(([id, gateway]) => ({
    id,
    secret: token(),
    pairingToken: gateway.pairingToken,
    maxConnections: id === 'a' ? maxConnectionsA : maxConnectionsB,
    maxBytesPerWindow: id === 'a' ? maxBytesA : maxBytesB,
    trafficWindowMs: 60_000,
  }));
  fixture.relay = await startRelay({
    gateways,
    sharedHosts: [SHARED_HOST],
    controlPort: 0,
    proxyPort: 0,
    connectTimeout: 1_000,
    pairingBodyTimeoutMs,
  });
  for (const gateway of gateways) {
    const state = fixture.gateways.get(gateway.id);
    let resolveOnline;
    const online = new Promise(resolve => { resolveOnline = resolve; });
    const client = startClient({
      url: `http://127.0.0.1:${fixture.relay.controlPort}`,
      secret: gateway.secret,
      gatewayId: gateway.id,
      gateway: state.url,
      allowInsecure: true,
      retryMs: 30,
      onOnline: resolveOnline,
      onDiagnostic(event) {
        if (event.event === 'data_open') state.dataChannels.add(event.correlation);
        if (event.event === 'data_close') state.dataChannels.delete(event.correlation);
      },
    });
    fixture.clients.set(gateway.id, client);
    await withTimeout(online, 2_000, `Gateway ${gateway.id} control did not open`);
  }

  t.after(async () => {
    for (const client of fixture.clients.values()) client.close();
    for (const socket of fixture.sockets) socket.terminate();
    if (fixture.relay) await fixture.relay.close();
    await Promise.all([...fixture.gateways.values()].map(async gateway => {
      for (const socket of gateway.websocketServer.clients) socket.terminate();
      gateway.server.closeAllConnections();
      await new Promise(resolve => gateway.server.close(resolve));
      gateway.websocketServer.close();
    }));
  });
  return fixture;
}

function httpThroughRelay(fixture, { id, path, method = 'GET', body, headers = {}, timeoutMs = 2_000 }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const outgoing = request({
      hostname: '127.0.0.1',
      port: fixture.relay.proxyPort,
      method,
      path: `/g/${id}${path}`,
      headers: { host: SHARED_HOST, ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => finish({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('aborted', () => finish({ status: response.statusCode || 0, aborted: true, body: Buffer.concat(chunks) }));
      response.once('error', error => finish({ status: response.statusCode || 0, error: error.code, body: Buffer.concat(chunks) }));
    });
    outgoing.setTimeout(timeoutMs, () => { outgoing.destroy(); finish({ status: 0, timeout: true, body: Buffer.alloc(0) }); });
    outgoing.once('error', error => finish({ status: 0, error: error.code, body: Buffer.alloc(0) }));
    if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

function readRelayHealth(fixture) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port: fixture.relay.controlPort, path: '/_relay/health' }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
      response.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function waitForRelayHealth(fixture, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await readRelayHealth(fixture);
    if (predicate(health)) return health;
    await delay(10);
  }
  throw new Error('Relay health did not reach the expected state');
}

function streamedUploadThroughRelay(fixture, { id, path, accessToken, body, chunkBytes = 16 * 1024, timeoutMs = 5_000 }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const outgoing = request({
      hostname: '127.0.0.1',
      port: fixture.relay.proxyPort,
      method: 'POST',
      path: `/g/${id}${path}`,
      headers: {
        host: SHARED_HOST,
        authorization: `Bearer ${accessToken}`,
        'content-length': String(body.length),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => finish({ status: response.statusCode || 0, body: Buffer.concat(chunks) }));
      response.once('aborted', () => finish({ status: response.statusCode || 0, aborted: true, body: Buffer.concat(chunks) }));
      response.once('error', error => finish({ status: response.statusCode || 0, error: error.code, body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => { outgoing.destroy(); finish({ status: 0, timeout: true, body: Buffer.alloc(0) }); }, timeoutMs);
    outgoing.once('error', error => finish({ status: 0, error: error.code, body: Buffer.alloc(0) }));
    void (async () => {
      try {
        for (let offset = 0; offset < body.length; offset += chunkBytes) {
          if (!outgoing.write(body.subarray(offset, Math.min(body.length, offset + chunkBytes)))) {
            await withTimeout(once(outgoing, 'drain'), timeoutMs, 'Upload request stalled under downstream backpressure');
          }
        }
        outgoing.end();
      } catch (error) {
        outgoing.destroy();
        finish({ status: 0, error: error.message, body: Buffer.alloc(0) });
      }
    })();
  });
}

async function pairGateway(fixture, id) {
  const gateway = fixture.gateways.get(id);
  const body = JSON.stringify({ token: gateway.pairingToken });
  const response = await httpThroughRelay(fixture, {
    id,
    path: '/api/mobile/session',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  });
  return { ...response, session: response.status === 200 ? JSON.parse(response.body.toString('utf8')) : null };
}

function openRpc(fixture, id, session) {
  const endpoint = `ws://127.0.0.1:${fixture.relay.proxyPort}/g/${id}/rpc?token=${encodeURIComponent(session.rpcToken)}`;
  const socket = new WebSocket(endpoint, {
    handshakeTimeout: 1_500,
    perMessageDeflate: false,
    headers: { host: SHARED_HOST, authorization: `Bearer ${session.accessToken}` },
  });
  fixture.sockets.add(socket);
  socket.on('error', () => {});
  return withTimeout(new Promise(resolve => {
    socket.once('open', () => resolve({ status: 101, socket }));
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve({ status: response.statusCode || 0, socket: null }); });
    socket.once('error', () => resolve({ status: 0, socket: null }));
  }), 2_000, 'RPC handshake timed out');
}

function websocketEcho(socket, value) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RPC echo timed out')), 1_000);
    socket.once('message', data => { clearTimeout(timer); resolve(data.toString()); });
    socket.send(value);
  });
}

test('relay forwards per-tenant CORS preflights for backend Origin policy and still requires Bearer for API GET', async t => {
  const fixture = await startFixture(t);
  for (const id of ['a', 'b']) {
    const gateway = fixture.gateways.get(id);
    const response = await httpThroughRelay(fixture, {
      id,
      path: '/api/mobile/session',
      method: 'OPTIONS',
      headers: {
        origin: gateway.allowedOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(response.status, 204, `Gateway ${id} should answer its own allowed preflight`);
    assert.equal(response.headers['access-control-allow-origin'], gateway.allowedOrigin);
    assert.deepEqual(gateway.preflights.at(-1), {
      path: '/api/mobile/session',
      host: SHARED_HOST,
      origin: gateway.allowedOrigin,
    }, 'the relay must strip only the selected route prefix and preserve Host and Origin');
  }

  const rejectedOrigin = await httpThroughRelay(fixture, {
    id: 'a',
    path: '/api/mobile/session',
    method: 'OPTIONS',
    headers: {
      origin: fixture.gateways.get('b').allowedOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(rejectedOrigin.status, 403, 'Gateway A owns the Origin decision for A preflights');
  assert.equal(fixture.gateways.get('a').preflights.at(-1).origin, fixture.gateways.get('b').allowedOrigin);

  const unauthenticated = await httpThroughRelay(fixture, { id: 'a', path: '/api/whoami' });
  assert.equal(unauthenticated.status, 401, 'OPTIONS bypass must not make actual API requests public');
  assert.equal(fixture.gateways.get('a').apiRequests, 0, 'the relay rejects an unauthenticated GET before the local Gateway');
});

test('aborted pairing body and truncated upstream session response settle without taking another Gateway offline', async t => {
  const fixture = await startFixture(t);
  const sessionB = await pairGateway(fixture, 'b');
  assert.equal(sessionB.status, 200);

  const socket = createConnection({ host: '127.0.0.1', port: fixture.relay.proxyPort });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write([
    'POST /g/a/api/mobile/session HTTP/1.1',
    `Host: ${SHARED_HOST}`,
    'Content-Type: application/json',
    'Content-Length: 200',
    '',
    '{"token":"partial',
  ].join('\r\n'));
  socket.destroy();
  await delay(100);

  const gatewayA = fixture.gateways.get('a');
  gatewayA.truncateNextSessionResponse = true;
  const truncated = await pairGateway(fixture, 'a');
  assert.ok(truncated.status === 502 || truncated.status === 503 || truncated.status === 0,
    'a truncated local session response must fail promptly instead of hanging or caching partial credentials');
  assert.notEqual(truncated.timeout, true, 'the relay must settle the truncated upstream response');

  const surviving = await httpThroughRelay(fixture, {
    id: 'b', path: '/api/whoami', headers: { authorization: `Bearer ${sessionB.session.accessToken}` },
  });
  assert.equal(surviving.status, 200, 'Gateway B remains usable after malformed A pairing traffic');
  assert.equal(JSON.parse(surviving.body.toString('utf8')).gateway, 'b');
});

test('an aborted ordinary streamed request does not crash the Relay process', async () => {
  const relayModule = new URL('../src/server.mjs', import.meta.url).href;
  const websocketModule = new URL('../node_modules/ws/index.js', import.meta.url).href;
  const childScript = `
    import { IncomingMessage } from 'node:http';
    import { createConnection } from 'node:net';
    import { startRelay } from ${JSON.stringify(relayModule)};
    import WebSocket from ${JSON.stringify(websocketModule)};
    const originalEmit = IncomingMessage.prototype.emit;
    IncomingMessage.prototype.emit = function (event, ...args) {
      if (event === 'error' && this.url === '/g/a/not-api') console.log('INCOMING_ERROR_EMITTED:' + (args[0]?.code || 'unknown'));
      return originalEmit.call(this, event, ...args);
    };
    const secret = 'relay-secret-for-abort-test-0123456789';
    const pairingToken = 'pairing-token-for-abort-test-0123456789';
    const relay = await startRelay({
      gateways: [{ id: 'a', secret, pairingToken, maxConnections: 4, maxBytesPerWindow: 2_000_000, trafficWindowMs: 60_000 }],
      sharedHosts: [${JSON.stringify(SHARED_HOST)}], controlPort: 0, proxyPort: 0, connectTimeout: 1_000,
    });
    const control = new WebSocket('ws://127.0.0.1:' + relay.controlPort + '/_relay/control', {
      headers: { authorization: 'Bearer ' + secret, 'x-kcoder-gateway-id': 'a' },
    });
    control.on('error', () => {});
    await new Promise((resolve, reject) => {
      control.once('open', resolve);
      control.once('unexpected-response', (_request, response) => reject(new Error('control rejected: ' + response.statusCode)));
    });
    const openRequest = new Promise(resolve => control.once('message', raw => resolve(JSON.parse(raw.toString()))));
    const attack = createConnection({ host: '127.0.0.1', port: relay.proxyPort });
    attack.on('error', () => {});
    attack.once('connect', () => {
      attack.write('POST /g/a/not-api HTTP/1.1\\r\\nHost: ${SHARED_HOST}\\r\\nContent-Length: 200\\r\\n\\r\\npartial');
    });
    const open = await Promise.race([openRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Relay did not reserve the request')), 1_000))]);
    if (open?.type !== 'open') throw new Error('unexpected control message');
    attack.destroy();
    setTimeout(async () => {
      console.log('RELAY_SURVIVED_ABORT');
      attack.destroy();
      control.terminate();
      await relay.close();
    }, 250);
  `;

  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exit = await withTimeout(new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))), 4_000, 'Relay subprocess hung after an aborted request');
  assert.deepEqual(exit, { code: 0, signal: null }, `Relay exited unexpectedly after request abort: ${stderr}`);
  assert.match(stdout, /INCOMING_ERROR_EMITTED:ECONNRESET/, 'the attack must exercise the request error path');
  assert.match(stdout, /RELAY_SURVIVED_ABORT/);
});

test('unauthenticated pairing body reads share tenant connection capacity, time out, and release their reservation', async t => {
  const fixture = await startFixture(t, { maxConnectionsA: 1, pairingBodyTimeoutMs: 400 });
  const sessionA = await pairGateway(fixture, 'a');
  const sessionB = await pairGateway(fixture, 'b');
  assert.equal(sessionA.status, 200);
  assert.equal(sessionB.status, 200);

  const rpcA = await openRpc(fixture, 'a', sessionA.session);
  assert.equal(rpcA.status, 101);
  const rpcAClosed = once(rpcA.socket, 'close');
  const deniedWhileActive = await pairGateway(fixture, 'a');
  assert.equal(deniedWhileActive.status, 429, 'an active A RPC consumes the same connection budget as pre-auth pairing reads');
  const unaffectedB = await httpThroughRelay(fixture, {
    id: 'b', path: '/api/whoami', headers: { authorization: `Bearer ${sessionB.session.accessToken}` },
  });
  assert.equal(unaffectedB.status, 200, 'Gateway A active capacity does not block Gateway B');
  rpcA.socket.terminate();
  await withTimeout(rpcAClosed, 1_000, 'Gateway A RPC did not release its connection budget');
  // B's completed GET retains one charged idle channel. A's RPC must release
  // its own channel; the subsequent A pairing also proves A capacity was freed.
  await waitForRelayHealth(fixture, health => health.connections === 1 && health.pending === 0 &&
    fixture.gateways.get('a').dataChannels.size === 0 && fixture.gateways.get('b').dataChannels.size === 1);

  const held = createConnection({ host: '127.0.0.1', port: fixture.relay.proxyPort });
  held.on('error', () => {});
  let heldResponse = '';
  held.setEncoding('utf8').on('data', chunk => { heldResponse += chunk; });
  const heldClosed = once(held, 'close');
  await once(held, 'connect');
  held.write([
    'POST /g/a/api/mobile/session HTTP/1.1',
    `Host: ${SHARED_HOST}`,
    'Content-Type: application/json',
    'Content-Length: 65536',
    '',
    '{"token":"partial',
  ].join('\r\n'));

  const rejectedA = await pairGateway(fixture, 'a');
  assert.equal(rejectedA.status, 429, 'Gateway A cannot exceed its configured pending connection budget while body is unauthenticated');
  const survivingB = await httpThroughRelay(fixture, {
    id: 'b', path: '/api/whoami', headers: { authorization: `Bearer ${sessionB.session.accessToken}` },
  });
  assert.equal(survivingB.status, 200, 'Gateway A body reservation does not consume Gateway B capacity');

  await withTimeout(heldClosed, 1_000, 'stalled pairing body was not closed after its deadline');
  assert.match(heldResponse, /HTTP\/1\.1 408 Request Timeout/, 'the expired partial body receives a bounded timeout response');
  const recoveredA = await pairGateway(fixture, 'a');
  assert.equal(recoveredA.status, 200, 'body timeout releases Gateway A pending reservation');
});

test('an expired A access session closes its active RPC while Gateway B remains connected', async t => {
  const fixture = await startFixture(t, { expiresInA: 500 });
  const sessionA = await pairGateway(fixture, 'a');
  const sessionB = await pairGateway(fixture, 'b');
  assert.equal(sessionA.status, 200);
  assert.equal(sessionB.status, 200);

  const rpcA = await openRpc(fixture, 'a', sessionA.session);
  const rpcB = await openRpc(fixture, 'b', sessionB.session);
  assert.equal(rpcA.status, 101);
  assert.equal(rpcB.status, 101);
  assert.equal(await websocketEcho(rpcB.socket, 'before-expiry'), 'before-expiry');

  const aClosed = once(rpcA.socket, 'close').then(() => true);
  const closedInTime = await Promise.race([aClosed, delay(1_000).then(() => false)]);
  assert.equal(closedInTime, true, 'the relay must actively close session-owned RPC sockets at expiry');
  assert.equal(rpcB.socket.readyState, WebSocket.OPEN, 'Gateway B RPC must not be closed with A session expiry');
  assert.equal(await websocketEcho(rpcB.socket, 'after-expiry'), 'after-expiry');

  const expiredApi = await httpThroughRelay(fixture, {
    id: 'a', path: '/api/whoami', headers: { authorization: `Bearer ${sessionA.session.accessToken}` },
  });
  assert.equal(expiredApi.status, 401);
});

test('HTTP request streaming preserves an upload while the selected Gateway reads slowly', async t => {
  const fixture = await startFixture(t, { maxBytesA: 8 * 1024 * 1024 });
  const gatewayA = fixture.gateways.get('a');
  gatewayA.slowUploadMs = 2;
  const sessionA = await pairGateway(fixture, 'a');
  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  const response = await streamedUploadThroughRelay(fixture, {
    id: 'a', path: '/api/slow-upload', accessToken: sessionA.session.accessToken, body: payload,
  });

  assert.equal(response.status, 200, 'the streamed upload completes through a throttled downstream reader');
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), {
    bytes: payload.length,
    chunks: gatewayA.slowUploadChunks,
    sha256: createHash('sha256').update(payload).digest('hex'),
  }, 'the upstream Gateway receives the complete ordered body');
  assert.ok(gatewayA.slowUploadChunks > 1, 'the Gateway consumes multiple bounded stream chunks');
});
