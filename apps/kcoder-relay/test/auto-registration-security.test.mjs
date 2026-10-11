// Independent adversarial checks for the auto-registration trust boundary.
// These use real loopback HTTP/WebSocket sockets and never run a model.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { openRegistrationStore } from '../src/registration-store.mjs';
import { startRelay } from '../src/server.mjs';
import { startRegisteredClient } from '../src/client.mjs';
import { buildPairingLink } from '../src/pair.mjs';

const SHARED_HOST = 'registration-security.example:8451';

function token() {
  return randomBytes(32).toString('hex');
}

async function privateDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'kcoder-registration-security-'));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function startFixture(t, registrationStoreFile, registrationKey, gateways = []) {
  const relay = await startRelay({
    gateways,
    sharedHosts: [SHARED_HOST],
    registrationKey,
    registrationStoreFile,
    controlPort: 0,
    proxyPort: 0,
  });
  t.after(() => relay.close());
  return relay;
}

function httpCall({ port, key, path = '/_relay/register', method = 'POST', rawBody, body, headers = {} }) {
  const bytes = Buffer.from(rawBody ?? JSON.stringify(body ?? {}));
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        host: '127.0.0.1',
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'content-length': String(bytes.length),
        connection: 'close',
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.once('aborted', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.once('error', reject);
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('registration request timed out')));
    outgoing.once('error', reject);
    outgoing.end(bytes);
  });
}

function parseJson(response) {
  return JSON.parse(response.body.toString('utf8'));
}

function staticGateway(id, secret, pairingToken) {
  return {
    id,
    secret,
    pairingToken,
    maxConnections: 128,
    maxBytesPerWindow: 64 * 1024 * 1024,
    trafficWindowMs: 60_000,
  };
}

test('registration key cannot become a pairing credential or retrieve an existing identity', async t => {
  const directory = await privateDirectory(t);
  const registrationStoreFile = join(directory, 'registered-gateways.json');
  const registrationKey = token();
  const relay = await startFixture(t, registrationStoreFile, registrationKey);
  const enrollmentToken = token();
  const pairingToken = token();
  const createdResponse = await httpCall({
    port: relay.controlPort,
    key: registrationKey,
    body: { enrollmentToken, pairingToken },
  });
  assert.equal(createdResponse.status, 201);
  const created = parseJson(createdResponse);

  const keyAsPairing = await httpCall({
    port: relay.controlPort,
    key: registrationKey,
    body: { enrollmentToken: token(), pairingToken: registrationKey },
  });
  assert.equal(keyAsPairing.status, 400);

  const keyAsProof = await httpCall({
    port: relay.controlPort,
    key: registrationKey,
    body: { enrollmentToken: registrationKey, pairingToken: token() },
  });
  assert.equal(keyAsProof.status, 400);

  const sameProofDifferentPair = await httpCall({
    port: relay.controlPort,
    key: registrationKey,
    body: { enrollmentToken, pairingToken: token() },
  });
  assert.equal(sameProofDifferentPair.status, 401);

  const newProofExistingPair = await httpCall({
    port: relay.controlPort,
    key: registrationKey,
    body: { enrollmentToken: token(), pairingToken },
  });
  assert.equal(newProofExistingPair.status, 409);

  const duplicateFieldBody = `{"enrollmentToken":"${token()}","enrollmentToken":"${token()}","pairingToken":"${token()}"}`;
  const duplicateField = await httpCall({
    port: relay.controlPort,
    key: registrationKey,
    rawBody: duplicateFieldBody,
  });
  assert.equal(duplicateField.status, 400, 'ambiguous duplicate JSON fields are rejected');

  const lookup = await httpCall({
    port: relay.controlPort,
    key: registrationKey,
    method: 'GET',
    path: `/_relay/register/${created.id}`,
  });
  assert.equal(lookup.status, 404, 'there is no key-only lookup route for assigned identities');
  for (const denied of [keyAsPairing, keyAsProof, sameProofDifferentPair, newProofExistingPair, duplicateField, lookup]) {
    const body = denied.body.toString('utf8');
    assert.equal(body.includes(created.secret), false, 'denials never return an existing control secret');
    assert.equal(body.includes(created.id), false, 'denials never disclose an existing Gateway ID');
  }

  await relay.close();
  const store = await openRegistrationStore({ path: registrationStoreFile });
  assert.equal(store.list().length, 1, 'failed attempts do not add or replace identities');
  assert.deepEqual(store.list()[0], created);
  await store.close();
});

test('startup rejects registration-key credential overlap and static/durable pairing collisions', async t => {
  const directory = await privateDirectory(t);
  const registrationKey = token();
  const staticPairingToken = token();
  const staticSecret = token();

  for (const [label, key, gateway] of [
    ['static control secret', staticSecret, staticGateway('static-a', staticSecret, staticPairingToken)],
    ['static pairing token', staticPairingToken, staticGateway('static-b', staticSecret, staticPairingToken)],
  ]) {
    await assert.rejects(
      startRelay({
        gateways: [gateway],
        sharedHosts: [SHARED_HOST],
        registrationKey: key,
        registrationStoreFile: join(directory, `${label.replaceAll(' ', '-')}.json`),
        controlPort: 0,
        proxyPort: 0,
      }),
      /independent from all Gateway credentials/,
      `${label} cannot also authorize registration`,
    );
  }

  const persistedSecretPath = join(directory, 'persisted-secret.json');
  const secretStore = await openRegistrationStore({ path: persistedSecretPath });
  const persistedSecret = await secretStore.register({ enrollmentToken: token(), pairingToken: token() });
  await secretStore.close();
  await assert.rejects(startRelay({
    gateways: [],
    sharedHosts: [SHARED_HOST],
    registrationKey: persistedSecret.secret,
    registrationStoreFile: persistedSecretPath,
    controlPort: 0,
    proxyPort: 0,
  }), /independent from all Gateway credentials/);

  const persistedPairingPath = join(directory, 'persisted-pairing.json');
  const pairingStore = await openRegistrationStore({ path: persistedPairingPath });
  await pairingStore.register({ enrollmentToken: token(), pairingToken: registrationKey });
  await pairingStore.close();
  await assert.rejects(startRelay({
    gateways: [],
    sharedHosts: [SHARED_HOST],
    registrationKey,
    registrationStoreFile: persistedPairingPath,
    controlPort: 0,
    proxyPort: 0,
  }), /independent from all Gateway credentials/);

  const duplicatePairingPath = join(directory, 'static-persisted-duplicate.json');
  const duplicateStore = await openRegistrationStore({ path: duplicatePairingPath });
  const persistedDuplicate = await duplicateStore.register({
    enrollmentToken: token(),
    pairingToken: staticPairingToken,
  });
  await duplicateStore.close();
  await assert.rejects(startRelay({
    gateways: [staticGateway('static-c', staticSecret, staticPairingToken)],
    sharedHosts: [SHARED_HOST],
    registrationKey,
    registrationStoreFile: duplicatePairingPath,
    controlPort: 0,
    proxyPort: 0,
  }), /pairing token|independent/i, 'persisted/static duplicate pairing must fail closed');
  const reopened = await openRegistrationStore({ path: duplicatePairingPath });
  assert.deepEqual(reopened.list(), [persistedDuplicate], 'failed startup leaves durable registration data untouched');
  await reopened.close();

  const staticCollisionPath = join(directory, 'static-collision.json');
  const relay = await startFixture(t, staticCollisionPath, registrationKey, [
    staticGateway('static-d', staticSecret, staticPairingToken),
  ]);
  const collision = await httpCall({
    port: relay.controlPort,
    key: registrationKey,
    body: { enrollmentToken: token(), pairingToken: staticPairingToken },
  });
  assert.equal(collision.status, 409, 'fresh proof cannot claim an existing static Gateway pairing token');
  await relay.close();
  const emptyStore = await openRegistrationStore({ path: staticCollisionPath });
  assert.deepEqual(emptyStore.list(), []);
  await emptyStore.close();
});

test('registration proof and shared key stay out of the cached identity, pairing link, and control credentials', async t => {
  const directory = await privateDirectory(t);
  const registrationKey = token();
  const pairingToken = token();
  const assignedId = 'assigned-gateway-0123456789';
  const assignedSecret = token();
  const identityFile = join(directory, 'client-identity.json');
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, websocket => webSockets.emit('connection', websocket, request));
  });
  t.after(async () => {
    for (const websocket of webSockets.clients) websocket.terminate();
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    webSockets.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const observedControl = new Promise(resolve => {
    webSockets.once('connection', (websocket, request) => resolve({ websocket, request }));
  });
  let observedRegistration;
  const client = await startRegisteredClient({
    url: relayUrl,
    registrationKey,
    pairingToken,
    identityFile,
    gateway: 'http://127.0.0.1:4186',
    allowInsecure: true,
    fetchImpl: async (input, options) => {
      const pending = JSON.parse(await readFile(identityFile, 'utf8'));
      observedRegistration = { url: String(input), options, pending };
      return new Response(JSON.stringify({
        id: assignedId,
        secret: assignedSecret,
        pairingToken,
        maxConnections: 128,
        maxBytesPerWindow: 64 * 1024 * 1024,
        trafficWindowMs: 60_000,
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => client.close());

  const control = await observedControl;
  const requestBody = JSON.parse(observedRegistration.options.body);
  assert.equal(observedRegistration.url, `${relayUrl}/_relay/register`);
  assert.equal(observedRegistration.options.redirect, 'error', 'registration secrets are never forwarded through redirects');
  assert.equal(observedRegistration.options.headers.authorization, `Bearer ${registrationKey}`);
  assert.equal(observedRegistration.pending.enrollmentToken, requestBody.enrollmentToken);
  assert.equal(observedRegistration.pending.id, undefined, 'proof is committed before the network request');
  assert.equal(observedRegistration.pending.secret, undefined);
  assert.doesNotMatch(observedRegistration.options.body, new RegExp(registrationKey));

  assert.equal(control.request.url, '/_relay/control');
  assert.equal(control.request.headers.authorization, `Bearer ${assignedSecret}`);
  assert.equal(control.request.headers['x-kcoder-device'], assignedId);
  assert.notEqual(control.request.headers.authorization, `Bearer ${registrationKey}`);

  const cached = await readFile(identityFile, 'utf8');
  assert.match(cached, new RegExp(assignedId));
  assert.match(cached, new RegExp(assignedSecret));
  assert.doesNotMatch(cached, new RegExp(registrationKey));
  assert.doesNotMatch(cached, new RegExp(pairingToken));
  assert.doesNotMatch(cached, /enrollmentToken/);
  assert.doesNotMatch(cached, new RegExp(requestBody.enrollmentToken));

  const pairingLink = buildPairingLink({
    publicUrl: 'https://registration-security.example:8451',
    token: pairingToken,
    gatewayId: assignedId,
    routeMode: 'path',
    includeGatewayId: true,
  });
  const deepLink = new URL(pairingLink);
  assert.equal(deepLink.searchParams.get('token'), pairingToken);
  assert.equal(deepLink.searchParams.get('gatewayId'), assignedId);
  assert.equal(pairingLink.includes(registrationKey), false);
  assert.equal(pairingLink.includes(assignedSecret), false);
  assert.equal(pairingLink.includes(requestBody.enrollmentToken), false);

  client.close();
  control.websocket.terminate();
});
