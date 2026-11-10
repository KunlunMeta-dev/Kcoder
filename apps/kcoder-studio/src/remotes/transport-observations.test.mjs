import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureGatewayRemoteTransportObservations, createRemoteTransportObservationRoute, REMOTE_TRANSPORT_OBSERVATIONS_PATH } from './transport-observations.mjs';
import { isContract } from '../../shared/generated/validator.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kc-remote-metadata-')); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identityFile = join(directory, 'identity.json'); const gatewaySecret = 'owned-native-gateway-secret-'.repeat(2);
  const relayUrl = 'https://relay.invalid'; const privateSecret = 'owned-registration-secret-'.repeat(2);
  await writeFile(identityFile, JSON.stringify({ version: 1, relayOrigin: relayUrl,
    gatewaySecretHash: createHash('sha256').update(gatewaySecret).digest('hex'), id: 'real-assigned-fixture', secret: privateSecret }), { mode: 0o600 });
  const env = { KCODER_STUDIO_RELAY_IDENTITY_FILE: identityFile, KCODER_STUDIO_RELAY_ORIGIN: relayUrl };
  return { directory, identityFile, gatewaySecret, relayUrl, privateSecret, env };
}
test('registered private metadata is observed without publishing credentials or claiming live routing', async t => {
  const f = await fixture(t); const before = await readFile(f.identityFile);
  const observe = captureGatewayRemoteTransportObservations({ env: f.env, gatewaySecret: f.gatewaySecret });
  assert.deepEqual(f.env, {}); const result = await observe(); assert.ok(isContract('RemoteCapabilityCatalog', result));
  assert.equal(result.entries[0].state, 'observed'); assert.equal(result.entries[0].identityState, 'observed');
  assert.equal(result.entries[0].businessState, 'unknown'); assert.equal(result.entries[0].nativeOwner, null);
  assert.equal(result.entries[0].boundary.resource.id, 'real-assigned-fixture'); assert.equal(result.entries[0].protocolVersion, null);
  const serialized = JSON.stringify(result); for (const privateValue of [f.gatewaySecret, f.privateSecret, f.identityFile, f.relayUrl]) assert.ok(!serialized.includes(privateValue));
  assert.deepEqual(await readFile(f.identityFile), before);
});
for (const failure of ['origin', 'internal-secret', 'malformed', 'mode', 'symlink', 'hardlink']) test(`private registration ${failure} fails closed without enrollment or secret diagnostics`, async t => {
  const f = await fixture(t);
  if (failure === 'origin') f.env.KCODER_STUDIO_RELAY_ORIGIN = 'https://different.invalid';
  if (failure === 'internal-secret') f.gatewaySecret = 'different-native-gateway-secret-'.repeat(2);
  if (failure === 'malformed') await writeFile(f.identityFile, '{}');
  if (failure === 'mode') await chmod(f.identityFile, 0o644);
  if (failure === 'symlink') { const link = join(f.directory, 'link'); await symlink(f.identityFile, link); f.env.KCODER_STUDIO_RELAY_IDENTITY_FILE = link; }
  if (failure === 'hardlink') await link(f.identityFile, join(f.directory, 'duplicate'));
  const result = await captureGatewayRemoteTransportObservations({ env: f.env, gatewaySecret: f.gatewaySecret })();
  assert.equal(result.entries[0].state, 'unavailable'); assert.equal(result.entries[0].nativeOwner, null);
  assert.equal(result.entries[0].boundary.resource, null); assert.ok(!JSON.stringify(result).includes(f.directory));
});
test('no configured source performs no private default lookup or initialization', async t => {
  const f = await fixture(t);
  const result = await captureGatewayRemoteTransportObservations({ env: {}, gatewaySecret: f.gatewaySecret })();
  assert.equal(result.entries[0].state, 'unknown'); assert.equal(result.entries[0].reasonCode, 'RELAY_REGISTRATION_NOT_CONFIGURED');
});
test('finite route checks Gateway authority and rejects caller-selected metadata paths before reading', async () => {
  let reads = 0; const response = {}; const route = createRemoteTransportObservationRoute({
    observe: async () => { reads++; return { observed: true }; }, canRead: (_request, session) => session?.admin === true,
    jsonResponse: (target, status, body) => Object.assign(target, { status, body }),
  });
  for (const [method, query, session, expected] of [['GET', '', {}, 403], ['POST', '', { admin: true }, 405], ['GET', '?identityFile=caller', { admin: true }, 400]]) {
    assert.equal(await route({ method }, response, new URL(`http://localhost${REMOTE_TRANSPORT_OBSERVATIONS_PATH}${query}`), session), true);
    assert.equal(response.status, expected); assert.equal(reads, 0);
  }
  await route({ method: 'GET' }, response, new URL(`http://localhost${REMOTE_TRANSPORT_OBSERVATIONS_PATH}`), { admin: true });
  assert.equal(response.status, 200); assert.equal(reads, 1);
});
test('startup metadata aliases are consumed once and conflicting references cannot select a source', async t => {
  const f = await fixture(t); f.env.kcoder_studio_relay_identity_file = join(f.directory, 'another');
  f.env.Kcoder_Studio_Relay_Origin = f.relayUrl;
  const observe = captureGatewayRemoteTransportObservations({ env: f.env, gatewaySecret: f.gatewaySecret });
  assert.deepEqual(f.env, {}); assert.equal((await observe()).entries[0].state, 'unknown');
});
test('metadata read cannot publish after Gateway authority changes during the private read', async () => {
  let complete, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { complete = resolve; });
  const session = { admin: true }, response = {};
  const route = createRemoteTransportObservationRoute({
    observe: () => { entered(); return pending; }, canRead: (_request, current) => current.admin,
    jsonResponse: (target, status, body) => Object.assign(target, { status, body }),
  });
  const reading = route({ method: 'GET' }, response, new URL(`http://localhost${REMOTE_TRANSPORT_OBSERVATIONS_PATH}`), session);
  await started; session.admin = false; complete({ entries: [{ id: 'prior-owner-registration' }] });
  await reading;
  assert.equal(response.status, 403);
  assert.equal(response.body.entries, undefined);
});
test('actual loopback Relay registration is read exactly and remains distinct from a closed control channel', async t => {
  const f = await fixture(t); await rm(f.identityFile);
  const { randomBytes } = await import('node:crypto');
  const { startRelay } = await import('../../../kcoder-relay/src/server.mjs');
  const { startRegisteredClient } = await import('../../../kcoder-relay/src/client.mjs');
  const { readRegisteredClientId } = await import('../../../kcoder-relay/src/client-identity.mjs');
  let relay, client, timer, onlineCount = 0;
  try {
    const registrationKey = randomBytes(32).toString('hex');
    relay = await startRelay({ gateways: [], sharedHosts: ['127.0.0.1'], registrationKey,
      registrationStoreFile: join(f.directory, 'registrations-v2.json'), controlPort: 0, proxyPort: 0 });
    const relayUrl = `http://127.0.0.1:${relay.controlPort}`;
    let markOnline; const online = new Promise(resolve => { markOnline = resolve });
    client = await startRegisteredClient({ url: relayUrl, registrationKey, gatewaySecret: f.gatewaySecret,
      identityFile: f.identityFile, gateway: 'http://127.0.0.1:9', allowInsecure: true, retryMs: 100,
      onOnline: () => { onlineCount++; markOnline(); } });
    await Promise.race([online, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned Relay control handshake timed out')), 5000); })]);
    clearTimeout(timer);
    const assigned = await readRegisteredClientId({ identityFile: f.identityFile, relayUrl, gatewaySecret: f.gatewaySecret });
    const before = await readFile(f.identityFile);
    const observe = captureGatewayRemoteTransportObservations({ env: { KCODER_STUDIO_RELAY_IDENTITY_FILE: f.identityFile, KCODER_STUDIO_RELAY_ORIGIN: relayUrl }, gatewaySecret: f.gatewaySecret });
    const first = await observe(); assert.equal(first.entries[0].boundary.resource.id, assigned);
    assert.equal(first.entries[0].state, 'observed'); assert.equal(first.entries[0].businessState, 'unknown');
    await client.close(); client = undefined;
    assert.equal((await observe()).entries[0].state, 'observed', 'Durable registration observation must not claim current WS online status');
    assert.equal(onlineCount, 1, 'Metadata reads never reconnect the Relay client');
    assert.deepEqual(await readFile(f.identityFile), before, 'Metadata observation never replaces a registration proof');
  } finally { clearTimeout(timer); await client?.close(); await relay?.close(); }
});
