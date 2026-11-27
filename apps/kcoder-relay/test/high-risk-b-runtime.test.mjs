import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRelayEnvironment, readRelayFile, relayServerConfig } from '../src/config.mjs';
import { addGatewayState, createGatewayRegistry, normalizeGatewayAddition } from '../src/server-routing.mjs';
import { verifyLocalUpdate } from '../src/update-local.mjs';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { createRelayAdministration } from '../src/admin.mjs';
import { hashAdminPassword } from '../src/admin-auth.mjs';
import { startRelay } from '../src/server.mjs';
import { startClient } from '../src/client.mjs';
import { isolatedGatewayAuthority } from '../src/gateway-origin.mjs';

test('environment and credential reads return the selected bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-env-parent-b-')); t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, 'shared'); await mkdir(parent);
  const file = join(parent, 'runtime.env'); await writeFile(file, 'MODE=owned\n');
  assert.deepEqual(parseRelayEnvironment(readRelayFile(file).bytes), { MODE: 'owned' });
});

test('a parent alias change during reading cannot redirect the held environment bytes or service reference', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-env-alias-b-')); t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, 'original'), alternate = join(root, 'alternate'), alias = join(root, 'alias');
  await mkdir(original); await mkdir(alternate); await symlink(original, alias);
  await writeFile(join(original, 'runtime.env'), 'MODE=original\n', { mode: 0o600 });
  await writeFile(join(alternate, 'runtime.env'), 'MODE=alternate\n', { mode: 0o600 });
  const read = fs.readSync; let changed = false;
  fs.readSync = function (...args) {
    if (!changed) { changed = true; fs.unlinkSync(alias); fs.symlinkSync(alternate, alias); }
    return read.apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    const held = readRelayFile(join(alias, 'runtime.env'));
    assert.equal(held.path, join(original, 'runtime.env'));
    assert.deepEqual(parseRelayEnvironment(held.bytes), { MODE: 'original' });
  } finally { fs.readSync = read; syncBuiltinESMExports(); }
});

test('a growing environment image is read only through its explicit byte budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-env-growth-b-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'runtime.env'); await writeFile(file, 'MODE=owned\n', { mode: 0o600 });
  const read = fs.readSync; let changed = false, bytes = 0;
  fs.readSync = function (...args) {
    if (!changed) { changed = true; fs.appendFileSync(file, 'x'.repeat(1024 * 1024)); }
    const count = read.apply(this, args); bytes += count; return count;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => readRelayFile(file, { limit: 128 }), /exceeds 128 bytes/); assert.ok(bytes <= 129); }
  finally { fs.readSync = read; syncBuiltinESMExports(); }
});

test('an administrator invitation forwards its explicitly requested Gateway capacity', async t => {
  let received;
  const password = 'Synthetic administrator password 0123456789';
  const admin = createRelayAdministration({ sharedHosts: new Set(['relay.example.test']), passwordHash: await hashAdminPassword(password),
    store: { async createActivationCode(input) { received = input; return { code: 'synthetic-invitation' }; } } });
  const server = createServer((incoming, response) => { if (!admin.handle(incoming, response)) { response.writeHead(404); response.end(); } });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie) => fetch(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const login = await post('/_relay/admin/api/login', { username: 'admin', password });
  assert.equal(login.status, 200); await login.text();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const invitation = await post('/_relay/admin/api/invitations', { label: 'owned', ttlMs: 60000, maxGateways: 2 }, cookie);
  assert.equal(invitation.status, 201); await invitation.text();
  assert.equal(received.signupCapacity, 2); assert.equal(received.purpose, 'register');
});

test('cookie-authenticated session deletion removes the original Relay grant before the next request', { timeout: 10000 }, async t => {
  let valid = true, validations = 0, relay, client;
  const gatewaySecret = 'b'.repeat(40), credential = 'c'.repeat(64), secret = 'a'.repeat(40);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const gateway = createServer(async (incoming, response) => {
    if (incoming.url === '/api/mobile/session/relay-validation') {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      validations++;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!valid || incoming.headers['x-kcoder-relay-validation'] !== gatewaySecret || body.credential !== credential) { response.writeHead(401); response.end(); return; }
      const expiresAt = Date.now() + 60000;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 1, kind: 'access', requestId: body.requestId, accessTokenHash: digest(credential), rpcTokenHash: 'd'.repeat(64), expiresAt, accessExpiresAt: expiresAt })); return;
    }
    incoming.resume();
    if (incoming.method === 'DELETE') { valid = false; response.writeHead(204); response.end(); return; }
    response.writeHead(200); response.end('owned API');
  });
  t.after(async () => {
    const failures = [];
    for (const cleanup of [() => client?.close(), () => relay?.close(), () => new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); })]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned cookie-grant fixture cleanup failed');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  relay = await startRelay({ gateways: [{ id: 'owned', secret, gatewaySecret }], sharedHosts: ['relay.example.test'], controlPort: 0, proxyPort: 0, connectTimeout: 1000 });
  let online;
  const ready = new Promise(resolve => { online = resolve; });
  client = startClient({ url: `http://127.0.0.1:${relay.controlPort}`, gatewayId: 'owned', secret,
    gateway: `http://127.0.0.1:${gateway.address().port}`, allowInsecure: true, retryMs: 30, onOnline: online });
  let timer;
  try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned client did not become ready')), 3000); })]); }
  finally { clearTimeout(timer); }
  const call = method => new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: relay.proxyPort, path: method === 'DELETE' ? '/g/owned/api/mobile/session' : '/g/owned/api/servers', method,
      headers: { host: isolatedGatewayAuthority('relay.example.test', 'owned'), cookie: `__Host-kcoder_studio_session=${credential}` } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject);
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Owned cookie fixture deadline')));
    outgoing.once('error', reject); outgoing.end();
  });
  assert.equal(await call('GET'), 200); assert.equal(validations, 1);
  assert.equal(await call('DELETE'), 204);
  assert.equal(await call('GET'), 401); assert.equal(validations, 2, 'the deleted Cookie grant cannot remain in the live map');
});

test('static Relay registry rejects aliases before trusting any credential or public authority', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-private-registry-b-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'registry.json');
  await writeFile(registry, JSON.stringify({ sharedHosts: ['relay.example.test'], gateways: [
    { id: 'owned', secret: 'a'.repeat(40), gatewaySecret: 'b'.repeat(40), maxConnections: 128, maxBytesPerWindow: 67108864, trafficWindowMs: 60000 },
  ] }), { mode: 0o600 });
  assert.equal(relayServerConfig({ KCODER_RELAY_REGISTRY_FILE: registry }).gateways.length, 1);
  const symbolic = join(root, 'symbolic.json'); await symlink(registry, symbolic);
  assert.throws(() => relayServerConfig({ KCODER_RELAY_REGISTRY_FILE: symbolic }), /private.*owner-owned/);
  const hard = join(root, 'hard.json'); await link(registry, hard);
  assert.throws(() => relayServerConfig({ KCODER_RELAY_REGISTRY_FILE: registry }), /single-link/);
});

test('registration requires an explicit public authority and keeps explicit mode ahead of legacy role variables', () => {
  const key = 'synthetic-registration-key-'.repeat(3);
  assert.throws(() => relayServerConfig({ KCODER_RELAY_REGISTRATION_KEY: key }), /requires KCODER_RELAY_PUBLIC_URL/);
  assert.deepEqual(relayServerConfig({ KCODER_RELAY_REGISTRATION_KEY: key, KCODER_RELAY_PUBLIC_URL: 'https://relay.example.test', KCODER_RELAY_SECRET: 'legacy'.repeat(8) }).gateways, []);
  assert.deepEqual(relayServerConfig({ KCODER_RELAY_REGISTRATION_KEY: key, KCODER_RELAY_PUBLIC_URL: 'https://relay.example.test' }).sharedHosts, ['relay.example.test']);
});

test('the live insertion point rechecks credential independence after an earlier admission', () => {
  const registry = createGatewayRegistry({ gateways: [], sharedHosts: ['relay.example.test'], allowEmpty: true });
  const first = normalizeGatewayAddition(registry, { id: 'one', secret: 'a'.repeat(40), gatewaySecret: 'b'.repeat(40) });
  const second = normalizeGatewayAddition(registry, { id: 'two', secret: 'c'.repeat(40), gatewaySecret: 'b'.repeat(40) });
  addGatewayState(registry, first);
  assert.throws(() => addGatewayState(registry, second), /independent/);
  assert.deepEqual([...registry.byId.keys()], ['one']);
});

async function healthFixture(t, { primaryFailure = false, cleanupFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-health-b-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<html>owned</html>', { mode: 0o600 });
  const publicUrl = new URL('https://relay.example.test');
  const gateway = `${publicUrl.origin}/g/owned`;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ kind: 'temporary', token: 'd'.repeat(64), expiresAt: Date.now() + 60000, publicBaseUrl: gateway,
    connectionRoutes: { version: 1, gatewayId: 'c'.repeat(64), publicKey: 'e'.repeat(64), endpoints: [{ kind: 'public', url: gateway }] } }));
  const fetch = async (url, options = {}) => {
    requests.push({ path: url.pathname, method: options.method || 'GET', body: options.body });
    if (url.pathname === '/mobile-entry') return Response.json({ version: 1, available: true, mobileUrl: `${gateway}/mobile/`, gatewayUrl: gateway });
    if (options.method === 'POST') return Response.json({ accessToken: 'synthetic-volatile-grant' });
    if (options.method === 'DELETE') { if (cleanupFailure) throw new Error('synthetic cleanup failure'); return new Response(null, { status: 204 }); }
    if (url.pathname === '/api/servers') return Response.json({ servers: primaryFailure ? [{ id: 'foreign' }] : [{ id: 'local' }] });
    if (url.pathname === '/mobile/') return new Response('<html>owned</html>');
    throw new Error('unexpected fixture request');
  };
  const plan = { gatewayId: 'owned', publicUrl, endpoint: new URL('http://127.0.0.1:1'),
    env: { KCODER_RELAY_GATEWAY_SECRET: 'x'.repeat(64), KCODER_RELAY_LOCAL_GATEWAY: 'http://127.0.0.1:1' },
    o: { mobileRoot: root, mobileManifestSha256: 'f'.repeat(64) }, manifest: { baseToken: '/owned-base', files: [{ path: 'index.html', text: false }] }, effectiveServers: [{ id: 'local' }] };
  return { plan, fetch, requests };
}

test('upgrade health uses a temporary grant and revokes only that original grant', async t => {
  const f = await healthFixture(t);
  assert.equal((await verifyLocalUpdate(f.plan, { fetch: f.fetch })).authenticated, true);
  assert.equal(JSON.parse(f.requests.find(row => row.method === 'POST').body).durableDeviceAuthorization, false);
  assert.equal(f.requests.filter(row => row.method === 'DELETE').length, 1);
});

test('health failure retains its original assertion and independent cleanup failure', async t => {
  const f = await healthFixture(t, { primaryFailure: true, cleanupFailure: true });
  await assert.rejects(verifyLocalUpdate(f.plan, { fetch: f.fetch }), error => {
    assert.match(error.message, /Gateway server configuration differs/);
    assert.match(error.cleanupError.message, /synthetic cleanup failure/);
    assert.equal(error.externalOutcome, 'unknown'); return true;
  });
  assert.equal(f.requests.filter(row => row.method === 'DELETE').length, 1);
});
