import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMobileRouteAuthorizationHandler, MOBILE_ROUTE_AUTHORIZATION_PATH } from './mobile-route-authorization.js';

const credential = 'a'.repeat(64);
const requestId = 'b'.repeat(48);
const rpcToken = 'cookie-auth';
const deviceId = 'device-authorization-0001';
const authorizationGeneration = 'authorization-generation-001';
const digest = value => createHash('sha256').update(value).digest('hex');

function setup(overrides = {}) {
  const calls = { readBody: 0, inspect: 0, response: null };
  const handler = createMobileRouteAuthorizationHandler({
    authRequired: true,
    tokenMatches: value => value === 'gateway-secret',
    authSessions: new Map([[credential, { deviceId, accessExpiresAt: 20_000, expiresAt: 25_000, authorizationGeneration }]]),
    inspectAccessAuthorization: async value => {
      calls.inspect++;
      return value === credential ? {
        accessTokenHash: digest(credential), expiresAt: 20_000, accessExpiresAt: 20_000,
        deviceId, wsLeaseExpiresAt: 25_000, refreshExpiresAt: 30_000, authorizationGeneration,
      } : undefined;
    },
    rpcToken,
    readBody: async (_request, maximumBytes) => { calls.readBody++; calls.maximumBytes = maximumBytes; return JSON.stringify({ version: 1, kind: 'access', credential, requestId }); },
    jsonResponse: (_response, status, payload, headers = {}) => { calls.response = { status, payload, headers }; },
    now: () => 10_000,
    ...overrides,
  });
  return { calls, handler };
}

function request(overrides = {}) {
  return { method: 'POST', headers: {
    'x-kcoder-relay-validation': 'gateway-secret', 'content-type': 'application/json',
  }, ...overrides };
}

test('internal access validation returns only hashes and current grant expiry metadata', async () => {
  const { calls, handler } = setup();
  const response = {};
  assert.equal(await handler(request(), response, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`)), true);
  assert.deepEqual(calls.response, { status: 200, payload: {
    version: 1, kind: 'access', requestId,
    accessTokenHash: digest(credential), rpcTokenHash: digest(rpcToken), expiresAt: 20_000, accessExpiresAt: 20_000,
    deviceId, wsLeaseExpiresAt: 25_000, refreshExpiresAt: 30_000,
  }, headers: {} });
  assert.equal(calls.maximumBytes, 4096);
  assert.equal(JSON.stringify(calls.response).includes(credential), false);
  assert.equal(JSON.stringify(calls.response).includes(rpcToken), false);
});

test('secret and no-Origin admission happen before body parsing', async () => {
  const badSecret = setup();
  await badSecret.handler(request({ headers: { 'x-kcoder-relay-validation': 'wrong', 'content-type': 'application/json' } }), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(badSecret.calls.response.status, 401);
  assert.equal(badSecret.calls.readBody, 0);

  const origin = setup();
  await origin.handler(request({ headers: { 'x-kcoder-relay-validation': 'gateway-secret', 'content-type': 'application/json', origin: 'https://relay.test' } }), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(origin.calls.response.status, 403);
  assert.equal(origin.calls.readBody, 0);
});

test('route rejects authorization bypasses, wrong methods, and malformed exact-body schemas', async () => {
  const noAuth = setup({ authRequired: false });
  await noAuth.handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(noAuth.calls.response.status, 404);
  assert.equal(noAuth.calls.readBody, 0);

  const query = setup();
  await query.handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}?extra=1`));
  assert.equal(query.calls.response.status, 403);
  assert.equal(query.calls.readBody, 0);

  const normalizedPath = setup();
  await normalizedPath.handler(request({ url: `/api/mobile/session/../session/relay-validation` }), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(normalizedPath.calls.response.status, 404);
  assert.equal(normalizedPath.calls.readBody, 0);

  const oversized = setup();
  await oversized.handler(request({ headers: { 'x-kcoder-relay-validation': 'gateway-secret', 'content-type': 'application/json', 'content-length': '4097' } }), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(oversized.calls.response.status, 413);
  assert.equal(oversized.calls.readBody, 0);

  const wrongMethod = setup();
  await wrongMethod.handler(request({ method: 'GET' }), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(wrongMethod.calls.response.status, 405);
  assert.equal(wrongMethod.calls.readBody, 0);

  const duplicate = setup({ readBody: async () => '{"version":1,"version":1,"kind":"access","credential":"' + credential + '","requestId":"' + requestId + '"}' });
  await duplicate.handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(duplicate.calls.response.status, 400);
  assert.equal(duplicate.calls.inspect, 0);

  const refresh = setup({ readBody: async () => JSON.stringify({ version: 1, kind: 'refresh', credential, requestId }) });
  await refresh.handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(refresh.calls.response.status, 400);
  assert.equal(refresh.calls.inspect, 0);
});

test('a live in-memory legacy session is validated without a durable device grant', async () => {
  const liveLegacyToken = '00000000-0000-4000-8000-000000000001';
  const authSessions = new Map([[liveLegacyToken, { expiresAt: 15_000, allowedServerIds: new Set() }]]);
  const { calls, handler } = setup({
    authSessions,
    inspectAccessAuthorization: async () => undefined,
    readBody: async () => JSON.stringify({ version: 1, kind: 'access', credential: liveLegacyToken, requestId }),
  });
  await handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(calls.response.status, 200);
  assert.equal(calls.response.payload.accessTokenHash, digest(liveLegacyToken));
  assert.equal('deviceId' in calls.response.payload, false);
  assert.equal(calls.inspect, 0);
});

test('a durable store match is rejected unless the Gateway has the same active session generation', async () => {
  const withoutRamSession = setup({ authSessions: new Map() });
  await withoutRamSession.handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(withoutRamSession.calls.response.status, 401);
  assert.equal(withoutRamSession.calls.inspect, 0);

  const mismatchedSession = setup({
    authSessions: new Map([[credential, { deviceId, accessExpiresAt: 20_000, expiresAt: 25_000, authorizationGeneration: 'older-generation-0001' }]]),
  });
  await mismatchedSession.handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(mismatchedSession.calls.response.status, 401);
  assert.equal(mismatchedSession.calls.inspect, 1);

  const mismatchedLease = setup({
    authSessions: new Map([[credential, { deviceId, accessExpiresAt: 20_000, expiresAt: 24_999, authorizationGeneration }]]),
  });
  await mismatchedLease.handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  assert.equal(mismatchedLease.calls.response.status, 401);
});

test('a durable session removed or replaced during store inspection is rejected', async t => {
  for (const mutation of ['delete', 'replace']) {
    await t.test(mutation, async () => {
      const liveSession = { deviceId, accessExpiresAt: 20_000, expiresAt: 25_000, authorizationGeneration };
      const authSessions = new Map([[credential, liveSession]]);
      let signalInspection;
      let releaseInspection;
      const inspectionStarted = new Promise(resolve => { signalInspection = resolve; });
      const pendingInspection = new Promise(resolve => { releaseInspection = resolve; });
      const { calls, handler } = setup({
        authSessions,
        inspectAccessAuthorization: () => { signalInspection(); return pendingInspection; },
      });
      const pendingResponse = handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
      await inspectionStarted;
      if (mutation === 'delete') authSessions.delete(credential);
      else authSessions.set(credential, { ...liveSession });
      releaseInspection({
        accessTokenHash: digest(credential), expiresAt: 20_000, accessExpiresAt: 20_000,
        deviceId, wsLeaseExpiresAt: 25_000, refreshExpiresAt: 30_000, authorizationGeneration,
      });
      await pendingResponse;
      assert.equal(calls.response.status, 401);
    });
  }
});

test('expiry is rechecked after delayed durable inspection', async () => {
  let currentTime = 10_000;
  let signalInspection;
  let releaseInspection;
  const inspectionStarted = new Promise(resolve => { signalInspection = resolve; });
  const pendingInspection = new Promise(resolve => { releaseInspection = resolve; });
  const { calls, handler } = setup({
    now: () => currentTime,
    inspectAccessAuthorization: () => { signalInspection(); return pendingInspection; },
  });
  const pendingResponse = handler(request(), {}, new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`));
  await inspectionStarted;
  currentTime = 20_000;
  releaseInspection({
    accessTokenHash: digest(credential), expiresAt: 20_000, accessExpiresAt: 20_000,
    deviceId, wsLeaseExpiresAt: 25_000, refreshExpiresAt: 30_000, authorizationGeneration,
  });
  await pendingResponse;
  assert.equal(calls.response.status, 401);
});
