import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { startClient } from '../src/client.mjs';
import { startRelay } from '../src/server.mjs';
import { isolatedGatewayAuthority } from '../src/gateway-origin.mjs';

const SHARED_HOST = 'p2p-signaling.test:8451';
const OFFER_PATH = '/api/mobile/p2p/offer';

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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startFakeGateway(id) {
  const state = {
    id,
    gatewaySecret: token(),
    requests: [],
    pendingConfig: [],
    holdConfig: false,
    offerResult: null,
    server: null,
    websocketServer: null,
  };
  const server = createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://gateway.invalid');
    const entry = { method: incoming.method, path: incoming.url, headers: incoming.headers };
    state.requests.push(entry);
    if (incoming.method === 'OPTIONS') {
      const allowed = incoming.headers.origin === `https://mobile-${id}.example`;
      response.writeHead(allowed ? 204 : 403, allowed ? {
        'access-control-allow-origin': incoming.headers.origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
        vary: 'Origin',
      } : { 'content-type': 'application/json' });
      response.end(allowed ? undefined : JSON.stringify({ error: 'origin_rejected' }));
      return;
    }
    if (incoming.method === 'GET' && url.pathname === '/api/mobile/p2p') {
      if (state.holdConfig) {
        state.pendingConfig.push(response);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ gateway: id, signaling: 'enabled' }));
      return;
    }
    if (incoming.method === 'POST' && url.pathname === OFFER_PATH) {
      entry.body = await readBody(incoming);
      const result = state.offerResult || { status: 200, body: { gateway: id, answer: 'v=0\r\no=fixture' } };
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
      return;
    }
    if (url.pathname === '/api/whoami') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ gateway: id }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.server = server;
  state.url = `http://127.0.0.1:${server.address().port}`;
  return state;
}

async function startFixture(t) {
  const fixture = { gateways: new Map(), clients: new Map(), relay: null };
  fixture.gateways.set('alpha', await startFakeGateway('alpha'));
  fixture.gateways.set('beta', await startFakeGateway('beta'));
  const configs = [...fixture.gateways].map(([id, gateway]) => ({
    id,
    secret: token(),
    gatewaySecret: gateway.gatewaySecret,
    maxConnections: 32,
    maxBytesPerWindow: 8 * 1024 * 1024,
    trafficWindowMs: 60_000,
  }));
  fixture.relay = await startRelay({
    gateways: configs,
    sharedHosts: [SHARED_HOST],
    controlPort: 0,
    proxyPort: 0,
    connectTimeout: 1_000,
  });

  try {
    for (const config of configs) {
      let online;
      const ready = new Promise(resolve => { online = resolve; });
      const gateway = fixture.gateways.get(config.id);
      const client = startClient({
        url: `http://127.0.0.1:${fixture.relay.controlPort}`,
        secret: config.secret,
        gatewayId: config.id,
        gateway: gateway.url,
        allowInsecure: true,
        retryMs: 30,
        onOnline: online,
      });
      fixture.clients.set(config.id, client);
      await withTimeout(ready, 2_000, `Gateway ${config.id} failed to connect to Relay`);
    }
  } catch (error) {
    for (const client of fixture.clients.values()) client.close();
    await fixture.relay.close();
    for (const gateway of fixture.gateways.values()) {
      gateway.server.closeAllConnections();
      await new Promise(resolve => gateway.server.close(resolve));
    }
    throw error;
  }

  t.after(async () => {
    for (const client of fixture.clients.values()) client.close();
    await fixture.relay.close();
    await Promise.all([...fixture.gateways.values()].map(async gateway => {
      gateway.server.closeAllConnections();
      await new Promise(resolve => gateway.server.close(resolve));
    }));
  });
  return fixture;
}

function requestRelay(fixture, { id = 'alpha', path, method = 'GET', body, headers = {}, localAddress = '127.0.0.1', timeoutMs = 3_000 }) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const outgoing = request({
      host: '127.0.0.1',
      localAddress,
      port: fixture.relay.proxyPort,
      method,
      path: `/g/${id}${path}`,
      headers: { host: isolatedGatewayAuthority(SHARED_HOST, id), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => finish({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('aborted', () => finish({ status: response.statusCode || 0, aborted: true, body: Buffer.concat(chunks) }));
      response.once('error', error => finish({ status: response.statusCode || 0, error: error.code, body: Buffer.concat(chunks) }));
    });
    timer = setTimeout(() => { outgoing.destroy(); finish({ status: 0, timeout: true, body: Buffer.alloc(0) }); }, timeoutMs);
    outgoing.once('error', error => finish({ status: 0, error: error.code, body: Buffer.alloc(0) }));
    if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

function offerPayload(overrides = {}) {
  return {
    version: 1,
    nonce: 'a'.repeat(48),
    offer: 'v=0\r\no=mobile-offer',
    auth: { kind: 'pairing', keyId: 'b'.repeat(64), proof: 'c'.repeat(64) },
    ...overrides,
  };
}

async function waitForPendingConfig(gateway, count) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (gateway.pendingConfig.length >= count) return;
    await delay(5);
  }
  throw new Error(`Gateway did not receive ${count} held P2P config requests`);
}

test('anonymous P2P config and offer forward only to the selected Gateway without credentials', async t => {
  const fixture = await startFixture(t);
  const config = await requestRelay(fixture, {
    path: '/api/mobile/p2p',
    headers: {
      authorization: 'Bearer should-not-reach-gateway',
      cookie: 'session=should-not-reach-gateway',
      'proxy-authorization': 'Basic should-not-reach-gateway',
      'x-kcoder-relay-validation': 'should-not-reach-gateway',
    },
  });
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.body.toString()), { gateway: 'alpha', signaling: 'enabled' });
  const forwardedConfig = fixture.gateways.get('alpha').requests.find(item => item.method === 'GET');
  assert.ok(forwardedConfig);
  for (const header of ['authorization', 'cookie', 'proxy-authorization', 'x-kcoder-relay-validation']) {
    assert.equal(forwardedConfig.headers[header], undefined, `${header} must not cross the anonymous config route`);
  }

  const payload = offerPayload();
  const sentBody = jsonBody(payload);
  const offer = await requestRelay(fixture, {
    path: OFFER_PATH,
    method: 'POST',
    body: sentBody,
    headers: {
      'content-type': 'application/json',
      'content-length': String(sentBody.length),
      authorization: 'Bearer should-not-reach-gateway',
      cookie: 'session=should-not-reach-gateway',
      'proxy-authorization': 'Basic should-not-reach-gateway',
      'x-kcoder-relay-validation': 'should-not-reach-gateway',
    },
  });
  assert.equal(offer.status, 200);
  assert.deepEqual(JSON.parse(offer.body.toString()), { gateway: 'alpha', answer: 'v=0\r\no=fixture' });

  const forwarded = fixture.gateways.get('alpha').requests.find(item => item.method === 'POST' && item.path === OFFER_PATH);
  assert.ok(forwarded);
  assert.deepEqual(forwarded.body, sentBody, 'Relay preserves the exact bounded offer payload');
  for (const header of ['authorization', 'cookie', 'proxy-authorization', 'x-kcoder-relay-validation']) {
    assert.equal(forwarded.headers[header], undefined, `${header} must not cross the anonymous signaling route`);
  }
  assert.equal(fixture.gateways.get('beta').requests.length, 0, 'a request for alpha never reaches beta');

  const sibling = await requestRelay(fixture, { id: 'beta', path: '/api/mobile/p2p' });
  assert.equal(sibling.status, 200);
  assert.deepEqual(JSON.parse(sibling.body.toString()), { gateway: 'beta', signaling: 'enabled' });
  const protectedApi = await requestRelay(fixture, { path: '/api/whoami' });
  assert.equal(protectedApi.status, 401, 'the P2P exception does not make sibling API routes anonymous');
  assert.equal(fixture.gateways.get('alpha').requests.some(item => item.path === '/api/whoami'), false);

  fixture.gateways.get('alpha').offerResult = { status: 409, body: { error: 'offer_conflict' } };
  const conflictBody = jsonBody(payload);
  const conflict = await requestRelay(fixture, {
    path: OFFER_PATH,
    method: 'POST',
    body: conflictBody,
    headers: { 'content-type': 'application/json', 'content-length': String(conflictBody.length) },
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(JSON.parse(conflict.body.toString()), { error: 'offer_conflict' }, 'Gateway signaling errors keep their JSON contract');
});

test('P2P preflights retain Gateway CORS handling while wrong methods, queries and schemas stay local', async t => {
  const fixture = await startFixture(t);
  const preflight = await requestRelay(fixture, {
    path: '/api/mobile/p2p',
    method: 'OPTIONS',
    headers: {
      origin: 'https://mobile-alpha.example',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://mobile-alpha.example');

  for (const request of [
    { path: OFFER_PATH, method: 'GET' },
    { path: '/api/mobile/p2p', method: 'POST' },
  ]) {
    assert.equal((await requestRelay(fixture, request)).status, 405);
  }
  assert.equal((await requestRelay(fixture, { path: '/api/mobile/p2p?extra=1' })).status, 400);
  assert.equal((await requestRelay(fixture, {
    path: `${OFFER_PATH}?extra=1`, method: 'POST', body: jsonBody({ version: 1, nonce: 'a'.repeat(48), offer: 'v=0' }),
    headers: { 'content-type': 'application/json' },
  })).status, 400);
  assert.equal((await requestRelay(fixture, { path: OFFER_PATH, method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);

  const invalidPayloads = [
    offerPayload({ extra: true }),
    offerPayload({ nonce: 'g'.repeat(48) }),
    offerPayload({ version: 2 }),
    offerPayload({ offer: '' }),
    offerPayload({ auth: { kind: 'other', keyId: 'b'.repeat(64), proof: 'c'.repeat(64) } }),
    offerPayload({ auth: { kind: 'access', keyId: 'b'.repeat(64), proof: 'short' } }),
  ];
  for (const payload of invalidPayloads) {
    const body = jsonBody(payload);
    const response = await requestRelay(fixture, {
      path: OFFER_PATH, method: 'POST', body,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    });
    assert.equal(response.status, 400);
  }
  const duplicateKeys = Buffer.from(`{"version":1,"nonce":"${'a'.repeat(48)}","offer":"v=0","offer":"v=1","auth":{"kind":"pairing","keyId":"${'b'.repeat(64)}","proof":"${'c'.repeat(64)}"}}`);
  assert.equal((await requestRelay(fixture, {
    path: OFFER_PATH, method: 'POST', body: duplicateKeys,
    headers: { 'content-type': 'application/json', 'content-length': String(duplicateKeys.length) },
  })).status, 400);
  const duplicateAuthKeys = Buffer.from(`{"version":1,"nonce":"${'a'.repeat(48)}","offer":"v=0","auth":{"kind":"pairing","kind":"access","keyId":"${'b'.repeat(64)}","proof":"${'c'.repeat(64)}"}}`);
  assert.equal((await requestRelay(fixture, {
    path: OFFER_PATH, method: 'POST', body: duplicateAuthKeys,
    headers: { 'content-type': 'application/json', 'content-length': String(duplicateAuthKeys.length) },
  })).status, 400);

  const oversized = Buffer.concat([Buffer.from('{"version":1,"nonce":"'), Buffer.alloc(65 * 1024, 0x61), Buffer.from('"}')]);
  assert.equal((await requestRelay(fixture, {
    path: OFFER_PATH, method: 'POST', body: oversized,
    headers: { 'content-type': 'application/json', 'content-length': String(oversized.length) },
  })).status, 413);
  assert.equal(fixture.gateways.get('alpha').requests.length, 1, 'only the valid CORS preflight reached the Gateway');
});

test('same-IP P2P signaling concurrency is bounded and released after completion', async t => {
  const fixture = await startFixture(t);
  const gateway = fixture.gateways.get('alpha');
  gateway.holdConfig = true;
  const active = Array.from({ length: 4 }, () => requestRelay(fixture, { path: '/api/mobile/p2p' }));
  await waitForPendingConfig(gateway, 4);
  const rejected = await requestRelay(fixture, { path: '/api/mobile/p2p' });
  assert.equal(rejected.status, 429, 'the per-IP concurrent request limit is enforced');
  for (const response of gateway.pendingConfig.splice(0)) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ gateway: 'alpha', signaling: 'enabled' }));
  }
  const completed = await Promise.all(active);
  assert.ok(completed.every(response => response.status === 200));

  gateway.holdConfig = false;
  assert.equal((await requestRelay(fixture, { path: '/api/mobile/p2p' })).status, 200,
    'a completed request releases its per-IP concurrency reservation');
});

test('P2P signaling total concurrency is bounded per Gateway across client IPs', async t => {
  const fixture = await startFixture(t);
  const gateway = fixture.gateways.get('alpha');
  gateway.holdConfig = true;
  const addresses = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5'];
  const active = addresses.flatMap(localAddress => Array.from({ length: 4 }, () =>
    requestRelay(fixture, { path: '/api/mobile/p2p', localAddress })));
  await waitForPendingConfig(gateway, 16);
  assert.equal((await requestRelay(fixture, { path: '/api/mobile/p2p', localAddress: '127.0.0.6' })).status, 429,
    'the per-Gateway P2P concurrency cap rejects work across distinct peer IPs');
  for (const response of gateway.pendingConfig.splice(0)) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ gateway: 'alpha', signaling: 'enabled' }));
  }
  const completed = await Promise.all(active);
  assert.ok(completed.every(response => response.status === 200));
});

test('P2P signaling applies a per-IP fixed-window request rate limit', async t => {
  const fixture = await startFixture(t);
  for (let index = 0; index < 60; index += 1) {
    assert.equal((await requestRelay(fixture, { path: '/api/mobile/p2p' })).status, 200);
  }
  assert.equal((await requestRelay(fixture, { path: '/api/mobile/p2p' })).status, 429);
  assert.equal(fixture.gateways.get('alpha').requests.filter(item => item.method === 'GET' && item.path === '/api/mobile/p2p').length, 60,
    'the request over the window limit never reaches the Gateway');
});
