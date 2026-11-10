import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMobileDeviceAuth, mobileDeviceStoreIdentity } from './mobile-device-auth.js';
import { createMobileRouteAuthorizationHandler, MOBILE_ROUTE_AUTHORIZATION_PATH } from './mobile-route-authorization.js';
import { registerMobileDeviceGrantState } from './retention-context.js';

test('route authorization inspects only the current unexpired durable access grant without writing the store', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-route-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let currentTime = 1_000_000;
  const auth = createMobileDeviceAuth({ directory, identity: mobileDeviceStoreIdentity('gateway-secret'), now: () => currentTime });
  const original = await auth.pair('Mobile device');
  const storePath = join(directory, 'mobile-device-auth', 'devices.json');
  const beforeContent = await readFile(storePath, 'utf8');
  const beforeStat = await stat(storePath);

  const metadata = await auth.inspectAccessAuthorization(original.accessToken);
  assert.deepEqual(metadata, {
    accessTokenHash: createHash('sha256').update(original.accessToken).digest('hex'),
    expiresAt: original.expiresAt,
    accessExpiresAt: original.expiresAt,
    wsLeaseExpiresAt: original.wsLeaseExpiresAt,
    refreshExpiresAt: original.refreshExpiresAt,
    deviceId: original.deviceId,
    authorizationGeneration: original.authorizationGeneration,
  });
  assert.equal(await readFile(storePath, 'utf8'), beforeContent);
  const afterStat = await stat(storePath);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);

  const rotated = await auth.refresh(original.refreshToken, randomUUID());
  assert.equal(await auth.inspectAccessAuthorization(original.accessToken), undefined);
  assert.equal((await auth.inspectAccessAuthorization(rotated.accessToken)).deviceId, original.deviceId);
  currentTime = rotated.expiresAt + 1;
  assert.equal(await auth.inspectAccessAuthorization(rotated.accessToken), undefined);
  currentTime = 1_000_000;
  await auth.revoke(original.deviceId);
  assert.equal(await auth.inspectAccessAuthorization(rotated.accessToken), undefined);
});

test('route authorization fails closed for another private-store identity without revoking or rewriting it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-route-auth-scope-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalAuth = createMobileDeviceAuth({ directory, identity: mobileDeviceStoreIdentity('gateway-secret') });
  const grant = await originalAuth.pair();
  const storePath = join(directory, 'mobile-device-auth', 'devices.json');
  const before = await readFile(storePath, 'utf8');
  const wrongIdentity = createMobileDeviceAuth({ directory, identity: mobileDeviceStoreIdentity('different-gateway-secret') });
  assert.equal(await wrongIdentity.inspectAccessAuthorization(grant.accessToken), undefined);
  assert.equal(await readFile(storePath, 'utf8'), before);
  assert.ok(await originalAuth.inspectAccessAuthorization(grant.accessToken));
});

test('Gateway restart rejects a store-only access token; refresh registers a current session that validates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-route-auth-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = mobileDeviceStoreIdentity('gateway-secret');
  const beforeRestartAuth = createMobileDeviceAuth({ directory, identity });
  const original = await beforeRestartAuth.pair();
  const families = new Map();
  const session = grant => registerMobileDeviceGrantState({
    families,
    payload: grant,
    allowedServerIds: [],
  }).session;
  const sessions = new Map([[original.accessToken, session(original)]]);
  const restartedAuth = createMobileDeviceAuth({ directory, identity });
  const makeHandler = (auth, activeSessions) => {
    const calls = { response: null, inspect: 0 };
    const handle = createMobileRouteAuthorizationHandler({
      authRequired: true,
      tokenMatches: token => token === 'gateway-secret',
      authSessions: activeSessions,
      inspectAccessAuthorization: token => { calls.inspect++; return auth.inspectAccessAuthorization(token); },
      rpcToken: 'cookie-auth',
      readBody: async request => request.rawBody,
      jsonResponse: (_response, status, payload) => { calls.response = { status, payload }; },
    });
    return { calls, handle };
  };
  const requestFor = token => ({ method: 'POST', headers: {
    'x-kcoder-relay-validation': 'gateway-secret', 'content-type': 'application/json',
  }, rawBody: JSON.stringify({ version: 1, kind: 'access', credential: token, requestId: 'd'.repeat(48) }) });
  const url = new URL(`http://gateway.test${MOBILE_ROUTE_AUTHORIZATION_PATH}`);

  const staleHandler = makeHandler(restartedAuth, new Map());
  await staleHandler.handle(requestFor(original.accessToken), {}, url);
  assert.equal(staleHandler.calls.response.status, 401);
  assert.equal(staleHandler.calls.inspect, 0);
  assert.ok(await restartedAuth.inspectAccessAuthorization(original.accessToken), 'the persistent record alone still matches, but is not a live Gateway session');

  const refreshed = await restartedAuth.refresh(original.refreshToken, randomUUID());
  const activeSessions = new Map([[refreshed.accessToken, session(refreshed)]]);
  const currentHandler = makeHandler(restartedAuth, activeSessions);
  await currentHandler.handle(requestFor(original.accessToken), {}, url);
  assert.equal(currentHandler.calls.response.status, 401);
  await currentHandler.handle(requestFor(refreshed.accessToken), {}, url);
  assert.equal(currentHandler.calls.response.status, 200);
  assert.equal(currentHandler.calls.response.payload.accessTokenHash, createHash('sha256').update(refreshed.accessToken).digest('hex'));
});
