import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { openRegistrationStore } from '../src/registration-store.mjs';
import { hashAdminPassword } from '../src/admin-auth.mjs';
import { startRelay } from '../src/server.mjs';
import { checkRegisteredClientAccess, ensureRegisteredClientIdentity, startRegisteredClient } from '../src/client.mjs';
import { isolatedGatewayUrl } from '../src/gateway-origin.mjs';
import { accountPairingProofMatches, createRelayAccountEntryHandler } from '../../kcoder-studio/src/gateway-relay-auth.js';
import { requestBody } from '../../kcoder-studio/src/gateway-http-body.js';

const proof = () => ({ enrollmentToken: randomBytes(32).toString('hex'), gatewaySecret: randomBytes(32).toString('hex') });
async function directory(t) {
  const home = await mkdtemp(join(tmpdir(), 'kcoder-activation-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}

test('a registration can revoke only itself and safely retry the revocation', async t => {
  const home = await directory(t);
  const registrationStoreFile = join(home, 'store.json');
  const store = await openRegistrationStore({ path: registrationStoreFile });
  const [first, second] = await Promise.all([store.register(proof()), store.register(proof())]);
  await store.close();
  const relay = await startRelay({ gateways: [], sharedHosts: ['relay.example'], registrationStoreFile,
    registrationKey: randomBytes(32).toString('hex'), controlPort: 0, proxyPort: 0 });
  t.after(() => relay.close());
  const access = (method, id, secret) => fetch(`http://127.0.0.1:${relay.controlPort}/_relay/account/access`,
    { method, headers: { authorization: `Bearer ${secret}`, 'x-kcoder-device': id } });
  assert.equal((await access('DELETE', first.id, second.secret)).status, 401);
  assert.equal((await access('GET', first.id, first.secret)).status, 204);
  assert.equal((await access('DELETE', first.id, first.secret)).status, 204);
  assert.equal((await access('DELETE', first.id, first.secret)).status, 204);
  assert.equal((await access('GET', first.id, first.secret)).status, 401);
  assert.equal((await access('GET', second.id, second.secret)).status, 204);
});

test('one-use code consumption is atomic, concurrent redemption is isolated, and lost receipts recover across restart', async t => {
  const home = await directory(t); const path = join(home, 'store.json');
  let store = await openRegistrationStore({ path }); t.after(() => store.close());
  const legacy = await store.register(proof());
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1, 'ordinary registration preserves the old format');
  const issued = await store.createActivationCode({ label: 'Laptop' });
  const before = await readFile(path, 'utf8');
  assert.equal(before.includes(issued.code), false, 'only the activation digest is persisted');
  const input = proof();
  await assert.rejects(store.redeemActivationCode(issued.code, input, { validateGateway() { throw Error('static identity conflict'); } }), /static identity conflict/);
  assert.equal(await readFile(path, 'utf8'), before, 'a failed registry validation cannot consume the code');
  const competing = proof();
  const results = await Promise.allSettled([store.redeemActivationCode(issued.code, input), store.redeemActivationCode(issued.code, competing)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(store.list().length, 2);
  await store.close(); store = await openRegistrationStore({ path });
  assert.deepEqual(await store.redeemActivationCode(issued.code, input), results[0].value);
  assert.ok(store.list().some(gateway => gateway.id === legacy.id), 'existing registrations survive format extension');
  const state = store.managementSnapshot();
  assert.equal(JSON.stringify(state).includes(input.gatewaySecret), false);
  assert.equal(state.activationCodes[0].gatewayId, results[0].value.id);
  await store.revokeGateway(results[0].value.id);
  await assert.rejects(store.redeemActivationCode(issued.code, input), { code: 'REGISTRATION_UNAUTHORIZED' });
  await assert.rejects(store.register(input), { code: 'REGISTRATION_UNAUTHORIZED' });
  await store.close(); store = await openRegistrationStore({ path });
  assert.equal(store.list().length, 1, 'restart cannot restore a revoked transport');
});

test('expired and revoked codes cannot enroll a device', async t => {
  const home = await directory(t); const store = await openRegistrationStore({ path: join(home, 'store.json') });
  t.after(() => store.close());
  const issued = await store.createActivationCode();
  await store.revokeActivationCode(issued.id);
  await assert.rejects(store.redeemActivationCode(issued.code, proof()), { code: 'REGISTRATION_UNAUTHORIZED' });
  const expiring = await store.createActivationCode({ ttlMs: 60000 });
  t.mock.method(Date, 'now', () => expiring.expiresAt + 1);
  await assert.rejects(store.redeemActivationCode(expiring.code, proof()), { code: 'REGISTRATION_UNAUTHORIZED' });
  assert.equal(store.list().length, 0);
});

test('KCoder invitations keep their lifetime while account sessions are capped at 30 days', async t => {
  const home = await directory(t); const path = join(home, 'store.json');
  let store = await openRegistrationStore({ path }); t.after(() => store.close());
  const day = 86400000;
  let now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  const unlimited = await store.createActivationCode({ signupCapacity: 1 });
  const limited = await store.createActivationCode({ signupCapacity: 1, ttlMs: 90 * day });
  const unclaimed = await store.createActivationCode({ signupCapacity: 1, ttlMs: 90 * day });
  const neverExpires = randomBytes(32).toString('base64url');
  const expires = randomBytes(32).toString('base64url');
  assert.equal(unlimited.expiresAt, null);
  assert.equal(limited.expiresAt, now + 90 * day);
  now += day;
  const limitedSession = await store.redeemAccountInvitation(limited.code, expires);
  assert.equal(limitedSession.sessionExpiresAt, now + 30 * day);
  now += 10 * day;
  assert.ok(store.getAccountSession(expires), 'the session lifetime starts at redemption');
  now = limitedSession.sessionExpiresAt;
  assert.equal(store.getAccountSession(expires), null);
  await assert.rejects(store.registerAccountSession(expires, proof()), { code: 'REGISTRATION_UNAUTHORIZED' });
  await assert.rejects(store.redeemAccountInvitation(limited.code, expires), { code: 'REGISTRATION_UNAUTHORIZED' });

  now = unclaimed.expiresAt;
  await assert.rejects(store.redeemAccountInvitation(unclaimed.code, neverExpires), { code: 'REGISTRATION_UNAUTHORIZED' });
  const unlimitedSession = await store.redeemAccountInvitation(unlimited.code, neverExpires);
  assert.equal(unlimitedSession.sessionExpiresAt, now + 30 * day);
  now += day;
  assert.deepEqual(store.getAccountSession(neverExpires), unlimitedSession);
  await assert.rejects(store.redeemAccountInvitation(unlimited.code, expires), { code: 'REGISTRATION_UNAUTHORIZED' });
  await store.close();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 6);
  store = await openRegistrationStore({ path });
  assert.deepEqual(store.getAccountSession(neverExpires), unlimitedSession);
  await store.revokeAccountSession(neverExpires);
  assert.equal(store.getAccountSession(neverExpires), null);
});

test('legacy sessions cannot survive an upgrade and a weak account must reset before signing in', async t => {
  const home = await directory(t); const path = join(home, 'store.json');
  const now = Date.now();
  const id = randomBytes(16).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const username = 'legacy';
  const password = '123';
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 32).toString('hex')}`;
  const token = () => randomBytes(32).toString('base64url');
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const legacySession = token();
  const legacyStudioCode = token();
  const legacyCode = (code, fields) => ({
    id: randomBytes(16).toString('hex'), accountId: id, label: '', codeHash: sha256(code),
    createdAt: now - 1_000, expiresAt: now + 120_000, revokedAt: null, gatewayId: null, ...fields,
  });
  await writeFile(path, JSON.stringify({ version: 5, gateways: [],
    accounts: [{ id, username, passwordHash, maxGateways: 30, revokedAt: null }],
    activationCodes: [
      legacyCode(token(), { sessionHash: sha256(legacySession), sessionExpiresAt: now + 86_400_000 }),
      legacyCode(legacyStudioCode, { purpose: 'studio' }),
    ],
  }), { mode: 0o600 });
  const store = await openRegistrationStore({ path }); t.after(() => store.close());
  const resetRequired = { code: 'REGISTRATION_PASSWORD_RESET_REQUIRED' };
  assert.equal(store.getAccountSession(legacySession), null);
  await assert.rejects(store.redeemAccountInvitation(legacyStudioCode, token()), { code: 'REGISTRATION_UNAUTHORIZED' });
  await assert.rejects(store.signInAccount({ username, password: 'wrong' }, token()), { code: 'REGISTRATION_UNAUTHORIZED' });
  await assert.rejects(store.signInAccount({ username, password }, token()), resetRequired);
  await assert.rejects(store.issueStudioLogin({ username, password }), resetRequired);
  await assert.rejects(store.registerAccount({ username, password }, proof()), resetRequired);
  const reset = await store.createActivationCode({ accountId: id, purpose: 'register' });
  await assert.rejects(store.redeemAccountInvitation(reset.code, token(), { username, password }),
    { code: 'REGISTRATION_PASSWORD_POLICY' });
  const strong = { username, password: 'fixture-replacement-password' };
  const newSession = token();
  assert.equal((await store.redeemAccountInvitation(reset.code, newSession, strong)).id, id);
  assert.equal((await store.signInAccount(strong, token())).id, id);
  assert.equal(store.getAccountSession(legacySession), null);
});

test('issuing a KCoder invitation reclaims an expired record only when the invitation ledger is full', async t => {
  const home = await directory(t); const path = join(home, 'store.json');
  const now = Date.now();
  const records = Array.from({ length: 512 }, (_, index) => ({
    id: randomBytes(16).toString('hex'), codeHash: randomBytes(32).toString('hex'), label: '',
    createdAt: now - 120000, expiresAt: index === 0 ? now - 60000 : now + 60000,
    revokedAt: null, gatewayId: null, signupCapacity: 1,
  }));
  await writeFile(path, JSON.stringify({ version: 4, gateways: [], activationCodes: records, accounts: [] }), { mode: 0o600 });
  const store = await openRegistrationStore({ path }); t.after(() => store.close());
  const issued = await store.createActivationCode({ signupCapacity: 1 });
  const after = store.managementSnapshot().activationCodes.map(record => record.id);
  assert.deepEqual(after, [...records.slice(1).map(record => record.id), issued.id]);
  await assert.rejects(store.createActivationCode({ signupCapacity: 1 }), { code: 'REGISTRATION_CAPACITY' });
});

test('administrator login, code issuance, real enrollment, control connection and immediate revocation use one registry', async t => {
  const home = await directory(t); const storeFile = join(home, 'store.json');
  const password = 'test-only-administrator-password+&测试';
  const relay = await startRelay({ gateways: [{ id: 'static-existing', secret: randomBytes(32).toString('hex'), gatewaySecret: randomBytes(32).toString('hex') }], sharedHosts: ['relay.example'], registrationStoreFile: storeFile,
    adminPasswordHash: await hashAdminPassword(password), requireAccount: false, controlPort: 0, proxyPort: 0 });
  let client; t.after(async () => { client?.close(); await relay.close(); });
  const endpoint = `http://127.0.0.1:${relay.controlPort}`;
  assert.equal((await fetch(endpoint + '/_relay/tls-ask?domain=ssh.relay.example')).status, 403);
  assert.equal((await fetch(endpoint + '/_relay/tls-ask?domain=g-unknown.relay.example')).status, 403);
  assert.equal((await fetch(endpoint + '/_relay/tls-ask?domain=ssh.relay.example', { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 403);
  let cookie = '';
  const adminRequest = (path, input, overrides = {}) => new Promise((resolve, reject) => {
    const call = request(`${endpoint}/_relay/admin/${path}`, {
      method: input === undefined ? 'GET' : 'POST', headers: { origin: endpoint,
        'content-type': 'application/json', cookie, ...overrides } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])) })));
    });
    call.on('error', reject); call.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
  const admin = (path, input, overrides) => adminRequest('api/' + path, input, overrides);
  assert.equal((await admin('state')).status, 401);
  assert.equal((await admin('login', { username: 'admin', password }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await admin('login', { username: 'admin', password: 'incorrect' })).status, 401);
  const login = await admin('login', { username: 'admin', password });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  const formLogin = (input, origin = endpoint) => adminRequest('login',
    new URLSearchParams(input).toString(), { origin, 'content-type': 'application/x-www-form-urlencoded', cookie: '' });
  for (const path of ['', 'assets/style.css', 'assets/app.js', 'api/state']) {
    assert.equal((await adminRequest(path, undefined, { host: 'relay.example' })).status, 404);
    assert.equal((await adminRequest(path, undefined, { 'x-forwarded-for': '127.0.0.1' })).status, 404);
  }
  const getDashboard = (sessionCookie = '') => adminRequest('', undefined, { cookie: sessionCookie });
  const loginPage = await getDashboard();
  assert.equal(loginPage.headers.get('referrer-policy'), 'same-origin');
  assert.match(await loginPage.text(), /<form id="login" method="post" action="\/_relay\/admin\/login">/);
  const wrongOrigin = await formLogin({ username: 'admin', password }, 'https://attacker.example');
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.get('set-cookie'), null);
  assert.equal((await formLogin({ username: 'admin', password }, 'null')).status, 403);
  const rejected = await formLogin({ username: 'admin', password: '<incorrect>' });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('set-cookie'), null);
  assert.equal(rejected.headers.get('referrer-policy'), 'same-origin');
  const errorPage = await rejected.text();
  assert.match(errorPage, /账号或密码不正确/);
  assert.match(errorPage, /id="login"/);
  assert.ok(!errorPage.includes('<incorrect>'));
  const nativeLogin = await formLogin({ username: 'admin', password });
  assert.equal(nativeLogin.status, 303);
  assert.equal(nativeLogin.headers.get('location'), '/_relay/admin/');
  assert.match(nativeLogin.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  const dashboard = await getDashboard(nativeLogin.headers.get('set-cookie').split(';')[0]);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get('referrer-policy'), 'same-origin');
  assert.doesNotMatch(await dashboard.text(), /id="login"/);
  const portalRequest = (path, payload, session = '') => new Promise((resolve, reject) => {
    const call = request(endpoint + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { host: 'relay.example', origin: 'https://relay.example', cookie: session,
        'content-type': 'application/x-www-form-urlencoded' },
    }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])) })));
    });
    call.on('error', reject);
    call.end(payload === undefined ? undefined : new URLSearchParams(payload).toString());
  });
  const inviteResponse = await admin('invitations', { label: 'KCoder user', ttlMs: 90 * 86400000 });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  assert.equal(invite.loginLink, `https://relay.example/_relay/signup#code=${invite.code}`);
  assert.equal((await (await admin('state')).json()).accounts.length, 0);
  const studioProof = randomBytes(32).toString('base64url');
  const studioSignIn = code => fetch(`${endpoint}/_relay/account/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${code}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionToken: studioProof }),
  });
  assert.equal((await studioSignIn(invite.code)).status, 401, 'a signup invitation cannot sign in to Studio');
  const signupPage = await portalRequest('/_relay/signup');
  const invitationField = (await signupPage.text()).match(/<input id="code"[^>]*>/)[0];
  assert.doesNotMatch(invitationField, /maxlength/);
  const foreignLink = invite.loginLink.replace('relay.example', 'attacker.example');
  assert.equal((await portalRequest('/_relay/signup', { code: foreignLink, username: '123', password: 'fixture-strong-password' })).status, 401);
  assert.equal((await portalRequest('/_relay/signup', { code: invite.code, username: '123', password: '123' })).status, 400);
  const registered = await portalRequest('/_relay/signup', { code: ' ' + invite.loginLink + ' ', username: '123', password: 'fixture-strong-password' });
  assert.equal(registered.status, 303);
  const registrationCookie = registered.headers.get('set-cookie').split(';')[0];
  assert.equal((await portalRequest('/_relay/signup', { code: invite.code, username: 'other', password: 'fixture-strong-password' })).status, 401);
  const passwordLogin = await portalRequest('/_relay/account/login', { username: '123', password: 'fixture-strong-password' });
  assert.equal(passwordLogin.status, 303);
  const cookieAge = Number(/Max-Age=(\d+)/.exec(passwordLogin.headers.get('set-cookie'))?.[1]);
  assert.ok(cookieAge >= 2_591_990 && cookieAge <= 2_592_000);
  const portalCookie = passwordLogin.headers.get('set-cookie').split(';')[0];
  assert.notEqual(portalCookie, registrationCookie);
  const portalPage = await portalRequest('/_relay/account/', undefined, portalCookie);
  const signedInPage = await portalPage.text();
  assert.match(signedInPage, /已登录 123/);
  assert.doesNotMatch(signedInPage, /获取 Studio 登录码/);
  assert.match(await (await portalRequest('/_relay/account/', undefined, portalCookie)).text(), /已登录 123/);
  assert.equal((await portalRequest('/_relay/account/connect', { gatewayId: 'static-existing' }, portalCookie)).status, 404);
  assert.equal((await portalRequest('/_relay/account/studio', {}, portalCookie)).status, 404);
  const credentials = input => new Promise((resolve, reject) => {
    const call = request(endpoint + '/_relay/account/studio-login', {
      method: 'POST',
      headers: { host: 'relay.example', origin: 'https://studio.example',
        'content-type': 'application/x-www-form-urlencoded' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode, cors: response.headers['access-control-allow-origin'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    call.on('error', reject);
    call.end(new URLSearchParams(input).toString());
  });
  assert.equal((await credentials({ username: '123', password: 'wrong' })).status, 401);
  const handoff = await credentials({ username: '123', password: 'fixture-strong-password' });
  assert.equal(handoff.status, 200);
  assert.equal(handoff.cors, '*');
  const { code } = handoff.body;
  const signedIn = await studioSignIn(code);
  assert.equal(signedIn.status, 200);
  const { account } = await signedIn.json();
  assert.equal(account.username, '123');
  assert.equal((await (await admin('state')).json()).accounts[0].id, account.id);
  assert.match(signedInPage, /当前会话到期时间/);
  const unusedHandoff = await credentials({ username: '123', password: 'fixture-strong-password' });
  assert.equal(unusedHandoff.status, 200);
  assert.equal((await portalRequest('/_relay/account/revoke-other-sessions', {}, portalCookie)).status, 303);
  assert.match(await (await portalRequest('/_relay/account/', undefined, portalCookie)).text(), /已登录 123/);
  assert.match(await (await portalRequest('/_relay/account/', undefined, registrationCookie)).text(), /登录 KCoder/);
  assert.equal((await fetch(endpoint + '/_relay/account/session', {
    headers: { authorization: `Bearer ${studioProof}` },
  })).status, 401);
  assert.equal((await studioSignIn(unusedHandoff.body.code)).status, 401);
  const secondHandoff = await credentials({ username: '123', password: 'fixture-strong-password' });
  assert.equal((await studioSignIn(secondHandoff.body.code)).status, 200);
  const reset = await (await admin(`accounts/${account.id}/login-codes`, {})).json();
  assert.equal((await portalRequest('/_relay/signup', { code: reset.code, username: '123', password: 'fixture-reset-password' })).status, 303);
  assert.equal((await portalRequest('/_relay/account/login', { username: '123', password: 'fixture-strong-password' })).status, 401);
  assert.equal((await portalRequest('/_relay/account/login', { username: '123', password: 'fixture-reset-password' })).status, 303);
  assert.equal((await fetch(`${endpoint}/_relay/account/session`, {
    headers: { authorization: `Bearer ${studioProof}` },
  })).status, 401, 'password reset revokes existing account sessions');
  assert.equal((await admin(`accounts/${account.id}/revoke`, {})).status, 200);
  assert.equal((await portalRequest('/_relay/account/login', { username: '123', password: 'fixture-reset-password' })).status, 401);

  const response = await admin('codes', { label: 'My computer', ttlMs: 60000 });
  assert.equal(response.status, 201); const issued = await response.json();
  assert.equal(new URL(issued.activationLink).search, '');
  const identityFile = join(home, 'desktop.json'); const input = proof();
  const options = { url: endpoint, activationCode: issued.code, gatewaySecret: input.gatewaySecret, identityFile, allowInsecure: true };
  let committed;
  await assert.rejects(ensureRegisteredClientIdentity({ ...options, fetchImpl: async (url, init) => {
    const response = await fetch(url, init); assert.equal(response.status, 201); committed = await response.clone().json();
    await response.body.cancel(); throw Error('lost registration response');
  } }), /registration request failed/);
  const restored = await ensureRegisteredClientIdentity(options);
  assert.equal(restored.id, committed.id);
  const second = await fetch(`${endpoint}/_relay/activate-device`, { method: 'POST',
    headers: { authorization: `Bearer ${issued.code}`, 'content-type': 'application/json' }, body: JSON.stringify(proof()) });
  assert.equal(second.status, 401);
  let online; const ready = new Promise(resolve => { online = resolve; });
  client = await startRegisteredClient({ ...options, activationCode: undefined, gateway: 'http://127.0.0.1:1', onOnline: online });
  await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('control did not connect')), 3000); timer.unref(); })]);
  let state = await (await admin('state')).json();
  assert.equal(state.gateways.find(gateway => gateway.id === restored.id).online, true);
  assert.equal(state.gateways.find(gateway => gateway.id === 'static-existing').readOnly, true);
  assert.equal(JSON.stringify(state).includes(restored.secret), false);
  assert.equal((await admin(`gateways/${restored.id}/revoke`, {})).status, 200);
  state = await (await admin('state')).json();
  assert.equal(state.gateways.find(gateway => gateway.id === restored.id).online, false);
  assert.ok(state.gateways.find(gateway => gateway.id === restored.id).revokedAt);
  assert.equal((await admin('logout', {})).status, 200);
  assert.equal((await admin('state')).status, 401);
});

test('Relay accounts own enrollment without a per-account quota and revoke only their Gateways', async t => {
  const home = await directory(t);
  const storeFile = join(home, 'store.json');
  const registrationKey = randomBytes(32).toString('base64url');
  const adminPassword = 'isolated-administrator-password';
  const accountPassword = 'isolated:account-password';
  const legacy = proof();
  let store = await openRegistrationStore({ path: storeFile });
  const oldIdentity = await store.register(legacy);
  const oldCode = await store.createActivationCode();
  const alice = await store.createAccount({ username: 'alice', password: accountPassword, maxGateways: 2 });
  const bob = await store.createAccount({ username: 'bob', maxGateways: 1 });
  const legacyAliceCode = await store.createActivationCode({ accountId: alice.id, ttlMs: 86400000 });
  const legacyBobCode = await store.createActivationCode({ accountId: bob.id, ttlMs: 86400000 });
  await store.close();
  const options = { gateways: [], sharedHosts: ['relay.example'], registrationStoreFile: storeFile,
    registrationKey, adminPasswordHash: await hashAdminPassword(adminPassword), controlPort: 0, proxyPort: 0 };
  let relay = await startRelay(options);
  let client;
  t.after(async () => { client?.close(); await relay.close(); });
  const base = () => `http://127.0.0.1:${relay.controlPort}`;
  let cookie;
  function relayRequest(path, { method = 'GET', headers, body } = {}) {
    return new Promise((resolve, reject) => {
      const call = request(base() + path, { method, headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
          headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])) })));
      });
      call.on('error', reject);
      call.end(body);
    });
  }
  async function admin(path, input) {
    const response = await relayRequest('/_relay/admin/api/' + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { origin: base(),
        'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  const auth = await admin('login', { username: 'admin', password: adminPassword });
  assert.equal(auth.status, 200);
  cookie = auth.cookie.split(';')[0];
  assert.equal((await admin('codes', {})).status, 404);
  const aInvite = { body: legacyAliceCode };
  const bInvite = { body: legacyBobCode };
  const bearer = token => 'Bearer ' + token;
  const basic = (username, password) => 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const enroll = async (authorization, input, path = '/_relay/account/register', proxyHeaders = {}) => {
    const response = await relayRequest(path, { method: 'POST', body: JSON.stringify(input),
      headers: { authorization, 'content-type': 'application/json', ...proxyHeaders } });
    const value = response.ok ? await response.json() : (await response.text(), null);
    return { status: response.status, value, error: response.headers.get('x-kcoder-relay-error') };
  };
  assert.equal((await enroll(bearer(registrationKey), proof(), '/_relay/register')).status, 401);
  assert.equal((await enroll(bearer(oldCode.code), proof(), '/_relay/activate-device')).status, 401);
  assert.equal((await enroll(bearer(registrationKey), legacy, '/_relay/register')).value.id, oldIdentity.id);
  assert.equal((await enroll(bearer(aInvite.body.code), proof(), '/_relay/activate-device')).status, 401);
  assert.equal((await enroll(bearer(oldCode.code), proof())).status, 401);
  assert.equal((await enroll(basic('alice', 'incorrect-password'), proof())).status, 401);
  for (let attempt = 0; attempt < 12; attempt++) {
    assert.equal((await enroll(basic('unknown', accountPassword), proof())).status, 401);
  }
  assert.equal((await enroll(basic('unknown', accountPassword), proof())).status, 429);
  const proxied = { host: 'relay.example', 'x-forwarded-host': 'relay.example', 'x-forwarded-proto': 'https' };
  for (let attempt = 0; attempt < 12; attempt++) {
    assert.equal((await enroll(basic('unknown', accountPassword), proof(), undefined,
      { ...proxied, 'x-forwarded-for': '198.51.100.10' })).status, 401);
  }
  assert.equal((await enroll(basic('unknown', accountPassword), proof(), undefined,
    { ...proxied, 'x-forwarded-for': '198.51.100.10' })).status, 429);
  assert.equal((await enroll(basic('unknown', accountPassword), proof(), undefined,
    { ...proxied, 'x-forwarded-for': '198.51.100.20' })).status, 401);
  assert.equal((await enroll(basic('unknown', accountPassword), proof(), undefined,
    { ...proxied, 'x-forwarded-for': '198.51.100.10, 198.51.100.20' })).status, 429);
  const firstInput = proof();
  const first = await enroll(bearer(aInvite.body.code), firstInput);
  assert.equal(first.status, 201);
  assert.equal((await enroll(bearer(aInvite.body.code), proof())).status, 401);
  assert.deepEqual((await enroll(bearer(aInvite.body.code), firstInput)).value, first.value);
  assert.equal((await enroll(bearer(bInvite.body.code), firstInput)).status, 401);
  const aliceOptions = { url: base(), allowInsecure: true,
    accountCredentials: { username: 'alice', password: accountPassword },
    gatewaySecret: proof().gatewaySecret, identityFile: join(home, 'client-identity.json') };
  const second = await ensureRegisteredClientIdentity(aliceOptions);
  assert.equal(await checkRegisteredClientAccess(aliceOptions), 'authorized');
  assert.deepEqual(await ensureRegisteredClientIdentity({ ...aliceOptions, accountCredentials: undefined }), second);
  assert.equal((await enroll(basic('alice', accountPassword), proof())).status, 201);
  assert.equal((await admin(`gateways/${oldIdentity.id}/account`, { accountId: bob.id })).status, 200);
  assert.equal((await admin(`gateways/${oldIdentity.id}/account`, { accountId: alice.id })).status, 400);
  const bobGateway = await enroll(bearer(bInvite.body.code), proof());
  assert.equal(bobGateway.status, 201);
  assert.equal((await enroll(bearer(registrationKey), legacy, '/_relay/register')).status, 401);
  const snapshot = (await admin('state')).body;
  assert.equal(snapshot.gateways.find(g => g.id === oldIdentity.id).accountId, bob.id);
  const persisted = await readFile(storeFile, 'utf8');
  assert.equal(JSON.parse(persisted).version, 3);
  for (const secret of [aInvite.body.code, bInvite.body.code, accountPassword]) {
    assert.ok(!persisted.includes(secret));
    assert.ok(!JSON.stringify(snapshot).includes(secret));
  }
  assert.ok(!JSON.stringify(snapshot).includes('scrypt$'));
  let online, rejected;
  const connected = new Promise(resolve => { online = resolve; });
  const disconnected = new Promise(resolve => { rejected = resolve; });
  let pairingProof;
  const blockedSurfaces = new Set();
  const accountEntry = createRelayAccountEntryHandler({
    secret: aliceOptions.gatewaySecret,
    publicPrefix: () => `/g/${second.id}`,
    requestBody,
    jsonResponse: (response, status, body) => response.writeHead(status).end(JSON.stringify(body)),
    browserCookie: async (_request, admin) => `__Host-kcoder_studio_session=${admin ? 'desktop' : 'mobile'}; Secure; HttpOnly; Path=/`,
  });
  const gateway = createServer(async (incoming, response) => {
    if (await accountEntry(incoming, response, new URL(incoming.url, 'http://localhost'))) return;
    if (incoming.url === '/api/mobile/session/relay-validation') {
      const { kind, credential } = JSON.parse(await requestBody(incoming));
      response.writeHead(kind !== 'public-surface' ? 400 : blockedSurfaces.has(credential) ? 403 : 204).end();
      return;
    }
    if (incoming.url === '/api/mobile/session') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const { token } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const received = incoming.headers['x-kcoder-relay-account-pairing'];
      pairingProof = received;
      if (!accountPairingProofMatches(aliceOptions.gatewaySecret, token, received) &&
          !accountPairingProofMatches(aliceOptions.gatewaySecret, token, received, 'mobileWeb')) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accessToken: randomBytes(32).toString('hex'), rpcToken: 'cookie-auth', expiresAt: Date.now() + 60_000 }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('open');
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  client = await startRegisteredClient({ ...aliceOptions, accountCredentials: undefined,
    gateway: `http://127.0.0.1:${gateway.address().port}`,
    retryMs: 30, onOnline: online, onDiagnostic(event) {
      if (event.event === 'control_error' && event.handshakeStatus === 401) rejected();
    } });
  await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(Error('no control connection')), 3000).unref())]);
  const portal = (path, payload, session) => relayRequest(path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { host: 'relay.example', origin: 'https://relay.example', cookie: session || '',
      'content-type': 'application/x-www-form-urlencoded' },
    body: payload === undefined ? undefined : new URLSearchParams(payload).toString(),
  });
  const webLogin = await portal('/_relay/account/login', { username: 'alice', password: accountPassword });
  assert.equal(webLogin.status, 303);
  const browserCookie = webLogin.headers.get('set-cookie').split(';')[0];
  const owned = await (await portal('/_relay/account/', undefined, browserCookie)).text();
  assert.ok(owned.includes(second.id));
  assert.ok(!owned.includes(bobGateway.value.id));
  assert.match(owned, /打开桌面 Web/);
  assert.match(owned, /打开移动 Web/);
  assert.doesNotMatch(owned, /打开手机 App/);
  const openPath = '/_relay/account/open';
  assert.equal((await portal(openPath, { gatewayId: second.id, surface: 'desktop' })).status, 401);
  assert.equal((await portal(openPath, { gatewayId: bobGateway.value.id, surface: 'desktop' }, browserCookie)).status, 404);
  blockedSurfaces.add('mobileApp');
  assert.equal((await portal('/_relay/account/connect', { gatewayId: second.id }, browserCookie)).status, 403);
  assert.equal((await portal(openPath, { gatewayId: second.id, surface: 'mobile' }, browserCookie)).status, 200);
  blockedSurfaces.clear();
  const openWeb = async surface => {
    const page = await portal(openPath, { gatewayId: second.id, surface }, browserCookie);
    assert.equal(page.status, 200);
    const html = await page.text();
    const target = new URL(html.match(/action="([^"]+)"/)[1]);
    assert.equal(target.href, new URL('account-entry', isolatedGatewayUrl('https://relay.example', second.id)).href);
    assert.match(page.headers.get('cache-control'), /no-store/);
    return { target, proof: html.match(/name="proof" value="([^"]+)"/)[1], surface };
  };
  function followWeb({ target, proof, surface }, { origin = 'https://relay.example', suffix = '', ...headers } = {}) {
    return new Promise((resolve, reject) => {
      const call = request(`http://127.0.0.1:${relay.proxyPort}${target.pathname}${suffix}`, {
        method: 'POST', headers: { host: target.host, origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      call.on('error', reject);
      call.setTimeout(3000, () => call.destroy(Error('web entry timed out')));
      call.end(new URLSearchParams({ proof, surface }).toString());
    });
  }
  const desktop = await openWeb('desktop');
  assert.equal((await followWeb(desktop, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await followWeb(desktop, { suffix: '?token=extra' })).status, 403);
  assert.equal((await followWeb({ ...desktop, surface: 'mobile' })).status, 401);
  const entered = await followWeb(desktop, { 'x-kcoder-relay-account-entry': '0'.repeat(64) });
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.location, `/g/${second.id}/`);
  assert.match(entered.headers['set-cookie'][0], /^__Host-kcoder_studio_session=desktop;/);
  assert.equal((await followWeb(desktop)).status, 401, 'browser handoffs are single use');
  assert.equal((await portal('/_relay/account/connect', { gatewayId: bobGateway.value.id }, browserCookie)).status, 404);
  const openMobile = async () => {
    const page = await portal('/_relay/account/connect', { gatewayId: second.id }, browserCookie);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /kcoder-studio:\/\/connect/);
    return html.match(/token=(kcacct1_[A-Za-z0-9_-]{43})/)[1];
  };
  const pair = (token, injectedProof) => new Promise((resolve, reject) => {
    const call = request(`http://127.0.0.1:${relay.proxyPort}/g/${second.id}/api/mobile/session`, {
      method: 'POST', headers: { host: isolatedGatewayUrl('https://relay.example', second.id).host,
        'content-type': 'application/json', ...(injectedProof ? { 'x-kcoder-relay-account-pairing': injectedProof } : {}) },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    call.setTimeout(3000, () => call.destroy(Error('mobile pair timed out')));
    call.on('error', reject);
    call.end(JSON.stringify({ token, durableDeviceAuthorization: true }));
  });
  const oneUse = await openMobile();
  assert.equal(await pair(oneUse), 200);
  assert.equal(await pair(oneUse, pairingProof), 401, 'a consumed proof cannot be forwarded again');
  assert.equal(await pair('ordinary-invalid-token', pairingProof), 401);
  assert.equal(pairingProof, undefined, 'external proof headers are stripped');
  const enteredMobile = await followWeb(await openWeb('mobile'));
  assert.equal(enteredMobile.status, 200);
  assert.match(enteredMobile.headers['set-cookie'][0], /^__Host-kcoder_studio_session=mobile;/);
  assert.match(enteredMobile.body, /sessionStorage\.setItem/);
  assert.match(enteredMobile.body, /location\.replace\("\/g\/[^/]+\/mobile\/connect\?gateway=/);
  assert.doesNotMatch(enteredMobile.body, /[?#&]token=/);
  assert.equal(await pair(enteredMobile.body.match(/kcacct1_[A-Za-z0-9_-]{43}/)[0]), 200);
  assert.equal(accountPairingProofMatches(aliceOptions.gatewaySecret, enteredMobile.body.match(/kcacct1_[A-Za-z0-9_-]{43}/)[0], pairingProof, 'mobileWeb'), true);
  const pendingPair = await openMobile();
  const pendingWeb = await openWeb('desktop');
  assert.equal((await portal('/_relay/account/logout', {}, browserCookie)).status, 303);
  assert.equal(await pair(pendingPair), 401, 'account logout invalidates outstanding mobile handoffs');
  assert.equal((await followWeb(pendingWeb)).status, 401, 'account logout invalidates outstanding web handoffs');
  const streaming = await new Promise((resolve, reject) => {
    const call = request(`http://127.0.0.1:${relay.proxyPort}/g/${second.id}/`, {
      headers: { host: isolatedGatewayUrl('https://relay.example', second.id).host },
    }, response => { call.setTimeout(0); resolve(response); });
    call.on('error', reject);
    call.setTimeout(3000, () => call.destroy(Error('no active Relay stream')));
    call.end();
  });
  assert.equal(streaming.statusCode, 200);
  const streamClosed = new Promise(resolve => streaming.once('close', resolve));
  streaming.resume();
  assert.equal((await admin(`accounts/${alice.id}/revoke`, {})).status, 200);
  assert.equal(await checkRegisteredClientAccess(aliceOptions), 'denied');
  await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(Error('no revocation rejection')), 3000).unref())]);
  await Promise.race([streamClosed, new Promise((_, reject) => setTimeout(() => reject(Error('active Relay stream survived revocation')), 3000).unref())]);
  assert.equal(streaming.complete, false);
  assert.equal((await enroll(bearer(aInvite.body.code), firstInput)).status, 401);
  assert.equal((await enroll(basic('alice', accountPassword), proof())).status, 401);
  client.close();
  await relay.close();
  relay = await startRelay(options);
  assert.equal((await enroll(basic('alice', accountPassword), proof())).status, 401);
  await relay.close();
  store = await openRegistrationStore({ path: storeFile });
  try { assert.deepEqual(store.list().map(gateway => gateway.id), [oldIdentity.id, bobGateway.value.id]); } finally { await store.close(); }
});
