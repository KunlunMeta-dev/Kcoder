// Shared-origin Mobile static requests may reopen one data tunnel before any
// Gateway bytes are sent. These tests use the production multi-Gateway Relay.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import WebSocket from 'ws';
import { startRelay } from '../src/server.mjs';
import { bridge } from '../src/transport.mjs';
import { isolatedGatewayAuthority } from '../src/gateway-origin.mjs';

const GATEWAY_ID = 'mobile-static-retry';
const SHARED_HOST = 'relay.example';
// Gateway traffic uses its isolated origin; the shared root only redirects.
const GATEWAY_HOST = isolatedGatewayAuthority(SHARED_HOST, GATEWAY_ID);
const ASSET = gzipSync(Buffer.from('export const p2pStaticRetryFixture = true;\n'));
const ASSET_ETAG = '"mobile-static-retry-gzip"';

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startFixture(t, { connectTimeout = 180 } = {}) {
  const secret = randomBytes(32).toString('hex');
  const gatewaySecret = randomBytes(32).toString('hex');
  const state = { methods: [], gatewayBytes: 0, truncateNextResponse: false, truncatedSocket: null };
  const gateway = createServer((request, response) => {
    state.methods.push(request.method);
    request.resume();
    request.once('end', () => {
      response.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(ASSET.length),
        etag: ASSET_ETAG,
        'cache-control': 'public, max-age=60',
      });
      if (state.truncateNextResponse) {
        state.truncateNextResponse = false;
        response.flushHeaders();
        response.write(ASSET.subarray(0, Math.max(1, Math.floor(ASSET.length / 2))));
        const socket = response.socket;
        state.truncatedSocket = socket;
        socket.once('close', () => {
          if (state.truncatedSocket === socket) state.truncatedSocket = null;
        });
        return;
      }
      response.end(request.method === 'HEAD' ? undefined : ASSET);
    });
  });
  gateway.on('connection', socket => {
    socket.on('data', chunk => { state.gatewayBytes += chunk.length; });
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');

  const fixture = {
    relay: null,
    gateway,
    gatewayPort: gateway.address().port,
    control: null,
    secret,
    gatewaySecret,
    state,
    opens: [],
    dataSockets: new Set(),
    publicSockets: new Set(),
    localSockets: new Set(),
    clientSockets: new Set(),
    connectTimeout,
    openWaiters: new Map(),
    waitForOpen(index) {
      if (this.opens[index - 1]) return Promise.resolve(this.opens[index - 1]);
      return withTimeout(new Promise(resolve => this.openWaiters.set(index, resolve)), 3000,
        `Relay did not issue data open ${index}`).finally(() => this.openWaiters.delete(index));
    },
  };

  t.after(async () => {
    for (const ws of fixture.dataSockets) ws.terminate();
    for (const ws of fixture.publicSockets) ws.terminate();
    for (const socket of fixture.clientSockets) socket.destroy();
    for (const socket of fixture.localSockets) socket.destroy();
    fixture.control?.terminate();
    if (fixture.relay) await fixture.relay.close();
    gateway.closeAllConnections?.();
    if (gateway.listening) await new Promise(resolve => gateway.close(resolve));
  });

  fixture.relay = await startRelay({
    gateways: [{
      id: GATEWAY_ID,
      secret,
      gatewaySecret,
      maxConnections: 8,
      maxBytesPerWindow: 8 * 1024 * 1024,
      trafficWindowMs: 60_000,
    }],
    sharedHosts: [SHARED_HOST],
    controlPort: 0,
    proxyPort: 0,
    connectTimeout,
  });

  const observeControl = control => {
    control.on('error', () => {});
    control.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type !== 'open' || typeof message.id !== 'string') return;
      fixture.opens.push(message);
      fixture.openWaiters.get(fixture.opens.length)?.(message);
    });
    return control;
  };
  fixture.openControl = async () => {
    const control = observeControl(new WebSocket(`ws://127.0.0.1:${fixture.relay.controlPort}/_relay/control`, {
      headers: {
        authorization: `Bearer ${fixture.secret}`,
        'x-kcoder-device': GATEWAY_ID,
        'x-kcoder-gateway-id': GATEWAY_ID,
      },
    }));
    fixture.control = control;
    await withTimeout(once(control, 'open'), 2000, 'multi-Gateway control did not open');
    return control;
  };
  await fixture.openControl();

  return fixture;
}

function beginPublicRequest(fixture, { path, method = 'GET', headers = {}, body, onData = () => {} } = {}) {
  let finish;
  let settled = false;
  const outcome = new Promise(resolve => { finish = resolve; });
  const settle = value => {
    if (settled) return;
    settled = true;
    finish(value);
  };
  const request = httpRequest({
    hostname: '127.0.0.1',
    port: fixture.relay.proxyPort,
    method,
    path: `/g/${GATEWAY_ID}${path}`,
    headers: { host: GATEWAY_HOST, ...headers },
  }, response => {
    const chunks = [];
    response.on('data', chunk => {
      chunks.push(Buffer.from(chunk));
      onData(chunk, response);
    });
    response.once('end', () => settle({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks),
      complete: response.complete,
    }));
    response.once('aborted', () => settle({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks),
      complete: false,
    }));
    response.once('error', () => settle({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks),
      complete: false,
    }));
    response.once('close', () => {
      if (!settled) settle({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        complete: response.complete,
      });
    });
  });
  request.on('socket', socket => fixture.clientSockets.add(socket));
  request.on('error', error => settle({ status: 0, errorCode: error.code ?? null, body: Buffer.alloc(0), complete: false }));
  if (body === undefined) request.end();
  else request.end(body);
  return { request, outcome };
}

function openDataSocket(fixture, id, { bridgeSocket } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${fixture.relay.controlPort}/_relay/data?id=${id}`, {
    headers: {
      authorization: `Bearer ${fixture.secret}`,
      'x-kcoder-device': GATEWAY_ID,
      'x-kcoder-gateway-id': GATEWAY_ID,
    },
    handshakeTimeout: 1500,
  });
  fixture.dataSockets.add(ws);
  ws.on('error', () => {});
  if (bridgeSocket) bridge(bridgeSocket, ws);
  return withTimeout(new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.once('open', () => finish({ status: 101, ws }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      finish({ status: response.statusCode, ws: null });
    });
    ws.once('error', error => finish({ status: 0, error, ws: null }));
  }), 2000, 'data WebSocket handshake did not settle');
}

async function attachData(fixture, id) {
  const socket = connect(fixture.gatewayPort, '127.0.0.1');
  fixture.localSockets.add(socket);
  socket.on('error', () => {});
  await withTimeout(once(socket, 'connect'), 1500, 'Gateway loopback connection did not open');
  const result = await openDataSocket(fixture, id, { bridgeSocket: socket });
  assert.equal(result.status, 101, 'current pending data ID upgrades');
  return result.ws;
}

async function waitForHealth(fixture, predicate, message) {
  const deadline = Date.now() + 2000;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${fixture.relay.controlPort}/_relay/health`);
    last = await response.json();
    if (predicate(last)) return last;
    await delay(10);
  }
  assert.fail(`${message}; last health=${JSON.stringify(last)}`);
}

async function assertUnknownDataId(fixture, id) {
  const result = await openDataSocket(fixture, id);
  assert.equal(result.status, 404, 'expired or cancelled pending IDs cannot attach late');
}

function openPublicWebSocket(fixture, path) {
  const ws = new WebSocket(`ws://127.0.0.1:${fixture.relay.proxyPort}/g/${GATEWAY_ID}${path}`, {
    headers: { host: GATEWAY_HOST },
    handshakeTimeout: 2000,
  });
  fixture.publicSockets.add(ws);
  ws.on('error', () => {});
  const outcome = new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.once('open', () => finish({ status: 101, ws }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      finish({ status: response.statusCode, ws: null });
    });
    ws.once('error', () => finish({ status: 0, ws: null }));
  });
  return { ws, outcome };
}

test('shared Mobile static GET retries one unattached Relay open and preserves gzip GET/HEAD bytes', async t => {
  const fixture = await startFixture(t, { connectTimeout: 260 });
  const get = beginPublicRequest(fixture, { path: '/mobile/assets/entry.js' });
  const first = await fixture.waitForOpen(1);
  const second = await fixture.waitForOpen(2);
  assert.notEqual(first.id, second.id, 'each attempt uses a new pending ID');
  assert.deepEqual(fixture.state.methods, [], 'the unattached first open sent no HTTP request to the Gateway');
  assert.equal(fixture.state.gatewayBytes, 0, 'the Gateway has received no request bytes before a data channel attaches');
  assert.equal((await waitForHealth(fixture, value => value.pending === 1, 'second pending open was not registered')).pending, 1);
  await assertUnknownDataId(fixture, first.id);
  await attachData(fixture, second.id);

  const getResponse = await withTimeout(get.outcome, 2500, 'retried static GET did not complete');
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.complete, true);
  assert.equal(getResponse.headers['content-encoding'], 'gzip');
  assert.equal(Number(getResponse.headers['content-length']), ASSET.length);
  assert.deepEqual(getResponse.body, ASSET, 'Relay forwards the original compressed representation unchanged');
  assert.ok(fixture.state.gatewayBytes > 0, 'the Gateway receives the request after the replacement data channel attaches');
  assert.deepEqual(fixture.state.methods, ['GET'], 'the same ClientRequest reaches the Gateway once');

  const head = beginPublicRequest(fixture, { path: '/mobile/assets/entry.js', method: 'HEAD' });
  const third = await fixture.waitForOpen(3);
  const fourth = await fixture.waitForOpen(4);
  assert.notEqual(third.id, fourth.id, 'HEAD retry uses a new pending ID');
  assert.deepEqual(fixture.state.methods, ['GET'], 'HEAD has not reached the Gateway before retry attachment');
  await assertUnknownDataId(fixture, third.id);
  await attachData(fixture, fourth.id);
  const headResponse = await withTimeout(head.outcome, 2000, 'static HEAD did not complete');
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers['content-encoding'], 'gzip');
  assert.equal(Number(headResponse.headers['content-length']), ASSET.length);
  assert.equal(headResponse.body.length, 0, 'HEAD keeps the original representation length without a body');
  assert.deepEqual(fixture.state.methods, ['GET', 'HEAD']);
});

test('two lost shared Mobile static opens end as exact 504 and both IDs stay expired', async t => {
  const fixture = await startFixture(t, { connectTimeout: 120 });
  const request = beginPublicRequest(fixture, { path: '/mobile/assets/lost.js' });
  const first = await fixture.waitForOpen(1);
  const second = await fixture.waitForOpen(2);
  assert.notEqual(first.id, second.id);

  const response = await withTimeout(request.outcome, 1500, 'two lost opens did not return a response');
  assert.equal(response.status, 504);
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(response.headers['content-length'], '16');
  assert.equal(response.body.toString('utf8'), 'Gateway Timeout\n');
  assert.equal(fixture.opens.length, 2, 'the Relay creates exactly two pending opens');
  assert.equal((await waitForHealth(fixture, value => value.pending === 0, 'timed-out opens leaked pending entries')).pending, 0);
  await assertUnknownDataId(fixture, first.id);
  await assertUnknownDataId(fixture, second.id);
});

test('P2P API GET, static POST, pairing and refresh POST, and WebSocket do not use static retry', async t => {
  const fixture = await startFixture(t, { connectTimeout: 130 });

  const attempts = [
    {
      name: 'P2P API GET',
      start: () => beginPublicRequest(fixture, { path: '/api/mobile/p2p' }),
      outcome: request => request.outcome,
    },
    {
      name: 'static POST',
      start: () => beginPublicRequest(fixture, {
        path: '/mobile/assets/upload.bin',
        method: 'POST',
        headers: { 'content-length': '3' },
        body: 'abc',
      }),
      outcome: request => request.outcome,
    },
    {
      name: 'pairing POST',
      start: () => beginPublicRequest(fixture, {
        path: '/api/mobile/session',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: fixture.gatewaySecret }),
      }),
      outcome: request => request.outcome,
    },
    {
      name: 'refresh POST',
      start: () => beginPublicRequest(fixture, {
        path: '/api/mobile/session/refresh',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'a'.repeat(64), rotationId: 'fixture-rotation-id-0001' }),
      }),
      outcome: request => request.outcome,
    },
  ];

  let openIndex = 0;
  for (const attempt of attempts) {
    const request = attempt.start();
    await fixture.waitForOpen(++openIndex);
    const response = await withTimeout(attempt.outcome(request), 1500, `${attempt.name} did not settle`);
    assert.equal(response.status, 504, `${attempt.name} should return its single-attempt timeout`);
    assert.equal(fixture.opens.length, openIndex, `${attempt.name} uses one pending open`);
  }

  const ws = openPublicWebSocket(fixture, '/mobile/live');
  await fixture.waitForOpen(++openIndex);
  const wsResponse = await withTimeout(ws.outcome, 1500, 'WebSocket upgrade did not settle');
  assert.equal(wsResponse.status, 504);
  assert.equal(fixture.opens.length, openIndex, 'WebSocket upgrade uses its existing single attempt');
  assert.equal((await waitForHealth(fixture, value => value.pending === 0, 'non-retried requests leaked pending entries')).pending, 0);
});

test('browser aborts on either pending attempt cancel the owned open without retry or leaks', async t => {
  const fixture = await startFixture(t, { connectTimeout: 200 });

  const firstRequest = beginPublicRequest(fixture, { path: '/mobile/assets/abort-first.js' });
  const first = await fixture.waitForOpen(1);
  firstRequest.request.destroy();
  await withTimeout(firstRequest.outcome, 1000, 'first-attempt abort did not settle');
  await waitForHealth(fixture, value => value.pending === 0, 'first-attempt abort left a pending open');
  await delay(fixture.connectTimeout * 1.2);
  assert.equal(fixture.opens.length, 1, 'aborting attempt one prevents its scheduled retry');
  await assertUnknownDataId(fixture, first.id);

  const secondRequest = beginPublicRequest(fixture, { path: '/mobile/assets/abort-second.js' });
  const secondAttempt = await fixture.waitForOpen(2);
  const thirdAttempt = await fixture.waitForOpen(3);
  secondRequest.request.destroy();
  await withTimeout(secondRequest.outcome, 1000, 'second-attempt abort did not settle');
  await waitForHealth(fixture, value => value.pending === 0, 'second-attempt abort left a pending open');
  await delay(fixture.connectTimeout * 1.2);
  assert.equal(fixture.opens.length, 3, 'aborting attempt two prevents a third open');
  await assertUnknownDataId(fixture, secondAttempt.id);
  await assertUnknownDataId(fixture, thirdAttempt.id);
});

test('an attached Gateway response failure is not retried', async t => {
  const fixture = await startFixture(t, { connectTimeout: 160 });
  fixture.state.truncateNextResponse = true;
  const request = beginPublicRequest(fixture, {
    path: '/mobile/assets/truncated.js',
    onData() {
      fixture.state.truncatedResponseObserved = true;
      fixture.state.truncatedSocket?.destroy();
    },
  });
  const open = await fixture.waitForOpen(1);
  await attachData(fixture, open.id);

  const response = await withTimeout(request.outcome, 2000, 'truncated Gateway response did not settle');
  assert.equal(response.status, 200, 'the Gateway response began before its body was interrupted');
  assert.equal(response.complete, false);
  assert.equal(fixture.state.truncatedResponseObserved, true, 'the public client observed response bytes before Gateway disconnect');
  assert.ok(response.body.length > 0 && response.body.length < ASSET.length, 'the client sees only the received partial bytes');
  assert.equal(fixture.opens.length, 1, 'an attached response failure never triggers a second open');
  await waitForHealth(fixture, value => value.pending === 0 && value.connections === 0,
    'attached response cleanup left an active or pending Relay tunnel');
});

test('a disconnected control generation does not retry an old request on its replacement', async t => {
  const fixture = await startFixture(t, { connectTimeout: 180 });
  const request = beginPublicRequest(fixture, { path: '/mobile/assets/replaced-control.js' });
  await fixture.waitForOpen(1);

  fixture.control.terminate();
  await waitForHealth(fixture, value => !value.online && value.pending === 0,
    'closing the owning control did not release its pending open');
  const response = await withTimeout(request.outcome, 1500, 'request did not settle after its control closed');
  assert.equal(response.status, 503, 'control closure is unavailable rather than a retryable timeout');

  await fixture.openControl();
  await waitForHealth(fixture, value => value.online, 'replacement control did not become online');
  await delay(fixture.connectTimeout * 1.5);
  assert.equal(fixture.opens.length, 1, 'the old request never opens a data channel in the replacement generation');
  assert.deepEqual(fixture.state.methods, [], 'no request bytes reached the Gateway');
});
