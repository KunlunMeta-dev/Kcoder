import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { credentials, relayServerConfig } from '../src/config.mjs';
import { startClient } from '../src/client.mjs';
import { fetchGatewayPairing } from '../src/pair.mjs';
import { isolatedGatewayUrl } from '../src/gateway-origin.mjs';

// Path-routed Gateways are paired on their isolated origin with the /g/<id> mount.
const isolated = (publicUrl, id) => isolatedGatewayUrl(publicUrl, id).href.replace(/\/$/, '');
const cyxGateway = isolated('https://hyf2333.top:8451', 'cyx');

const secretA = 'relay-control-secret-alpha-0123456789';
const secretB = 'relay-control-secret-bravo-0123456789';
const tokenA = 'gateway-pairing-token-alpha-0123456789';
const tokenB = 'gateway-pairing-token-bravo-0123456789';
const relayPackageRoot = fileURLToPath(new URL('../', import.meta.url));

const dynamicToken = 'f'.repeat(64);
function pairingFetch(publicGateway, override = {}) {
  return async (url, options) => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:4186');
    assert.equal(new URL(url).pathname, '/api/mobile/pairing/relay');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['x-kcoder-relay-validation'], tokenA);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return Response.json({ kind: 'temporary', token: dynamicToken, expiresAt: Date.now() + 60_000, publicBaseUrl: publicGateway,
      connectionRoutes: { version: 1, gatewayId: 'c'.repeat(64), publicKey: 'd'.repeat(64),
        endpoints: [{ kind: 'public', url: publicGateway }] }, ...override });
  };
}

test('pairing discovery accepts a fixed device credential and enforces an explicitly selected mode', async () => {
  const publicGateway = 'https://hyf2333.top:8451/g/cyx';
  const fixed = { kind: 'fixed', token: 'fixed-mobile-pairing-token-'.repeat(3), expiresAt: null };
  for (const tokenMode of ['auto', 'fixed']) {
    const result = await fetchGatewayPairing({ localGateway: 'http://127.0.0.1:4186', gatewaySecret: tokenA,
      publicGateway, tokenMode, fetchImpl: pairingFetch(publicGateway, fixed) });
    assert.equal(result.kind, 'fixed'); assert.equal(result.token, fixed.token); assert.equal(result.expiresAt, null);
  }
  for (const [tokenMode, override] of [['temporary', fixed], ['fixed', {}], ['auto', { ...fixed, token: tokenA }],
    ['auto', { ...fixed, expiresAt: 0 }]]) {
    await assert.rejects(fetchGatewayPairing({ localGateway: 'http://127.0.0.1:4186', gatewaySecret: tokenA,
      publicGateway, tokenMode, fetchImpl: pairingFetch(publicGateway, override) }), /invalid device pairing/);
  }
});

function gateway(id, secret, gatewaySecret) {
  return {
    id,
    secret,
    gatewaySecret,
    maxConnections: 128,
    maxBytesPerWindow: 67_108_864,
    trafficWindowMs: 60_000,
  };
}

function registry() {
  return {
    gateways: [gateway('cyx', secretA, tokenA)],
    sharedHosts: ['hyf2333.top:8451'],
  };
}

async function isolatedTempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-config-pair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}


async function writeRegistry(t, value) {
  const directory = await isolatedTempDir(t);
  const path = join(directory, 'registry.json');
  await writeFile(path, Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function configFor(path, env = {}) {
  return relayServerConfig({ KCODER_RELAY_REGISTRY_FILE: path, ...env });
}

test('registry loads the complete multi-Gateway shape and server ports', async t => {
  const value = registry();
  value.gateways.push(gateway('lab', secretB, tokenB));
  value.sharedHosts.push('relay-alt.example:9443');
  const path = await writeRegistry(t, value);
  const result = configFor(path, { KCODER_RELAY_CONTROL_PORT: '18452', KCODER_RELAY_PROXY_PORT: '18451' });

  assert.deepEqual(result.gateways, value.gateways);
  assert.deepEqual(result.sharedHosts, value.sharedHosts);
  assert.equal(Object.hasOwn(result, 'legacy'), false);
  assert.equal(result.controlPort, 18452);
  assert.equal(result.proxyPort, 18451);
});

test('registry rejects malformed JSON or invalid fields', async t => {
  const malformed = await writeRegistry(t, '{not json');
  assert.throws(() => configFor(malformed), /valid JSON/);

  const unknown = registry();
  unknown.gateways[0].hosts = ['hyf2333.top:8451'];
  const unknownPath = await writeRegistry(t, unknown);
  assert.throws(() => configFor(unknownPath), /unknown hosts/);

  const missing = registry();
  delete missing.gateways[0].trafficWindowMs;
  const missingPath = await writeRegistry(t, missing);
  assert.throws(() => configFor(missingPath), /missing trafficWindowMs/);

});

test('registry read is bounded and malformed authorities do not enter routing config', async t => {
  const oversized = await writeRegistry(t, Buffer.alloc(256 * 1024 + 1, 32));
  assert.throws(() => configFor(oversized), /exceeds 262144 bytes/);

  for (const host of ['hyf2333.top:8451/path', 'https://hyf2333.top:8451', 'user@host:8451', 'bad host:8451']) {
    await t.test(`rejects shared host ${host}`, async t2 => {
      const value = registry();
      value.sharedHosts = [host];
      const path = await writeRegistry(t2, value);
      assert.throws(() => configFor(path), /exact host authority/);
    });
  }
});

test('registry rejects duplicate IDs, ambiguous hosts, and reused Gateway credentials', async t => {
  const cases = [
    ['case-insensitive duplicate IDs', value => value.gateways.push(gateway('CYX', secretB, tokenB)), /Duplicate Gateway ID/],
    ['duplicate authorities after normalization', value => value.sharedHosts.push('HYF2333.TOP:8451'), /duplicate authority/],
    ['shared relay secret', value => value.gateways.push(gateway('lab', secretA, tokenB)), /share a relay secret/],
    ['shared pairing token', value => value.gateways.push(gateway('lab', secretB, tokenA)), /share a pairing token/],
    ['pair token reused as a relay secret', value => value.gateways.push(gateway('lab', tokenA, tokenB)), /must be distinct/],
    ['secret reused as its pairing token', value => { value.gateways[0].gatewaySecret = secretA; }, /must be distinct/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async t2 => {
      const value = registry();
      mutate(value);
      const path = await writeRegistry(t2, value);
      assert.throws(() => configFor(path), pattern);
    });
  }
});

test('registry requires long credentials and bounded resource fields', async t => {
  const cases = [
    ['short relay secret', value => { value.gateways[0].secret = 'short'; }, /secret of at least 32/],
    ['short pairing token', value => { value.gateways[0].gatewaySecret = 'short'; }, /pairing token of at least 32/],
    ['zero max connections', value => { value.gateways[0].maxConnections = 0; }, /maxConnections/],
    ['fractional window size', value => { value.gateways[0].maxBytesPerWindow = 1.5; }, /maxBytesPerWindow/],
    ['excessive traffic window', value => { value.gateways[0].trafficWindowMs = 86_400_001; }, /trafficWindowMs/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async t2 => {
      const value = registry();
      mutate(value);
      const path = await writeRegistry(t2, value);
      assert.throws(() => configFor(path), pattern);
    });
  }
});

test('legacy credentials keep device compatibility and reject conflicting ID aliases', () => {
  const legacy = credentials({ KCODER_RELAY_SECRET: secretA, KCODER_RELAY_DEVICE_ID: 'old-device' });
  assert.equal(legacy.device, 'old-device');

  const alias = credentials({ KCODER_RELAY_SECRET: secretA, KCODER_RELAY_GATEWAY_ID: 'new-gateway' });
  assert.equal(alias.device, 'new-gateway');

  assert.throws(() => credentials({
    KCODER_RELAY_SECRET: secretA,
    KCODER_RELAY_DEVICE_ID: 'old-device',
    KCODER_RELAY_GATEWAY_ID: 'new-gateway',
  }), /conflicts/);

  const oldServerConfig = relayServerConfig({ KCODER_RELAY_SECRET: secretA, KCODER_RELAY_DEVICE_ID: 'old-device' });
  assert.equal(oldServerConfig.gateways.length, 1);
  assert.equal(oldServerConfig.legacy, true);
  assert.equal(oldServerConfig.gateways[0].id, 'old-device');
  assert.equal(oldServerConfig.gateways[0].secret, secretA);
});

test('client authenticates the selected Gateway ID in headers and rejects mismatched open messages', async t => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  let connectionCount = 0;
  let observedHeaders;
  let observedPath;
  let controlClosed;
  const closedControl = new Promise(resolve => { controlClosed = resolve; });
  wss.on('connection', (socket, request) => {
    connectionCount += 1;
    observedHeaders = request.headers;
    observedPath = request.url;
    socket.send(JSON.stringify({ type: 'open', id: 'a'.repeat(48), gatewayId: 'other-gateway' }));
    socket.once('close', controlClosed);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const client = startClient({
    url: `http://127.0.0.1:${http.address().port}`,
    secret: secretA,
    gatewayId: 'selected-gateway',
    gateway: 'http://127.0.0.1:1',
    allowInsecure: true,
    retryMs: 5000,
  });
  t.after(async () => {
    client.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(() => http.close(resolve)));
  });

  let timeout;
  try {
    await Promise.race([
      closedControl,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('client did not reject a mismatched Gateway ID')), 1000); timeout.unref(); }),
    ]);
  } finally { clearTimeout(timeout); }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(observedHeaders['x-kcoder-device'], 'selected-gateway');
  assert.equal(observedHeaders.authorization, `Bearer ${secretA}`);
  assert.equal(new URL(observedPath, 'http://relay.test').search, '');
  assert.equal(connectionCount, 1, 'the client must not open a data socket for another Gateway');
});
