import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createBrowserSessionCookies } from '../src/browser-session-cookie.js';
import { openRegistrationStore } from '../../kcoder-relay/src/registration-store.mjs';
import { startRelay } from '../../kcoder-relay/src/server.mjs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayRelayManagement, observeGatewayRelayConnectionStatus, restoreGatewayRelay } from '../src/gateway-relay-management.js';
import { activateGatewayRelay } from '../src/gateway-relay-instance.js';
import { isGatewayBrowserAdminRequest } from '../src/gateway-browser-access.js';
import { ensureRegisteredClientIdentity } from '../../kcoder-relay/src/client.mjs';
import { isolatedGatewayUrl } from '../../kcoder-relay/src/gateway-origin.mjs';
import { prepareInstanceIdentityFile, resolveIdentityFile } from '../../kcoder-relay/src/client-identity.mjs';
import { captureGatewayRemoteTransportObservations } from '../src/remotes/transport-observations.mjs';

test('Relay connection diagnostics retain a revoked status until a fresh authenticated open', () => {
  let status = observeGatewayRelayConnectionStatus('offline', { event: 'control_error', errorKind: 'handshake_status', handshakeStatus: 401 });
  assert.equal(status, 'denied');
  status = observeGatewayRelayConnectionStatus(status, { event: 'control_error', errorKind: 'transport' });
  status = observeGatewayRelayConnectionStatus(status, { event: 'control_close' });
  assert.equal(status, 'denied');
  assert.equal(observeGatewayRelayConnectionStatus(status, { event: 'control_open' }), 'online');
  assert.equal(observeGatewayRelayConnectionStatus('online', { event: 'control_error', errorKind: 'timeout' }), 'offline');
});

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-gateway-relay-api-'));
  const admin = { browserAdmin: true, allowedServerIds: new Set(['local']) };
  const phone = { ...admin, deviceId: 'paired-phone' };
  const sessionFor = request => request.headers.cookie?.split(/;\s*/).includes('admin=1') ? admin : phone;
  let handle;
  const server = createServer(async (request, response) => {
    try {
      if (!await handle(request, response, new URL(request.url, 'http://localhost').pathname, sessionFor(request))) { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = {
    isAdmin: (request, session) => isGatewayBrowserAdminRequest(request, session, [{ id: 'local' }], true),
    sameOrigin: request => request.headers.origin === origin && request.headers['content-type'] === 'application/json',
    requestBody: async (request, limit) => {
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > limit) throw Error('Too large'); } return body;
    },
    jsonResponse(response, status, body, headers) { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)); },
    ...overrides,
    env: { KCODER_STUDIO_DATA_DIR: directory, ...overrides.env },
  };
  handle = createGatewayRelayManagement(options);
  const call = (path = '/api/relay', input, headers = {}, method = input === undefined ? 'GET' : 'POST') => fetch(origin + path, {
    method, headers: { cookie: 'admin=1', origin, 'content-type': 'application/json', ...headers },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { call, directory, admin, env: options.env, replace: () => { handle = createGatewayRelayManagement(options); } };
}

test('Relay management keeps its startup registration after the metadata observer consumes private environment entries', async t => {
  const api = await setup(t, { publicBaseUrl: 'https://g-fixture.relay.example/g/fixture', env: {
    KCODER_STUDIO_RELAY_ORIGIN: 'https://relay.example',
    KCODER_STUDIO_RELAY_IDENTITY_FILE: '/owned/relay/client-identity.json',
    KCODER_STUDIO_RELAY_SECRET: 's'.repeat(64),
  } });
  captureGatewayRemoteTransportObservations({ env: api.env, gatewaySecret: api.env.KCODER_STUDIO_RELAY_SECRET });
  assert.equal(api.env.KCODER_STUDIO_RELAY_ORIGIN, undefined);
  assert.equal(api.env.KCODER_STUDIO_RELAY_IDENTITY_FILE, undefined);
  const state = await (await api.call()).json();
  assert.equal(state.configured, true);
  assert.equal(state.relayUrl, 'https://relay.example');
  assert.equal(state.switchSupported, true);
  assert.equal(JSON.stringify(state).includes('s'.repeat(64)), false);
});

test('browser management rejects paired/bearer/scoped clients, foreign origins and replacement of an existing registration', async t => {
  let activated = false;
  const api = await setup(t, { publicBaseUrl: 'https://current.example/g/current', activate: () => { activated = true; } });
  assert.equal((await api.call('/api/relay', undefined, { cookie: '' })).status, 403);
  for (const path of ['/api/relay/switch', '/api/relay/switch/cancel', '/api/relay/rollback']) {
    assert.equal((await api.call(path, { expectedRevision: 0 }, { cookie: '' })).status, 403);
  }
  assert.equal((await api.call('/api/relay', undefined, { authorization: 'Bearer phone-credential' })).status, 403);
  api.admin.allowedServerIds.clear(); assert.equal((await api.call()).status, 403); api.admin.allowedServerIds.add('local');
  const state = await (await api.call()).json(); assert.equal(state.configured, false); assert.equal(state.externallyManaged, true); assert.equal(state.publicBaseUrl, 'https://current.example/g/current');
  assert.equal((await api.call('/api/relay/activation', { activationLink: 'a'.repeat(43) }, { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await api.call('/api/relay/activation', { activationLink: 'a'.repeat(43) })).status, 409);
  assert.equal(activated, false);
});

test('Electron-owned external Relay transport remains switchable and can request its owner restart after revocation', async t => {
  let restartRequired = false; let restarts = 0;
  const api = await setup(t, { externallyManaged: true, externalOwnerCanApply: true,
    publicBaseUrl: 'https://g-current.relay.example/g/current',
    env: { KCODER_STUDIO_PUBLIC_ACCESS_URL: 'https://g-current.relay.example/g/current', KCODER_STUDIO_RELAY_SECRET: 's'.repeat(64) },
    getState: async () => ({ configured: true, publicBaseUrl: 'https://g-current.relay.example/g/current', revision: 0, restartRequired }),
    getExternalAccessStatus: async () => 'denied', restart: () => { restarts++; } });
  const status = await (await api.call()).json();
  assert.equal(status.configured, true);
  assert.equal(status.externallyManaged, undefined);
  assert.equal(status.accountAccessStatus, 'denied');
  assert.equal(status.switchSupported, true);
  assert.equal(status.restartSupported, true);
  const attempt = await api.call('/api/relay/switch', { requestId: '00000000-0000-4000-8000-000000000001', expectedRevision: 0,
    relayUrl: 'https://new.example', activationLink: 'b'.repeat(43) });
  assert.notDeepEqual(await attempt.json(), { error: 'Gateway Relay is unavailable or busy' });
  restartRequired = true;
  assert.equal((await api.call('/api/relay/restart', {})).status, 202);
  assert.equal(restarts, 1);
});

test('independent launcher switch is offered only after the explicit access probe is denied', async t => {
  let access = 'unknown';
  const api = await setup(t, { externallyManaged: true, getState: async () => ({ configured: true, publicBaseUrl: 'https://managed.example/g/id', restartRequired: false }),
    getExternalAccessStatus: async () => access });
  let state = await (await api.call()).json();
  assert.equal(state.configured, false);
  assert.equal(state.externallyManaged, true);
  assert.equal(state.switchSupported, false);
  access = 'denied';
  state = await (await api.call()).json();
  assert.equal(state.accountAccessStatus, 'denied');
  assert.equal(state.switchSupported, true);
});

test('invite and password sign-in are rejected before Gateway handling on non-loopback HTTP', async t => {
  let activations = 0;
  let configured = false;
  const api = await setup(t, { sameOrigin: () => true, getState: async () => ({ configured, revision: 0, restartRequired: false }),
    activate: async () => { activations++; } });
  const lan = { origin: 'http://192.168.1.20:4173' };
  const password = await api.call('/api/relay/activation', { relayUrl: 'https://relay.example',
    accountCredentials: { username: 'fixture.user', password: 'fixture-password-value' } }, lan);
  assert.equal(password.status, 400);
  assert.deepEqual(await password.json(), { error: 'RELAY_LOGIN_REQUIRES_SECURE_ORIGIN' });
  configured = true;
  const invite = await api.call('/api/relay/switch', { requestId: '00000000-0000-4000-8000-000000000001', expectedRevision: 0,
    relayUrl: 'https://relay.example', activationLink: 'a'.repeat(43) }, lan);
  assert.equal(invite.status, 400);
  assert.deepEqual(await invite.json(), { error: 'RELAY_LOGIN_REQUIRES_SECURE_ORIGIN' });
  assert.equal(activations, 0);
});

test('HTTP switch API rejects a same-origin retry when the original login proof is still pending', async t => {
  let restarts = 0;
  const api = await setup(t, { getState: async () => ({ configured: false, needsLogin: true, hasPendingIdentity: true,
    restartRequired: true, revision: 0, selectedProfileId: null, relayUrl: 'https://old.example' }),
  restart: () => { restarts++; } });
  const runtime = { isolatedGatewayUrl, prepareInstanceIdentityFile, resolveIdentityFile,
    ensureRegisteredClientIdentity: options => ensureRegisteredClientIdentity({ ...options,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'invite denied' }), { status: 401 }) }) };
  await assert.rejects(activateGatewayRelay({ userDataDir: api.directory,
    activationLink: `https://old.example/_relay/activate#code=${'a'.repeat(43)}`, loadRuntime: async () => runtime }), { status: 401 });
  const response = await api.call('/api/relay/switch', { requestId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 0, relayUrl: 'https://old.example' });
  assert.equal(response.status, 409);
  assert.equal((await api.call('/api/relay/restart', {})).status, 409);
  assert.equal(restarts, 0);
  await assert.rejects(readFile(join(api.directory, 'relay-profiles', '00000000-0000-4000-8000-000000000001', 'desktop-relay.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(api.directory, 'desktop-relay.json'), 'utf8')).activationCode, 'a'.repeat(43));
});

test('web activation reuses the original private identity and reload recovers registration state without exposing credentials', async t => {
  let enrolled = 0;
  const runtime = { isolatedGatewayUrl, prepareInstanceIdentityFile, resolveIdentityFile,
    ensureRegisteredClientIdentity: options => ensureRegisteredClientIdentity({ ...options, fetchImpl: async (_url, input) => {
      enrolled++; const request = JSON.parse(input.body);
      return new Response(JSON.stringify({ id: 'web-fixture', secret: 's'.repeat(64), gatewaySecret: request.gatewaySecret,
        maxConnections: 128, maxBytesPerWindow: 65536, trafficWindowMs: 60000 }), { status: 201 });
    } }),
    startRegisteredClient: () => assert.fail('activation cannot open a transport before restart'),
  };
  const api = await setup(t, { activate: options => activateGatewayRelay({ ...options, loadRuntime: async () => runtime }) });
  assert.equal((await (await api.call()).json()).configured, false);
  const link = `https://relay.example/_relay/activate#code=${'a'.repeat(43)}`;
  assert.equal((await api.call('/api/relay/activation', { activationLink: link })).status, 200);
  assert.equal(enrolled, 1); api.replace();
  const state = await (await api.call()).json(); assert.equal(state.restartRequired, true); assert.equal(state.restartSupported, false);
  assert.equal(JSON.stringify(state).includes('s'.repeat(64)), false);
  assert.deepEqual(JSON.parse(await readFile(join(api.directory, 'desktop-relay.json'), 'utf8')), { url: 'https://relay.example' });
  assert.equal((await api.call('/api/relay/activation', { activationLink: link.replace('a'.repeat(43), 'b'.repeat(43)) })).status, 400);
  assert.equal(enrolled, 1);
  assert.equal((await api.call('/api/relay/restart', {})).status, 409);
});

test('account invite redemption stays Gateway-owned, uses the account endpoint, and clears the saved one-use token', async t => {
  let endpoint; let authorization;
  const runtime = { isolatedGatewayUrl, prepareInstanceIdentityFile, resolveIdentityFile,
    ensureRegisteredClientIdentity: options => ensureRegisteredClientIdentity({ ...options, fetchImpl: async (url, input) => {
      endpoint = new URL(url).pathname; authorization = input.headers.authorization;
      const request = JSON.parse(input.body);
      return new Response(JSON.stringify({ id: 'account-fixture', secret: 's'.repeat(64), gatewaySecret: request.gatewaySecret,
        maxConnections: 128, maxBytesPerWindow: 65536, trafficWindowMs: 60000 }), { status: 201 });
    } }),
    startRegisteredClient: () => assert.fail('registration must wait for the owning Gateway restart'),
  };
  const api = await setup(t, { activate: options => activateGatewayRelay({ ...options, loadRuntime: async () => runtime }) });
  const token = 'c'.repeat(43);
  const response = await api.call('/api/relay/activation', { activationLink: `https://relay.example/_relay/login#code=${token}` });
  assert.equal(response.status, 200);
  assert.equal(endpoint, '/_relay/account/register');
  assert.equal(authorization, `Bearer ${token}`);
  const config = JSON.parse(await readFile(join(api.directory, 'desktop-relay.json'), 'utf8'));
  assert.deepEqual(config, { url: 'https://relay.example' });
  const state = await (await api.call()).json();
  assert.equal(state.restartRequired, true);
  assert.equal(JSON.stringify(state).includes(token), false);
});

test('a full invite link selects its own Relay origin instead of the packaged default', async t => {
  let selectedOrigin;
  const api = await setup(t, { env: { KCODER_STUDIO_RELAY_DEFAULT_URL: 'https://packaged-default.example' },
    activate: async options => { selectedOrigin = options.relayUrl; return { publicBaseUrl: 'https://g-fixture.invite.example/g/id', restartRequired: true }; } });
  const link = `https://invite.example/_relay/login#code=${'d'.repeat(43)}`;
  assert.equal((await api.call('/api/relay/activation', { activationLink: link })).status, 200);
  assert.equal(selectedOrigin, 'https://invite.example');
});

test('a bare 43-character account token uses the account registration route', async t => {
  let endpoint;
  const runtime = { isolatedGatewayUrl, prepareInstanceIdentityFile, resolveIdentityFile,
    ensureRegisteredClientIdentity: options => ensureRegisteredClientIdentity({ ...options, fetchImpl: async (url, input) => {
      endpoint = new URL(url).pathname;
      const body = JSON.parse(input.body);
      return new Response(JSON.stringify({ id: 'bare-code-fixture', secret: 'b'.repeat(64), gatewaySecret: body.gatewaySecret,
        maxConnections: 128, maxBytesPerWindow: 65536, trafficWindowMs: 60000 }), { status: 201 });
    } }),
    startRegisteredClient: () => assert.fail('registration must wait for the owning Gateway restart'),
  };
  const api = await setup(t, { activate: options => activateGatewayRelay({ ...options, loadRuntime: async () => runtime }) });
  const token = 'e'.repeat(43);
  const response = await api.call('/api/relay/activation', { relayUrl: 'https://relay.example', activationLink: token });
  assert.equal(response.status, 200);
  assert.equal(endpoint, '/_relay/account/register');
});

test('account password is forwarded only for this HTTPS-or-loopback request and server denial is localized by code', async t => {
  let observed;
  const api = await setup(t, { activate: async options => {
    observed = options.accountCredentials;
    throw Object.assign(Error('sensitive Relay response'), { status: 401 });
  } });
  const password = 'fixture-account-password';
  const response = await api.call('/api/relay/activation', { relayUrl: 'https://relay.example',
    accountCredentials: { username: 'fixture.user', password } });
  assert.equal(response.status, 401);
  assert.deepEqual(observed, { username: 'fixture.user', password });
  const body = await response.json();
  assert.deepEqual(body, { error: 'RELAY_ACCOUNT_LOGIN_REJECTED' });
  assert.equal(JSON.stringify(body).includes(password), false);
  await assert.rejects(readFile(join(api.directory, 'desktop-relay.json')), { code: 'ENOENT' });
});

test('account Gateway-capacity denial remains distinct from a transient rate limit', async t => {
  const api = await setup(t, { activate: async () => {
    throw Object.assign(Error('account capacity reached'), { status: 429, code: 'RELAY_ACCOUNT_CAPACITY' });
  } });
  const response = await api.call('/api/relay/activation', { relayUrl: 'https://relay.example',
    accountCredentials: { username: 'fixture.user', password: 'fixture-account-password' } });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'RELAY_ACCOUNT_CAPACITY' });
});

test('only one activation runs and restart is scheduled once after the HTTP receipt finishes', async t => {
  let unblock; const blocked = new Promise(resolve => { unblock = resolve; }); let entered;
  const active = new Promise(resolve => { entered = resolve; }); let restartCount = 0;
  let restartRequired = false;
  const api = await setup(t, { getState: async () => ({ configured: false, restartRequired }),
    activate: async () => { entered(); await blocked; restartRequired = true; return { restartRequired: true }; },
    restart: () => { restartCount++; },
  });
  const first = api.call('/api/relay/activation', { activationLink: 'a'.repeat(43) }); await active;
  assert.equal((await api.call('/api/relay/activation', { activationLink: 'b'.repeat(43) })).status, 409);
  unblock(); assert.equal((await first).status, 200); assert.equal(restartCount, 0);
  assert.equal((await api.call('/api/relay/restart', {})).status, 202);
  assert.equal((await api.call('/api/relay/restart', {})).status, 202); assert.equal(restartCount, 1);
});

test('restoring an already managed Gateway neither enrolls a new device nor opens a second transport', async () => {
  const env = { KCODER_STUDIO_PUBLIC_ACCESS_URL: 'https://current.example/g/current', KCODER_STUDIO_RELAY_SECRET: 's'.repeat(64) };
  const snapshot = { ...env }; assert.equal(await restoreGatewayRelay(env), null); assert.deepEqual(env, snapshot);
});

test('Relay restore returns null for a fresh default and restores an existing registered identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-restore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let registrations = 0; let starts = 0;
  const runtime = { isolatedGatewayUrl, prepareInstanceIdentityFile, resolveIdentityFile,
    ensureRegisteredClientIdentity: options => ensureRegisteredClientIdentity({ ...options, fetchImpl: async (_url, input) => {
      registrations++;
      const body = JSON.parse(input.body);
      return new Response(JSON.stringify({ id: 'restore-fixture', secret: 'r'.repeat(64), gatewaySecret: body.gatewaySecret,
        maxConnections: 128, maxBytesPerWindow: 65536, trafficWindowMs: 60000 }), { status: 201 });
    } }),
    startRegisteredClient: options => { starts++; return { close() {} }; },
  };
  const loadRuntime = async () => runtime;
  const env = { KCODER_STUDIO_DATA_DIR: directory, KCODER_STUDIO_RELAY_DEFAULT_URL: 'https://relay.example' };
  assert.equal(await restoreGatewayRelay(env, error => { throw error; }, { loadRuntime }), null);
  await activateGatewayRelay({ userDataDir: directory, activationLink: `https://relay.example/_relay/login#code=${'z'.repeat(43)}`, loadRuntime });
  assert.equal(registrations, 1);
  const restored = await restoreGatewayRelay(env, error => { throw error; }, { loadRuntime });
  assert.ok(restored);
  assert.equal(restored.relayOrigin, 'https://relay.example');
  assert.equal(registrations, 1);
  assert.equal(starts, 0);
  await restored.connect('http://127.0.0.1:1');
  assert.equal(starts, 1);
  restored.close();
});


test('Relay startup failure preserves saved recovery input and leaves the local Gateway available', async t => {
  const api = await setup(t);
  const path = join(api.directory, 'desktop-relay.json');
  const original = '{invalid-private-relay-input';
  await writeFile(path, original, { mode: 0o600 });
  let failures = 0;
  assert.equal(await restoreGatewayRelay({ KCODER_STUDIO_DATA_DIR: api.directory }, () => { failures++; }), null);
  assert.equal(failures, 1);
  assert.equal(await readFile(path, 'utf8'), original);
});


test('switch HTTP entry rejects a stale revision before preparing credentials', async t => {
  const api = await setup(t, { getState: async () => ({ configured: true, revision: 0, restartRequired: false }) });
  const response = await api.call('/api/relay/switch', { requestId: '00000000-0000-4000-8000-000000000001', expectedRevision: 12,
    relayUrl: 'https://new.example', activationLink: 'a'.repeat(43) });
  assert.equal(response.status, 409);
  await assert.rejects(readFile(join(api.directory, 'desktop-relay.json')), { code: 'ENOENT' });
});

test('local Gateway revocation waits for a Relay receipt before disabling startup and restarting', async t => {
  let outcome = 'unknown';
  let calls = 0;
  let restartHost;
  const api = await setup(t, {
    externallyManaged: true, publicBaseUrl: 'https://relay.example/g/fixture',
    env: { KCODER_STUDIO_RELAY_ORIGIN: 'https://relay.example', KCODER_STUDIO_RELAY_IDENTITY_FILE: '/owned/identity.json' },
    restart: authority => { restartHost = authority; },
    getExternalAccessStatus: async ({ revoke }) => { assert.equal(revoke, true); calls++; return outcome; },
  });
  const endpoint = '/api/relay/revoke';
  assert.equal((await api.call(endpoint, { expectedRevision: 0 }, { cookie: '' })).status, 403);
  assert.equal((await api.call(endpoint, { expectedRevision: 4 })).status, 409);
  assert.equal(calls, 0);
  assert.equal((await api.call(endpoint, { expectedRevision: 0 })).status, 503);
  await assert.rejects(readFile(join(api.directory, 'desktop-relay.json')), { code: 'ENOENT' });
  assert.equal(restartHost, undefined);
  outcome = 'revoked';
  assert.equal((await api.call(endpoint, { expectedRevision: 0 })).status, 202);
  assert.match(restartHost, /^127\.0\.0\.1:\d+$/);
  assert.deepEqual(JSON.parse(await readFile(join(api.directory, 'desktop-relay.json'), 'utf8')),
    { url: 'https://relay.example', disabled: true, revision: 1 });
  assert.equal(await restoreGatewayRelay({ KCODER_STUDIO_DATA_DIR: api.directory }, error => { throw error; }), null);
});

test('a public same-origin Gateway administrator can revoke without restarting', async t => {
  const publicBaseUrl = 'https://g-fixture.relay.example/g/fixture';
  const origin = new URL(publicBaseUrl).origin;
  const environment = { KCODER_STUDIO_RELAY_ORIGIN: 'https://relay.example',
    KCODER_STUDIO_RELAY_IDENTITY_FILE: '/owned/identity.json', KCODER_STUDIO_RELAY_SECRET: 's'.repeat(64),
    KCODER_STUDIO_PUBLIC_ACCESS_URL: publicBaseUrl };
  let revoked = 0;
  const api = await setup(t, {
    sameOrigin: request => request.headers.origin === origin && request.headers['content-type'] === 'application/json',
    liveRelay: {
      environment,
      revoke: async () => { revoked++; return 'revoked'; },
      clear: async () => { for (const key of Object.keys(environment)) delete environment[key]; },
    },
  });
  const endpoint = '/api/relay/revoke';
  const input = { expectedRevision: 0 };
  assert.equal((await api.call(endpoint, input, { origin, cookie: '' })).status, 403);
  assert.equal((await api.call(endpoint, input, { origin: 'https://foreign.example' })).status, 403);
  assert.equal(revoked, 0);
  const response = await api.call(endpoint, input, { origin });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).disabled, true);
  assert.equal(revoked, 1);
});

test('KCoder login enrolls the Gateway once and keeps its registration after browser logout', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const home = await mkdtemp(join(tmpdir(), 'kcoder-product-account-relay-'));
  const storeFile = join(home, 'store.json');
  const store = await openRegistrationStore({ path: storeFile });
  const invitation = await store.createActivationCode({ signupCapacity: 1 });
  assert.equal(store.managementSnapshot().accounts.length, 0);
  await store.close();
  const relay = await startRelay({ gateways: [], sharedHosts: ['relay.example'], registrationStoreFile: storeFile, controlPort: 0, proxyPort: 0 });
  t.after(async () => { await relay.close(); await rm(home, { recursive: true, force: true }); });
  const control = new URL(`http://127.0.0.1:${relay.controlPort}`);
  const issuer = 'https://relay.example';
  const accountFetch = (url, init) => {
    assert.equal(url.origin, issuer);
    assert.equal(init.redirect, 'error');
    return fetch(new URL(url.pathname, control), init);
  };
  const runtime = { isolatedGatewayUrl, prepareInstanceIdentityFile, resolveIdentityFile,
    ensureRegisteredClientIdentity: options => ensureRegisteredClientIdentity({ ...options, fetchImpl: accountFetch }),
    startRegisteredClient: () => { throw Error('Activation must leave the transport stopped until restart'); },
  };
  const api = await setup(t, {
    env: { KCODER_STUDIO_RELAY_DEFAULT_URL: issuer },
    accountCookies: createBrowserSessionCookies({ publicOrigins: new Set() }),
    accountFetch, activate: options => activateGatewayRelay({ ...options, loadRuntime: async () => runtime }),
  });
  const path = '/api/kcoder-account';
  const entry = await api.call(path);
  assert.deepEqual(await entry.json(), { available: true, account: null, portalUrl: issuer + '/_relay/account/' });
  const header = entry.headers.get('set-cookie');
  assert.match(header, /HttpOnly; SameSite=Strict; Path=\//);
  const cookie = `admin=1; ${header.split(';')[0]}`;
  const sessionProof = header.match(/=([\w-]+);/)[1];
  const guest = await api.call('/api/relay/activation', { useKCoderAccount: true }, { cookie });
  assert.equal(guest.status, 401);
  assert.equal((await guest.json()).error, 'KCODER_ACCOUNT_SIGN_IN_REQUIRED');
  await assert.rejects(readFile(join(api.directory, 'desktop-relay.json')), { code: 'ENOENT' });
  assert.equal((await api.call(path, { invitation: invitation.code }, { cookie, origin: 'https://attacker.example' })).status, 403);
  assert.equal((await api.call(path, { invitation: invitation.code }, { cookie: cookie.split('; ')[1] })).status, 403);
  const foreign = { invitation: `https://attacker.example/_relay/login#code=${invitation.code}` };
  assert.equal((await api.call(path, foreign, { cookie })).status, 400);

  const input = { invitation: `${issuer}/_relay/login#code=${invitation.code}` };
  const login = await api.call(path, input, { cookie });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /(?:^|; )Max-Age=2592000(?:;|$)/);
  const status = await login.json();
  assert.match(status.account.username, /^kcoder-/);
  assert.deepEqual(await (await api.call(path, input, { cookie })).json(), status, 'retry after a lost reply uses the same receipt');
  const anotherCookie = (await api.call(path)).headers.get('set-cookie').split(';')[0];
  assert.equal((await api.call(path, input, { cookie: `admin=1; ${anotherCookie}` })).status, 401);
  api.replace();
  assert.deepEqual(await (await api.call(path, undefined, { cookie })).json(), { ...status, portalUrl: issuer + '/_relay/account/' }, 'a restarted Gateway can still verify the product cookie');
  assert.equal((await api.call('/api/relay/activation', { useKCoderAccount: true, relayUrl: 'https://attacker.example' }, { cookie })).status, 403);
  assert.equal((await (await api.call('/api/relay')).json()).restartRequired, true);
  assert.deepEqual(JSON.parse(await readFile(join(api.directory, 'desktop-relay.json'), 'utf8')), { url: issuer });
  const identity = JSON.parse(await readFile(resolveIdentityFile({}, api.directory), 'utf8'));

  const logout = await api.call(path, undefined, { cookie }, 'DELETE');
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.deepEqual(await (await api.call(path, undefined, { cookie })).json(), { available: true, account: null, portalUrl: issuer + '/_relay/account/' });
  assert.equal((await fetch(new URL('/_relay/account/enroll', control), { method: 'POST', headers: {
    authorization: `Bearer ${sessionProof}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ enrollmentToken: randomBytes(32).toString('hex'), gatewaySecret: randomBytes(32).toString('hex') }) })).status, 401);
  const saved = await readFile(storeFile, 'utf8');
  assert.equal(saved.includes(sessionProof) || saved.includes(invitation.code), false);
  assert.equal(JSON.parse(saved).gateways.find(gateway => gateway.id === identity.id).accountId, status.account.id);
  assert.equal(JSON.parse(saved).gateways.length, 1);
  assert.equal(JSON.parse(saved).gateways.find(gateway => gateway.id === identity.id).revokedAt, undefined);
});

test('Gateway keeps the finite account session when automatic enrollment fails', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const maxAge = 90 * 86400;
  const api = await setup(t, {
    env: { KCODER_STUDIO_RELAY_DEFAULT_URL: 'https://relay.example' },
    accountCookies: createBrowserSessionCookies({ publicOrigins: new Set() }),
    accountFetch: async () => Response.json({ account: { id: 'test', username: 'test', sessionExpiresAt: now + maxAge * 1000 } }),
    activate: async () => { throw Error('simulated enrollment failure'); },
  });
  const path = '/api/kcoder-account';
  const entry = await api.call(path);
  const cookie = `admin=1; ${entry.headers.get('set-cookie').split(';')[0]}`;
  const signedIn = await api.call(path, { invitation: 'a'.repeat(43) }, { cookie });
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).relayRegistrationFailed, true);
  assert.match(signedIn.headers.get('set-cookie'), new RegExp(`Max-Age=${maxAge}`));
});

test('account sign-out removes the local cookie when the account service is unavailable', async t => {
  const api = await setup(t, {
    env: { KCODER_STUDIO_RELAY_DEFAULT_URL: 'https://relay.example' },
    accountCookies: createBrowserSessionCookies({ publicOrigins: new Set() }),
    accountFetch: async () => { throw Error('simulated network failure'); },
  });
  const path = '/api/kcoder-account';
  const entry = await api.call(path);
  const cookie = `admin=1; ${entry.headers.get('set-cookie').split(';')[0]}`;
  const logout = await api.call(path, undefined, { cookie }, 'DELETE');
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { available: true, account: null, revocationUnconfirmed: true });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});
