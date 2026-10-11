// Black-box tests for temporary Relay registration, per-Gateway credentials,
// cached client identities, and the public path used by mobile pairing.
// Fake Gateways exercise only real loopback TCP/HTTP/WebSocket transport; they
// do not run the Rust app-server or send model traffic.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { startRelay } from '../src/server.mjs';
import { startRegisteredClient } from '../src/client.mjs';
import { readRegisteredClientId, readRegisteredClientIdentity } from '../src/client-identity.mjs';
import { buildPairingLink } from '../src/pair.mjs';

const SHARED_HOST = 'registered-relay.example';
const REGISTRATION_KEY = randomToken();

function randomToken() {
  return randomBytes(32).toString('hex');
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

async function privateHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-relay-auto-registration-'));
  await chmod(root, 0o700);
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home };
}

function relayOptions(registrationStoreFile, registrationKey = REGISTRATION_KEY, ports = {}) {
  return {
    registrationKey,
    registrationStoreFile,
    gateways: [],
    sharedHosts: [SHARED_HOST],
    controlPort: ports.controlPort ?? 0,
    proxyPort: ports.proxyPort ?? 0,
  };
}

async function startRelayFixture(t, storeFile, registrationKey = REGISTRATION_KEY, ports = {}) {
  const relay = await startRelay(relayOptions(storeFile, registrationKey, ports));
  t.after(() => relay.close());
  return relay;
}

function httpRequest({ port, path = '/_relay/register', method = 'POST', key = REGISTRATION_KEY, body, rawBody, headers = {}, timeoutMs = 2500 }) {
  const bytes = rawBody === undefined
    ? Buffer.from(JSON.stringify(body ?? {}))
    : Buffer.from(rawBody);
  const requestHeaders = {
    host: '127.0.0.1',
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    'content-length': String(bytes.length),
    connection: 'close',
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers: requestHeaders }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.once('aborted', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('error', error => reject(error));
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error(`HTTP request timed out: ${method} ${path}`)));
    outgoing.once('error', reject);
    outgoing.end(bytes);
  });
}

function register(port, enrollmentToken = randomToken(), pairingToken = randomToken(), options = {}) {
  return httpRequest({
    port,
    body: { enrollmentToken, pairingToken, ...(options.extraBody ?? {}) },
    key: options.key ?? REGISTRATION_KEY,
    timeoutMs: options.timeoutMs ?? 3000,
  });
}

function jsonBody(response) {
  try { return JSON.parse(response.body.toString('utf8')); }
  catch { throw new Error(`Expected JSON response (HTTP ${response.status}): ${response.body.toString('utf8')}`); }
}

async function registerWithRetry(port, enrollmentToken, pairingToken) {
  let response;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    response = await register(port, enrollmentToken, pairingToken);
    if (response.status !== 429) return response;
    await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)));
  }
  return response;
}

function openControl(port, gateway, { authorization = gateway.secret, gatewayId = gateway.id, path = '/_relay/control' } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: {
      authorization: `Bearer ${authorization}`,
      'x-kcoder-gateway-id': gatewayId,
      'x-kcoder-device': gatewayId,
    },
    handshakeTimeout: 1200,
  });
  socket.on('error', () => {});
  return new Promise(resolve => {
    const timer = setTimeout(() => { socket.terminate(); resolve({ status: 0, socket }); }, 1600);
    socket.once('open', () => { clearTimeout(timer); resolve({ status: 101, socket }); });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      const status = response.statusCode ?? 0;
      response.resume();
      socket.terminate();
      resolve({ status, socket });
    });
  });
}

function proxyHttp(port, { id, path = '/api/mobile/session', method = 'GET', body, authorization, timeoutMs = 2500 }) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = { host: SHARED_HOST, connection: 'close' };
  if (authorization) headers.authorization = `Bearer ${authorization}`;
  if (bytes) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(bytes.length);
  }
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: `/g/${encodeURIComponent(id)}${path.startsWith('/') ? path : `/${path}`}`,
      method,
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => finish({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('aborted', () => finish({ status: 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy());
    outgoing.once('error', () => finish({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    if (bytes) outgoing.end(bytes); else outgoing.end();
  });
}

function proxyWebSocket(port, { id, path = '/rpc', authorization, protocols }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/g/${encodeURIComponent(id)}${path}`, {
    headers: { host: SHARED_HOST, ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
    ...(protocols ? { protocol: protocols } : {}),
    handshakeTimeout: 1500,
  });
  socket.on('error', () => {});
  return new Promise(resolve => {
    const timer = setTimeout(() => { socket.terminate(); resolve({ status: 0, socket }); }, 1900);
    socket.once('open', () => { clearTimeout(timer); resolve({ status: 101, socket }); });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      const status = response.statusCode ?? 0;
      response.resume();
      socket.terminate();
      resolve({ status, socket });
    });
  });
}

function websocketMessage(socket, message, timeoutMs = 2000) {
  return withTimeout(new Promise((resolve, reject) => {
    socket.once('message', data => resolve(data.toString()));
    socket.send(message, error => { if (error) reject(error); });
  }), timeoutMs, 'WebSocket echo timed out');
}

async function truncatedHttpBody(port) {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  return new Promise(resolve => {
    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0));
    };
    const timer = setTimeout(() => { socket.destroy(); finish(); }, 1800);
    socket.on('connect', () => socket.end([
      'POST /_relay/register HTTP/1.1',
      'Host: 127.0.0.1',
      `Authorization: Bearer ${REGISTRATION_KEY}`,
      'Content-Type: application/json',
      'Content-Length: 200',
      'Connection: close',
      '',
      '',
      '{"enrollmentToken":"truncated"',
    ].join('\r\n')));
    socket.on('data', chunk => { raw += chunk.toString('latin1'); });
    socket.once('end', finish);
    socket.once('close', finish);
  });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function fakeGateway(t, name, pairingToken) {
  const state = { name, pairingToken, accessTokens: new Set(), rpcToken: randomToken(), server: null, sockets: new Set() };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://gateway.invalid');
    if (request.method === 'POST' && url.pathname === '/api/mobile/session') {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { response.writeHead(400); response.end('bad request'); return; }
      if (payload?.token !== state.pairingToken) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const accessToken = randomToken();
      state.accessTokens.add(accessToken);
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `kcoder_session=${randomToken()}; Path=/; HttpOnly`,
      });
      response.end(JSON.stringify({ accessToken, rpcToken: state.rpcToken, expiresAt: Date.now() + 60_000 }));
      return;
    }

    const accessToken = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];
    if (!accessToken || !state.accessTokens.has(accessToken)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/api/whoami') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ gateway: state.name, path: url.pathname }));
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://gateway.invalid');
    const token = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];
    if (url.pathname !== '/rpc' || !state.accessTokens.has(token) || url.searchParams.get('token') !== state.rpcToken) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, ws => websocketServer.emit('connection', ws));
  });
  websocketServer.on('connection', socket => {
    state.sockets.add(socket);
    socket.on('message', data => socket.send(`${state.name}:${data.toString()}`));
    socket.once('close', () => state.sockets.delete(socket));
  });
  state.port = await listen(server);
  state.url = `http://127.0.0.1:${state.port}`;
  state.server = server;
  state.websocketServer = websocketServer;
  t.after(async () => {
    for (const socket of websocketServer.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    websocketServer.close();
  });
  return state;
}

async function waitForOnline(options) {
  let finish;
  const online = new Promise(resolve => { finish = resolve; });
  const client = await startRegisteredClient({
    ...options,
    retryMs: 30,
    onOnline: () => {
      options.onOnline?.();
      finish();
    },
  });
  try {
    await withTimeout(online, 3500, 'registered Gateway did not connect to Relay');
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}

test('registration assigns unguessable credentials, is idempotent, persists, and caps the store at 256', async t => {
  const { home } = await privateHome(t);
  const storeFile = join(home, 'registration-store.json');
  let relay = await startRelayFixture(t, storeFile);

  const enrollmentA = randomToken();
  const pairingA = randomToken();
  const firstResponse = await register(relay.controlPort, enrollmentA, pairingA);
  assert.equal(firstResponse.status, 201);
  const first = jsonBody(firstResponse);
  assert.deepEqual(Object.keys(first).sort(), [
    'id', 'secret', 'pairingToken', 'maxConnections', 'maxBytesPerWindow', 'trafficWindowMs',
  ].sort());
  assert.equal(first.pairingToken, pairingA);
  assert.equal(typeof first.id, 'string');
  assert.equal(typeof first.secret, 'string');
  assert.ok(first.id.length >= 12, 'the Relay assigns a nontrivial independent ID');
  assert.notEqual(first.id, enrollmentA);
  assert.notEqual(first.secret, REGISTRATION_KEY);
  assert.notEqual(first.secret, pairingA);
  assert.ok(Number.isSafeInteger(first.maxConnections) && first.maxConnections > 0);

  const duplicateResponse = await register(relay.controlPort, enrollmentA, pairingA);
  assert.ok([200, 201].includes(duplicateResponse.status));
  assert.deepEqual(jsonBody(duplicateResponse), first, 'same enrollment and pairing proof restore the same credentials');
  const collision = await register(relay.controlPort, randomToken(), pairingA);
  assert.equal(collision.status, 409, 'a pairing token cannot be claimed by a second enrollment');

  const enrollmentB = randomToken();
  const pairingB = randomToken();
  const secondResponse = await register(relay.controlPort, enrollmentB, pairingB);
  assert.equal(secondResponse.status, 201);
  const second = jsonBody(secondResponse);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.secret, first.secret);

  const mode = (await stat(storeFile)).mode & 0o777;
  assert.equal(mode, 0o600, 'registration store is private');

  const controlPort = relay.controlPort;
  const proxyPort = relay.proxyPort;
  await relay.close();
  relay = await startRelayFixture(t, storeFile, REGISTRATION_KEY, { controlPort, proxyPort });
  const restoredResponse = await register(relay.controlPort, enrollmentA, pairingA);
  assert.ok([200, 201].includes(restoredResponse.status));
  assert.deepEqual(jsonBody(restoredResponse), first, 'restart preserves the assigned ID and independent secret');

  // Fill the store through the HTTP surface. Repeated enrollment proofs stay
  // sequential here so this capacity check does not measure the concurrency gate.
  for (let index = 2; index < 256; index += 1) {
    const response = await register(relay.controlPort, randomToken(), randomToken());
    assert.equal(response.status, 201, `registration ${index + 1} should fit in the 256-entry store`);
  }
  const atCapacity = await register(relay.controlPort, randomToken(), randomToken());
  assert.equal(atCapacity.status, 429, 'a 257th independent identity is rejected');
  const oldIdentityAtCapacity = await register(relay.controlPort, enrollmentA, pairingA);
  assert.ok([200, 201].includes(oldIdentityAtCapacity.status), 'an idempotent restore still succeeds at capacity');
  assert.deepEqual(jsonBody(oldIdentityAtCapacity), first);

  const fullControlPort = relay.controlPort;
  const fullProxyPort = relay.proxyPort;
  await relay.close();
  relay = await startRelayFixture(t, storeFile, REGISTRATION_KEY, { controlPort: fullControlPort, proxyPort: fullProxyPort });
  assert.equal((await register(relay.controlPort, randomToken(), randomToken())).status, 429,
    'the 256-entry capacity is preserved across a second Relay restart');
  const restoredAtCapacity = await register(relay.controlPort, enrollmentA, pairingA);
  assert.ok([200, 201].includes(restoredAtCapacity.status));
  assert.deepEqual(jsonBody(restoredAtCapacity), first);
});

test('registration rejects bad keys and malformed inputs, and concurrent independent registrations are not lost', async t => {
  const { home } = await privateHome(t);
  const relay = await startRelayFixture(t, join(home, 'store.json'));

  assert.equal((await register(relay.controlPort, randomToken(), randomToken(), { key: randomToken() })).status, 401);
  assert.equal((await register(relay.controlPort, randomToken(), randomToken(), { extraBody: { gatewayId: 'chosen-by-caller' } })).status, 400,
    'clients cannot choose their assigned Gateway ID');
  assert.equal(await truncatedHttpBody(relay.controlPort), 400, 'a prematurely ended HTTP body is rejected');
  const malformed = await httpRequest({ port: relay.controlPort, rawBody: '{not-json' });
  assert.equal(malformed.status, 400);
  const tooLarge = await httpRequest({ port: relay.controlPort, rawBody: JSON.stringify({ enrollmentToken: randomToken(), pairingToken: randomToken(), padding: 'x'.repeat(65 * 1024) }) });
  assert.equal(tooLarge.status, 413);

  const attempts = Array.from({ length: 24 }, () => ({ enrollment: randomToken(), pairing: randomToken() }));
  const responses = await Promise.all(attempts.map(pair => registerWithRetry(relay.controlPort, pair.enrollment, pair.pairing)));
  assert.ok(responses.every(response => response.status === 201), 'all unique registrations eventually finish despite the bounded in-flight limit');
  const identities = responses.map(jsonBody);
  assert.equal(new Set(identities.map(identity => identity.id)).size, attempts.length, 'concurrent registrations receive distinct IDs');
  assert.equal(new Set(identities.map(identity => identity.secret)).size, attempts.length, 'concurrent registrations receive distinct secrets');

  for (let index = 0; index < attempts.length; index += 1) {
    const repeated = await register(relay.controlPort, attempts[index].enrollment, attempts[index].pairing);
    assert.ok([200, 201].includes(repeated.status));
    assert.deepEqual(jsonBody(repeated), identities[index], `registration ${index} remains persisted after concurrent writes`);
  }
});

test('registered client rejects a registration redirect without forwarding its proof or shared key', async t => {
  const { home } = await privateHome(t);
  const redirected = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${capturePort}/capture` });
    response.end();
  });
  const captured = [];
  const captureServer = createServer((request, response) => {
    captured.push({ authorization: request.headers.authorization, body: request.body });
    request.resume();
    response.writeHead(200);
    response.end('{}');
  });
  const capturePort = await listen(captureServer);
  const redirectPort = await listen(redirected);
  t.after(async () => {
    redirected.closeAllConnections();
    captureServer.closeAllConnections();
    await Promise.all([
      new Promise(resolve => redirected.close(resolve)),
      new Promise(resolve => captureServer.close(resolve)),
    ]);
  });

  const identityFile = join(home, 'redirected.identity.json');
  await assert.rejects(startRegisteredClient({
    url: `http://127.0.0.1:${redirectPort}`,
    registrationKey: REGISTRATION_KEY,
    pairingToken: randomToken(),
    identityFile,
    gateway: 'http://127.0.0.1:4186',
    allowInsecure: true,
  }), /registration request failed/i);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(captured.length, 0, 'the redirected origin never receives the Bearer key or enrollment proof');
  const pending = JSON.parse(await readFile(identityFile, 'utf8'));
  assert.equal(typeof pending.enrollmentToken, 'string', 'the client retains its retryable enrollment proof after redirect failure');
  assert.equal(await stat(identityFile).then(value => value.mode & 0o777), 0o600);
});

test('registered client retries the same proof after network failure and a committed response is lost', async t => {
  const { home } = await privateHome(t);
  const pairingToken = randomToken();
  const gateway = await fakeGateway(t, 'retry-machine', pairingToken);
  const relay = await startRelayFixture(t, join(home, 'store.json'));
  const identityFile = join(home, 'retry-machine.identity.json');
  const options = {
    url: `http://127.0.0.1:${relay.controlPort}`,
    registrationKey: REGISTRATION_KEY,
    pairingToken,
    identityFile,
    gateway: gateway.url,
    allowInsecure: true,
  };

  let initialProof;
  await assert.rejects(startRegisteredClient({
    ...options,
    fetchImpl: async (_url, init) => {
      initialProof = JSON.parse(init.body);
      throw new Error('simulate network unavailable before registration');
    },
  }), /registration request failed/i);
  const pendingAfterNetworkFailure = JSON.parse(await readFile(identityFile, 'utf8'));
  assert.equal(pendingAfterNetworkFailure.enrollmentToken, initialProof.enrollmentToken,
    'the client saves its proof before the first network attempt and keeps it after failure');

  let repeatedProof;
  let committedResponse;
  await assert.rejects(startRegisteredClient({
    ...options,
    fetchImpl: async (url, init) => {
      repeatedProof = JSON.parse(init.body);
      const response = await fetch(url, init);
      assert.equal(response.status, 201, 'the Relay committed this identity before the simulated response loss');
      committedResponse = await response.clone().json();
      await response.body?.cancel?.().catch(() => {});
      throw new Error('simulate connection loss after Relay commit');
    },
  }), /registration request failed/i);
  assert.deepEqual(repeatedProof, initialProof, 'retry after a dropped response reuses the exact enrollment and pairing proof');
  const pendingAfterLostResponse = JSON.parse(await readFile(identityFile, 'utf8'));
  assert.equal(pendingAfterLostResponse.enrollmentToken, initialProof.enrollmentToken);

  let client;
  client = await waitForOnline(options);
  t.after(() => client?.close());
  const restored = await readRegisteredClientIdentity({ identityFile, relayUrl: options.url, pairingToken });
  assert.deepEqual(restored, { id: committedResponse.id, secret: committedResponse.secret },
    'the idempotent retry restores the Relay assignment made before the first response was lost');
});

test('registered client preserves its pending proof when local identity saving fails after Relay commit', async t => {
  const { home } = await privateHome(t);
  const pairingToken = randomToken();
  const gateway = await fakeGateway(t, 'save-retry-machine', pairingToken);
  const relay = await startRelayFixture(t, join(home, 'store.json'));
  const identityFile = join(home, 'save-retry-machine.identity.json');
  const backupFile = join(home, 'pending-proof.backup');
  const options = {
    url: `http://127.0.0.1:${relay.controlPort}`,
    registrationKey: REGISTRATION_KEY,
    pairingToken,
    identityFile,
    gateway: gateway.url,
    allowInsecure: true,
  };
  let committedResponse;
  let cameOnline = false;
  await assert.rejects(startRegisteredClient({
    ...options,
    onOnline: () => { cameOnline = true; },
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      assert.equal(response.status, 201);
      committedResponse = await response.clone().json();
      // The Relay has committed and answered. Move the pending file aside and
      // replace its path with a directory so the client's atomic save fails.
      await rename(identityFile, backupFile);
      await mkdir(identityFile, { mode: 0o700 });
      return response;
    },
  }), /identity must be a regular file/i);
  assert.equal(cameOnline, false, 'the client does not start a control connection before identity persistence succeeds');
  const savedPendingProof = JSON.parse(await readFile(backupFile, 'utf8'));
  assert.equal(typeof savedPendingProof.enrollmentToken, 'string');
  assert.equal(await stat(backupFile).then(value => value.mode & 0o777), 0o600);

  await rm(identityFile, { recursive: true, force: true });
  await rename(backupFile, identityFile);
  let client;
  client = await waitForOnline(options);
  t.after(() => client?.close());
  const restored = await readRegisteredClientIdentity({ identityFile, relayUrl: options.url, pairingToken });
  assert.deepEqual(restored, { id: committedResponse.id, secret: committedResponse.secret },
    'retry reuses the original proof and saves the credentials already assigned by the Relay');
});

test('registered Gateways isolate HTTP and WebSocket traffic, survive Relay restart and reconnect without the shared key', async t => {
  const { home } = await privateHome(t);
  const storeFile = join(home, 'registration-store.json');
  const pairingA = randomToken();
  const pairingB = randomToken();
  const gatewayA = await fakeGateway(t, 'machine-a', pairingA);
  const gatewayB = await fakeGateway(t, 'machine-b', pairingB);
  let relay = await startRelayFixture(t, storeFile);

  const identityFileA = join(home, 'machine-a.identity.json');
  const identityFileB = join(home, 'machine-b.identity.json');
  let onlineCountA = 0;
  let resolveSecondOnlineA;
  const secondOnlineA = new Promise(resolve => { resolveSecondOnlineA = resolve; });
  let clientA = await waitForOnline({
    url: `http://127.0.0.1:${relay.controlPort}`,
    registrationKey: REGISTRATION_KEY,
    pairingToken: pairingA,
    identityFile: identityFileA,
    gateway: gatewayA.url,
    allowInsecure: true,
    onOnline: () => {
      onlineCountA += 1;
      if (onlineCountA === 2) resolveSecondOnlineA();
    },
  });
  let clientB = await waitForOnline({
    url: `http://127.0.0.1:${relay.controlPort}`,
    registrationKey: REGISTRATION_KEY,
    pairingToken: pairingB,
    identityFile: identityFileB,
    gateway: gatewayB.url,
    allowInsecure: true,
  });
  t.after(() => { clientA?.close(); clientB?.close(); });

  const identityA = await readRegisteredClientIdentity({ identityFile: identityFileA, relayUrl: `http://127.0.0.1:${relay.controlPort}`, pairingToken: pairingA });
  const identityB = await readRegisteredClientIdentity({ identityFile: identityFileB, relayUrl: `http://127.0.0.1:${relay.controlPort}`, pairingToken: pairingB });
  assert.notEqual(identityA.id, identityB.id, 'each machine receives an independent ID');
  assert.notEqual(identityA.secret, identityB.secret, 'each machine receives an independent Relay secret');
  assert.equal((await stat(identityFileA)).mode & 0o777, 0o600, 'cached identity file is private');
  assert.equal((await stat(identityFileB)).mode & 0o777, 0o600, 'second cached identity file is private');

  const qrGatewayId = await readRegisteredClientId({
    identityFile: identityFileA,
    relayUrl: `http://127.0.0.1:${relay.controlPort}`,
    pairingToken: pairingA,
  });
  assert.equal(qrGatewayId, identityA.id, 'the phone pairing path resolves the assigned ID from the cached identity');
  const mobileLinkA = new URL(buildPairingLink({
    publicUrl: 'https://registered-relay.example',
    token: pairingA,
    gatewayId: qrGatewayId,
    routeMode: 'path',
    includeGatewayId: true,
  }));
  assert.equal(mobileLinkA.searchParams.get('gateway'), `https://registered-relay.example/g/${qrGatewayId}`);
  assert.equal(mobileLinkA.searchParams.get('token'), pairingA);
  assert.equal(mobileLinkA.searchParams.get('gatewayId'), qrGatewayId);
  assert.equal(mobileLinkA.searchParams.has('secret'), false, 'mobile pairing link never contains the Relay secret');

  // This is the same path and token shape the phone receives in the QR link.
  const pairedA = await proxyHttp(relay.proxyPort, {
    id: qrGatewayId,
    path: '/api/mobile/session',
    method: 'POST',
    body: { token: mobileLinkA.searchParams.get('token') },
  });
  assert.equal(pairedA.status, 200, 'the registered public path accepts phone pairing for its Gateway');
  const sessionA = JSON.parse(pairedA.body.toString('utf8'));
  assert.equal(typeof sessionA.accessToken, 'string');
  assert.equal(typeof sessionA.rpcToken, 'string');
  assert.match(String(pairedA.headers['set-cookie']), new RegExp(`Path=/g/${identityA.id}/`, 'i'));

  const pairedB = await proxyHttp(relay.proxyPort, {
    id: identityB.id,
    path: '/api/mobile/session',
    method: 'POST',
    body: { token: pairingB },
  });
  assert.equal(pairedB.status, 200);
  const sessionB = JSON.parse(pairedB.body.toString('utf8'));

  const httpA = await proxyHttp(relay.proxyPort, { id: identityA.id, path: '/api/whoami', authorization: sessionA.accessToken });
  const httpB = await proxyHttp(relay.proxyPort, { id: identityB.id, path: '/api/whoami', authorization: sessionB.accessToken });
  assert.equal(JSON.parse(httpA.body.toString('utf8')).gateway, 'machine-a');
  assert.equal(JSON.parse(httpB.body.toString('utf8')).gateway, 'machine-b');
  const crossedHttp = await proxyHttp(relay.proxyPort, { id: identityB.id, path: '/api/whoami', authorization: sessionA.accessToken });
  assert.equal(crossedHttp.status, 401, 'one Gateway mobile credential cannot access the other Gateway API');
  const sharedKeyApi = await proxyHttp(relay.proxyPort, { id: identityB.id, path: '/api/whoami', authorization: REGISTRATION_KEY });
  assert.equal(sharedKeyApi.status, 401, 'the registration key is not a data/API credential');
  const sharedKeyPairing = await proxyHttp(relay.proxyPort, {
    id: identityB.id,
    path: '/api/mobile/session',
    method: 'POST',
    body: { token: REGISTRATION_KEY },
  });
  assert.equal(sharedKeyPairing.status, 401, 'the registration key is not a mobile pairing token');

  const wsA = await proxyWebSocket(relay.proxyPort, {
    id: identityA.id,
    path: `/rpc?token=${encodeURIComponent(sessionA.rpcToken)}`,
    authorization: sessionA.accessToken,
  });
  const wsB = await proxyWebSocket(relay.proxyPort, {
    id: identityB.id,
    path: `/rpc?token=${encodeURIComponent(sessionB.rpcToken)}`,
    authorization: sessionB.accessToken,
  });
  assert.equal(wsA.status, 101);
  assert.equal(wsB.status, 101);
  assert.equal(await websocketMessage(wsA.socket, 'first'), 'machine-a:first');
  assert.equal(await websocketMessage(wsB.socket, 'second'), 'machine-b:second');
  const crossedWs = await proxyWebSocket(relay.proxyPort, {
    id: identityB.id,
    path: `/rpc?token=${encodeURIComponent(sessionA.rpcToken)}`,
    authorization: sessionA.accessToken,
  });
  assert.ok(crossedWs.status >= 400, 'a Gateway A session cannot open Gateway B WebSocket RPC');
  wsA.socket.terminate();
  wsB.socket.terminate();

  // A caller with only the shared registration key cannot impersonate an
  // assigned ID on the control channel or ask the API to choose one.
  const sharedKeyControl = await openControl(relay.controlPort, identityB, { authorization: REGISTRATION_KEY });
  assert.equal(sharedKeyControl.status, 401);
  const sharedKeyData = await openControl(relay.controlPort, identityB, {
    authorization: REGISTRATION_KEY,
    path: '/_relay/data?id=000000000000000000000000000000000000000000000000',
  });
  assert.equal(sharedKeyData.status, 401, 'the shared registration key cannot open a Gateway data socket');
  const chooseId = await register(relay.controlPort, randomToken(), randomToken(), { extraBody: { gatewayId: identityB.id } });
  assert.equal(chooseId.status, 400);
  const lookupSecret = await httpRequest({ port: relay.controlPort, path: `/_relay/register/${identityB.id}`, method: 'GET' });
  assert.ok(lookupSecret.status >= 400, 'the registration endpoint has no shared-key credential lookup route');

  const controlPort = relay.controlPort;
  const proxyPort = relay.proxyPort;
  const clientIdentityBeforeRestart = await readFile(identityFileA);
  assert.equal(onlineCountA, 1);
  clientB.close();
  clientB = null;
  await relay.close();
  relay = await startRelayFixture(t, storeFile, randomToken(), { controlPort, proxyPort });

  // Removing the shared key still permits a cached identity to reconnect.
  // Gateway A stays alive and retries after the Relay closes its control
  // socket; Gateway B starts from disk without any registration key.
  await withTimeout(secondOnlineA, 3500, 'Gateway A did not reconnect after losing the Relay connection');
  clientB = await waitForOnline({
    url: `http://127.0.0.1:${relay.controlPort}`,
    identityFile: identityFileB,
    gateway: gatewayB.url,
    allowInsecure: true,
  });
  assert.deepEqual(await readFile(identityFileA), clientIdentityBeforeRestart, 'cached reconnect does not rewrite or replace the assigned identity');
  assert.deepEqual(await readRegisteredClientIdentity({ identityFile: identityFileA, relayUrl: `http://127.0.0.1:${relay.controlPort}`, pairingToken: pairingA }), identityA);
  assert.deepEqual(await readRegisteredClientIdentity({ identityFile: identityFileB, relayUrl: `http://127.0.0.1:${relay.controlPort}`, pairingToken: pairingB }), identityB);
  const afterRestartA = await proxyHttp(relay.proxyPort, { id: identityA.id, path: '/api/whoami', authorization: sessionA.accessToken });
  const afterRestartB = await proxyHttp(relay.proxyPort, { id: identityB.id, path: '/api/whoami', authorization: sessionB.accessToken });
  // A fresh Relay has no in-memory mobile sessions, so pairing again proves
  // old independent client credentials still authorize control/data transport.
  assert.equal(afterRestartA.status, 401);
  assert.equal(afterRestartB.status, 401);
  const repairedA = await proxyHttp(relay.proxyPort, { id: identityA.id, path: '/api/mobile/session', method: 'POST', body: { token: pairingA } });
  const repairedB = await proxyHttp(relay.proxyPort, { id: identityB.id, path: '/api/mobile/session', method: 'POST', body: { token: pairingB } });
  assert.equal(repairedA.status, 200);
  assert.equal(repairedB.status, 200);
  assert.equal((await register(relay.controlPort, randomToken(), randomToken(), { key: REGISTRATION_KEY })).status, 401,
    'rotating the shared registration key does not restore the previous registration credential');
  const renewedSessionA = JSON.parse(repairedA.body.toString('utf8'));
  const renewedWsA = await proxyWebSocket(relay.proxyPort, {
    id: identityA.id,
    path: `/rpc?token=${encodeURIComponent(renewedSessionA.rpcToken)}`,
    authorization: renewedSessionA.accessToken,
  });
  assert.equal(renewedWsA.status, 101, 'the old independent Relay secret still carries new WebSocket data after key rotation');
  assert.equal(await websocketMessage(renewedWsA.socket, 'after-key-rotation'), 'machine-a:after-key-rotation');
  renewedWsA.socket.terminate();
});

test('registration body readers are bounded, time out, and release slots after disconnect', async t => {
  const { home } = await privateHome(t);
  const relay = await startRelayFixture(t, join(home, 'store.json'));
  const sockets = new Set();
  t.after(() => { for (const socket of sockets) socket.destroy(); });

  const makePartial = () => {
    const socket = createConnection({ host: '127.0.0.1', port: relay.controlPort });
    socket.on('error', () => {});
    sockets.add(socket);
    return new Promise((resolve, reject) => {
      let data = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('partial registration did not time out')); }, 6500);
      socket.on('connect', () => socket.write([
        'POST /_relay/register HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${REGISTRATION_KEY}`,
        'Content-Type: application/json',
        'Content-Length: 256',
        'Connection: close',
        '',
        '',
      ].join('\r\n') + '{"enrollmentToken":"partial"'));
      socket.on('data', chunk => { data += chunk.toString('latin1'); });
      socket.once('end', () => {
        clearTimeout(timer);
        const status = /^HTTP\/1\.1 (\d+)/.exec(data)?.[1];
        resolve(Number(status ?? 0));
      });
      socket.once('close', () => {
        if (data && !/^HTTP\/1\.1/.test(data)) return;
        if (!data) { clearTimeout(timer); reject(new Error('registration socket closed without an HTTP response')); }
      });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
  };

  const timedOut = makePartial();
  const started = Date.now();
  assert.equal(await timedOut, 408, 'a partial registration body reaches the fixed read deadline');
  assert.ok(Date.now() - started >= 4500 && Date.now() - started < 6500, 'the partial body is closed near the bounded five-second deadline');
  assert.equal((await register(relay.controlPort)).status, 201, 'the timed-out reader releases capacity');

  // Hold the body open for each of the eight permitted readers. A ninth valid
  // request is rejected promptly, then aborting the readers frees the slots.
  const held = [];
  for (let index = 0; index < 8; index += 1) {
    const socket = createConnection({ host: '127.0.0.1', port: relay.controlPort });
    socket.on('error', () => {});
    sockets.add(socket);
    held.push(socket);
    await once(socket, 'connect');
    socket.write([
      'POST /_relay/register HTTP/1.1',
      'Host: 127.0.0.1',
      `Authorization: Bearer ${REGISTRATION_KEY}`,
      'Content-Type: application/json',
      'Content-Length: 256',
      'Connection: close',
      '',
      '',
    ].join('\r\n') + `{"enrollmentToken":"held-${index}"`);
  }
  await new Promise(resolve => setTimeout(resolve, 40));
  const overLimit = await register(relay.controlPort, randomToken(), randomToken());
  assert.equal(overLimit.status, 429, 'the ninth concurrent body reader is rejected');
  for (const socket of held) socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 50));
  const afterAbort = await register(relay.controlPort, randomToken(), randomToken());
  assert.equal(afterAbort.status, 201, 'aborted requests release every reserved registration slot');
});
