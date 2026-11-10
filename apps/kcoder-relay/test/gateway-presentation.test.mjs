import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isolatedGatewayUrl } from '../src/gateway-origin.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const gatewaySecret = 'owned-presentation-pairing-token-'.repeat(2);
const relayOrigin = 'https://relay.example';
const assignedUrl = isolatedGatewayUrl(relayOrigin, 'assigned-id');
const gatewayOrigin = assignedUrl.origin;
const gatewayHost = assignedUrl.host;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kc-relay-presentation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityFile = join(root, 'identity.json');
  const identity = JSON.stringify({ version: 1, relayOrigin, gatewaySecretHash: sha(gatewaySecret), id: 'assigned-id', secret: 'owned-identity-secret-'.repeat(3) });
  await writeFile(identityFile, identity, { mode: 0o600 });
  return { root, identityFile, identity };
}

for (const entry of ['source', 'relay']) for (const fixedMobileToken of ['', 'owned-fixed-mobile-token-'.repeat(3)])
test(`owned ${entry} Gateway preserves routing and independent fixed/temporary mobile pairing (fixed=${Boolean(fixedMobileToken)})`, async t => {
  const f = await fixture({ after() {} }); let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; }
    await rm(f.root, { recursive: true, force: true });
    t.diagnostic(`owned wrapper pid=${child?.pid} closed; owned state removed`);
  });
  await writeFile(join(f.root, 'servers.json'), JSON.stringify([{ id: 'local', label: 'Owned target', transport: 'local', workspace: f.root }]));
  const mobileRoot = join(f.root, 'mobile'); await mkdir(mobileRoot);
  const baseToken = '/__kcoder_mobile_mount_v1__';
  const html = `<html><script src="${baseToken}/app.js"></script></html>`;
  await writeFile(join(mobileRoot, 'index.html'), html);
  await writeFile(join(mobileRoot, 'kcoder-mobile-web.json'), JSON.stringify({ version: 1, baseToken, files: [
    { path: 'index.html', size: Buffer.byteLength(html), sha256: sha(html), text: true, replacements: 1 },
  ] }));
  child = spawn(process.execPath, [entry === 'relay' ? 'apps/kcoder-relay/src/gateway.mjs' : 'apps/kcoder-studio/dev-server.mjs'], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    env: { PATH: process.env.PATH, NODE_ENV: 'test', HOME: f.root, XDG_CONFIG_HOME: f.root,
      KCODER_RELAY_ENV_FILE: join(f.root, 'absent.env'), KCODER_RELAY_CONFIG_DIR: join(f.root, 'profile'),
      KCODER_RELAY_SERVERS_FILE: join(f.root, 'servers.json'),
      KCODER_RELAY_IDENTITY_FILE: f.identityFile, KCODER_RELAY_REGISTRATION_KEY: 'owned-registration-key-'.repeat(3),
      KCODER_RELAY_PUBLIC_URL: relayOrigin, KCODER_RELAY_GATEWAY_SECRET: gatewaySecret,
      KCODER_RELAY_DEVICE_ID: 'legacy-id', KCODER_RELAY_GATEWAY_ID: 'another-legacy-id',
      KCODER_RELAY_LOCAL_GATEWAY: 'http://127.0.0.1:0', KCODER_STUDIO_MOBILE_WEB_ROOT: mobileRoot,
      KCODER_STUDIO_SERVERS_STORE: join(f.root, 'servers.json'), KCODER_STUDIO_WORKSPACE: f.root,
      KCODER_STUDIO_WEB_ROOT: f.root, KCODER_STUDIO_MOBILE_PAIRING_TOKEN: fixedMobileToken,
      KCODER_CONFIG_DIR: join(f.root, 'profile'), KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
      KCODER_STUDIO_SERVERS_FILE: join(f.root, 'servers.json'), KCODER_STUDIO_RELAY_SECRET: gatewaySecret,
      KCODER_STUDIO_PUBLIC_ORIGINS: gatewayOrigin, KCODER_STUDIO_PUBLIC_ACCESS_URL: gatewayOrigin + '/g/assigned-id' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const base = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Owned wrapper startup timeout')), 120_000);
    child.once('close', () => { clearTimeout(timer); reject(new Error('Owned wrapper exited before ready: ' + stderr.replaceAll(gatewaySecret, '[redacted]').replaceAll('owned-registration-key-'.repeat(3), '[redacted]').replaceAll('owned-identity-secret-'.repeat(3), '[redacted]'))); });
    child.stdout.on('data', bytes => { output += bytes; const match = output.match(/KCoder Studio: (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  assert.equal(new URL(base).hostname, '127.0.0.1', 'the Relay Gateway keeps HTTP on loopback');
  const listeningPort = Number(new URL(base).port);
  const call = (headers, path = '/mobile-entry', method = 'GET', body) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: listeningPort, path, method, headers, timeout: 5000 }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    }); req.once('timeout', () => req.destroy(new Error('Owned request timeout'))); req.once('error', reject); req.end(body);
  });
  const expected = { version: 1, available: true, gatewayUrl: `${gatewayOrigin}/g/assigned-id`, mobileUrl: `${gatewayOrigin}/g/assigned-id/mobile/` };
  const legacy = await call({ host: gatewayHost }); assert.equal(legacy.status, 200); assert.deepEqual(JSON.parse(legacy.body), expected);
  const prefix = '/g/assigned-id';
  const signed = await call({ host: gatewayHost, 'x-kcoder-mobile-mount': prefix,
    'x-kcoder-mobile-mount-proof': createHmac('sha256', gatewaySecret).update(JSON.stringify(['kcoder-mobile-mount-v1', gatewayHost, prefix])).digest('hex') });
  assert.equal(signed.status, 200); assert.deepEqual(JSON.parse(signed.body), expected);
  const direct = await call({}); assert.equal(JSON.parse(direct.body).gatewayUrl, `http://127.0.0.1:${listeningPort}`);
  const anonymousApi = await call({ host: gatewayHost, origin: gatewayOrigin }, '/api/servers');
  assert.equal(anonymousApi.status, 401, 'Gateway API authentication remains enabled');
  const peerCapability = await call({ host: gatewayHost, origin: gatewayOrigin }, '/api/mobile/p2p');
  assert.equal(peerCapability.status, 200, 'P2P is available without an opt-in flag when the installed RTC module loads');
  // The relay wrapper keeps STUN on the shared Relay hostname; a bare Gateway derives it from its public URL.
  assert.deepEqual(JSON.parse(peerCapability.body).stunUrls, [`stun:${entry === 'relay' ? 'relay.example' : assignedUrl.hostname}:8452`]);
  const denied = await call({ host: gatewayHost, origin: gatewayOrigin, 'content-type': 'application/json' },
    '/api/mobile/session', 'POST', JSON.stringify({ token: gatewaySecret, durableDeviceAuthorization: true }));
  assert.equal(denied.status, 401, 'the private internal credential cannot pair a phone');
  const pairingResponse = await call({ 'x-kcoder-relay-validation': gatewaySecret }, '/api/mobile/pairing/relay');
  assert.equal(pairingResponse.status, 200);
  const pairing = JSON.parse(pairingResponse.body);
  assert.notEqual(pairing.token, gatewaySecret);
  assert.equal(pairing.kind, fixedMobileToken ? 'fixed' : 'temporary');
  if (fixedMobileToken) {
    assert.equal(pairing.token, fixedMobileToken); assert.equal(pairing.expiresAt, null);
    const admin = await call({ host: gatewayHost }, '/login?token=' + fixedMobileToken);
    assert.equal(admin.status, 303); assert.ok(admin.headers.location.includes('linkError'));
    assert.equal(admin.headers['set-cookie'], undefined, 'mobile pairing does not authorize browser administration');
    const directApi = await call({ host: gatewayHost, authorization: 'Bearer ' + fixedMobileToken }, '/api/servers');
    assert.equal(directApi.status, 401, 'pairing must first exchange for a device session');
  }
  const externalPairing = await call({ host: gatewayHost, 'x-kcoder-relay-validation': gatewaySecret }, '/api/mobile/pairing/relay');
  assert.equal(externalPairing.status, 404, 'the public authority cannot obtain a pairing token');
  const sessionResponse = await call({ host: gatewayHost, origin: gatewayOrigin, 'content-type': 'application/json' },
    '/api/mobile/session', 'POST', JSON.stringify({ token: pairing.token, durableDeviceAuthorization: true }));
  assert.equal(sessionResponse.status, 200, 'the Gateway-generated dynamic token pairs a phone without a fixed login token');
  const session = JSON.parse(sessionResponse.body);
  assert.deepEqual(session.connectionRoutes.endpoints, [{ kind: 'public', url: `${gatewayOrigin}/g/assigned-id` }], 'only the public endpoint is advertised for P2P and Relay');
  const authenticatedApi = await call({ host: gatewayHost, origin: gatewayOrigin, authorization: `Bearer ${session.accessToken}` }, '/api/servers');
  assert.equal(authenticatedApi.status, 200, 'the temporary Gateway session remains the protected API credential');
  const deletedSession = await call({ host: gatewayHost, origin: gatewayOrigin, authorization: `Bearer ${session.accessToken}` }, '/api/mobile/session', 'DELETE');
  assert.equal(deletedSession.status, 204, 'the wrapper permits exact temporary session cleanup');
  const temporaryResponse = await call({ 'x-kcoder-relay-validation': gatewaySecret, 'x-kcoder-pairing-token-mode': 'temporary' }, '/api/mobile/pairing/relay');
  assert.equal(temporaryResponse.status, 200);
  const temporary = JSON.parse(temporaryResponse.body); assert.equal(temporary.kind, 'temporary');
  assert.ok(temporary.expiresAt > Date.now()); if (fixedMobileToken) assert.notEqual(temporary.token, fixedMobileToken);
  const pairedTemporary = await call({ host: gatewayHost, origin: gatewayOrigin, 'content-type': 'application/json' }, '/api/mobile/session', 'POST', JSON.stringify({ token: temporary.token, durableDeviceAuthorization: true }));
  assert.equal(pairedTemporary.status, 200, 'temporary pairing remains available alongside fixed credentials');
  assert.equal((await call({ host: gatewayHost, authorization: 'Bearer ' + JSON.parse(pairedTemporary.body).accessToken }, '/api/mobile/session', 'DELETE')).status, 204);
  assert.equal(await readFile(f.identityFile, 'utf8'), f.identity);
});

test('presentation selection covers registered, existing identity and static legacy/path modes without rewriting identity', async t => {
  const f = await fixture(t);
  const { resolveGatewayPresentation } = await import('../src/gateway-presentation.mjs');
  const base = { KCODER_RELAY_PUBLIC_URL: relayOrigin, KCODER_RELAY_GATEWAY_SECRET: gatewaySecret };
  const registered = { gatewayId: 'assigned-id', routeMode: 'path', publicAccessUrl: `${gatewayOrigin}/g/assigned-id` };
  for (const env of [
    { ...base, KCODER_RELAY_REGISTRATION_KEY: 'registration-key-'.repeat(3), KCODER_RELAY_DEVICE_ID: 'legacy-id', KCODER_RELAY_GATEWAY_ID: 'conflicting-legacy' },
    { ...base, KCODER_RELAY_IDENTITY_FILE: f.identityFile, KCODER_RELAY_DEVICE_ID: 'legacy-id' },
    base,
  ]) assert.deepEqual(await resolveGatewayPresentation(env, { identityFile: f.identityFile, identityExists: path => { assert.equal(path, f.identityFile); return true; } }), registered);
  for (const [routeMode, expected] of [[undefined, relayOrigin], ['legacy', relayOrigin], ['path', `${isolatedGatewayUrl(relayOrigin, 'static-id').origin}/g/static-id`]]) {
    assert.deepEqual(await resolveGatewayPresentation({ ...base, KCODER_RELAY_DEVICE_ID: 'static-id', KCODER_RELAY_ROUTE_MODE: routeMode }, { identityFile: f.identityFile, identityExists: () => false }),
      { gatewayId: 'static-id', routeMode: routeMode || 'legacy', publicAccessUrl: expected });
  }
  await assert.rejects(resolveGatewayPresentation({ ...base, KCODER_RELAY_IDENTITY_FILE: f.identityFile, KCODER_RELAY_ROUTE_MODE: 'legacy' }), /requires path/);
  await assert.rejects(resolveGatewayPresentation({ ...base, KCODER_RELAY_IDENTITY_FILE: f.identityFile, KCODER_STUDIO_PUBLIC_ACCESS_URL: `${relayOrigin}/g/legacy-id` }), /conflicts/);
  await assert.rejects(resolveGatewayPresentation({ ...base, KCODER_RELAY_IDENTITY_FILE: f.identityFile, KCODER_RELAY_GATEWAY_SECRET: 'different-pairing-token-'.repeat(3) }), /different Gateway/);
  assert.equal(await readFile(f.identityFile, 'utf8'), f.identity);
});

test('owned wrapper fails closed before Gateway spawn when its registered identity is unavailable', async t => {
  const f = await fixture(t);
  for (const identityFile of [join(f.root, 'missing.json'), f.identityFile]) {
    if (identityFile === f.identityFile) await writeFile(identityFile, '{}');
    const child = spawn(process.execPath, ['apps/kcoder-relay/src/gateway.mjs'], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)), env: {
        PATH: process.env.PATH, HOME: f.root, KCODER_RELAY_ENV_FILE: join(f.root, 'absent.env'),
        KCODER_RELAY_IDENTITY_FILE: identityFile, KCODER_RELAY_PUBLIC_URL: relayOrigin,
        KCODER_RELAY_GATEWAY_SECRET: gatewaySecret, KCODER_RELAY_DEVICE_ID: 'legacy-id',
        KCODER_RELAY_LOCAL_GATEWAY: 'http://127.0.0.1:0',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
    const [code] = await once(child, 'close'); assert.equal(code, 1); assert.doesNotMatch(output, /KCoder Studio:/);
  }
});
