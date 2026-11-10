import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ensureRegisteredClientIdentity } from '../../kcoder-relay/src/client.mjs';
import { prepareInstanceIdentityFile, resolveIdentityFile } from '../../kcoder-relay/src/client-identity.mjs';
import { isolatedGatewayUrl } from '../../kcoder-relay/src/gateway-origin.mjs';
import { activateGatewayRelay, prepareGatewayRelay, gatewayRelayRegistrationState } from '../src/gateway-relay-instance.js';
import { createGatewayRelaySwitch, verifyRelayMount, verifyRelayProfile } from '../src/gateway-relay-switch.js';

async function fixture(t, { initial = true } = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kcoder-relay-switch-'));
  t.after(() => rm(userDataDir, { recursive: true, force: true }));
  let enrollments = 0; let rejectedOrigin; const clients = [];
  const runtime = { isolatedGatewayUrl, prepareInstanceIdentityFile, resolveIdentityFile,
    ensureRegisteredClientIdentity: options => ensureRegisteredClientIdentity({ ...options, fetchImpl: async (url, input) => {
      enrollments++; const body = JSON.parse(input.body);
      if (new URL(url).origin === rejectedOrigin) return new Response(JSON.stringify({ error: 'denied' }), { status: 401 });
      const id = new URL(url).hostname.split('.')[0];
      return new Response(JSON.stringify({ id, secret: (id + '-control-secret-').repeat(4), gatewaySecret: body.gatewaySecret,
        maxConnections: 128, maxBytesPerWindow: 65536, trafficWindowMs: 60000 }), { status: 201 });
    } }),
    startRegisteredClient: async options => {
      const client = { closed: false, close() { this.closed = true; } }; clients.push(client); queueMicrotask(options.onOnline); return client;
    },
  };
  const loadRuntime = async () => runtime;
  const helpers = { userDataDir, loadRuntime, clients, enrollments: () => enrollments,
    rejectOrigin: value => { rejectedOrigin = value; },
    verify: (relay, options) => verifyRelayProfile(relay, { ...options, checkOrigin: async () => {} }) };
  if (!initial) return helpers;
  const a = await activateGatewayRelay({ userDataDir, activationLink: `https://old.example/_relay/activate#code=${'a'.repeat(43)}`, loadRuntime });
  const legacyIdentity = await readFile(join(userDataDir, 'relay/client-identity.json'));
  const legacySecret = await readFile(join(userDataDir, 'desktop-relay/gateway-secret'));
  const env = { KCODER_STUDIO_RELAY_SECRET: legacySecret.toString().trim(), KCODER_STUDIO_RELAY_ORIGIN: 'https://old.example' };
  const original = await prepareGatewayRelay({ userDataDir, env, loadRuntime });
  await original.connect('http://127.0.0.1:1'); t.after(() => original.close());
  return { ...helpers, env, a, originalClient: clients[0], legacyIdentity, legacySecret };
}

test('verified switch keeps the original identity, survives restart and can restore the previous Relay without re-enrolling', async t => {
  const f = await fixture(t);
  const switches = createGatewayRelaySwitch({ ...f, publicBaseUrl: f.a.publicBaseUrl });
  const requestId = randomUUID();
  await assert.rejects(switches.switch({ expectedRevision: 0 }), /Invalid Relay switch request/);
  await switches.switch({ expectedRevision: 0, requestId, relayUrl: 'https://new.example', activationLink: 'b'.repeat(43) });
  await assert.rejects(switches.switch({ expectedRevision: 0, requestId, relayUrl: 'https://different.example' }), { code: 'RELAY_CONFIG_CONFLICT' });
  assert.equal(f.enrollments(), 2); assert.equal(f.clients.at(-1).closed, true); assert.equal(f.originalClient.closed, false);
  assert.deepEqual(await readFile(join(f.userDataDir, 'relay/client-identity.json')), f.legacyIdentity);
  assert.deepEqual(await readFile(join(f.userDataDir, 'desktop-relay/gateway-secret')), f.legacySecret);
  const state = await gatewayRelayRegistrationState({ ...f, publicBaseUrl: f.a.publicBaseUrl });
  assert.equal(state.restartRequired, true); assert.equal(state.revision, 2); assert.equal(state.selectedRelay.url, 'https://new.example');
  const restarted = await prepareGatewayRelay({ ...f, env: { KCODER_RELAY_PUBLIC_URL: 'https://old.example' } });
  assert.match(restarted.publicBaseUrl, /\.new\.example\//); assert.equal(f.enrollments(), 2); restarted.close();
  const restored = createGatewayRelaySwitch({ ...f, publicBaseUrl: restarted.publicBaseUrl });
  await restored.rollback(2);
  const original = await prepareGatewayRelay({ ...f, env: {} });
  assert.equal(original.publicBaseUrl, f.a.publicBaseUrl); assert.equal(f.enrollments(), 2); original.close();
});

test('a failed verification leaves the old connection selected and retry reuses the same enrolled candidate', async t => {
  const f = await fixture(t); const requestId = randomUUID();
  const failed = createGatewayRelaySwitch({ ...f, publicBaseUrl: f.a.publicBaseUrl, verify: async () => { throw Error('offline'); } });
  await assert.rejects(failed.switch({ expectedRevision: 0, requestId, relayUrl: 'https://new.example', activationLink: 'b'.repeat(43) }), /offline/);
  let state = await gatewayRelayRegistrationState({ ...f, publicBaseUrl: f.a.publicBaseUrl });
  assert.equal(state.restartRequired, false); assert.equal(state.switchAttempt.id, requestId); assert.equal(state.revision, 1);
  const current = await prepareGatewayRelay({ ...f, env: {} }); assert.equal(current.publicBaseUrl, f.a.publicBaseUrl); current.close();
  const retry = createGatewayRelaySwitch({ ...f, publicBaseUrl: f.a.publicBaseUrl });
  await retry.switch({ expectedRevision: 1, requestId });
  assert.equal(f.enrollments(), 2, 'verification retry cannot consume a second activation code');
  state = await gatewayRelayRegistrationState({ ...f, publicBaseUrl: f.a.publicBaseUrl }); assert.equal(state.restartRequired, true);
  await retry.switch({ expectedRevision: 1, requestId }); assert.equal(f.enrollments(), 2, 'a lost completed response is idempotent');
});

test('a consumed account invite survives failed mount verification and same-request retry without enrollment again', async t => {
  const f = await fixture(t); const requestId = randomUUID();
  const failed = createGatewayRelaySwitch({ ...f, publicBaseUrl: f.a.publicBaseUrl, verify: async () => { throw Error('offline'); } });
  const invite = `https://new.example/_relay/login#code=${'c'.repeat(43)}`;
  await assert.rejects(failed.switch({ expectedRevision: 0, requestId, relayUrl: 'https://new.example', activationLink: invite }), /offline/);
  assert.equal(f.enrollments(), 2);
  const candidatePath = join(f.userDataDir, 'relay-profiles', requestId, 'desktop-relay.json');
  assert.deepEqual(JSON.parse(await readFile(candidatePath, 'utf8')), { url: 'https://new.example' });
  const state = await gatewayRelayRegistrationState({ ...f, publicBaseUrl: f.a.publicBaseUrl });
  assert.equal(state.switchAttempt.id, requestId);
  assert.equal(state.switchAttempt.needsActivation, false);
  const retry = createGatewayRelaySwitch({ ...f, publicBaseUrl: f.a.publicBaseUrl });
  await retry.switch({ expectedRevision: 1, requestId, relayUrl: 'https://new.example',
    accountCredentials: { username: 'stale.user', password: 'stale-password-value' } });
  assert.equal(f.enrollments(), 2, 'the registered candidate is reused after its one-time invite was consumed');
});

test('a pending invite can correct an initially failed Relay origin without replacing the original proof', async t => {
  const f = await fixture(t, { initial: false });
  f.rejectOrigin('https://old.example');
  const originalInvite = `https://old.example/_relay/activate#code=${'a'.repeat(43)}`;
  await assert.rejects(activateGatewayRelay({ userDataDir: f.userDataDir, activationLink: originalInvite, loadRuntime: f.loadRuntime }), { status: 401 });
  const originalConfig = JSON.parse(await readFile(join(f.userDataDir, 'desktop-relay.json'), 'utf8'));
  assert.equal(originalConfig.activationCode, 'a'.repeat(43));
  const originalIdentity = JSON.parse(await readFile(join(f.userDataDir, 'relay/client-identity.json'), 'utf8'));
  assert.equal(originalIdentity.id, undefined);
  const switches = createGatewayRelaySwitch({ ...f, publicBaseUrl: null, verify: async () => {} });
  await assert.rejects(switches.switch({ expectedRevision: 0, requestId: randomUUID(), relayUrl: 'https://old.example',
    activationLink: originalInvite }, { allowUntrackedOriginal: true, pendingOriginCorrection: true }), { code: 'RELAY_CONFIG_CONFLICT' });
  assert.equal(f.enrollments(), 1, 'same-origin recovery must retry the saved proof, not enroll a replacement identity');

  const requestId = randomUUID();
  const correctedInvite = `https://new.example/_relay/login#code=${'b'.repeat(43)}`;
  await switches.switch({ expectedRevision: 0, requestId, relayUrl: 'https://new.example', activationLink: correctedInvite },
    { allowUntrackedOriginal: true, pendingOriginCorrection: true });
  const config = JSON.parse(await readFile(join(f.userDataDir, 'desktop-relay.json'), 'utf8'));
  assert.equal(config.activationCode, 'a'.repeat(43));
  assert.equal(config.selectedProfile, requestId);
  assert.equal(config.previousProfile, undefined);
  assert.deepEqual(config.switchAttempt, undefined);
  assert.equal(JSON.parse(await readFile(join(f.userDataDir, 'relay/client-identity.json'), 'utf8')).id, undefined);
  const candidate = JSON.parse(await readFile(join(f.userDataDir, 'relay-profiles', requestId, 'desktop-relay.json'), 'utf8'));
  assert.deepEqual(candidate, { url: 'https://new.example' });
  assert.equal(f.enrollments(), 2);
  const state = await gatewayRelayRegistrationState({ ...f, publicBaseUrl: null });
  assert.equal(state.restartRequired, true);
  assert.equal(state.selectedRelay.url, 'https://new.example');
  assert.equal(state.previousRelay, undefined);
});

test('Relay profile verification checks the exact mount against its temporary nonce probe and rejects route errors', async t => {
  const requested = [];
  const candidate = 'https://g-0123456789012345678901234567890123456789.relay.example/g/gateway-one';
  let probeUrl; let closed = false;
  const relay = { publicBaseUrl: candidate, async connect(url, options) { probeUrl = url; options.onOnline(); }, close() { closed = true; } };
  await verifyRelayProfile(relay, { publicBaseUrl: 'https://old.example/g/old', checkOrigin: async (url, signal, nonce) => {
    await verifyRelayMount(url, signal, nonce, async mount => {
      requested.push(new URL(mount));
      return fetch(probeUrl, { method: 'HEAD' });
    });
  } });
  assert.equal(requested[0].origin, new URL(candidate).origin);
  assert.equal(requested[0].pathname, '/g/gateway-one/');
  assert.equal(closed, true);
  await assert.rejects(fetch(probeUrl, { method: 'HEAD' }));
  for (const status of [404, 421, 502]) await assert.rejects(verifyRelayMount(candidate, undefined, 'expected-nonce',
    async () => new Response(null, { status })), /Relay mount verification failed/);
  await assert.rejects(verifyRelayMount(candidate, undefined, 'expected-nonce',
    async () => new Response(null, { status: 204, headers: { 'x-kcoder-relay-verification': 'wrong-nonce' } })), /Relay mount verification failed/);
});

test('stale edits and late verification cannot overwrite a cancelled or newer selection', async t => {
  const f = await fixture(t); const requestId = randomUUID(); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }); const wait = new Promise(resolve => { release = resolve; });
  const switches = createGatewayRelaySwitch({ ...f, publicBaseUrl: f.a.publicBaseUrl, verify: async () => { entered(); await wait; } });
  await assert.rejects(switches.switch({ expectedRevision: 4, requestId, relayUrl: 'https://new.example', activationLink: 'b'.repeat(43) }), { code: 'RELAY_CONFIG_CONFLICT' });
  assert.equal(f.enrollments(), 1);
  const pending = switches.switch({ expectedRevision: 0, requestId, relayUrl: 'https://new.example', activationLink: 'b'.repeat(43) }); await ready;
  await switches.cancel(1); release(); await assert.rejects(pending, { code: 'RELAY_CONFIG_CONFLICT' });
  const state = await gatewayRelayRegistrationState({ ...f, publicBaseUrl: f.a.publicBaseUrl });
  assert.equal(state.restartRequired, false); assert.equal(state.switchAttempt, undefined); assert.equal(state.revision, 2);
  assert.deepEqual(await readFile(join(f.userDataDir, 'relay/client-identity.json')), f.legacyIdentity);
});

test('a new-origin TLS failure closes only its candidate and leaves the active configuration unchanged', async t => {
  const f = await fixture(t); const requestId = randomUUID();
  const switches = createGatewayRelaySwitch({ ...f, publicBaseUrl: f.a.publicBaseUrl,
    verify: (relay, options) => verifyRelayProfile(relay, { ...options, checkOrigin: async () => { throw Error('new origin TLS unavailable'); } }) });
  await assert.rejects(switches.switch({ expectedRevision: 0, requestId, relayUrl: 'https://new.example', activationLink: 'b'.repeat(43) }), /TLS unavailable/);
  assert.equal(f.clients.at(-1).closed, true);
  assert.equal(f.originalClient.closed, false);
  const state = await gatewayRelayRegistrationState({ ...f, publicBaseUrl: f.a.publicBaseUrl });
  assert.equal(state.restartRequired, false); assert.equal(state.selectedProfileId, null);
  assert.deepEqual(await readFile(join(f.userDataDir, 'relay/client-identity.json')), f.legacyIdentity);
});
