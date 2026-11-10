import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayPairingHandler, gatewayRelaySecret, relaySecretMatches, RELAY_PAIRING_PATH,
  gatewayMobilePairingToken, fixedMobilePairingTokenMatches, selectMobilePairingCredential } from './gateway-relay-auth.js';
import { createMobileDeviceAuth } from './mobile-device-auth.js';

const secret = 'private-relay-secret-'.repeat(3);
const fixedMobile = 'mobile-pairing-only-'.repeat(3);
test('fixed mobile pairing configuration is independent from browser and Relay authority', async () => {
  assert.equal(gatewayMobilePairingToken({}), '');
  assert.equal(gatewayMobilePairingToken({ KCODER_STUDIO_MOBILE_PAIRING_TOKEN: fixedMobile }), fixedMobile);
  for (const env of [{ KCODER_STUDIO_AUTH_TOKEN: fixedMobile }, { KCODER_STUDIO_RELAY_SECRET: fixedMobile }]) {
    assert.throws(() => gatewayMobilePairingToken({ ...env, KCODER_STUDIO_MOBILE_PAIRING_TOKEN: fixedMobile }), /separate/);
  }
  assert.throws(() => gatewayMobilePairingToken({ KCODER_STUDIO_MOBILE_PAIRING_TOKEN: 'short' }), /32-512/);
  assert.equal(fixedMobilePairingTokenMatches(fixedMobile, fixedMobile), true);
  assert.equal(fixedMobilePairingTokenMatches(fixedMobile, secret), false);
  let reads = 0;
  const temporary = async () => { reads++; return { token: 'f'.repeat(64), expiresAt: Date.now() + 10000 }; };
  assert.deepEqual(await selectMobilePairingCredential('auto', fixedMobile, temporary), { kind: 'fixed', token: fixedMobile, expiresAt: null });
  assert.equal(reads, 0);
  assert.equal((await selectMobilePairingCredential('temporary', fixedMobile, temporary)).kind, 'temporary');
  assert.equal((await selectMobilePairingCredential('auto', '', temporary)).kind, 'temporary');
  await assert.rejects(selectMobilePairingCredential('fixed', '', temporary), /not configured/);
  await assert.rejects(selectMobilePairingCredential('unknown', fixedMobile, temporary), /Invalid/);
});
test('Relay credential is independent from the optional fixed browser login token', () => {
  assert.equal(gatewayRelaySecret({}), '');
  assert.equal(gatewayRelaySecret({ KCODER_STUDIO_RELAY_SECRET: secret }), secret);
  assert.throws(() => gatewayRelaySecret({ KCODER_STUDIO_RELAY_SECRET: secret, KCODER_STUDIO_AUTH_TOKEN: secret }), /independent/);
  assert.throws(() => gatewayRelaySecret({ KCODER_STUDIO_RELAY_SECRET: 'short' }), /independent/);
  assert.equal(relaySecretMatches(secret, secret), true);
  assert.equal(relaySecretMatches(secret, 'f'.repeat(64)), false);
  assert.equal(relaySecretMatches('', ''), false);
});

test('dynamic pairing discovery requires private credentials, exact local path, loopback Host and no browser authority', async () => {
  let reads = 0;
  const handle = createRelayPairingHandler({ secret, getPairing: async () => { reads++; return { token: 'f'.repeat(64) }; },
    jsonResponse: (response, status, body) => Object.assign(response, { status, body }) });
  const request = { url: RELAY_PAIRING_PATH, method: 'GET', headers: { host: '127.0.0.1:4186', 'x-kcoder-relay-validation': secret }, socket: { remoteAddress: '127.0.0.1' } };
  for (const edit of [r => delete r.headers['x-kcoder-relay-validation'], r => { r.headers.host = 'relay.example'; },
    r => { r.socket.remoteAddress = '192.0.2.1'; }, r => { r.headers.origin = 'https://relay.example'; },
    r => { r.headers.authorization = 'Bearer ' + secret; }, r => { r.headers.cookie = 'session=x'; },
    r => { r.method = 'POST'; }, r => { r.url += '?x=1'; }]) {
    const r = structuredClone(request); edit(r); const response = {};
    assert.equal(await handle(r, response, new URL(r.url, 'http://localhost')), true);
    assert.ok([403, 404].includes(response.status));
  }
  assert.equal(reads, 0);
  const response = {};
  await handle(request, response, new URL(RELAY_PAIRING_PATH, 'http://localhost'));
  assert.equal(response.status, 200); assert.equal(reads, 1);
  const invalidMode = structuredClone(request); invalidMode.headers['x-kcoder-pairing-token-mode'] = 'unknown';
  const rejected = {};
  await handle(invalidMode, rejected, new URL(RELAY_PAIRING_PATH, 'http://localhost'));
  assert.equal(rejected.status, 400); assert.equal(reads, 1);
});

test('Relay migration and restart preserve paired devices, Gateway identity and token rotation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-device-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = createMobileDeviceAuth({ directory, identity: 'previous-fixed-login' });
  const grant = await old.pair('Owned migration device');
  const connection = await old.getConnectionIdentity();
  const migrated = createMobileDeviceAuth({ directory, identity: null });
  assert.deepEqual(await migrated.getConnectionIdentity(), connection);
  const refreshed = await migrated.refresh(grant.refreshToken, 'migration-rotation-0123456789');
  assert.equal(refreshed.deviceId, grant.deviceId);
  const pairing = await migrated.getPairingCredential();
  const restarted = createMobileDeviceAuth({ directory, identity: null });
  assert.equal(await restarted.matchesPairingCredential(pairing.token), true);
  await restarted.rotatePairingCredential();
  assert.equal(await restarted.matchesPairingCredential(pairing.token), false);
  assert.equal((await restarted.list())[0].id, grant.deviceId);
});
