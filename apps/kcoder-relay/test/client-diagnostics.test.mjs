// Only loopback fixtures. No public Relay, product Gateway, model or session.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { startClient, startRegisteredClient } from '../src/client.mjs';

const gatewayId = 'diagnostic-fixture-gateway';
const secret = 'fixture-control-secret-0123456789-abcdefghijklmnop';
const pairingToken = 'fixture-pairing-token-0123456789-abcdefghijklmnop';
const registrationKey = 'fixture-register-key-0123456789-abcdefghijklmnop';
const channelId = 'a'.repeat(48);
const correlation = createHash('sha256').update(channelId).digest('hex');
const body = 'fixture-body-MUST-NOT-BE-IN-DIAGNOSTICS';

async function eventually(predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`loopback fixture timed out: ${label}`);
}

function trackConnections(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

async function fixture(t, { mode = 'success', registered = false, onDiagnostic } = {}) {
  const events = [];
  const responses = [];
  const dataStreams = new Set();
  let client, control;
  let registrationRequests = 0;
  let localRequests = 0;
  const gateway = createServer((_request, response) => {
    localRequests += 1;
    response.writeHead(200, { 'content-length': Buffer.byteLength(body), connection: 'close' });
    response.end(body);
  });
  const gatewayConnections = trackConnections(gateway);
  const server = createServer((request, response) => {
    if (registered && request.url === '/_relay/register') {
      registrationRequests += 1;
      request.resume();
      response.writeHead(201, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ id: gatewayId, secret, pairingToken, maxConnections: 128, maxBytesPerWindow: 1024 * 1024, trafficWindowMs: 60_000 }));
    } else {
      response.writeHead(404, { connection: 'close' });
      response.end();
    }
  });
  const relayConnections = trackConnections(server);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const identityDirectory = registered ? await mkdtemp(join(tmpdir(), 'kc-relay-diagnostics-')) : null;
  t.after(async () => {
    client?.close();
    for (const ws of wss.clients) ws.terminate();
    for (const stream of dataStreams) stream.destroy();
    server.closeAllConnections();
    gateway.closeAllConnections();
    await eventually(() => relayConnections.size === 0 && gatewayConnections.size === 0, 'all owned TCP sockets closed');
    if (gateway.listening) await new Promise(resolve => gateway.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => wss.close(resolve));
    if (identityDirectory) await rm(identityDirectory, { recursive: true, force: true });
    assert.equal(wss.clients.size, 0);
    assert.equal(dataStreams.size, 0);
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/_relay/data' && mode === 'handshake404') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      ws.on('error', () => {});
      if (url.pathname === '/_relay/control') {
        control = ws;
      } else {
        const stream = createWebSocketStream(ws);
        dataStreams.add(stream);
        stream.once('close', () => dataStreams.delete(stream));
        stream.on('error', () => {});
        stream.on('data', chunk => responses.push(chunk));
        stream.write('GET /fixture HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n');
      }
    });
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const gatewayPort = gateway.address().port;
  if (mode === 'refused') await new Promise(resolve => gateway.close(resolve));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let resolveOnline;
  const online = new Promise(resolve => { resolveOnline = resolve; });
  const common = {
    url,
    gateway: `http://127.0.0.1:${gatewayPort}`,
    allowInsecure: true,
    onOnline: resolveOnline,
    // Leave all production timeouts/retries at their unchanged defaults.
    onDiagnostic: onDiagnostic === false ? undefined : record => {
      events.push(record);
      onDiagnostic?.(record);
    },
  };
  client = registered
    ? await startRegisteredClient({ ...common, registrationKey, pairingToken, identityFile: join(identityDirectory, 'identity.json') })
    : startClient({ ...common, secret, gatewayId });
  let onlineReady = false;
  online.then(() => { onlineReady = true; });
  await eventually(() => onlineReady && control !== undefined, 'control open');
  control.send(JSON.stringify({ type: 'open', id: channelId, gatewayId }));
  return {
    events,
    response: () => Buffer.concat(responses).toString(),
    registrationRequests: () => registrationRequests,
    localRequests: () => localRequests,
    close: () => client.close(),
  };
}

function checkSafeRecords(events) {
  const keys = new Set(['event', 'generation', 'atUnixMs', 'monotonicMs', 'correlation', 'errorKind', 'handshakeStatus', 'closeCode', 'hadError', 'rejectReason']);
  const allowedEvents = new Set(['control_connecting', 'control_open', 'control_error', 'control_close', 'reconnect_scheduled', 'open_received', 'open_rejected', 'data_connecting', 'data_open', 'data_error', 'data_close', 'local_connecting', 'local_connect', 'local_error', 'local_timeout', 'local_close', 'bridge_closed', 'client_stopped']);
  for (const event of events) {
    assert.ok(allowedEvents.has(event.event));
    assert.equal(event.generation, 1);
    assert.ok(Number.isFinite(event.atUnixMs) && Number.isFinite(event.monotonicMs));
    for (const [key, value] of Object.entries(event)) {
      assert.ok(keys.has(key), `unexpected diagnostic key ${key}`);
      assert.ok(['string', 'number', 'boolean'].includes(typeof value));
    }
    if (event.correlation !== undefined) assert.equal(event.correlation, correlation);
  }
  const text = JSON.stringify(events);
  for (const forbidden of [channelId, gatewayId, secret, pairingToken, registrationKey, body, 'http://', 'ws://', '/_relay/']) {
    assert.ok(!text.includes(forbidden), 'diagnostics must not contain identities, credentials, URL or payload');
  }
}

test('invalid diagnostic observer rejects before registration or identity storage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kc-relay-invalid-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityDirectory = join(root, 'not-created');
  const identityFile = join(identityDirectory, 'identity.json');
  let fetchCalls = 0;
  await assert.rejects(startRegisteredClient({
    url: 'http://127.0.0.1:1',
    allowInsecure: true,
    registrationKey,
    pairingToken,
    identityFile,
    onDiagnostic: {},
    fetchImpl: async () => { fetchCalls += 1; throw new Error('registration must not run'); },
  }), /^Error: onDiagnostic must be a function$/);
  assert.equal(fetchCalls, 0);
  await assert.rejects(lstat(identityDirectory), { code: 'ENOENT' });
  await assert.rejects(lstat(identityFile), { code: 'ENOENT' });
});

test('diagnostic registered client observes real control/data/TCP chain without sensitive output', async t => {
  const f = await fixture(t, { registered: true });
  await eventually(() => f.response().endsWith(body), 'actual loopback HTTP body');
  await eventually(() => f.events.some(event => event.event === 'local_close') && f.events.some(event => event.event === 'data_close'), 'normal transport cleanup');
  assert.match(f.response(), /^HTTP\/1\.1 200 /);
  assert.equal(f.registrationRequests(), 1);
  assert.equal(f.localRequests(), 1);
  const ordering = ['control_connecting', 'control_open', 'open_received', 'data_connecting', 'data_open', 'local_connecting', 'local_connect'];
  let previous = -1;
  for (const name of ordering) {
    const index = f.events.findIndex(event => event.event === name);
    assert.ok(index > previous, `${name} must follow its actual prerequisite`);
    previous = index;
  }
  assert.ok(f.events.some(event => event.event === 'bridge_closed'));
  f.close();
  checkSafeRecords(f.events);
});

test('diagnostic data handshake 404 keeps default abort behavior and never opens local TCP', async t => {
  const f = await fixture(t, { mode: 'handshake404' });
  await eventually(() => f.events.some(event => event.event === 'data_close'), 'failed handshake closed');
  const error = f.events.find(event => event.event === 'data_error');
  assert.equal(error.errorKind, 'handshake_status');
  assert.equal(error.handshakeStatus, 404);
  assert.ok(!f.events.some(event => event.event === 'data_open' || event.event.startsWith('local_')));
  assert.equal(f.localRequests(), 0);
  assert.equal(f.response(), '');
  checkSafeRecords(f.events);
});

test('diagnostic local TCP refusal reports bounded error and closes its existing bridge', async t => {
  const f = await fixture(t, { mode: 'refused' });
  await eventually(() => f.events.some(event => event.event === 'local_close') && f.events.some(event => event.event === 'data_close'), 'refused connection cleanup');
  assert.ok(f.events.some(event => event.event === 'data_open'));
  assert.equal(f.events.find(event => event.event === 'local_error').errorKind, 'refused');
  assert.equal(f.events.find(event => event.event === 'local_close').hadError, true);
  assert.ok(f.events.some(event => event.event === 'bridge_closed'));
  assert.equal(f.events.filter(event => event.event === 'open_received').length, 1);
  assert.equal(f.localRequests(), 0);
  assert.equal(f.response(), '');
  checkSafeRecords(f.events);
});

test('throwing observer and absent observer preserve legacy forwarding and cleanup', async t => {
  for (const onDiagnostic of [() => { throw new Error('observer-only failure'); }, false]) {
    const f = await fixture(t, { onDiagnostic });
    await eventually(() => f.response().endsWith(body), 'legacy API body despite observer behavior');
    assert.equal(f.localRequests(), 1);
    if (onDiagnostic === false) assert.deepEqual(f.events, []);
    else checkSafeRecords(f.events);
    f.close();
  }
});
